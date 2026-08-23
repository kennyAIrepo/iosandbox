/**
 * hopeOS SDK — Caption Strip + Voice
 * ═══════════════════════════════════════════════════════════════
 * The SINK half of the sign contract: recognized tokens → a slim
 * bottom-anchored rolling subtitle strip (the world.html sayAI
 * pattern, extracted) + best-effort Web Speech voice.
 *
 * VOICE IS BEST-EFFORT BY DESIGN. iOS speechSynthesis is the flakiest
 * link in the chain: it must be primed from a user gesture, getVoices()
 * populates async, and the synth can wedge in `speaking` forever.
 * Mitigations here: prime() on first tap, short utterances only, and a
 * watchdog that cancels a stuck synth. Captions are the product; voice
 * degrades to silence, never blocks.
 */

export class CaptionStrip {
  /**
   * @param parent  element to mount into (default document.body). Elements
   *   are created via parent.ownerDocument, not the bare global `document`
   *   — required so this same class works unmodified when `parent` lives
   *   in a Picture-in-Picture window's own separate document (pip-captions.js).
   */
  constructor(parent = document.body, opts = {}) {
    this.opts = { maxLines: 3, fadeMs: 8000, fontPx: 16, ...opts };
    const doc = parent.ownerDocument || document;
    this.el = doc.createElement('div');
    this.el.style.cssText =
      'position:absolute;left:0;right:0;bottom:0;pointer-events:none;' +
      'display:flex;flex-direction:column;align-items:center;gap:4px;' +
      `padding:8px 12px;z-index:20;font:${this.opts.fontPx}px/1.35 system-ui,sans-serif;`;
    parent.appendChild(this.el);
    this._timers = [];
  }

  /** Push one caption line. dim=true renders as a de-emphasized note. */
  push(text, { dim = false, conf = null } = {}) {
    const doc = this.el.ownerDocument;
    const line = doc.createElement('div');
    line.style.cssText =
      'background:rgba(0,0,0,0.72);color:' + (dim ? '#9aa4ad' : '#fff') + ';' +
      'border-radius:6px;padding:3px 12px;max-width:90%;transition:opacity 0.6s;';
    line.textContent = conf !== null ? `${text}  ·${Math.round(conf * 100)}%` : text;
    this.el.appendChild(line);
    while (this.el.children.length > this.opts.maxLines) this.el.firstChild.remove();
    const t = setTimeout(() => { line.style.opacity = '0'; }, this.opts.fadeMs);
    this._timers.push(t);
  }

  clear() {
    for (const t of this._timers) clearTimeout(t);
    this._timers = [];
    this.el.replaceChildren();
  }
}

export class Speaker {
  constructor(opts = {}) {
    this.opts = { rate: 1.0, watchdogMs: 6000, ...opts };
    this.enabled = false;
    this._primed = false;
    this._watchdog = null;
    this.available = typeof speechSynthesis !== 'undefined';
  }

  /** Call from a user-gesture handler once (iOS autoplay policy). */
  prime() {
    if (!this.available || this._primed) return;
    try {
      const u = new SpeechSynthesisUtterance('');
      u.volume = 0;
      speechSynthesis.speak(u);
      this._primed = true;
    } catch { /* voice is optional */ }
  }

  speak(text) {
    if (!this.available || !this.enabled || !text) return;
    try {
      const u = new SpeechSynthesisUtterance(text);
      u.rate = this.opts.rate;
      speechSynthesis.speak(u);
      // watchdog: a wedged synth (classic iOS failure) gets cancelled so
      // the next token isn't queued behind a corpse
      clearTimeout(this._watchdog);
      this._watchdog = setTimeout(() => {
        if (speechSynthesis.speaking) speechSynthesis.cancel();
      }, this.opts.watchdogMs);
    } catch { /* degrade to captions-only */ }
  }
}
