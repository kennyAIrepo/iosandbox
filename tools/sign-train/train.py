"""Train SignNet on prepped shards, signer-disjoint validation.

  python train.py --shards /data/sign-shards --epochs 60 --bs 256

Augmentations run in feature space (serve-space windows), matching the
Kaggle-winner recipes: mirror (+ hand-block swap), rotate/scale/shift
about the origin, temporal stretch, coordinate noise, frame + hand
dropout. Validation is ALWAYS held-out signers (participant ids) —
unseen-signer generalization is the number that matters, never mix.
"""
import argparse, json, math
from pathlib import Path
import numpy as np
import torch
import torch.nn.functional as F
from torch.utils.data import Dataset, DataLoader

from features import FEATURE_DIM, WINDOW_T, HAND_L_OFF, HAND_R_OFF, N_HAND, POSE_OFF
from model import SignNet

XI = np.arange(0, FEATURE_DIM, 2)     # x feature columns
L_COLS = np.arange(HAND_L_OFF * 2, (HAND_L_OFF + N_HAND) * 2)
R_COLS = np.arange(HAND_R_OFF * 2, (HAND_R_OFF + N_HAND) * 2)
# pose left/right pairs inside SIGN_POSE_IDX order [nose,shL,shR,elL,elR,wrL,wrR,hiL,hiR]
POSE_SWAPS = [(1, 2), (3, 4), (5, 6), (7, 8)]


def load_shards(path):
    Xs, Ls, ys, gs = [], [], [], []
    for f in sorted(Path(path).glob("shard_*.npz")):
        z = np.load(f, allow_pickle=False)
        Xs.append(z["X"]); Ls.append(z["L"]); ys.append(z["y"]); gs.append(z["g"])
    return (np.concatenate(Xs), np.concatenate(Ls),
            np.concatenate(ys), np.concatenate(gs))


def augment(x, length, rng):
    x = x.copy()
    # mirror: negate x, swap hand blocks, swap pose L/R slots
    if rng.random() < 0.5:
        x[:, XI] *= -1
        x[:, L_COLS], x[:, R_COLS] = x[:, R_COLS].copy(), x[:, L_COLS].copy()
        for a, b in POSE_SWAPS:
            ia = (POSE_OFF + a) * 2; ib = (POSE_OFF + b) * 2
            x[:, ia:ia + 2], x[:, ib:ib + 2] = x[:, ib:ib + 2].copy(), x[:, ia:ia + 2].copy()
    # rotate / scale / shift about origin
    th = rng.uniform(-0.23, 0.23)                       # ±13°
    s = rng.uniform(0.9, 1.1)
    c0, s0 = math.cos(th) * s, math.sin(th) * s
    px, py = x[:, XI].copy(), x[:, XI + 1].copy()
    x[:, XI] = c0 * px - s0 * py + rng.uniform(-0.1, 0.1)
    x[:, XI + 1] = s0 * px + c0 * py + rng.uniform(-0.1, 0.1)
    # zeros are padding/missing — keep them zero, not shifted
    pad_mask = (px == 0) & (py == 0)
    x[:, XI][pad_mask] = 0.0
    x[:, XI + 1][pad_mask] = 0.0
    # temporal stretch: resample the valid span by 0.8–1.2
    if length > 4 and rng.random() < 0.7:
        new_len = int(np.clip(length * rng.uniform(0.8, 1.2), 4, WINDOW_T))
        pick = np.linspace(0, length - 1, new_len).astype(int)
        x[:new_len] = x[pick]
        x[new_len:] = 0.0
        length = new_len
    # coordinate noise + dropouts
    noise = rng.normal(0, 0.01, x.shape).astype(np.float32)
    noise[x == 0] = 0.0
    x += noise
    if rng.random() < 0.3:                              # frame dropout
        kill = rng.random(WINDOW_T) < 0.1
        x[kill] = 0.0
    if rng.random() < 0.05:                             # one-hand dropout
        x[:, L_COLS if rng.random() < 0.5 else R_COLS] = 0.0
    return x, length


class SignDS(Dataset):
    def __init__(self, X, L, y, train):
        self.X, self.L, self.y, self.train = X, L, y, train
        self.rng = np.random.default_rng()

    def __len__(self):
        return len(self.y)

    def __getitem__(self, i):
        x = self.X[i].astype(np.float32)
        if self.train:
            x, _ = augment(x, int(self.L[i]), self.rng)
        return torch.from_numpy(x), int(self.y[i])


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--shards", required=True)
    ap.add_argument("--epochs", type=int, default=60)
    ap.add_argument("--bs", type=int, default=256)
    ap.add_argument("--lr", type=float, default=3e-4)
    ap.add_argument("--val-signers", type=int, default=4)
    ap.add_argument("--out", default="signnet.pt")
    args = ap.parse_args()

    X, L, y, g = load_shards(args.shards)
    n_classes = int(y.max()) + 1
    signers = np.unique(g)
    rng = np.random.default_rng(46)
    val_g = set(rng.choice(signers, args.val_signers, replace=False).tolist())
    val_m = np.isin(g, list(val_g))
    print(f"{len(y)} windows · {n_classes} classes · {len(signers)} signers · "
          f"val signers {sorted(val_g)} ({val_m.sum()} windows)")

    dev = "cuda" if torch.cuda.is_available() else "cpu"
    tr = DataLoader(SignDS(X[~val_m], L[~val_m], y[~val_m], True), batch_size=args.bs,
                    shuffle=True, num_workers=4, pin_memory=True, drop_last=True)
    va = DataLoader(SignDS(X[val_m], L[val_m], y[val_m], False), batch_size=args.bs,
                    num_workers=2, pin_memory=True)

    model = SignNet(n_classes).to(dev)
    print(f"SignNet {sum(p.numel() for p in model.parameters())/1e6:.2f}M params on {dev}")
    opt = torch.optim.AdamW(model.parameters(), lr=args.lr, weight_decay=0.05)
    sched = torch.optim.lr_scheduler.OneCycleLR(
        opt, max_lr=args.lr, total_steps=args.epochs * len(tr), pct_start=0.1)
    best = 0.0

    for ep in range(args.epochs):
        model.train()
        for xb, yb in tr:
            xb, yb = xb.to(dev, non_blocking=True), yb.to(dev, non_blocking=True)
            with torch.autocast(dev, dtype=torch.bfloat16, enabled=dev == "cuda"):
                loss = F.cross_entropy(model(xb), yb, label_smoothing=0.1)
            opt.zero_grad(set_to_none=True)
            loss.backward()
            opt.step(); sched.step()

        model.eval()
        top1 = top5 = n = 0
        with torch.no_grad():
            for xb, yb in va:
                logits = model(xb.to(dev)).float().cpu()
                r = logits.topk(5, dim=1).indices
                top1 += (r[:, 0] == yb).sum().item()
                top5 += (r == yb[:, None]).any(1).sum().item()
                n += len(yb)
        a1, a5 = top1 / n, top5 / n
        flag = ""
        if a1 > best:
            best = a1
            torch.save({"model": model.state_dict(), "n_classes": n_classes,
                        "val_signers": sorted(val_g), "top1": a1, "top5": a5}, args.out)
            flag = " ← saved"
        print(f"ep {ep + 1:3d}  loss {loss.item():.3f}  val top1 {a1:.3f} top5 {a5:.3f}{flag}")

    print(f"best unseen-signer top1: {best:.3f} → {args.out}")


if __name__ == "__main__":
    main()
