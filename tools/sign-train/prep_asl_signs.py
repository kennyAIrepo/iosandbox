"""asl-signs parquet → training shards in the serve-space feature layout.

  python prep_asl_signs.py --data /data/asl-signs --out /data/sign-shards

Input:  train.csv (path, participant_id, sequence_id, sign) +
        train_landmark_files/<participant>/<sequence>.parquet
        (543 landmarks/frame: face 468, left_hand 21, pose 33, right_hand 21;
        NaN when undetected — the legacy-holistic Kaggle extraction)
Output: shard_XXX.npz with
        X  float16 [N, 64, 102]   serve-space windows (features.py)
        L  uint8   [N]            true lengths before zero-pad
        y  int16   [N]            sign index (sign_to_prediction_index_map.json)
        g  int32   [N]            participant id — signer-disjoint splits ONLY
        src str    [N]            provenance tag (internal: distribution-shift
                                  debugging per source; not user-facing)
"""
import argparse, json
from pathlib import Path
import numpy as np
import pandas as pd

from features import featurize_sequence, to_window, FEATURE_DIM, WINDOW_T

SHARD = 4096


def load_sequence(pq_path):
    df = pd.read_parquet(pq_path, columns=["frame", "type", "landmark_index", "x", "y"])
    frames = np.sort(df["frame"].unique())
    fmap = {f: i for i, f in enumerate(frames)}
    T = len(frames)
    hand_l = np.full((T, 21, 2), np.nan, dtype=np.float32)
    hand_r = np.full((T, 21, 2), np.nan, dtype=np.float32)
    pose = np.full((T, 33, 2), np.nan, dtype=np.float32)
    buckets = {"left_hand": hand_l, "right_hand": hand_r, "pose": pose}
    for typ, arr in buckets.items():
        part = df[df["type"] == typ]
        t_idx = part["frame"].map(fmap).to_numpy()
        arr[t_idx, part["landmark_index"].to_numpy()] = part[["x", "y"]].to_numpy()
    return hand_l, hand_r, pose


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--data", required=True, help="asl-signs competition root")
    ap.add_argument("--out", required=True)
    ap.add_argument("--aspect", type=float, default=0.75)
    ap.add_argument("--src-fps", type=float, default=30.0)
    ap.add_argument("--limit", type=int, default=0, help="debug: first N sequences")
    args = ap.parse_args()

    root, out = Path(args.data), Path(args.out)
    out.mkdir(parents=True, exist_ok=True)
    sign_map = json.loads((root / "sign_to_prediction_index_map.json").read_text())
    meta = pd.read_csv(root / "train.csv")
    if args.limit:
        meta = meta.head(args.limit)

    labels = [None] * len(sign_map)
    for s, i in sign_map.items():
        labels[i] = s
    (out / "labels.json").write_text(json.dumps(labels))

    X, L, y, g = [], [], [], []
    shard_n, done, skipped = 0, 0, 0

    def flush():
        nonlocal X, L, y, g, shard_n
        if not X:
            return
        np.savez_compressed(
            out / f"shard_{shard_n:03d}.npz",
            X=np.stack(X).astype(np.float16), L=np.array(L, np.uint8),
            y=np.array(y, np.int16), g=np.array(g, np.int32),
            src=np.array(["asl-signs"] * len(X)))
        shard_n += 1
        X, L, y, g = [], [], [], []

    for row in meta.itertuples():
        try:
            hl, hr, po = load_sequence(root / row.path)
            feats = featurize_sequence(hl, hr, po, aspect=args.aspect)
            win, length = to_window(feats, src_fps=args.src_fps)
            if length < 2 or not np.any(win):
                skipped += 1
                continue
            X.append(win); L.append(length)
            y.append(sign_map[row.sign]); g.append(row.participant_id)
            done += 1
            if len(X) >= SHARD:
                flush()
            if done % 2000 == 0:
                print(f"  {done} sequences ({skipped} skipped)")
        except Exception as e:
            skipped += 1
            print(f"  skip {row.path}: {e}")
    flush()
    print(f"done: {done} windows in {shard_n} shards, {skipped} skipped → {out}")


if __name__ == "__main__":
    main()
