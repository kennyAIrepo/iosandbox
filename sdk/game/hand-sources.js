/**
 * hand-sources.js — where a tile's hands come from (SPEC §8 HandSource adapter: `{ kind, video|null, start(), stop() }`).
 * Browser only.
 *
 *   LocalCameraSource   ONE getUserMedia through sdk/core/tracking.js initCamera (dropins §3.1) — the page's single grab
 *   CloneSource         stream.clone() of that grab for the solo tester's extra tiles (tile-pipeline.js cloneStreamToTiles)
 *   ClipSource          CompositeCam.useFile(url) (test-source.js:83-86) — the repeatable semi-real path (?clip=)
 *   KeyboardSource      the accessibility hand: a synthetic pack written to S.ovPacks[clientId] BEFORE rigs and physics
 *                       read the tile's packs (CONTRACTS §0 / §6 [5]), so it goes through exactly the production chain
 *                       and the doctrine — pickup only by _wrapGrab (Space held → PackGen.cup), open hand = release
 *                       (Space up → PackGen.open for one frame, then the flat shelf), never a teleport.
 *
 * Bots and remote hands are packet senders / RemoteHands (bot-tile.js, remote-tile.js), not sources here.
 */
import { initCamera } from '../core/tracking.js';        // tracking.js:274-292
import { CompositeCam } from '../core/test-source.js';   // test-source.js:52-114
import { PackGen } from './pack-gen.js';
import { D } from './court-space.js';

function makeVideo(existing) {
  const v = existing || document.createElement('video');
  v.muted = true; v.playsInline = true; v.autoplay = true;
  v.setAttribute('playsinline', ''); v.setAttribute('muted', '');
  return v;
}

function stopStream(s) { if (s && s.getTracks) for (const t of s.getTracks()) { try { t.stop(); } catch (_) { /* already ended */ } } }

export class LocalCameraSource {
  /** @param {{width?:number, height?:number, video?:HTMLVideoElement}} o  (initCamera asks for 1280x720 ideal; other sizes are applied to the track afterwards) */
  constructor({ width = 1280, height = 720, video = null } = {}) {
    this.kind = 'local';
    this.width = width; this.height = height;
    this.video = makeVideo(video);
    this.stream = null;
  }
  async start() {
    const { stream } = await initCamera(null, this.video);                 // ONE getUserMedia; clones come from stream.clone()
    this.stream = stream;
    if (this.width !== 1280 || this.height !== 720) {
      const track = stream.getVideoTracks()[0];
      if (track && track.applyConstraints) await track.applyConstraints({ width: { ideal: this.width }, height: { ideal: this.height } }).catch(() => {});
    }
    return { video: this.video, stream: this.stream };
  }
  stop() { stopStream(this.stream); this.stream = null; if (this.video) { try { this.video.pause(); } catch (_) {} this.video.srcObject = null; } }
}

export class CloneSource {
  /** @param {MediaStream} stream  the local grab; @param {{video?:HTMLVideoElement}} o */
  constructor(stream, { video = null } = {}) {
    this.kind = 'clone';
    this.source = stream;
    this.video = makeVideo(video);
    this.stream = null;
  }
  async start() {
    this.stream = this.source.clone();
    this.video.srcObject = this.stream;
    await this.video.play().catch(() => {});
    return { video: this.video, stream: this.stream };
  }
  stop() { stopStream(this.stream); this.stream = null; if (this.video) { try { this.video.pause(); } catch (_) {} this.video.srcObject = null; } }
}

export class ClipSource {
  /** @param {string} url  a local clip (mp4 / webm / object URL); @param {{video?:HTMLVideoElement, width?:number, height?:number, fps?:number}} o */
  constructor(url, { video = null, width = 1280, height = 720, fps = 30 } = {}) {
    this.kind = 'clip';
    this.url = url;
    this.video = makeVideo(video);
    this.cam = new CompositeCam({ count: 1, width, height, fps });
    this.stream = this.cam.stream;
  }
  async start() {
    await this.cam.useFile(this.url);                                       // loops the clip into the composite canvas
    await this.cam.attach(this.video).catch(() => {});                      // the tile video shows the captureStream
    return { video: this.video, stream: this.stream };
  }
  stop() { this.cam.stop(); if (this.video) { try { this.video.pause(); } catch (_) {} this.video.srcObject = null; } }
}

/**
 * The keyboard hand. Arrows move the pack at `speedMps` inside the tile's world rect (hand plane z = -D); Space held
 * morphs it to `cup` (wrap pickup), Space released emits `open` for ONE frame (release with the pack's measured
 * velocity — PropBall's own follow history reads the position delta / dt) and then the palm-up `flat` shelf.
 * The page calls `tick(dt)` once per frame BEFORE the tile's packs are read; it writes `S.ovPacks[clientId] = {L:null, R:pack}`.
 */
export class KeyboardSource {
  /**
   * @param {{S:object, clientId:string, tileWorldRect:(()=>{x0,y0,x1,y1,floorY})|{x0,y0,x1,y1,floorY}, speedMps?:number, toggleKey?:string|null}} o
   */
  constructor({ S, clientId, tileWorldRect, speedMps = 0.6, toggleKey = 'KeyK' } = {}) {
    this.kind = 'keyboard';
    this.video = null;
    this.S = S; this.clientId = clientId;
    this.rectFn = typeof tileWorldRect === 'function' ? tileWorldRect : () => tileWorldRect;
    this.speedMps = speedMps;
    this.toggleKey = toggleKey;
    this.state = { active: false, x: 0, y: 0, z: -D, closed: false };
    this.keys = { left: false, right: false, up: false, down: false };
    this.pack = null;
    this.shape = 'none';                 // 'flat' | 'cup' | 'open' | 'none' — what the last tick wrote
    this._openFrames = 0;
    this._wrote = false;
    this._win = null;
    this._onDown = e => this._key(e, true);
    this._onUp = e => this._key(e, false);
  }

  _rect() {
    const r = this.rectFn();
    return r || { x0: -0.8, y0: -0.5, x1: 0.8, y1: 0.5, floorY: -0.5 };
  }

  bind(win = window) {
    this.unbind();
    this._win = win;
    win.addEventListener('keydown', this._onDown);
    win.addEventListener('keyup', this._onUp);
    return this;
  }
  unbind() {
    if (!this._win) return;
    this._win.removeEventListener('keydown', this._onDown);
    this._win.removeEventListener('keyup', this._onUp);
    this._win = null;
  }

  _key(e, down) {
    const tgt = e.target;
    if (tgt && (tgt.tagName === 'INPUT' || tgt.tagName === 'TEXTAREA' || tgt.isContentEditable)) return;   // typing in the panel
    const code = e.code || e.key;
    if (down && this.toggleKey && code === this.toggleKey && !e.repeat && !e.ctrlKey && !e.metaKey && !e.altKey) {
      this.toggle(!this.state.active); e.preventDefault(); return;      // K toggles the keyboard hand (SPEC §5); pass toggleKey:null when the page owns the keymap
    }
    if (!this.state.active) return;
    switch (code) {
      case 'ArrowLeft': this.keys.left = down; break;
      case 'ArrowRight': this.keys.right = down; break;
      case 'ArrowUp': this.keys.up = down; break;
      case 'ArrowDown': this.keys.down = down; break;
      case 'Space': case ' ':
        if (down) { if (!this.state.closed) { this.state.closed = true; this._openFrames = 0; } }
        else if (this.state.closed) { this.state.closed = false; this._openFrames = 1; }
        break;
      default: return;
    }
    e.preventDefault();
  }

  /** Turn the keyboard hand on (at the tile centre) or off (its ovPacks entry is removed; a held ball is released next frame by the doctrine). */
  toggle(on) {
    const want = on === undefined ? !this.state.active : !!on;
    if (want === this.state.active) return this.state.active;
    this.state.active = want;
    if (want) {
      const r = this._rect();
      this.state.x = (r.x0 + r.x1) / 2;
      this.state.y = (r.y0 + r.y1) / 2 - 0.1;
      this.state.z = -D;
      this.state.closed = false;
      this._openFrames = 0;
      this.keys.left = this.keys.right = this.keys.up = this.keys.down = false;
    } else {
      this._clear();
    }
    return this.state.active;
  }

  _clear() {
    if (this._wrote && this.S && this.S.ovPacks && this.S.ovPacks[this.clientId]) delete this.S.ovPacks[this.clientId];
    this._wrote = false; this.pack = null; this.shape = 'none';
  }

  /**
   * One frame: integrate the arrows, choose the shape, write the ovPacks entry.
   * @returns {{L:null, R:Array|null}}
   */
  tick(dt) {
    const s = this.state;
    if (!s.active) { if (this._wrote) this._clear(); return { L: null, R: null }; }
    const step = this.speedMps * Math.max(0, Math.min(dt || 0, 0.1));
    const r = this._rect();
    if (this.keys.left) s.x -= step;
    if (this.keys.right) s.x += step;
    if (this.keys.up) s.y += step;
    if (this.keys.down) s.y -= step;
    const m = 0.05;                                                         // keep the palm block inside the tile
    s.x = Math.min(r.x1 - m, Math.max(r.x0 + m, s.x));
    s.y = Math.min(r.y1 - m, Math.max(r.y0 + m, s.y));
    s.z = -D;
    let shape;
    if (s.closed) shape = 'cup';
    else if (this._openFrames > 0) { shape = 'open'; this._openFrames--; }
    else shape = 'flat';
    this.pack = shape === 'cup' ? PackGen.cup(s.x, s.y, s.z) : shape === 'open' ? PackGen.open(s.x, s.y, s.z) : PackGen.flat(s.x, s.y, s.z);
    this.shape = shape;
    if (this.S) {
      if (!this.S.ovPacks) this.S.ovPacks = {};
      const cur = this.S.ovPacks[this.clientId];
      if (cur && typeof cur === 'object') { cur.L = null; cur.R = this.pack; }
      else this.S.ovPacks[this.clientId] = { L: null, R: this.pack };
      this._wrote = true;
    }
    return { L: null, R: this.pack };
  }

  start() { return Promise.resolve({ video: null, stream: null }); }
  stop() { this.toggle(false); this.unbind(); }
}

/** @param {'local'|'clone'|'clip'} kind */
export function makeHandSource(kind, opts = {}) {
  switch (kind) {
    case 'local': return new LocalCameraSource(opts);
    case 'clone': return new CloneSource(opts.stream, opts);
    case 'clip': return new ClipSource(opts.url, opts);
    default: throw new Error('makeHandSource: unknown kind ' + kind);
  }
}
