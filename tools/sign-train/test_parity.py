"""Proves features.py reproduces the JS featurizer bit-close from the same
raw-camera input. The fixture's `expected` block is the serve-side truth
(computed by sign-landmarks.js on the mirrored stream). Run after ANY edit
to either featurizer; a max error above 1e-5 means train/serve layouts
have drifted — the silent-accuracy-killer this file exists to catch.

  node make_parity_fixture.mjs && python test_parity.py
"""
import json
from pathlib import Path
import numpy as np

from features import featurize_sequence, FEATURE_DIM

fx = json.loads((Path(__file__).parent / "parity_fixture.json").read_text())
T = len(fx["rawPose"])
pose = np.array(fx["rawPose"], dtype=np.float32)            # [T,33,3] x,y,v
hand_r = np.array(fx["rawHandR"], dtype=np.float32)         # [T,21,2]
hand_l = np.full((T, 21, 2), np.nan, dtype=np.float32)

# features.py consumes raw coords with NaN for missing; fixture pose uses
# v=0 for unset points — map those to NaN like the JS minVis gate does
vis = pose[:, :, 2] < 0.5
pose_xy = pose[:, :, :2].copy()
pose_xy[vis] = np.nan

got = featurize_sequence(hand_l, hand_r, pose_xy, aspect=fx["aspect"])
want = np.array([[np.nan if v is None else v for v in row] for row in fx["expected"]],
                dtype=np.float32)

assert got.shape == (T, FEATURE_DIM) == want.shape, (got.shape, want.shape)
nan_match = np.isnan(got) == np.isnan(want)
assert nan_match.all(), f"NaN pattern mismatch at {np.argwhere(~nan_match)[:5]}"
finite = ~np.isnan(want)
err = np.abs(got[finite] - want[finite]).max()
print(f"parity: max err {err:.2e} over {finite.sum()} finite features")
assert err < 1e-5, "train/serve featurizer drift!"
print("OK — features.py matches sign-landmarks.js")
