"""Scan every shard on the Modal volume, report/delete any that fail to load.
Standalone (does not import modal_train.py — cross-file imports don't
resolve reliably under Modal's per-script mount layout); just re-attaches
to the same named app/volume.

  py -m modal run tools/sign-train/validate_shards.py::check
  py -m modal run tools/sign-train/validate_shards.py::check --delete-bad
"""
import modal

app = modal.App("hopeos-sign-validate")
vol = modal.Volume.from_name("sign-data", create_if_missing=False)
image = modal.Image.debian_slim(python_version="3.11").pip_install("numpy")


@app.function(image=image, volumes={"/vol": vol}, timeout=600)
def check(delete_bad: bool = False):
    import numpy as np
    from pathlib import Path
    vol.reload()
    out = Path("/vol/shards")
    files = sorted(out.glob("shard_*.npz"))
    bad = []
    for f in files:
        try:
            z = np.load(f)
            _ = z["X"].shape, z["L"].shape, z["y"].shape, z["split"].shape
        except Exception as e:
            bad.append(f.name)
            print(f"BAD {f.name}: {e}")
    print(f"{len(files)} shard files, {len(bad)} bad")
    if delete_bad and bad:
        for name in bad:
            (out / name).unlink()
        vol.commit()
        print(f"deleted {len(bad)} bad shard(s)")
    return bad
