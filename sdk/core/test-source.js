/**
 * hopeOS SDK — Test Source (fake multi-person input, TEST-ONLY)
 * ═══════════════════════════════════════════════════════════════
 * Test the multi-person stack with ONE person (or zero). The whole
 * pipeline only cares that its input is a <video> with N bodies in
 * it — it never knows the pixels aren't a real camera. So we composite
 * a source (your webcam, or a recorded clip) into a canvas tiled N×,
 * and expose THAT as a MediaStream. Downstream is untouched.
 *
 *   const cam = new CompositeCam({ count: 2 });   // 2 clones of you
 *   await cam.useWebcam();                          // or cam.useFile('clip.mp4')
 *   await cam.attach(detectionVideoEl);             // feeds the pipeline
 *   const mt = await initMultiplayerTracking(detectionVideoEl, {...});
 *   cam.setCount(4); cam.setOverlap(0.15);          // live, no re-init
 *
 * The stream IDENTITY never changes when you retile, so tracking never
 * has to be re-initialised — only the composite config mutates.
 *
 * CAVEATS (be honest with the numbers):
 *   • the tiling draw + captureStream add ~1-3ms a real 2-person camera
 *     wouldn't — absolute ms is slightly pessimistic, but A/B and scaling
 *     comparisons are valid;
 *   • clones share your exact motion (correlated) — great for load/latency,
 *     weaker for testing id-swaps between genuinely independent people
 *     (use a recorded clip, option 2, for that).
 */

function drawCover(ctx, v, dx, dy, dw, dh) {
  const sw = v.videoWidth || v.width, sh = v.videoHeight || v.height;
  if (!sw || !sh) return;
  const sAsp = sw / sh, dAsp = dw / dh;
  let cw, ch, cx, cy;
  if (sAsp > dAsp) { ch = sh; cw = sh * dAsp; cx = (sw - cw) / 2; cy = 0; }
  else { cw = sw; ch = sw / dAsp; cx = 0; cy = (sh - ch) / 2; }
  ctx.drawImage(v, cx, cy, cw, ch, dx, dy, dw, dh);
}

/** Tile rectangles for N clones. count 2 supports overlap (0..0.4) to
 *  deliberately stress the intruder-mask / occlusion paths. */
function layoutTiles(count, overlap, w, h) {
  if (count <= 1) return [{ x: 0, y: 0, w, h }];
  if (count === 2) {
    const tw = w * (0.5 + overlap);
    return [{ x: 0, y: 0, w: tw, h }, { x: w - tw, y: 0, w: tw, h }];
  }
  if (count === 3) { const tw = w / 3; return [0, 1, 2].map(i => ({ x: i * tw, y: 0, w: tw, h })); }
  const tw = w / 2, th = h / 2;   // 4 → quadrants
  return [{ x: 0, y: 0, w: tw, h: th }, { x: tw, y: 0, w: tw, h: th },
          { x: 0, y: th, w: tw, h: th }, { x: tw, y: th, w: tw, h: th }];
}

export class CompositeCam {
  constructor(opts = {}) {
    this.w = opts.width || 1280;
    this.h = opts.height || 720;
    this.count = opts.count || 1;
    this.overlap = opts.overlap || 0;
    this.canvas = document.createElement('canvas');
    this.canvas.width = this.w; this.canvas.height = this.h;
    this.ctx = this.canvas.getContext('2d');
    this.src = document.createElement('video');
    this.src.muted = true; this.src.playsInline = true;
    this.stream = this.canvas.captureStream(opts.fps || 30);
    this._raf = null;
  }

  async useWebcam() {
    const s = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: 'user', width: { ideal: this.w }, height: { ideal: this.h } }
    });
    this.src.srcObject = s; this.src.src = '';
    await this.src.play(); this._start();
  }

  /** Feed an EXISTING MediaStream (e.g. a clone of the page's camera stream —
   *  avoids a second getUserMedia, which fails on single-camera devices). */
  async useStream(stream) {
    this.src.srcObject = stream; this.src.src = '';
    await this.src.play(); this._start();
  }

  /** Feed a recorded clip (best for repeatable benchmarks — record 2-4 real people once). */
  async useFile(url) {
    this.src.srcObject = null; this.src.src = url; this.src.loop = true;
    await this.src.play(); this._start();
  }

  setCount(n) { this.count = Math.max(1, n | 0); }
  setOverlap(x) { this.overlap = Math.max(0, Math.min(0.4, x)); }

  _start() {
    if (this._raf) return;
    const draw = () => { this._raf = requestAnimationFrame(draw); this._draw(); };
    draw();
  }

  _draw() {
    const v = this.src;
    if (v.readyState < 2) return;
    const { ctx, w, h } = this;
    ctx.fillStyle = '#0b0e13'; ctx.fillRect(0, 0, w, h);
    for (const t of layoutTiles(this.count, this.overlap, w, h)) drawCover(ctx, v, t.x, t.y, t.w, t.h);
  }

  /** Point a detection <video> at the composite stream (call once). */
  attach(detVideo) { detVideo.srcObject = this.stream; return detVideo.play(); }

  stop() {
    if (this._raf) cancelAnimationFrame(this._raf);
    this._raf = null;
    this.src.srcObject?.getTracks?.().forEach(t => t.stop());
    this.stream.getTracks().forEach(t => t.stop());
  }
}
