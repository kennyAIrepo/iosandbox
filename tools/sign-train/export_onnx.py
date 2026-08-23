"""Export the trained SignNet to ONNX for onnxruntime-web (WASM EP).

  python export_onnx.py --ckpt signnet.pt --labels /data/sign-shards/labels.json --out signnet.onnx

Doctrine (see the blueprint): opset 17 (native LayerNormalization),
FIXED shape [1, 64, 102] — no dynamic axes, sidesteps the transformer
dynamic-shape export bugs; batch is always 1 at serve. Verifies ONNX
output parity against torch before writing labels next to the model.
Serve with:  signlab.html?model=<url>/signnet.onnx&labels=<url>/labels.json
(.onnx is gitignored — host the pair on the CDN/file server, never commit.)
"""
import argparse, json, shutil
from pathlib import Path
import numpy as np
import torch

from features import FEATURE_DIM, WINDOW_T
from model import SignNet


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--ckpt", required=True)
    ap.add_argument("--labels", required=True)
    ap.add_argument("--out", default="signnet.onnx")
    args = ap.parse_args()

    ck = torch.load(args.ckpt, map_location="cpu", weights_only=True)
    model = SignNet(ck["n_classes"]).eval()
    model.load_state_dict(ck["model"])
    print(f"ckpt: top1 {ck.get('top1'):.3f} top5 {ck.get('top5'):.3f} "
          f"(val signers {ck.get('val_signers')})")

    dummy = torch.randn(1, WINDOW_T, FEATURE_DIM)
    torch.onnx.export(
        model, dummy, args.out,
        input_names=["x"], output_names=["logits"],
        opset_version=17, dynamo=False)

    import onnxruntime as ort
    sess = ort.InferenceSession(args.out, providers=["CPUExecutionProvider"])
    for _ in range(3):
        x = torch.randn(1, WINDOW_T, FEATURE_DIM)
        with torch.no_grad():
            want = model(x).numpy()
        got = sess.run(["logits"], {"x": x.numpy()})[0]
        err = np.abs(want - got).max()
        assert err < 1e-3, f"parity FAILED: {err}"
    print(f"parity ok (max err {err:.2e})")

    out = Path(args.out)
    shutil.copy(args.labels, out.with_name("labels.json"))
    mb = out.stat().st_size / 1e6
    print(f"wrote {out} ({mb:.1f} MB fp32) + labels.json")
    print("optional: python -m onnxruntime.quantization.preprocess + quantize_dynamic for ~4x size")


if __name__ == "__main__":
    main()
