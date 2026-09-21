/**
 * video-sink.js — OutgoingSink: the C1 / C3 "as others see you" surface (CONTRACTS §4.2, SPEC §4 step 7, BUILD-PLAN T8).
 * ─────────────────────────────────────────────────────────────────────────────────────────────────────────────
 * One 2D canvas (default 1280x720, the size a Teams camera tile expects) that is redrawn once per rendered frame:
 *
 *   1. the local camera <video>, UN-mirrored — the raw frame is what other people see; the tile's mirror is a CSS
 *      scaleX(-1) on the media only (teamslab.css `.tile--local .tile__media`) and never reaches drawImage — fitted like
 *      the tile does (object-fit: cover, centred crop, TilePipeline.setCover),
 *   2. the local tile's rect of the ONE WebGL surface (stage.renderer.domElement, dpr-scaled) on top of it, flipped
 *      horizontally: the surface is drawn for the mirrored tile (a hand at world +x sits on the right of the tile, over
 *      the mirrored video), so over the un-mirrored video that same hand must land on the LEFT. Both flips together
 *      keep holohands / props / the ball glued to the hands others see.
 *
 * `draw()` MUST run right after `stage.render()` in the same task: the stage renderer has no preserveDrawingBuffer, so
 * the WebGL back buffer is only readable until the frame is composited (teamslab.html wraps `stage.render`).
 *
 * Return paths (SPEC §8 "Outgoing video"):
 *   C1  `openWindow()` — a popup on this same page (`teamslab.html?outgoing=1&sinkview=1`) that paints the canvas at
 *       w x h from BroadcastChannel 'hopeos-outgoing' (ImageBitmap per frame, Blob fallback); OBS window-captures the
 *       popup → OBS Virtual Camera → "OBS Virtual Camera" in Teams. Pixels only: no packets leave on this path.
 *   C3  `stream` — `canvas.captureStream(fps)`; `new LocalVideoStream(stream)` for ACS (R/acs/acs-client.html:233-274).
 *
 * Budget (R/gaps/render-budget/decision.md §4): NO second WebGL renderer — this is a 2D context, `stage.contexts()` is
 * untouched; the frame broadcast only runs while a viewer is alive (hello / ping every second, 3 s grace) and never
 * faster than `fps`. Derived from R/acs/acs-client.html:233-274 (compositor → captureStream) and
 * R/video-effects/effect-core.js:44-56 (working surface + running stats).
 *
 * Browser only (canvas, BroadcastChannel, createImageBitmap). Nothing here reads hands, packets or the wire.
 */

export const OUTGOING_CHANNEL = 'hopeos-outgoing';
/** popup viewer URL relative to the page: the same teamslab.html in `sinkview` mode */
export const SINKVIEW_QUERY = 'outgoing=1&sinkview=1';

const nowMs = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());
const VIEWER_GRACE_MS = 3000;

export class OutgoingSink {
  /**
   * @param {object} o
   * @param {{renderer:{domElement:HTMLCanvasElement, getPixelRatio?:Function}}} o.stage   the StageRenderer (its live renderer is read every draw — survives a context rebuild)
   * @param {HTMLVideoElement|(() => HTMLVideoElement|null)} o.video                      the local tile's <video> (raw camera frame; the CSS mirror is not part of it)
   * @param {() => ({x:number,y:number,w:number,h:number}|null)} o.localVp                 the local tile's rect in surface CSS px (top-left origin; the rect whose u,v run 0..1 — NOT the gutter-extended GL viewport)
   * @param {number} [o.w=1280] @param {number} [o.h=720] @param {number} [o.fps=30]
   * @param {boolean} [o.flipOverlay=true]    flip the surface crop horizontally (the surface is drawn for a mirrored tile)
   * @param {string} [o.channel]              BroadcastChannel name for the popup viewer
   * @param {string|null} [o.popupUrl]        popup URL (default: this page with `?outgoing=1&sinkview=1`)
   * @param {HTMLCanvasElement} [o.canvas]    an existing canvas to draw into (default: a detached one)
   */
  constructor({ stage, video, localVp, w = 1280, h = 720, fps = 30, flipOverlay = true, channel = OUTGOING_CHANNEL, popupUrl = null, canvas = null } = {}) {
    if (!stage) throw new Error('OutgoingSink: stage required');
    this.stage = stage;
    this._video = typeof video === 'function' ? video : () => video || null;
    this.localVp = typeof localVp === 'function' ? localVp : () => localVp || null;
    this.w = w | 0; this.h = h | 0; this.fps = fps;
    this.flipOverlay = !!flipOverlay;
    this.channelName = channel;
    this.popupUrl = popupUrl;
    this.canvas = canvas || document.createElement('canvas');
    this.canvas.width = this.w; this.canvas.height = this.h;
    this.ctx = this.canvas.getContext('2d', { alpha: false, desynchronized: true }) || this.canvas.getContext('2d');
    /** live numbers (contract: fps, w, h; width/height aliases for the API tab) */
    this.stats = { fps: 0, w: this.w, h: this.h, width: this.w, height: this.h, frames: 0, drawMs: 0, sent: 0, viewers: 0, videoOk: false, overlayOk: false, lastDrawAt: 0 };
    this._stream = null;
    this.window = null;
    this._fpsN = 0; this._fpsAt = nowMs();
    this._lastSent = -Infinity; this._pending = false; this._blobMode = false;
    this._viewers = new Map();      // viewerId -> lastSeen (performance.now())
    this._bc = null;
    this._onMsg = (e) => this._onChannel(e.data);
    this._disposed = false;
    this._openChannel();
  }

  // ── channel (popup viewer) ─────────────────────────────────────────────────────────────────────────────────
  _openChannel() {
    if (this._bc || typeof BroadcastChannel === 'undefined') return;
    try { this._bc = new BroadcastChannel(this.channelName); this._bc.addEventListener('message', this._onMsg); } catch (_) { this._bc = null; }
  }
  _onChannel(m) {
    if (!m || typeof m !== 'object' || !this._bc) return;
    if (m.type === 'hello' || m.type === 'ping') {
      this._viewers.set(m.id || 'viewer', nowMs());
      this.stats.viewers = this._viewers.size;
      if (m.type === 'hello') { try { this._bc.postMessage({ type: 'meta', w: this.w, h: this.h, fps: this.fps }); } catch (_) { /* ignore */ } }
    } else if (m.type === 'bye') {
      this._viewers.delete(m.id || 'viewer'); this.stats.viewers = this._viewers.size;
    }
  }
  /** a viewer said hello / ping within the last 3 s */
  hasViewer(now = nowMs()) {
    for (const [id, at] of this._viewers) if (now - at > VIEWER_GRACE_MS) this._viewers.delete(id);
    this.stats.viewers = this._viewers.size;
    return this._viewers.size > 0;
  }
  _broadcast(now) {
    if (!this._bc || this._pending || !this.hasViewer(now)) return;
    if (now - this._lastSent < 1000 / this.fps - 0.5) return;
    this._lastSent = now; this._pending = true;
    const done = () => { this._pending = false; };
    const send = (msg) => { if (!this._bc) return false; try { this._bc.postMessage(msg); this.stats.sent++; return true; } catch (_) { return false; } };
    if (!this._blobMode && typeof createImageBitmap === 'function') {
      createImageBitmap(this.canvas).then((bmp) => {
        const okSend = send({ type: 'frame', bitmap: bmp, w: this.w, h: this.h, t: now });   // structured clone copies the bitmap
        try { bmp.close(); } catch (_) { /* ignore */ }
        if (!okSend && this._bc) this._blobMode = true;                                      // DataCloneError → encoded frames from now on
        done();
      }).catch(() => { this._blobMode = true; done(); });
      return;
    }
    try {
      this.canvas.toBlob((blob) => { if (blob) send({ type: 'frame', blob, w: this.w, h: this.h, t: now }); done(); }, 'image/jpeg', 0.85);
    } catch (_) { done(); }
  }

  // ── per frame ──────────────────────────────────────────────────────────────────────────────────────────────
  /** Call once per rendered frame, right after stage.render() (same task). */
  draw() {
    if (this._disposed) return;
    const t0 = nowMs(), ctx = this.ctx, w = this.w, h = this.h;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.globalAlpha = 1;
    ctx.fillStyle = '#000'; ctx.fillRect(0, 0, w, h);
    // 1. the camera, un-mirrored, object-fit: cover (the tile's fit)
    const v = this._video();
    let videoOk = false;
    if (v && v.readyState >= 2 && v.videoWidth > 0 && v.videoHeight > 0) {
      const vw = v.videoWidth, vh = v.videoHeight, s = Math.max(w / vw, h / vh), sw = w / s, sh = h / s;
      try { ctx.drawImage(v, (vw - sw) / 2, (vh - sh) / 2, sw, sh, 0, 0, w, h); videoOk = true; } catch (_) { videoOk = false; }
    }
    // 2. my rect of the surface, flipped so the overlay lands where others see the hands
    const vp = this.localVp();
    const r = this.stage.renderer, surf = r && r.domElement;
    let overlayOk = false;
    if (vp && surf && vp.w > 0 && vp.h > 0 && surf.width > 0 && surf.height > 0) {
      const dpr = (r.getPixelRatio && r.getPixelRatio()) || (surf.width / Math.max(1, surf.clientWidth || surf.width)) || 1;
      let sx = vp.x * dpr, sy = vp.y * dpr, sw = vp.w * dpr, sh = vp.h * dpr;
      // clamp to the backing store (rounding at the stage edge)
      if (sx < 0) { sw += sx; sx = 0; } if (sy < 0) { sh += sy; sy = 0; }
      sw = Math.min(sw, surf.width - sx); sh = Math.min(sh, surf.height - sy);
      if (sw > 0 && sh > 0) {
        ctx.save();
        if (this.flipOverlay) { ctx.translate(w, 0); ctx.scale(-1, 1); }
        try { ctx.drawImage(surf, sx, sy, sw, sh, 0, 0, w, h); overlayOk = true; } catch (_) { overlayOk = false; }
        ctx.restore();
      }
    }
    // stats
    const st = this.stats;
    st.frames++; st.videoOk = videoOk; st.overlayOk = overlayOk; st.lastDrawAt = t0;
    this._fpsN++;
    if (t0 - this._fpsAt >= 1000) { st.fps = this._fpsN * 1000 / (t0 - this._fpsAt); this._fpsN = 0; this._fpsAt = t0; }
    st.drawMs = nowMs() - t0;
    this._broadcast(t0);
  }

  // ── outputs ────────────────────────────────────────────────────────────────────────────────────────────────
  /** C3: the canvas as a camera-like MediaStream (captureStream(fps)); created on first read */
  get stream() {
    if (!this._stream && this.canvas.captureStream) this._stream = this.canvas.captureStream(this.fps);
    return this._stream;
  }
  /** the popup viewer's URL: this page with `?outgoing=1&sinkview=1` (other params dropped) */
  get viewerUrl() {
    if (this.popupUrl) return this.popupUrl;
    const u = new URL(location.href); u.search = '?' + SINKVIEW_QUERY; u.hash = '';
    return u.href;
  }
  /** popup open and not closed by the user */
  get open() { return !!(this.window && !this.window.closed); }
  /**
   * C1: open (or focus) the popup viewer. Call from a user gesture (More → Outgoing video) or the popup blocker eats it
   * (returns null). The viewer says hello on the channel; frames flow while it pings.
   */
  openWindow() {
    if (this.open) { try { this.window.focus(); } catch (_) { /* ignore */ } return this.window; }
    const feat = `popup=yes,width=${this.w},height=${this.h},resizable=yes,scrollbars=no,noopener=no`;
    let win = null;
    try { win = window.open(this.viewerUrl, 'hopeos-outgoing', feat); } catch (_) { win = null; }
    this.window = win || null;
    return this.window;
  }

  dispose() {
    if (this._disposed) return;
    this._disposed = true;
    if (this._bc) { try { this._bc.postMessage({ type: 'bye', from: 'sink' }); } catch (_) { /* ignore */ } try { this._bc.removeEventListener('message', this._onMsg); this._bc.close(); } catch (_) { /* ignore */ } this._bc = null; }
    if (this._stream) { for (const tr of this._stream.getTracks()) { try { tr.stop(); } catch (_) { /* ignore */ } } this._stream = null; }
    this._viewers.clear(); this.stats.viewers = 0;
    try { this.ctx.setTransform(1, 0, 0, 1, 0, 0); this.ctx.clearRect(0, 0, this.w, this.h); } catch (_) { /* ignore */ }
  }
}

/**
 * OutgoingViewer — the popup side (`teamslab.html?outgoing=1&sinkview=1`): paints the sink's frames into a w x h canvas.
 * Says hello once and pings every second so the sink knows somebody is watching; `stats.connected` flips false when no
 * frame arrived for `staleMs` or the sink said bye. Paints directly from the message (no rAF: a popup behind the
 * meeting window is a background tab and rAF never fires there; OBS still captures the canvas).
 */
export class OutgoingViewer {
  /**
   * @param {HTMLCanvasElement} canvas
   * @param {{channel?:string, pingMs?:number, staleMs?:number, onState?:(connected:boolean)=>void}} o
   */
  constructor(canvas, { channel = OUTGOING_CHANNEL, pingMs = 1000, staleMs = 2500, onState = null } = {}) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d', { alpha: false }) || canvas.getContext('2d');
    this.id = 'v-' + Math.random().toString(36).slice(2, 8);
    this.onState = onState;
    this.stats = { frames: 0, fps: 0, w: canvas.width | 0, h: canvas.height | 0, lastAt: 0, connected: false, mode: 'idle' };
    this._fpsN = 0; this._fpsAt = nowMs();
    this._staleMs = staleMs;
    this._bc = null;
    this._onMsg = (e) => this._onMessage(e.data);
    try { this._bc = new BroadcastChannel(channel); this._bc.addEventListener('message', this._onMsg); } catch (_) { this._bc = null; }
    this._say('hello');
    this._timer = setInterval(() => { this._say('ping'); this._checkStale(); }, pingMs);
    this._onHide = () => this.dispose();
    if (typeof addEventListener === 'function') addEventListener('pagehide', this._onHide, { once: true });
  }
  _say(type) { if (!this._bc) return; try { this._bc.postMessage({ type, id: this.id, t: nowMs() }); } catch (_) { /* ignore */ } }
  _setConnected(on) { if (this.stats.connected === on) return; this.stats.connected = on; if (this.onState) { try { this.onState(on); } catch (_) { /* ignore */ } } }
  _checkStale() { if (this.stats.connected && nowMs() - this.stats.lastAt > this._staleMs) this._setConnected(false); }
  _size(w, h) {
    if (!(w > 0 && h > 0)) return;
    if (this.canvas.width !== w || this.canvas.height !== h) { this.canvas.width = w; this.canvas.height = h; }
    this.stats.w = w; this.stats.h = h;
  }
  _paint(img, w, h) {
    this._size(w || img.width, h || img.height);
    try { this.ctx.drawImage(img, 0, 0, this.canvas.width, this.canvas.height); } catch (_) { return; }
    const now = nowMs(), st = this.stats;
    st.frames++; st.lastAt = now; this._fpsN++;
    if (now - this._fpsAt >= 1000) { st.fps = this._fpsN * 1000 / (now - this._fpsAt); this._fpsN = 0; this._fpsAt = now; }
    this._setConnected(true);
  }
  _onMessage(m) {
    if (!m || typeof m !== 'object') return;
    if (m.type === 'meta') { this._size(m.w, m.h); this._say('ping'); }
    else if (m.type === 'frame') {
      if (m.bitmap) { this.stats.mode = 'bitmap'; this._paint(m.bitmap, m.w, m.h); try { m.bitmap.close(); } catch (_) { /* ignore */ } }
      else if (m.blob && typeof createImageBitmap === 'function') { this.stats.mode = 'blob'; createImageBitmap(m.blob).then((b) => { this._paint(b, m.w, m.h); try { b.close(); } catch (_) { /* ignore */ } }).catch(() => {}); }
    } else if (m.type === 'bye' && m.from === 'sink') this._setConnected(false);
  }
  dispose() {
    if (this._timer) { clearInterval(this._timer); this._timer = 0; }
    this._say('bye');
    if (this._bc) { try { this._bc.removeEventListener('message', this._onMsg); this._bc.close(); } catch (_) { /* ignore */ } this._bc = null; }
    this._setConnected(false);
  }
}
