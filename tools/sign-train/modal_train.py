"""hopeos-sign — Modal training lane (app `hopeos-sign`, volume `sign-data`).

Runs the whole M1/M2 data+train pipeline in the cloud (the b3iq node is
driver-blocked and sits on 11 Mbps; Modal downloads 42.8 GB in minutes):

  py -m modal run tools/sign-train/modal_train.py::download_citizen   # ~30 min
  py -m modal run tools/sign-train/modal_train.py::extract            # CPU fan-out
  py -m modal run tools/sign-train/modal_train.py::make_shards
  py -m modal run tools/sign-train/modal_train.py::train              # L40S
  py -m modal volume get sign-data artifacts/signnet.onnx
  py -m modal volume get sign-data artifacts/labels.json

Then: signlab.html?model=<hosted>/signnet.onnx&labels=<hosted>/labels.json

PARITY DOCTRINE: extraction uses mediapipe==0.10.18 (the pinned browser
version) with the EXACT .task model files tracking.js loads — hand
float16/1 + pose_full float16/1 — so train and serve landmark
distributions match by construction. features.py (mounted) does the
serve-space normalization; test_parity.py guards it against the JS side.

Data source: ASL Citizen (Microsoft Download Center, direct no-auth URL),
2,731 glosses, 83k videos, official signer-disjoint splits. A Kaggle
asl-signs path can be added once a `kaggle-api` Modal secret exists.
"""
import sys
from pathlib import Path

import modal

app = modal.App("hopeos-sign")
vol = modal.Volume.from_name("sign-data", create_if_missing=True)

CITIZEN_URL = "https://download.microsoft.com/download/b/8/8/b88c0bae-e6c1-43e1-8726-98cf5af36ca4/ASL_Citizen.zip"
# the SAME model assets sdk/core/tracking.js pins (never bump one side alone)
HAND_TASK = "https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task"
POSE_TASK = "https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_full/float16/1/pose_landmarker_full.task"

HERE = Path(__file__).parent
RATE_HZ = 15

dl_image = modal.Image.debian_slim(python_version="3.11").apt_install("curl", "unzip", "aria2")

extract_image = (
    modal.Image.debian_slim(python_version="3.11")
    .apt_install("libgl1", "libglib2.0-0", "curl")
    .pip_install("mediapipe==0.10.18", "opencv-python-headless", "numpy")
    .run_commands(
        "mkdir -p /models"
        f" && curl -sL -o /models/hand.task {HAND_TASK}"
        f" && curl -sL -o /models/pose.task {POSE_TASK}"
    )
    .add_local_dir(HERE, "/root/signtrain")
)

train_image = (
    modal.Image.debian_slim(python_version="3.11")
    .pip_install("torch", "numpy", "onnx", "onnxruntime", "onnxscript")
    .add_local_dir(HERE, "/root/signtrain")
)


# ── stage 1: dataset onto the volume ──────────────────────────────────────
# aria2c, not curl: the single-stream curl attempt got its long-held
# throttled connection reset by the CDN partway through (self-healed via
# -C/resume, but repeatedly). Splitting into N parallel segments (a) goes
# faster against a per-connection throttle and (b) each segment is short-
# lived enough to dodge the reset; -c/--continue resumes the SAME partial
# file (including one a plain curl -C - left behind) instead of restarting.
@app.function(image=dl_image, volumes={"/vol": vol}, timeout=6 * 3600)
def download_citizen(connections: int = 16):
    import subprocess
    vol.reload()   # see the partial file curl already wrote, if any
    subprocess.run([
        "aria2c", "-c", "-x", str(connections), "-s", str(connections), "-k", "1M",
        "--retry-wait=5", "--max-tries=0", "--timeout=60", "--connect-timeout=30",
        "-d", "/vol", "-o", "ASL_Citizen.zip", CITIZEN_URL
    ], check=True)
    vol.commit()
    zp = "/vol/ASL_Citizen.zip"
    subprocess.run(["unzip", "-n", "-q", zp, "-d", "/vol/citizen"], check=True)
    vol.commit()
    import os
    n = sum(len(fs) for _, _, fs in os.walk("/vol/citizen"))
    print(f"downloaded + unzipped: {n} files")
    return n


# ── stage 2: video → serve-space feature sequences (CPU fan-out) ──────────
@app.function(image=extract_image, volumes={"/vol": vol}, timeout=3600, cpu=2)
def extract_batch(names: list[str]) -> int:
    import cv2
    import numpy as np
    sys.path.insert(0, "/root/signtrain")
    from features import featurize_sequence
    from mediapipe.tasks import python as mp_python
    from mediapipe.tasks.python import vision
    import mediapipe as mp

    out_dir = Path("/vol/feats")
    out_dir.mkdir(exist_ok=True)

    def landmarkers():
        hand = vision.HandLandmarker.create_from_options(vision.HandLandmarkerOptions(
            base_options=mp_python.BaseOptions(model_asset_path="/models/hand.task"),
            running_mode=vision.RunningMode.VIDEO, num_hands=2))
        pose = vision.PoseLandmarker.create_from_options(vision.PoseLandmarkerOptions(
            base_options=mp_python.BaseOptions(model_asset_path="/models/pose.task"),
            running_mode=vision.RunningMode.VIDEO))
        return hand, pose

    # One bad video (corrupt frame, transient decode/I/O glitch under heavy
    # concurrent volume access) must never cost the other ~79 videos in this
    # batch — an earlier unguarded version silently dropped whole batches
    # this way (502/83399 videos went missing despite decoding fine on
    # direct retest — see diagnose_missing). Isolate per-video, always
    # release resources, keep going.
    done = 0
    for name in names:
        dst = out_dir / (Path(name).stem + ".npz")
        if dst.exists():
            done += 1
            continue
        cap = None
        hand = pose = None
        try:
            src = Path("/vol/citizen") / name
            cap = cv2.VideoCapture(str(src))
            if not cap.isOpened():
                print(f"unreadable: {name}")
                continue
            fps = cap.get(cv2.CAP_PROP_FPS) or 30.0
            step = max(1, round(fps / RATE_HZ))
            w = cap.get(cv2.CAP_PROP_FRAME_WIDTH) or 4
            h = cap.get(cv2.CAP_PROP_FRAME_HEIGHT) or 3
            hand, pose = landmarkers()          # fresh per video: VIDEO mode timestamps
            HL, HR, PO = [], [], []
            i = 0
            while True:
                ok, frame = cap.read()
                if not ok:
                    break
                if i % step:
                    i += 1
                    continue
                ts = int(i / fps * 1000)
                img = mp.Image(image_format=mp.ImageFormat.SRGB,
                               data=cv2.cvtColor(frame, cv2.COLOR_BGR2RGB))
                hr = hand.detect_for_video(img, ts)
                pr = pose.detect_for_video(img, ts)
                hl = np.full((21, 2), np.nan, np.float32)
                hrr = np.full((21, 2), np.nan, np.float32)
                # raw (non-selfie) video: category_name IS the anatomical hand
                # (tracking.js flips labels only because it mirrors selfie input);
                # chirality stays unverified per the standing rule — the mirror
                # augmentation in training absorbs residual label noise.
                for lm, hd in zip(hr.hand_landmarks, hr.handedness):
                    tgt = hl if hd[0].category_name == "Left" else hrr
                    for j, p in enumerate(lm):
                        tgt[j] = (p.x, p.y)
                po = np.full((33, 2), np.nan, np.float32)
                if pr.pose_landmarks:
                    for j, p in enumerate(pr.pose_landmarks[0]):
                        if (p.visibility or 1.0) >= 0.5:      # JS minVis gate
                            po[j] = (p.x, p.y)
                HL.append(hl); HR.append(hrr); PO.append(po)
                i += 1
            if len(PO) < 2:
                continue
            feats = featurize_sequence(np.stack(HL), np.stack(HR), np.stack(PO),
                                       aspect=float(w) / float(h))
            np.savez_compressed(dst, f=feats.astype(np.float16), rate=RATE_HZ)
            done += 1
        except Exception as e:
            print(f"FAILED {name}: {e}")
        finally:
            if cap is not None:
                cap.release()
            if hand is not None:
                hand.close()
            if pose is not None:
                pose.close()
    vol.commit()
    return done


@app.function(image=dl_image, volumes={"/vol": vol}, timeout=24 * 3600)
def extract(batch_size: int = 80):
    """Fan the whole video set across extract_batch containers.

    batch_size sets the fan-out width: 83k videos / 80 ≈ 1000+ batches —
    Modal runs as many concurrently as the workspace cap allows and queues
    the rest, so wall-clock approaches single-batch time (~5-10 min) at no
    extra cost (same total CPU-hours either way). extract_batch skips
    already-written .npz files, so re-running after a partial failure only
    does the missing tail."""
    vol.reload()
    root = Path("/vol/citizen")
    vids = sorted(str(p.relative_to(root)) for p in root.rglob("*.mp4"))
    print(f"{len(vids)} videos")
    chunks = [vids[i:i + batch_size] for i in range(0, len(vids), batch_size)]
    total = sum(extract_batch.map(chunks))
    print(f"extracted {total}/{len(vids)}")
    return total


@app.function(image=dl_image, volumes={"/vol": vol}, timeout=3600)
def backfill(batch_size: int = 10):
    """Re-run extraction for exactly the videos still missing an .npz —
    idempotent, cheap, safe to call repeatedly until missing == 0. Small
    batch_size caps how much a single crash can cost (see extract_batch's
    per-video try/except fix — this is the belt-and-suspenders half)."""
    vol.reload()
    root = Path("/vol/citizen")
    feats = Path("/vol/feats")
    vids = sorted(str(p.relative_to(root)) for p in root.rglob("*.mp4"))
    have = {p.stem for p in feats.glob("*.npz")}
    missing = [v for v in vids if Path(v).stem not in have]
    print(f"{len(vids)} total, {len(have)} have, {len(missing)} missing → backfilling")
    if not missing:
        return 0
    chunks = [missing[i:i + batch_size] for i in range(0, len(missing), batch_size)]
    total = sum(extract_batch.map(chunks))
    print(f"backfilled {total}/{len(missing)}")
    return total
    return total


# ── diagnostic: why did a video not yield an .npz? ─────────────────────────
@app.function(image=extract_image, volumes={"/vol": vol}, timeout=600)
def diagnose_missing(n: int = 8):
    import cv2
    import numpy as np
    sys.path.insert(0, "/root/signtrain")
    from mediapipe.tasks import python as mp_python
    from mediapipe.tasks.python import vision
    import mediapipe as mp

    vol.reload()
    root = Path("/vol/citizen")
    feats = Path("/vol/feats")
    vids = sorted(str(p.relative_to(root)) for p in root.rglob("*.mp4"))
    have = {p.stem for p in feats.glob("*.npz")}
    missing = [v for v in vids if Path(v).stem not in have]
    print(f"{len(vids)} total, {len(have)} extracted, {len(missing)} missing")

    def landmarkers():
        hand = vision.HandLandmarker.create_from_options(vision.HandLandmarkerOptions(
            base_options=mp_python.BaseOptions(model_asset_path="/models/hand.task"),
            running_mode=vision.RunningMode.VIDEO, num_hands=2))
        pose = vision.PoseLandmarker.create_from_options(vision.PoseLandmarkerOptions(
            base_options=mp_python.BaseOptions(model_asset_path="/models/pose.task"),
            running_mode=vision.RunningMode.VIDEO))
        return hand, pose

    import random
    random.seed(46)
    sample = random.sample(missing, min(n, len(missing)))
    for name in sample:
        src = root / name
        cap = cv2.VideoCapture(str(src))
        if not cap.isOpened():
            print(f"{name}: cv2 cannot open")
            continue
        fps = cap.get(cv2.CAP_PROP_FPS) or 30.0
        w = cap.get(cv2.CAP_PROP_FRAME_WIDTH)
        h = cap.get(cv2.CAP_PROP_FRAME_HEIGHT)
        nframes = cap.get(cv2.CAP_PROP_FRAME_COUNT)
        pose_hits = 0
        hand_hits = 0
        checked = 0
        i = 0
        step = max(1, round(fps / RATE_HZ))
        hand, pose = landmarkers()          # fresh per video — same rule as extract_batch
        try:
            while checked < 40:
                ok, frame = cap.read()
                if not ok:
                    break
                if i % step:
                    i += 1
                    continue
                ts = int(i / fps * 1000)
                img = mp.Image(image_format=mp.ImageFormat.SRGB,
                               data=cv2.cvtColor(frame, cv2.COLOR_BGR2RGB))
                pr = pose.detect_for_video(img, ts)
                hr = hand.detect_for_video(img, ts)
                if pr.pose_landmarks:
                    pose_hits += 1
                if hr.hand_landmarks:
                    hand_hits += 1
                checked += 1
                i += 1
        except Exception as e:
            print(f"{name}: {w:.0f}x{h:.0f} fps={fps:.1f} frames={nframes:.0f} "
                  f"EXCEPTION after {checked} frames: {e}")
            cap.release(); hand.close(); pose.close()
            continue
        cap.release()
        hand.close(); pose.close()
        print(f"{name}: {w:.0f}x{h:.0f} fps={fps:.1f} frames={nframes:.0f} "
              f"checked={checked} pose_hits={pose_hits} hand_hits={hand_hits}")


# ── stage 3: sequences + official splits → training shards ────────────────
# Fanned out like extraction — a single container serially loading and
# windowing all 83k .npz feature files blew through Modal's 1hr function
# timeout and got cancelled with nothing committed (small-file I/O at that
# volume adds up fast with zero parallelism; same shape of mistake as the
# original unguarded extract_batch, different stage). Each container packs
# one shard from one chunk of rows and writes it independently.
SHARD_ROWS = 4096

@app.function(image=train_image, volumes={"/vol": vol}, timeout=3600, cpu=2)
def pack_shard(rows: list, gmap: dict, shard_idx: int) -> tuple:
    import os
    import numpy as np
    sys.path.insert(0, "/root/signtrain")
    from features import to_window

    out = Path("/vol/shards")
    dst = out / f"shard_{shard_idx:03d}.npz"
    tmp = out / f".tmp_{shard_idx:03d}_{os.getpid()}.npz"
    if dst.exists():
        return (0, 0)                      # idempotent: safe to re-run after a partial failure
    X, L, y, g, sp, miss = [], [], [], [], [], 0
    for stem, gloss, pid, split in rows:
        f = Path("/vol/feats") / (stem + ".npz")
        if not f.exists():
            miss += 1
            continue
        try:
            seq = np.load(f)["f"].astype(np.float32)
        except Exception:
            miss += 1
            continue
        win, length = to_window(seq, src_fps=RATE_HZ)       # already 15 Hz
        if length < 2 or not np.any(win):
            miss += 1
            continue
        X.append(win); L.append(length); y.append(gmap[gloss]); g.append(pid); sp.append(split)
    if X:
        # write to a temp name, THEN atomically rename onto the real filename —
        # a container killed mid-write (e.g. `modal app stop` on a straggler)
        # can only ever leave behind an orphaned .tmp_* file, never a corrupt
        # shard_NNN.npz that the exists()-only idempotency check above would
        # wrongly trust as complete on the next run. os.replace is atomic on
        # the same filesystem, which the volume mount guarantees here.
        np.savez_compressed(tmp, X=np.stack(X).astype(np.float16), L=np.array(L, np.uint8),
                            y=np.array(y, np.int32), g=np.array(g),
                            split=np.array(sp), src=np.array(["asl-citizen"] * len(X)))
        os.replace(tmp, dst)
        vol.commit()
    return (len(X), miss)


def _labeled_rows():
    """(video_stem, gloss, participant, split) for every row across the
    official split CSVs — deterministic order, shared by make_shards and
    backfill_shards so chunk position always maps to the same rows."""
    import csv
    rows = []
    for split_csv in Path("/vol/citizen").rglob("*.csv"):
        split = split_csv.stem.lower()
        if split not in ("train", "val", "test"):
            continue
        with open(split_csv, newline="", encoding="utf-8-sig") as fh:
            for r in csv.DictReader(fh):
                cols = {k.strip().lower().replace(" ", "_"): v for k, v in r.items()}
                vf = next((v for k, v in cols.items() if "video" in k), None)
                gl = next((v for k, v in cols.items() if "gloss" in k), None)
                pid = next((v for k, v in cols.items() if "participant" in k), "0")
                if vf and gl:
                    rows.append((Path(vf).stem, gl.strip().upper(), str(pid), split))
    return rows


@app.function(image=dl_image, volumes={"/vol": vol}, timeout=1800)
def make_shards():
    import json
    vol.reload()
    rows = _labeled_rows()
    glosses = sorted({g for _, g, _, _ in rows})
    gmap = {g: i for i, g in enumerate(glosses)}
    out = Path("/vol/shards"); out.mkdir(exist_ok=True)
    (out / "labels.json").write_text(json.dumps(glosses))
    print(f"{len(rows)} labeled videos, {len(glosses)} glosses")

    # NOTE: deliberately NOT shuffled — chunk position must stay stable
    # across re-runs so pack_shard's idempotent "skip if shard file already
    # exists" check keeps matching the same rows to the same shard index.
    # Shuffling would silently drop whatever rows land in a position whose
    # shard already exists from a prior partial run. Only shuffle safely on
    # a from-scratch rebuild (empty /vol/shards).
    chunks = [rows[i:i + SHARD_ROWS] for i in range(0, len(rows), SHARD_ROWS)]
    results = list(pack_shard.map(chunks, [gmap] * len(chunks), range(len(chunks))))
    total = sum(n for n, _ in results)
    miss = sum(m for _, m in results)
    print(f"shards: {len(chunks)} · {total} windows · {miss} missing/empty")
    return len(chunks)


@app.function(image=dl_image, volumes={"/vol": vol}, timeout=1800)
def backfill_shards(sub_size: int = 512):
    """Re-run ONLY chunks still missing an .npz, split into much smaller
    sub-chunks (default 8x finer) so a straggler-heavy chunk that blew a
    timeout gets fanned wide instead of retried as one big slow unit.
    Reuses pack_shard unchanged — sub-chunks get fresh non-colliding
    indices (1000+) so they never collide with the original 0..N range."""
    import json
    vol.reload()
    rows = _labeled_rows()
    glosses = sorted({g for _, g, _, _ in rows})
    gmap = {g: i for i, g in enumerate(glosses)}
    out = Path("/vol/shards")

    chunks = [rows[i:i + SHARD_ROWS] for i in range(0, len(rows), SHARD_ROWS)]
    missing_idx = [i for i in range(len(chunks)) if not (out / f"shard_{i:03d}.npz").exists()]
    print(f"{len(chunks)} total chunks, {len(missing_idx)} missing: {missing_idx}")
    if not missing_idx:
        return 0

    sub_chunks, sub_ids = [], []
    for orig_idx in missing_idx:
        rows_i = chunks[orig_idx]
        for j in range(0, len(rows_i), sub_size):
            sub_chunks.append(rows_i[j:j + sub_size])
            sub_ids.append(1000 + orig_idx * 100 + j // sub_size)
    print(f"split into {len(sub_chunks)} sub-chunks of ≤{sub_size} rows")
    results = list(pack_shard.map(sub_chunks, [gmap] * len(sub_chunks), sub_ids))
    total = sum(n for n, _ in results)
    print(f"backfilled {total} windows across {len(sub_chunks)} sub-shards")
    return total


# ── stage 4: train on L40S + export ONNX ──────────────────────────────────
@app.function(image=train_image, volumes={"/vol": vol}, gpu="L40S", timeout=12 * 3600)
def train(epochs: int = 40, bs: int = 512, lr: float = 3e-4):
    import json
    import numpy as np
    import torch
    import torch.nn.functional as F
    from torch.utils.data import DataLoader
    sys.path.insert(0, "/root/signtrain")
    from features import FEATURE_DIM, WINDOW_T
    from model import SignNet
    from train import SignDS

    vol.reload()
    Xs, Ls, ys, sps = [], [], [], []
    for f in sorted(Path("/vol/shards").glob("shard_*.npz")):
        z = np.load(f)
        Xs.append(z["X"]); Ls.append(z["L"]); ys.append(z["y"]); sps.append(z["split"])
    X = np.concatenate(Xs); L = np.concatenate(Ls)
    y = np.concatenate(ys); sp = np.concatenate(sps)
    n_classes = int(y.max()) + 1
    tr_m, va_m = sp == "train", sp == "val"        # official signer-disjoint splits
    print(f"{len(y)} windows · {n_classes} classes · train {tr_m.sum()} val {va_m.sum()}")

    tr = DataLoader(SignDS(X[tr_m], L[tr_m], y[tr_m], True), batch_size=bs,
                    shuffle=True, num_workers=8, pin_memory=True, drop_last=True)
    va = DataLoader(SignDS(X[va_m], L[va_m], y[va_m], False), batch_size=bs, num_workers=4)

    model = SignNet(n_classes).cuda()
    opt = torch.optim.AdamW(model.parameters(), lr=lr, weight_decay=0.05)
    sched = torch.optim.lr_scheduler.OneCycleLR(
        opt, max_lr=lr, total_steps=epochs * len(tr), pct_start=0.1)
    best, art = 0.0, Path("/vol/artifacts")
    art.mkdir(exist_ok=True)

    for ep in range(epochs):
        model.train()
        for xb, yb in tr:
            xb, yb = xb.cuda(non_blocking=True), yb.cuda(non_blocking=True)
            with torch.autocast("cuda", dtype=torch.bfloat16):
                loss = F.cross_entropy(model(xb), yb, label_smoothing=0.1)
            opt.zero_grad(set_to_none=True)
            loss.backward()
            opt.step(); sched.step()
        model.eval()
        t1 = t5 = n = 0
        with torch.no_grad():
            for xb, yb in va:
                r = model(xb.cuda()).float().cpu().topk(5, dim=1).indices
                t1 += (r[:, 0] == yb).sum().item()
                t5 += (r == yb[:, None]).any(1).sum().item()
                n += len(yb)
        a1, a5 = t1 / n, t5 / n
        if a1 > best:
            best = a1
            torch.save({"model": model.state_dict(), "n_classes": n_classes,
                        "top1": a1, "top5": a5}, art / "signnet.pt")
        print(f"ep {ep + 1:3d} loss {loss.item():.3f} val top1 {a1:.3f} top5 {a5:.3f}"
              f"{' ← saved' if a1 == best else ''}")
        vol.commit()

    # ── export best → ONNX (opset 17, fixed shape) + parity ──
    import onnxruntime as ort
    ck = torch.load(art / "signnet.pt", map_location="cpu", weights_only=True)
    m = SignNet(ck["n_classes"]).eval()
    m.load_state_dict(ck["model"])
    torch.onnx.export(m, torch.randn(1, WINDOW_T, FEATURE_DIM), str(art / "signnet.onnx"),
                      input_names=["x"], output_names=["logits"], opset_version=17)
    # The newer torch.onnx exporter defaults to splitting large weight
    # tensors into a companion signnet.onnx.data file (standard for big
    # models, avoids protobuf's 2GB cap) — wrong shape for us: the browser
    # client does one fetch() and expects one self-contained file. Collapse
    # back to a single embedded-weights file before anything downloads it.
    import onnx
    proto = onnx.load(str(art / "signnet.onnx"), load_external_data=True)
    onnx.save_model(proto, str(art / "signnet.onnx"), save_as_external_data=False)
    (art / "signnet.onnx.data").unlink(missing_ok=True)
    sess = ort.InferenceSession(str(art / "signnet.onnx"), providers=["CPUExecutionProvider"])
    x = torch.randn(1, WINDOW_T, FEATURE_DIM)
    with torch.no_grad():
        err = float(np.abs(m(x).numpy() - sess.run(["logits"], {"x": x.numpy()})[0]).max())
    assert err < 1e-3, f"ONNX parity failed: {err}"
    (art / "metrics.json").write_text(json.dumps(
        {"top1": ck["top1"], "top5": ck["top5"], "classes": ck["n_classes"],
         "onnx_parity_err": err}))
    import shutil
    shutil.copy("/vol/shards/labels.json", art / "labels.json")
    vol.commit()
    print(f"best val top1 {ck['top1']:.3f} top5 {ck['top5']:.3f} · onnx parity {err:.2e}"
          f" → /vol/artifacts/")
    return {"top1": ck["top1"], "top5": ck["top5"]}


@app.function(image=train_image, volumes={"/vol": vol}, timeout=600)
def export_only():
    """Export the already-trained checkpoint to ONNX — no GPU, no retraining.
    Exists because the export step is a separate failure surface from
    training itself (e.g. a missing onnx-side package): reruns should
    reuse the finished /vol/artifacts/signnet.pt, not redo 40 epochs."""
    import json, shutil
    import numpy as np
    import torch
    import onnxruntime as ort
    sys.path.insert(0, "/root/signtrain")
    from features import FEATURE_DIM, WINDOW_T
    from model import SignNet

    vol.reload()
    art = Path("/vol/artifacts")
    ck = torch.load(art / "signnet.pt", map_location="cpu", weights_only=True)
    m = SignNet(ck["n_classes"]).eval()
    m.load_state_dict(ck["model"])
    torch.onnx.export(m, torch.randn(1, WINDOW_T, FEATURE_DIM), str(art / "signnet.onnx"),
                      input_names=["x"], output_names=["logits"], opset_version=17)
    # The newer torch.onnx exporter defaults to splitting large weight
    # tensors into a companion signnet.onnx.data file (standard for big
    # models, avoids protobuf's 2GB cap) — wrong shape for us: the browser
    # client does one fetch() and expects one self-contained file. Collapse
    # back to a single embedded-weights file before anything downloads it.
    import onnx
    proto = onnx.load(str(art / "signnet.onnx"), load_external_data=True)
    onnx.save_model(proto, str(art / "signnet.onnx"), save_as_external_data=False)
    (art / "signnet.onnx.data").unlink(missing_ok=True)
    sess = ort.InferenceSession(str(art / "signnet.onnx"), providers=["CPUExecutionProvider"])
    x = torch.randn(1, WINDOW_T, FEATURE_DIM)
    with torch.no_grad():
        err = float(np.abs(m(x).numpy() - sess.run(["logits"], {"x": x.numpy()})[0]).max())
    assert err < 1e-3, f"ONNX parity failed: {err}"
    (art / "metrics.json").write_text(json.dumps(
        {"top1": ck["top1"], "top5": ck["top5"], "classes": ck["n_classes"],
         "onnx_parity_err": err}))
    shutil.copy("/vol/shards/labels.json", art / "labels.json")
    vol.commit()
    print(f"best val top1 {ck['top1']:.3f} top5 {ck['top5']:.3f} · onnx parity {err:.2e}"
          f" → /vol/artifacts/")
    return {"top1": ck["top1"], "top5": ck["top5"]}
