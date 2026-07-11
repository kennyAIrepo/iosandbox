/**
 * hopeOS SDK — MoveNet MultiPose (multi-person body + identity)
 * ═══════════════════════════════════════════════════════════════
 * The ALWAYS-ON base of the multiplayer stack. Finds every player in
 * one webcam, hands out STABLE per-player ids, and yields the wrist
 * anchors + crop boxes the per-player MediaPipe pipelines run inside.
 *
 * WHY MoveNet over MediaPipe numPoses>1: MediaPipe's person detector
 * cancels one person when two stand <~75cm apart (mediapipe#4681);
 * MoveNet MultiPose keeps both shoulder-to-shoulder and ships a
 * built-in cross-frame tracker (enableTracking) — free stable ids.
 *
 * ASYNC PUMP: TF.js estimatePoses() is async (GPU readback), but the
 * render loop calls detect() synchronously. So MoveNet runs in a
 * self-scheduling background loop that stores its LATEST result;
 * detect() consumers read that cached result (≤1 frame stale, and the
 * crop boxes are EMA-smoothed downstream anyway). Fully decoupled.
 *
 * Output of latest(): [{ id, score, keypoints:[17×{x,y,score,name}] }]
 *   coords are NORMALIZED 0..1 in RAW (un-mirrored) video space.
 *   Mirroring happens once, downstream, in player-tracker.js.
 *
 * COCO-17 keypoint order (indices used downstream):
 *   0 nose · 5/6 shoulders · 7/8 elbows · 9/10 wrists · 11/12 hips
 */

const TF_URL = 'https://cdn.jsdelivr.net/npm/@tensorflow/tfjs@4.22.0/dist/tf.min.js';
const PD_URL = 'https://cdn.jsdelivr.net/npm/@tensorflow-models/pose-detection@2.1.3/dist/pose-detection.min.js';

function loadScript(src) {
  return new Promise((resolve, reject) => {
    for (const s of document.scripts) if (s.src === src) { resolve(); return; }
    const el = document.createElement('script');
    el.src = src; el.async = true;
    el.onload = () => resolve();
    el.onerror = () => reject(new Error('[multipose] failed to load ' + src));
    document.head.appendChild(el);
  });
}

// TF.js + pose-detection are loaded as UMD globals (window.tf / window.poseDetection)
// rather than ESM: the `+esm` bundles each ship their own tfjs-core copy, which
// breaks the peer-dependency backend registration. UMD is the battle-tested path.
let _libsP = null;
function ensureLibs() {
  if (_libsP) return _libsP;
  _libsP = (async () => {
    if (!window.tf) await loadScript(TF_URL);
    if (!window.poseDetection) await loadScript(PD_URL);
    const tf = window.tf;
    await tf.setBackend('webgl');
    await tf.ready();
    return { tf, pd: window.poseDetection };
  })();
  return _libsP;
}

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

/**
 * @param {object} opts
 *   maxDim      MoveNet input max dimension (mult of 32, default 256) — accuracy/speed dial
 *   maxPoses    max people to detect (default 6, MULTIPOSE cap)
 *   minPoseScore  drop poses below this overall score (default 0.2)
 *   fpsCap      throttle the background pump (default 30) — leaves GPU for MediaPipe + Three
 *   smoothing   MoveNet built-in temporal smoothing (default true)
 */
export async function initMultiPose(opts = {}) {
  const { pd } = await ensureLibs();

  const detector = await pd.createDetector(pd.SupportedModels.MoveNet, {
    modelType: pd.movenet.modelType.MULTIPOSE_LIGHTNING,
    enableTracking: true,
    trackerType: pd.TrackerType.Keypoint,   // OKS on joints — holds ids when players stand close
    multiPoseMaxDimension: opts.maxDim || 256,
    enableSmoothing: opts.smoothing !== false
  });

  const maxPoses = opts.maxPoses || 6;
  const minScore = opts.minPoseScore ?? 0.2;
  const minIntervalMs = 1000 / (opts.fpsCap || 30);

  let latest = [];
  let latestT = -1;
  let lastMs = 0;
  let vw = 0, vh = 0;
  let running = false;
  let pumping = false;

  /** One estimation pass → normalized, id-carrying poses (RAW space). */
  async function estimate(video) {
    vw = video.videoWidth || vw;
    vh = video.videoHeight || vh;
    if (!vw || !vh) return [];
    const t0 = performance.now();
    const raw = await detector.estimatePoses(video, { maxPoses, flipHorizontal: false });
    lastMs = performance.now() - t0;
    const out = [];
    for (const p of raw) {
      if (p.id == null) continue;                 // needs enableTracking id
      if ((p.score ?? 1) < minScore) continue;
      const kp = new Array(p.keypoints.length);
      for (let i = 0; i < p.keypoints.length; i++) {
        const k = p.keypoints[i];
        kp[i] = { x: k.x / vw, y: k.y / vh, score: k.score ?? 0, name: k.name };
      }
      out.push({ id: p.id, score: p.score ?? 0, keypoints: kp });
    }
    return out;
  }

  async function pump(video) {
    if (pumping) return;
    pumping = true;
    while (running) {
      if (video.readyState < 2 || !video.videoWidth) { await sleep(50); continue; }
      const t = performance.now();
      try {
        latest = await estimate(video);
        latestT = performance.now();
      } catch (e) {
        console.warn('[multipose] estimate error', e);
        await sleep(120);
      }
      const spent = performance.now() - t;
      if (spent < minIntervalMs) await sleep(minIntervalMs - spent);
    }
    pumping = false;
  }

  return {
    /** Begin the background estimation pump on a video element. */
    start(video) { if (!running) { running = true; pump(video); } },
    /** Stop the pump (keeps the detector for a later restart). */
    stop() { running = false; },
    /** Latest normalized tracked poses (cached, ≤1 pump-interval stale). */
    latest: () => latest,
    /** performance.now() when latest() was produced. */
    latestTime: () => latestT,
    /** Last single-pass inference cost (ms). */
    lastCostMs: () => lastMs,
    /** Source video dimensions once known. */
    videoSize: () => ({ w: vw, h: vh }),
    /** One-shot estimate (test harnesses / benchmarks). */
    estimate,
    dispose() { running = false; detector.dispose?.(); }
  };
}
