/**
 * hopeOS SDK — Sign Classifier (ONNX Runtime Web)
 * ═══════════════════════════════════════════════════════════════
 * The temporal-classifier lane: a SignBuffer window → gloss
 * probabilities, entirely in-browser on the WASM-SIMD execution
 * provider. WASM (not WebGPU) is deliberate: at this model size
 * (~2-5M params, one window/second) GPU dispatch overhead loses to
 * SIMD CPU, and single-threaded WASM needs no COOP/COEP headers.
 *
 * ORT is CDN-loaded and memoized (the tracking.js getVision pattern).
 * Model bytes are fetched once and cached in the Cache API keyed by
 * URL (best-effort — Safari ITP may evict; network path always kept).
 * `.onnx` files are gitignored by repo policy: models are CDN/remote
 * assets or in-memory bytes (toy-model.js), never committed.
 *
 * Output contract: 2D [1,C] logits (real classifier) or 3D [1,T,C]
 * (toy model — last valid frame is read). Softmax + top-k here;
 * calibrated confidence gating lives in SignRecognizer.
 */

const ORT_VERSION = '1.22.0';
const ORT_URL = `https://cdn.jsdelivr.net/npm/onnxruntime-web@${ORT_VERSION}/dist/ort.min.mjs`;
const ORT_WASM_BASE = `https://cdn.jsdelivr.net/npm/onnxruntime-web@${ORT_VERSION}/dist/`;

let _ortP = null;
/** The onnxruntime-web ESM module (memoized, one per page). */
export function getOrt(url = ORT_URL, wasmBase = ORT_WASM_BASE) {
  if (!_ortP) {
    _ortP = import(url).then(m => {
      const ort = m.default ?? m;
      ort.env.wasm.wasmPaths = wasmBase;
      ort.env.wasm.numThreads = 1;   // single-thread: no crossOriginIsolated requirement
      return ort;
    });
  }
  return _ortP;
}

async function fetchModel(url) {
  try {
    const cache = await caches.open('hopeos-sign-models');
    const hit = await cache.match(url);
    if (hit) return new Uint8Array(await hit.arrayBuffer());
    const res = await fetch(url);
    if (!res.ok) throw new Error(`model fetch ${res.status}`);
    const buf = await res.arrayBuffer();
    cache.put(url, new Response(buf.slice(0))).catch(() => {});
    return new Uint8Array(buf);
  } catch {
    const res = await fetch(url);                    // Cache API unavailable → plain fetch
    if (!res.ok) throw new Error(`model fetch ${res.status}`);
    return new Uint8Array(await res.arrayBuffer());
  }
}

export class SignClassifier {
  /**
   * @param opts.model    URL string OR Uint8Array of ONNX bytes
   * @param opts.labels   gloss strings, index-aligned with model output
   * @param opts.T/F      window shape (must match the export; fixed axes)
   * @param opts.inputName/outputName  tensor names (default x / logits)
   */
  constructor(opts = {}) {
    this.opts = { inputName: 'x', outputName: 'logits', T: 64, F: 102, labels: null, ...opts };
    this.session = null;
    this.backend = null;
    this.lastMs = 0;
  }

  get ready() { return !!this.session; }

  async load() {
    const ort = await getOrt(this.opts.ortUrl, this.opts.wasmBase);
    const m = this.opts.model;
    const bytes = typeof m === 'string' ? await fetchModel(m) : m;
    if (!bytes) throw new Error('SignClassifier: no model given');
    this.session = await ort.InferenceSession.create(bytes, {
      executionProviders: ['wasm']
    });
    this.backend = 'wasm';
    this._ort = ort;
    return this;
  }

  /**
   * @param {Object} win  SignBuffer segment: {data: Float32Array(T*F), length}
   * @returns {probs: Float32Array, top: [{index, label, p}], ms} or null if not ready
   */
  async classify(win, topK = 5) {
    if (!this.session) return null;
    const { T, F, inputName, outputName } = this.opts;
    const t0 = performance.now();
    const input = new this._ort.Tensor('float32', win.data, [1, T, F]);
    const out = await this.session.run({ [inputName]: input });
    const tensor = out[outputName] ?? out[Object.keys(out)[0]];
    this.lastMs = performance.now() - t0;

    // 2D [1,C] → row 0; 3D [1,T,C] (toy) → last valid frame's logits
    let logits;
    if (tensor.dims.length === 3) {
      const C = tensor.dims[2];
      const row = Math.max(0, Math.min(win.length - 1, tensor.dims[1] - 1));
      logits = tensor.data.subarray(row * C, (row + 1) * C);
    } else {
      logits = tensor.data;
    }

    // softmax
    let max = -Infinity;
    for (let i = 0; i < logits.length; i++) if (logits[i] > max) max = logits[i];
    const probs = new Float32Array(logits.length);
    let sum = 0;
    for (let i = 0; i < logits.length; i++) { probs[i] = Math.exp(logits[i] - max); sum += probs[i]; }
    for (let i = 0; i < probs.length; i++) probs[i] /= sum;

    const idx = [...probs.keys()].sort((a, b) => probs[b] - probs[a]).slice(0, topK);
    const top = idx.map(i => ({
      index: i,
      label: this.opts.labels?.[i] ?? `class_${i}`,
      p: probs[i]
    }));
    return { probs, top, ms: this.lastMs };
  }
}
