# sign-train — M1/M2 training lane for the sign-dictation stack

Trains the temporal classifier that `sdk/recognition/` serves in-browser.
Research project: train on whatever data is available; keep the internal
`src` provenance tag in the shards (per-source distribution-shift debugging).

## The one rule

**`features.py` must stay bit-identical to `sdk/recognition/sign-landmarks.js`.**
After editing either:

```
node tools/sign-train/make_parity_fixture.mjs
python tools/sign-train/test_parity.py        # gate: max err < 1e-5
```

## Run on the 5090 node (b3iq)

> ⚠ As of 2026-08-13 the node has an NVML driver/library mismatch
> (unattended-upgrades bumped userspace to 595.84 under the old kernel
> module). The running sam3_serve keeps its GPU context but NEW GPU
> processes can't start — training is blocked until a coordinated
> reboot. Shared node: never reboot unilaterally.

```bash
ssh b3iq
python3 -m venv ~/sign-train-venv && . ~/sign-train-venv/bin/activate
# RTX 5090 is Blackwell (sm_120): needs torch >= 2.7 with cu128 wheels
pip install torch --index-url https://download.pytorch.org/whl/cu128
pip install numpy pandas pyarrow onnxruntime kaggle

# Kaggle token: put kaggle.json (from kaggle.com/settings) in ~/.kaggle/  (none there yet)
kaggle competitions download -c asl-signs -p /data && unzip -q /data/asl-signs.zip -d /data/asl-signs

python prep_asl_signs.py --data /data/asl-signs --out /data/sign-shards   # ~94k windows
python train.py --shards /data/sign-shards --epochs 60                    # unseen-signer top1 printed per epoch
python export_onnx.py --ckpt signnet.pt --labels /data/sign-shards/labels.json
```

Serve: host `signnet.onnx` + `labels.json` (`.onnx` is gitignored — use the
node's serve_files.py / CDN), then

```
signlab.html?model=<url>/signnet.onnx&labels=<url>/labels.json
```

## Files

| file | role |
|---|---|
| `features.py` | Python mirror of the serve featurizer + windowing (15 Hz, T=64, pad-zeros) |
| `prep_asl_signs.py` | Kaggle asl-signs parquet → `shard_*.npz` (X/L/y/signer/src) |
| `model.py` | SignNet: Linear → 3× depthwise-Conv1D → 4× Transformer → mean-pool (~3M params) |
| `train.py` | signer-disjoint val, winner-recipe augs (mirror+slot-swap, affine, stretch, dropouts) |
| `export_onnx.py` | opset 17, fixed [1,64,102], ORT parity check, labels.json |
| `make_parity_fixture.mjs` / `test_parity.py` | JS↔Python featurizer drift gate |

## Targets (blueprint gates)

- M1 sanity: seen-signer top1 well above 90% (winners hit ~0.89 LB with far bigger ensembles — we accept less for 3M params)
- M2 gate: **unseen-signer** top1 ≥ 0.80 / top5 ≥ 0.95 on 250 signs
- Next data: ASL Citizen (2,731 signs) + PopSign videos re-extracted with the
  pinned tasks-vision `.task` models (kills the legacy-holistic shift for good)
