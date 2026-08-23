/**
 * hopeOS SDK — Toy ONNX Builder (M0 latency probe)
 * ═══════════════════════════════════════════════════════════════
 * Hand-encodes a small ONNX model as protobuf bytes, entirely in JS —
 * no PyTorch, no network, no committed .onnx file (weights are
 * gitignored by policy). Purpose: prove the ONNX-Runtime-Web wiring
 * end-to-end (session create → tensor in → logits out) and give a
 * FLOPs-representative latency number before the real classifier
 * exists. NOT a recognizer — outputs are deterministic noise.
 *
 * Graph (opset 13):  x [1,T,F] → (MatMul → Relu) × (layers-1)
 *                              →  MatMul → logits [1,T,C]
 * Default T=64 F=102 H=512 C=250, 4 matmuls ≈ 0.7M params ≈ 45M MACs
 * per window — the cost class of the planned 1D-CNN+Transformer.
 *
 * Weights are deterministic xorshift pseudo-randoms scaled by
 * sqrt(2/fanIn) so activations stay finite and tests are stable.
 * Runs in Node too (pure typed arrays) — sign-smoke.mjs sanity-checks
 * the bytes; the browser probe runs them for real.
 */

// ── minimal protobuf writers ──────────────────────────────────────
const varint = (n) => {
  const out = [];
  while (n > 0x7f) { out.push((n & 0x7f) | 0x80); n >>>= 7; }
  out.push(n);
  return Uint8Array.from(out);
};
const cat = (...parts) => {
  let len = 0;
  for (const p of parts) len += p.length;
  const out = new Uint8Array(len);
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
};
const key = (field, wire) => varint((field << 3) | wire);
const vField = (field, n) => cat(key(field, 0), varint(n));               // varint
const bField = (field, bytes) => cat(key(field, 2), varint(bytes.length), bytes);  // len-delim
const sField = (field, str) => bField(field, new TextEncoder().encode(str));
const packedVarints = (field, nums) => bField(field, cat(...nums.map(varint)));

// ── ONNX messages ─────────────────────────────────────────────────
const dim = (n) => bField(1, vField(1, n));                               // Dimension.dim_value
const tensorType = (dims) => bField(1, cat(                               // TypeProto.tensor_type
  vField(1, 1),                                                           //   elem_type FLOAT
  bField(2, cat(...dims.map(dim)))                                        //   shape
));
const valueInfo = (name, dims) => cat(sField(1, name), bField(2, tensorType(dims)));
const node = (op, inputs, outputs) => cat(
  ...inputs.map(s => sField(1, s)),
  ...outputs.map(s => sField(2, s)),
  sField(4, op)
);
const initializer = (name, dims, f32) => cat(
  packedVarints(1, dims),                                                 // dims
  vField(2, 1),                                                           // data_type FLOAT
  sField(8, name),
  bField(9, new Uint8Array(f32.buffer, f32.byteOffset, f32.byteLength))   // raw_data LE
);

// deterministic weights: xorshift32 → uniform(-1,1) × sqrt(2/fanIn)
function makeWeights(rows, cols, seed) {
  const w = new Float32Array(rows * cols);
  const scale = Math.sqrt(2 / rows);
  let s = seed >>> 0 || 1;
  for (let i = 0; i < w.length; i++) {
    s ^= s << 13; s >>>= 0;
    s ^= s >> 17;
    s ^= s << 5; s >>>= 0;
    w[i] = ((s / 0xffffffff) * 2 - 1) * scale;
  }
  return w;
}

/**
 * Build the toy model. @returns {Uint8Array} ONNX ModelProto bytes.
 * Input tensor name 'x' [1,T,F], output 'logits' [1,T,C].
 */
export function buildToyModel({ T = 64, F = 102, H = 512, layers = 4, C = 250 } = {}) {
  const nodes = [], inits = [];
  let prev = 'x', prevDim = F;
  for (let l = 0; l < layers; l++) {
    const last = l === layers - 1;
    const outDim = last ? C : H;
    const wName = `W${l}`;
    inits.push(initializer(wName, [prevDim, outDim], makeWeights(prevDim, outDim, 0x5eed + l)));
    const mmOut = last ? 'logits' : `mm${l}`;
    nodes.push(node('MatMul', [prev, wName], [mmOut]));
    if (!last) {
      nodes.push(node('Relu', [mmOut], [`act${l}`]));
      prev = `act${l}`;
    }
    prevDim = outDim;
  }
  const graph = cat(
    ...nodes.map(n => bField(1, n)),
    sField(2, 'signlab-toy'),
    ...inits.map(t => bField(5, t)),
    bField(11, valueInfo('x', [1, T, F])),
    bField(12, valueInfo('logits', [1, T, C]))
  );
  return cat(
    vField(1, 8),                                 // ir_version
    sField(2, 'hopeos-signlab'),                  // producer_name
    bField(7, graph),
    bField(8, vField(2, 13))                      // opset_import { version: 13 }
  );
}
