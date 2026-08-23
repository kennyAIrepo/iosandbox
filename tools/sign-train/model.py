"""SignNet — 1D-Conv + Transformer temporal classifier (the hoyso48 recipe
class, sized for ONNX-Runtime-Web WASM: ~3M params, single window ≈ ms).

Input  x [B, 64, 102]  serve-space windows, zero-padded, NO mask —
       pad-as-zeros is a train/serve shared convention (features.py /
       sign-buffer.js), so the model learns padding instead of needing
       a mask input (keeps the ONNX export one-tensor simple).
Output logits [B, C]
"""
import torch
import torch.nn as nn

from features import FEATURE_DIM, WINDOW_T


class ConvBlock(nn.Module):
    def __init__(self, d, k=5):
        super().__init__()
        self.dw = nn.Conv1d(d, d, k, padding=k // 2, groups=d)
        self.pw = nn.Conv1d(d, d, 1)
        self.bn = nn.BatchNorm1d(d)
        self.act = nn.GELU()

    def forward(self, x):                      # [B, D, T]
        return x + self.bn(self.pw(self.act(self.dw(x))))


class SignNet(nn.Module):
    def __init__(self, n_classes, d=256, conv_blocks=3, tf_layers=4, heads=4, ff=512,
                 t=WINDOW_T, f=FEATURE_DIM, dropout=0.2):
        super().__init__()
        self.inp = nn.Sequential(nn.Linear(f, d), nn.LayerNorm(d), nn.GELU())
        self.pos = nn.Parameter(torch.zeros(1, t, d))
        self.convs = nn.ModuleList(ConvBlock(d) for _ in range(conv_blocks))
        enc = nn.TransformerEncoderLayer(
            d_model=d, nhead=heads, dim_feedforward=ff, dropout=dropout,
            batch_first=True, norm_first=True, activation="gelu")
        self.tf = nn.TransformerEncoder(enc, tf_layers)
        self.head = nn.Sequential(nn.LayerNorm(d), nn.Dropout(dropout), nn.Linear(d, n_classes))

    def forward(self, x):                      # [B, T, F]
        h = self.inp(x) + self.pos
        h = h.transpose(1, 2)                  # [B, D, T]
        for c in self.convs:
            h = c(h)
        h = self.tf(h.transpose(1, 2))         # [B, T, D]
        return self.head(h.mean(dim=1))        # maskless mean: pad-is-zeros convention


if __name__ == "__main__":
    m = SignNet(250)
    n = sum(p.numel() for p in m.parameters())
    out = m(torch.zeros(2, WINDOW_T, FEATURE_DIM))
    print(f"SignNet: {n/1e6:.2f}M params, out {tuple(out.shape)}")
