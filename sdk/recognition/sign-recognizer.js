/**
 * hopeOS SDK — Sign Recognizer (public facade)
 * ═══════════════════════════════════════════════════════════════
 * The one class a page wires up. Composes SignFeaturizer → SignBuffer →
 * SignClassifier and exposes the contract's two lanes
 * (assets/sign.contract.json):
 *
 *   CONTINUOUS — update(frame, tMs, aspect) → contract-keyed values,
 *     the BodyProbe/HandProbe shape, polled every frame:
 *       sign.segment.active   0|1
 *       sign.motion           torso-units/s motion energy
 *       sign.buffer.fill      0..1 of a full classifier window
 *       sign.hand.L.seen / sign.hand.R.seen
 *       sign.confidence       last emitted token's probability
 *
 *   DISCRETE — on('token', (gloss, conf, meta) => …) with the
 *     body-gestures.js cooldown idiom. Also:
 *       'segment'  every closed segment (fires even with no model —
 *                  signlab runs features-only until weights exist)
 *       'lowconf'  segment classified below minConf (top guess passed
 *                  through so UIs can show "did you mean…")
 *
 * No model → no tokens, honestly: nothing is faked. Classification is
 * async (ORT run) — segments queue FIFO so token order is stable.
 */

import { SignFeaturizer } from './sign-landmarks.js';
import { SignBuffer } from './sign-buffer.js';
import { SignClassifier } from './sign-classifier.js';

export class SignRecognizer {
  /**
   * @param opts.model / opts.labels  passed to SignClassifier (optional —
   *        omit both to run the features+segmentation lane only)
   * @param opts.minConf    token gate (default 0.5)
   * @param opts.cooldownMs same-gloss re-emit gate (default 600)
   * @param opts.buffer     SignBuffer opts overrides (thresholds, rateHz…)
   */
  constructor(opts = {}) {
    this.opts = { minConf: 0.5, cooldownMs: 600, ...opts };
    this._listeners = {};
    this._cooldowns = {};
    this.featurizer = new SignFeaturizer(opts.featurizer);
    this.buffer = new SignBuffer({
      ...opts.buffer,
      onSegment: seg => this._onSegment(seg)
    });
    this.classifier = opts.model
      ? new SignClassifier({ model: opts.model, labels: opts.labels, ...opts.classifier })
      : null;
    this._classifyChain = Promise.resolve();   // FIFO — token order is stable
    this.values = {
      'sign.segment.active': false,
      'sign.motion': 0,
      'sign.buffer.fill': 0,
      'sign.hand.L.seen': false,
      'sign.hand.R.seen': false,
      'sign.confidence': 0
    };
  }

  /** Load the classifier (no-op in features-only mode). */
  async init() {
    if (this.classifier) await this.classifier.load();
    return this;
  }

  on(event, cb) {
    (this._listeners[event] = this._listeners[event] || []).push(cb);
    return this;
  }

  off(event, cb) {
    const list = this._listeners[event];
    if (list) this._listeners[event] = list.filter(f => f !== cb);
  }

  _emit(event, ...args) {
    for (const cb of (this._listeners[event] || [])) cb(...args);
  }

  /** Cooldown-gated token emit — the body-gestures idiom, keyed per gloss. */
  _emitToken(gloss, conf, meta) {
    const now = performance.now();
    if (this._cooldowns[gloss] && now - this._cooldowns[gloss] < this.opts.cooldownMs) return;
    this._cooldowns[gloss] = now;
    this.values['sign.confidence'] = conf;
    this._emit('token', gloss, conf, meta);
  }

  /** Call once per tracker.detect(). Returns the contract-keyed values. */
  update(frame, tMs, aspect = 4 / 3) {
    const feat = this.featurizer.update(frame, tMs, aspect);
    this.buffer.push(feat, tMs);
    const v = this.values;
    v['sign.segment.active'] = this.buffer.active;
    v['sign.motion'] = this.buffer.energy;
    v['sign.buffer.fill'] = this.buffer.fill;
    v['sign.hand.L.seen'] = feat.handL;
    v['sign.hand.R.seen'] = feat.handR;
    return v;
  }

  _onSegment(seg) {
    this._emit('segment', seg);
    if (!this.classifier?.ready) return;
    this._classifyChain = this._classifyChain
      .then(() => this.classifier.classify(seg))
      .then(res => {
        if (!res) return;
        const best = res.top[0];
        const meta = { top: res.top, ms: res.ms, durMs: seg.durMs, t0: seg.t0, t1: seg.t1 };
        if (best.p >= this.opts.minConf) this._emitToken(best.label, best.p, meta);
        else this._emit('lowconf', best.label, best.p, meta);
      })
      .catch(e => this._emit('error', e));
  }
}
