/**
 * hopeOS SDK — Tracking Module
 * Camera access + MediaPipe hand/pose landmark detection.
 * Returns raw normalized landmark data — no Three.js dependency.
 *
 * Game integration:
 *   const tracker = await initTracking(videoEl, { numHands: 2 });
 *   const frame = tracker.detect();  // { hands, handedness, pose }
 *
 * Multi-person integration (sdk/core/multiplayer.js):
 *   The landmarker constructors below are exported as standalone factories
 *   (createHandLandmarker / createPoseLandmarker) so per-player pipelines can
 *   spin up their own instances that share ONE memoized vision fileset.
 */

const NOISE = 0.003;
const stH = [null, null];

function stabilize(raw, idx) {
  if (!stH[idx]) { stH[idx] = raw.map(p => ({ x: p.x, y: p.y, z: p.z })); return stH[idx]; }
  for (let j = 0; j < raw.length; j++) {
    if (Math.hypot(raw[j].x - stH[idx][j].x, raw[j].y - stH[idx][j].y) > NOISE) {
      stH[idx][j] = { x: raw[j].x, y: raw[j].y, z: raw[j].z };
    }
  }
  return stH[idx];
}

// ── Shared vision runtime (memoized) ──────────────────────────────────────
// One dynamic import + one FilesetResolver for the whole page, reused by
// initTracking AND every per-player pipeline. Loading the WASM twice would
// waste memory and warmup; these promises guarantee a single instance.
const VISION_URL = 'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.18/+esm';
const WASM_URL   = 'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.18/wasm';
const HAND_MODEL = 'https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task';
const POSE_MODEL = 'https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_lite/float16/1/pose_landmarker_lite.task';
const FACE_MODEL = 'https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task';

let _visionP = null;
let _filesetP = null;

/** The @mediapipe/tasks-vision ESM module (memoized). */
export function getVision() {
  if (!_visionP) _visionP = import(VISION_URL);
  return _visionP;
}

/** The shared FilesetResolver (memoized) — one WASM fileset per page. */
export async function getFileset() {
  if (!_filesetP) {
    const V = await getVision();
    _filesetP = V.FilesetResolver.forVisionTasks(WASM_URL);
  }
  return _filesetP;
}

/** Create a HandLandmarker (GPU, VIDEO). Same config initTracking has always used. */
export async function createHandLandmarker(opts = {}) {
  const V = await getVision();
  const fs = await getFileset();
  return V.HandLandmarker.createFromOptions(fs, {
    baseOptions: { modelAssetPath: HAND_MODEL, delegate: 'GPU' },
    runningMode: opts.runningMode || 'VIDEO',
    numHands: opts.numHands || 2,
    minHandDetectionConfidence: opts.handConfidence || 0.5,
    minTrackingConfidence: opts.trackingConfidence || 0.5
  });
}

/** Create a PoseLandmarker (GPU, VIDEO). numPoses defaults to 1 (per-crop use). */
export async function createPoseLandmarker(opts = {}) {
  const V = await getVision();
  const fs = await getFileset();
  return V.PoseLandmarker.createFromOptions(fs, {
    baseOptions: { modelAssetPath: opts.model || POSE_MODEL, delegate: 'GPU' },
    runningMode: opts.runningMode || 'VIDEO',
    numPoses: opts.numPoses || 1,
    minPoseDetectionConfidence: opts.poseConfidence || 0.5,
    minTrackingConfidence: opts.trackingConfidence || 0.5
  });
}

/** Create a FaceLandmarker (GPU, VIDEO, 478 pts + 52 blendshapes). */
export async function createFaceLandmarker(opts = {}) {
  const V = await getVision();
  const fs = await getFileset();
  return V.FaceLandmarker.createFromOptions(fs, {
    baseOptions: { modelAssetPath: FACE_MODEL, delegate: 'GPU' },
    runningMode: opts.runningMode || 'VIDEO',
    numFaces: opts.numFaces || 1,
    minFaceDetectionConfidence: 0.5,
    minTrackingConfidence: 0.5,
    outputFaceBlendshapes: true,
    outputFacialTransformationMatrixes: false
  });
}

export async function initTracking(videoEl, opts = {}) {
  const handLandmarker = await createHandLandmarker({
    numHands: opts.numHands || 2,
    handConfidence: opts.handConfidence,
    trackingConfidence: opts.trackingConfidence
  });

  const poseLandmarker = await createPoseLandmarker({ numPoses: 1 });

  // Face Landmarker (optional — 478 landmarks + 52 blendshapes)
  let faceLandmarker = null;
  if (opts.enableFace !== false) {
    try {
      faceLandmarker = await createFaceLandmarker({ numFaces: 1 });
      console.log('[tracking] FaceLandmarker loaded (478 pts + 52 blendshapes)');
    } catch (e) {
      console.warn('[tracking] FaceLandmarker not available:', e);
    }
  }

  let lastDetectTime = -1;
  let frameCount = 0;
  // opts.raw = true → skip the legacy deadband stabilizer and return raw
  // mirrored landmarks (for consumers doing their own One-Euro filtering —
  // the deadband quantizes slow motion into stair-steps AND adds lag).
  const useRaw = !!opts.raw;

  /** Detect hands + pose + face from current video frame. Call once per rAF. */
  function detect() {
    const result = { hands: null, handsWorld: null, handedness: [], handCount: 0, pose: null, poseWorld: null, face: null };
    if (videoEl.readyState < 2) return result;

    const now = performance.now();
    if (now === lastDetectTime) return result;
    lastDetectTime = now;
    frameCount++;

    // Hands (every frame)
    const hr = handLandmarker.detectForVideo(videoEl, now);
    if (hr.landmarks && hr.landmarks.length) {
      result.handCount = hr.landmarks.length;
      result.hands = [];
      result.handsWorld = [];
      result.handedness = [];
      for (let h = 0; h < result.handCount; h++) {
        // Mirror X for selfie camera
        const mirrored = hr.landmarks[h].map(p => ({ x: 1 - p.x, y: p.y, z: p.z }));
        result.hands.push(useRaw ? mirrored : stabilize(mirrored, h));
        // TRUE-3D pose (metres, origin at hand centre, camera-view axes) —
        // raw and UNmirrored: viewpoint retargeting (first/third person)
        // happens downstream in hand-views.js, never here.
        result.handsWorld.push(hr.worldLandmarks?.[h] || null);
        // MediaPipe labels are mirrored for selfie — flip
        const label = hr.handednesses?.[h]?.[0]?.categoryName === 'Left' ? 'Right' : 'Left';
        result.handedness.push(label);
      }
    }

    // Pose (every Nth frame for performance; body-mesh consumers want 2)
    if (frameCount % (opts.poseEvery || 4) === 0) {
      const pr = poseLandmarker.detectForVideo(videoEl, now);
      if (pr.landmarks && pr.landmarks.length > 0) {
        // v = per-landmark visibility (0..1) — partial-body inference gates
        // on it (out-of-frame legs, occluded arms). Filters ignore it.
        result.pose = pr.landmarks[0].map(p => ({ x: 1 - p.x, y: p.y, z: p.z || 0, v: p.visibility ?? 1 }));
      }
      if (pr.worldLandmarks && pr.worldLandmarks.length > 0) {
        result.poseWorld = pr.worldLandmarks[0];
      }
    }

    // Face (every 3rd frame — 478 landmarks + 52 blendshapes)
    if (faceLandmarker && frameCount % 3 === 0) {
      const fr = faceLandmarker.detectForVideo(videoEl, now);
      if (fr.faceLandmarks && fr.faceLandmarks.length > 0) {
        result.face = {
          landmarks: fr.faceLandmarks[0],
          blendshapes: fr.faceBlendshapes?.[0] || null
        };
      }
    }

    return result;
  }

  return { detect, handLandmarker, poseLandmarker, faceLandmarker };
}

/** Start camera and attach to video elements.
 *  Uses ONE getUserMedia and clones the track for the background — a second
 *  getUserMedia call fails on devices with a single-camera lock (most phones). */
export async function initCamera(bgVideoEl, detectionVideoEl) {
  const stream = await navigator.mediaDevices.getUserMedia({
    video: { facingMode: 'user', width: { ideal: 1280 }, height: { ideal: 720 } }
  });

  // Detection uses the live stream directly
  detectionVideoEl.srcObject = stream;
  await detectionVideoEl.play();

  // Background mirror gets a clone of the same stream (no 2nd camera grab)
  let bgStream = null;
  if (bgVideoEl) {
    bgStream = stream.clone();
    bgVideoEl.srcObject = bgStream;
    bgVideoEl.play().catch(() => {});
  }
  // Return both streams so the camera can be fully released on toggle-off.
  return { stream, bgStream };
}
