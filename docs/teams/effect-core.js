// effect-core.js — hopeOS video-effect core, shared by video-effect.html (inside Teams)
// and host-harness.html (local Chrome simulation). Vanilla ES module, no bundler.
//
// It implements BOTH callback shapes that @microsoft/teams-js videoEffects.registerForVideoFrame
// requires — the SDK throws "Both videoFrameHandler and videoBufferHandler must be provided" if
// either is missing (packages/teams-js/src/public/videoEffects.ts L229-231, main, 2026-09-18):
//
//   videoFrameHandler(videoFrameData) -> Promise<VideoFrame>      // "mediaStream" hosts (WebCodecs)
//   videoBufferHandler(bufferData, notifyProcessed, notifyError)  // "sharedFrame" hosts (NV12 in place)
//
// Contract details taken from the SDK source (teams-js 2.56.0, main branch, 2026-09-18):
//   * mediaStream path: the SDK wraps whatever VideoFrame we return in `new VideoFrame(ours,
//     { timestamp: original.timestamp })`, enqueues that, then closes BOTH the original and ours
//     (internal/videoEffectsUtils.ts DefaultTransformer.transform L188-208). So: return a fresh
//     VideoFrame, never close the input yourself, never keep a reference to the returned frame.
//   * sharedFrame path: bufferData = { width, height, videoFrameBuffer: Uint8ClampedArray (NV12),
//     lumaStride?, chromaStride?, stride?, timestamp? } (videoEffects.ts L35-64). Mutate videoFrameBuffer
//     IN PLACE, then call notifyVideoFrameProcessed(). Old hosts send `data` instead of `videoFrameBuffer`;
//     the SDK normalises that before we see it (videoEffects.ts normalizeVideoBufferData L424-435).
//   * Only NV12 is offered by the public enum VideoFrameFormat (videoEffects.ts L70-73).
//   * Budget: "We require the frame rate of the video to be at least 22fps for 720p" (videoEffects.ts
//     L128, L162) — about 45 ms per frame, serial. The host may push 'video.setFrameProcessTimeLimit'
//     (default 100 ms in internal/videoPerformanceMonitor.ts L31) and the SDK emits
//     'video.performance.frameProcessingSlow' if our 1-second average exceeds it (L56-75).
//     videoEffectsEx additionally warns after 2000 ms per frame (private/videoEffectsEx.ts L36, L295-303).

export const EFFECT_IDS = Object.freeze({
  // Must match meetingExtensionDefinition.videoFilters[].id in manifest.json exactly.
  HOLOHANDS: '2a4f6c8e-1b3d-4e5f-8a9b-0c1d2e3f4a5b',
  BALL_PASS: '9f8e7d6c-5b4a-4c3d-9e2f-1a0b9c8d7e6f',
  APPLE:     'c3d4e5f6-a7b8-4c9d-8e0f-1a2b3c4d5e6f',
});

/**
 * Create the effect pipeline.
 *
 * @param {object}   [opts]
 * @param {Function} [opts.createTracker]  async () => tracker, where tracker.detectForVideo(imageSource, tsMs)
 *                                         returns a result. Plug the MediaPipe Tasks-Vision HandLandmarker /
 *                                         PoseLandmarker here (see video-effect.html createHandTracker()).
 * @param {Function} [opts.render]         (ctx2d, w, h, trackerResult, effectId, tMs) => void. The hopeOS
 *                                         three.js / HoloHands overlay draws here. Default = debug overlay.
 */
export function createEffect(opts = {}) {
  const createTracker = opts.createTracker || null;
  const render = opts.render || defaultDebugRender;

  let currentEffectId;          // undefined = effect disabled
  let tracker = null;           // lazily created on first effect selection
  let trackerPromise = null;

  // Working surfaces. OffscreenCanvas keeps this usable from a Worker later
  // (the sample README recommends moving frame processing off the main thread).
  const canvas = new OffscreenCanvas(16, 16);
  const ctx = canvas.getContext('2d', { willReadFrequently: true });

  const stats = { frames: 0, lastMs: 0, avgMs: 0, maxMs: 0, mode: 'idle' };

  function ensureSize(w, h) {
    if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h; }
  }

  function bump(ms) {
    stats.frames++;
    stats.lastMs = ms;
    stats.avgMs = stats.avgMs + (ms - stats.avgMs) / Math.min(stats.frames, 60);
    stats.maxMs = Math.max(stats.maxMs, ms);
  }

  async function ensureTracker() {
    if (!createTracker) return null;
    if (!trackerPromise) trackerPromise = createTracker().then((t) => (tracker = t));
    return trackerPromise;
  }

  /**
   * registerForVideoEffect callback. Resolve when ready; throw an EffectFailureReason string
   * ('InvalidEffectId' | 'InitializationFailure') to make the host show a failure. The SDK maps any other
   * rejection to InitializationFailure and reports readiness to the host via 'video.videoEffectReadiness'
   * (internal/videoEffectsUtils.ts createEffectParameterChangeCallback L505-531).
   */
  async function onEffectChanged(effectId /*, effectParam (videoEffectsEx only) */) {
    if (effectId === undefined || effectId === null) { currentEffectId = undefined; return; } // EffectDisabled
    if (!Object.values(EFFECT_IDS).includes(effectId)) throw 'InvalidEffectId';
    try { await ensureTracker(); } catch (e) { console.error('tracker init failed', e); throw 'InitializationFailure'; }
    currentEffectId = effectId;
  }

  /** Draw one processed frame (any CanvasImageSource) into `canvas` and return it. */
  async function renderInto(source, w, h, tsMicros) {
    ensureSize(w, h);
    ctx.drawImage(source, 0, 0, w, h);
    let result = null;
    if (tracker && currentEffectId) {
      // MediaPipe Tasks-Vision wants a monotonically increasing timestamp in ms. Feeding the canvas keeps this
      // path identical for both handlers; ImageSource (= TexImageSource) also accepts a WebCodecs VideoFrame
      // directly, which saves one copy on the mediaStream path (see NOTES.md).
      result = tracker.detectForVideo(canvas, tsMicros / 1000);
    }
    render(ctx, w, h, result, currentEffectId, tsMicros / 1000);
    return canvas;
  }

  // ---------------------------------------------------------------- mediaStream path
  /** @type {(videoFrameData: {videoFrame: VideoFrame}) => Promise<VideoFrame>} */
  async function videoFrameHandler(videoFrameData) {
    const t0 = performance.now();
    stats.mode = 'mediaStream';
    const input = /** @type {VideoFrame} */ (videoFrameData.videoFrame);
    if (!currentEffectId) {
      // Pass-through still has to return a *new* frame the SDK can close independently.
      return new VideoFrame(input, { timestamp: input.timestamp });
    }
    const w = input.displayWidth || input.codedWidth;
    const h = input.displayHeight || input.codedHeight;
    await renderInto(input, w, h, input.timestamp);
    // Chrome converts the canvas to a VideoFrame (RGBA/BGRA); the host re-encodes as needed.
    const out = new VideoFrame(canvas, { timestamp: input.timestamp });
    bump(performance.now() - t0);
    return out;
  }

  // ---------------------------------------------------------------- sharedFrame path
  /** @type {(b: {width:number,height:number,videoFrameBuffer:Uint8ClampedArray,lumaStride?:number,chromaStride?:number,timestamp?:number}, ok:()=>void, err:(m:string)=>void) => void} */
  function videoBufferHandler(bufferData, notifyVideoFrameProcessed, notifyError) {
    const t0 = performance.now();
    stats.mode = 'sharedFrame';
    if (!currentEffectId) { notifyVideoFrameProcessed(); return; }
    const { width: w, height: h, videoFrameBuffer: buf } = bufferData;
    const lumaStride = bufferData.lumaStride || w;
    const chromaStride = bufferData.chromaStride || w;
    const ts = bufferData.timestamp || 0;
    // Wrap the NV12 bytes as a VideoFrame so the same 2D/three.js render path is used.
    // layout[] lets us honour host strides (VideoFrameBufferInit.layout, WebCodecs spec).
    let frame;
    try {
      frame = new VideoFrame(buf, {
        format: 'NV12', codedWidth: w, codedHeight: h, timestamp: ts,
        layout: [{ offset: 0, stride: lumaStride }, { offset: lumaStride * h, stride: chromaStride }],
      });
    } catch (e) { notifyError('NV12 wrap failed: ' + e); return; }
    renderInto(frame, w, h, ts).then(() => {
      frame.close();
      // Read back RGBA and write NV12 in place (BT.601 limited range, same matrix as the sample's
      // webgl-video-filter.js rgba_to_nv12). This JS loop is the slow part — see NOTES.md for the GPU route.
      const rgba = ctx.getImageData(0, 0, w, h).data;
      rgbaToNV12InPlace(rgba, w, h, buf, lumaStride, chromaStride);
      bump(performance.now() - t0);
      notifyVideoFrameProcessed();
    }).catch((e) => { frame.close(); notifyError(String(e)); });
  }

  return {
    EFFECT_IDS,
    onEffectChanged,
    videoFrameHandler,
    videoBufferHandler,
    setEffect: (id) => onEffectChanged(id),
    get effectId() { return currentEffectId; },
    stats,
  };
}

/** RGBA -> NV12 (Y plane then interleaved UV, 4:2:0), written into `dst` honouring strides. */
export function rgbaToNV12InPlace(rgba, w, h, dst, lumaStride, chromaStride) {
  const uvBase = lumaStride * h;
  for (let y = 0; y < h; y++) {
    const row = y * w * 4, yRow = y * lumaStride;
    for (let x = 0; x < w; x++) {
      const i = row + x * 4, r = rgba[i], g = rgba[i + 1], b = rgba[i + 2];
      dst[yRow + x] = clamp8(0.257 * r + 0.504 * g + 0.098 * b + 16);
    }
  }
  for (let y = 0; y < h; y += 2) {
    const uvRow = uvBase + (y >> 1) * chromaStride;
    for (let x = 0; x < w; x += 2) {
      // average the 2x2 block for chroma
      let r = 0, g = 0, b = 0;
      for (let dy = 0; dy < 2; dy++) for (let dx = 0; dx < 2; dx++) {
        const i = ((y + dy) * w + (x + dx)) * 4; r += rgba[i]; g += rgba[i + 1]; b += rgba[i + 2];
      }
      r *= 0.25; g *= 0.25; b *= 0.25;
      dst[uvRow + x]     = clamp8(-0.148 * r - 0.291 * g + 0.439 * b + 128); // U
      dst[uvRow + x + 1] = clamp8( 0.439 * r - 0.368 * g - 0.071 * b + 128); // V
    }
  }
}
function clamp8(v) { return v < 0 ? 0 : v > 255 ? 255 : v | 0; }

/** Default overlay: proves the pipeline is live. Replace with the hopeOS HoloHands renderer. */
export function defaultDebugRender(ctx, w, h, trackerResult, effectId, tMs) {
  // TODO(hopeOS): three.js WebGL layer — render the HoloHands rig + props to a second (Offscreen)canvas with
  // alpha and ctx.drawImage() it here; keep the 2D ctx for the HUD only.
  ctx.save();
  ctx.lineWidth = Math.max(2, w / 240);
  ctx.strokeStyle = effectId === EFFECT_IDS.BALL_PASS ? '#ff3b3b' : effectId === EFFECT_IDS.APPLE ? '#3bff6a' : '#3b9cff';
  ctx.strokeRect(ctx.lineWidth, ctx.lineWidth, w - 2 * ctx.lineWidth, h - 2 * ctx.lineWidth);
  // Orbiting marker so a frozen frame is visually obvious.
  const a = (tMs / 1000) * Math.PI;
  ctx.beginPath(); ctx.arc(w / 2 + Math.cos(a) * w * 0.3, h / 2 + Math.sin(a) * h * 0.3, w / 40, 0, Math.PI * 2);
  ctx.fillStyle = ctx.strokeStyle; ctx.fill();
  if (trackerResult && trackerResult.landmarks) {
    // HandLandmarkerResult.landmarks: NormalizedLandmark[][] (x, y in 0..1) — tasks-vision vision.d.ts.
    ctx.fillStyle = '#fff';
    for (const hand of trackerResult.landmarks) for (const p of hand) {
      ctx.beginPath(); ctx.arc(p.x * w, p.y * h, w / 200, 0, Math.PI * 2); ctx.fill();
    }
  }
  ctx.restore();
}
