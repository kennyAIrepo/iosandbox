"""Feature layout — the Python mirror of sdk/recognition/sign-landmarks.js.

THE PARITY CONTRACT (assets/sign.contract.json):
  51 points x (x, y) = 102 features per frame
    [0..20]   hand L (anatomical)
    [21..41]  hand R
    [42..50]  pose subset [nose, shoulderL, shoulderR, elbowL, elbowR,
                           wristL, wristR, hipL, hipR] = [0,11,12,13,14,15,16,23,24]
  origin  = mid-shoulder (per frame, never smoothed)
  scale   = torso length (mid-shoulder to mid-hip), EMA alpha 0.2;
            fallback shoulderWidth * 1.35 when hips are missing
  x is aspect-corrected then divided by scale; y divided by scale.

SERVE-SPACE MIRRORING: the browser tracker emits selfie-MIRRORED coords;
Kaggle/holistic extractions are raw camera. We convert training data INTO
serve space here:  x_feat = -(x_raw - ox) * aspect / scale.
Anatomical hand labels do not swap under mirroring (tracking.js un-flips
its labels; holistic's left_hand/right_hand are already anatomical) —
only the x sign changes. Mirror AUGMENTATION (train.py) negates x and
swaps the two hand blocks, exactly matching a left-handed signer.

Any edit here must be mirrored in sign-landmarks.js and covered by
tests/sign-smoke.mjs. Distribution shift is silent — parity is doctrine.
"""
import numpy as np

SIGN_POSE_IDX = [0, 11, 12, 13, 14, 15, 16, 23, 24]
N_HAND = 21
N_POSE = len(SIGN_POSE_IDX)
N_POINTS = N_HAND * 2 + N_POSE          # 51
FEATURE_DIM = N_POINTS * 2              # 102
HAND_L_OFF, HAND_R_OFF, POSE_OFF = 0, N_HAND, N_HAND * 2

WINDOW_T = 64
RATE_HZ = 15
SHOULDER_TO_TORSO = 1.35
SCALE_EMA = 0.2
# portrait phone capture (PopSign / asl-signs source videos); serve-side
# corrects with the live videoW/videoH, so both end up isotropic
DEFAULT_ASPECT = 0.75


def featurize_sequence(hand_l, hand_r, pose, aspect=DEFAULT_ASPECT):
    """(T,21,2) L hand, (T,21,2) R hand, (T,33,2+) pose  →  (T,102) float32.

    NaN in = NaN out (window assembly zeros them, like sign-buffer.js).
    Inputs are raw-camera normalized coords; output is serve-space
    (mirrored, origin-centred, torso-scaled) features.
    """
    T = pose.shape[0]
    out = np.full((T, FEATURE_DIM), np.nan, dtype=np.float32)
    scale_ema = 0.0

    for t in range(T):
        s_l, s_r = pose[t, 11, :2], pose[t, 12, :2]
        if np.isnan(s_l).any() or np.isnan(s_r).any():
            continue                                    # no body → all-NaN frame
        ox, oy = (s_l + s_r) / 2.0
        shoulder_w = np.hypot((s_l[0] - s_r[0]) * aspect, s_l[1] - s_r[1])
        h_l, h_r = pose[t, 23, :2], pose[t, 24, :2]
        if not (np.isnan(h_l).any() or np.isnan(h_r).any()):
            hx, hy = (h_l + h_r) / 2.0
            scale = np.hypot((ox - hx) * aspect, oy - hy)
        else:
            scale = shoulder_w * SHOULDER_TO_TORSO
        if scale > 1e-4:
            scale_ema = scale if scale_ema == 0.0 else scale_ema + SCALE_EMA * (scale - scale_ema)
        if scale_ema < 1e-4:
            continue

        def put(pt_idx, xy):
            # raw→serve mirroring: negate the origin-relative, aspect-corrected x
            out[t, pt_idx * 2] = -((xy[..., 0] - ox) * aspect) / scale_ema
            out[t, pt_idx * 2 + 1] = (xy[..., 1] - oy) / scale_ema

        for i in range(N_HAND):
            put(HAND_L_OFF + i, hand_l[t, i])
            put(HAND_R_OFF + i, hand_r[t, i])
        for k, pi in enumerate(SIGN_POSE_IDX):
            put(POSE_OFF + k, pose[t, pi, :2])
    return out


def to_window(feats, src_fps=30.0, rate_hz=RATE_HZ, T=WINDOW_T):
    """(T_src,102) at src_fps → fixed (T,102) float32 + true length.

    Decimate to rate_hz; longer than T → uniform resample down to exactly T
    (length=T); shorter → zero-pad at the end (the sign-buffer.js
    convention: NaN→0, pad→0, no mask — the model trains on this layout).
    """
    step = src_fps / rate_hz
    idx = np.arange(0, feats.shape[0], step).astype(int)
    idx = idx[idx < feats.shape[0]]
    f = feats[idx]
    if f.shape[0] > T:
        pick = np.linspace(0, f.shape[0] - 1, T).astype(int)
        f = f[pick]
    length = f.shape[0]
    win = np.zeros((T, FEATURE_DIM), dtype=np.float32)
    win[:length] = np.nan_to_num(f, nan=0.0)
    return win, length
