/**
 * sdk/game/sfx.js — the twin's audio cues, synthesized (WebAudio, no assets). CONTRACTS §3.8; derived from
 * AudioCues in latency-cues.js (research latency-cues.mjs:93-125) and latency-feel.md §5.4 ("audio leads vision").
 * ─────────────────────────────────────────────────────────────────────────────
 *   whoosh  LAUNCH seen — panned toward the receiving tile (panForTile)      textTwin 'Ball thrown'
 *   thud    catch (support / cradle / wrap) from the catcher's own client    'Ball caught'
 *   bonk    a miss: first floor bounce of a ball that came from another tile 'Ball missed'
 *   tick    arrival cue at 300 ms lead (predicted or confirmed)              'Ball incoming'
 *   chime   goal                                                             'Goal'
 *   sink    rest timeout: the ball sinks to the gutter                       'Ball sinking, back to kickoff'
 *   pop     respawn / arrival promote                                        'Ball respawned'
 * Every cue = OscillatorNode | noise AudioBufferSourceNode → GainNode envelope → StereoPannerNode(pan) → master GainNode
 * (volume × duck × mute) → destination. Node-safe to IMPORT (nothing touches AudioContext until unlock()); every cue is a
 * no-op until unlock() ran from a user gesture (autoplay policy), and every cue has a text twin for the live region.
 */

const TEXT = Object.freeze({
  whoosh: 'Ball thrown',
  thud: 'Ball caught',
  bonk: 'Ball missed',
  tick: 'Ball incoming',
  chime: 'Goal',
  sink: 'Ball sinking, back to kickoff',
  pop: 'Ball respawned',
});
export const SFX_NAMES = Object.freeze(Object.keys(TEXT));
const DUCK_GAIN = Math.pow(10, -12 / 20);          // -12 dB while PushToTalk listens

export class Sfx {
  constructor({ muted = false, volume = 0.35 } = {}) {
    this.ctx = null; this.master = null;
    this._muted = !!muted; this._ducked = false; this.volume = volume;
    this.stats = { played: 0, skipped: 0 };
    this.last = null;                                // last cue name (probes / HUD)
  }

  /** Create / resume the AudioContext on the first user gesture. Returns false where WebAudio does not exist (Node, old WebViews). */
  unlock() {
    const AC = (typeof AudioContext !== 'undefined') ? AudioContext : (typeof webkitAudioContext !== 'undefined' ? webkitAudioContext : null);
    if (!AC) return false;
    if (!this.ctx) {
      this.ctx = new AC();
      this.master = this.ctx.createGain();
      this.master.connect(this.ctx.destination);
      this._applyGain(0);
    }
    if (this.ctx.state === 'suspended') this.ctx.resume();
    return true;
  }
  get muted() { return this._muted; }
  mute(b) { this._muted = !!b; this._applyGain(0.02); }
  /** -12 dB while PushToTalk is listening. */
  duck(b) { this._ducked = !!b; this._applyGain(0.05); }
  setVolume(v) { this.volume = Math.max(0, Math.min(1, v)); this._applyGain(0.02); }
  _applyGain(rampS) {
    if (!this.master) return;
    const g = this._muted ? 0 : this.volume * (this._ducked ? DUCK_GAIN : 1);
    const t = this.ctx.currentTime;
    this.master.gain.cancelScheduledValues(t);
    if (rampS > 0) { this.master.gain.setValueAtTime(this.master.gain.value, t); this.master.gain.linearRampToValueAtTime(g, t + rampS); }
    else this.master.gain.setValueAtTime(g, t);
  }
  /** Text twin of a cue for the aria-live region (A1). */
  textTwin(name) { return TEXT[name] || ''; }

  // ── building blocks ─────────────────────────────────────────────────────
  _ready(name) {
    this.last = name;
    if (!this.ctx || this._muted) { this.stats.skipped++; return null; }
    this.stats.played++;
    return this.ctx;
  }
  _out(ac, pan, t) {
    const p = ac.createStereoPanner(); p.pan.setValueAtTime(Math.max(-1, Math.min(1, pan || 0)), t);
    p.connect(this.master);
    return p;
  }
  _noise(ac, durS, window = true) {
    const n = Math.max(1, Math.floor(ac.sampleRate * durS));
    const buf = ac.createBuffer(1, n, ac.sampleRate), d = buf.getChannelData(0);
    for (let i = 0; i < n; i++) d[i] = (Math.random() * 2 - 1) * (window ? Math.sin(Math.PI * i / n) : 1);
    const src = ac.createBufferSource(); src.buffer = buf;
    return src;
  }
  _env(ac, t, a, peak, decay, end = 0.0001) {
    const g = ac.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(Math.max(0.0002, peak), t + a);
    g.gain.exponentialRampToValueAtTime(end, t + a + decay);
    return g;
  }

  // ── cues ────────────────────────────────────────────────────────────────
  /** windowed noise through a rising band-pass — the ball crossing the gutter (latency-cues.mjs:98-108) */
  whoosh(pan = 0, durMs = 350) {
    const ac = this._ready('whoosh'); if (!ac) return false;
    const t = ac.currentTime, dur = durMs / 1000;
    const src = this._noise(ac, dur);
    const bp = ac.createBiquadFilter(); bp.type = 'bandpass'; bp.Q.value = 1.2;
    bp.frequency.setValueAtTime(600, t); bp.frequency.exponentialRampToValueAtTime(2400, t + dur);
    const g = ac.createGain(); g.gain.setValueAtTime(0.7, t);
    src.connect(bp).connect(g).connect(this._out(ac, pan, t)); src.start(t); src.stop(t + dur + 0.01);
    return true;
  }
  /** low sine drop — the ball settling into a hand */
  thud(pan = 0) {
    const ac = this._ready('thud'); if (!ac) return false;
    const t = ac.currentTime;
    const o = ac.createOscillator(); o.type = 'sine';
    o.frequency.setValueAtTime(140, t); o.frequency.exponentialRampToValueAtTime(50, t + 0.12);
    const g = ac.createGain(); g.gain.setValueAtTime(1.0, t); g.gain.exponentialRampToValueAtTime(0.001, t + 0.15);
    o.connect(g).connect(this._out(ac, pan, t)); o.start(t); o.stop(t + 0.16);
    return true;
  }
  /** hollow triangle knock — a miss on the floor; louder with the impact speed |vy| (m/s) */
  bonk(pan = 0, vy = 0) {
    const ac = this._ready('bonk'); if (!ac) return false;
    const t = ac.currentTime, amp = 0.5 + Math.min(0.5, Math.abs(vy) * 0.15);
    const o = ac.createOscillator(); o.type = 'triangle';
    o.frequency.setValueAtTime(220, t); o.frequency.exponentialRampToValueAtTime(90, t + 0.09);
    const g = this._env(ac, t, 0.004, amp, 0.2);
    const n = this._noise(ac, 0.04, false), ng = ac.createGain(); ng.gain.setValueAtTime(0.25 * amp, t); ng.gain.exponentialRampToValueAtTime(0.001, t + 0.04);
    const out = this._out(ac, pan, t);
    o.connect(g).connect(out); n.connect(ng).connect(out);
    o.start(t); o.stop(t + 0.22); n.start(t); n.stop(t + 0.05);
    return true;
  }
  /** short high click — 300 ms before a predicted / confirmed arrival */
  tick(pan = 0) {
    const ac = this._ready('tick'); if (!ac) return false;
    const t = ac.currentTime;
    const o = ac.createOscillator(); o.type = 'square'; o.frequency.setValueAtTime(1200, t);
    const g = this._env(ac, t, 0.002, 0.35, 0.035);
    o.connect(g).connect(this._out(ac, pan, t)); o.start(t); o.stop(t + 0.05);
    return true;
  }
  /** C5-E5-G5 arpeggio — goal (latency-cues.mjs:116-124) */
  chime() {
    const ac = this._ready('chime'); if (!ac) return false;
    const t = ac.currentTime, out = this._out(ac, 0, t);
    [523.25, 659.25, 783.99].forEach((f, i) => {
      const o = ac.createOscillator(); o.type = 'sine'; o.frequency.value = f;
      const g = ac.createGain(); const t0 = t + i * 0.08;
      g.gain.setValueAtTime(0.0001, t0); g.gain.exponentialRampToValueAtTime(0.8, t0 + 0.02); g.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.5);
      o.connect(g).connect(out); o.start(t0); o.stop(t0 + 0.52);
    });
    return true;
  }
  /** falling sine under a closing low-pass — the ball sinking through the floor (600 ms, RESPAWN_TRANSIT_MS) */
  sink() {
    const ac = this._ready('sink'); if (!ac) return false;
    const t = ac.currentTime;
    const o = ac.createOscillator(); o.type = 'sine';
    o.frequency.setValueAtTime(300, t); o.frequency.exponentialRampToValueAtTime(60, t + 0.6);
    const lp = ac.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.setValueAtTime(1200, t); lp.frequency.exponentialRampToValueAtTime(120, t + 0.6);
    const g = ac.createGain(); g.gain.setValueAtTime(0.6, t); g.gain.exponentialRampToValueAtTime(0.001, t + 0.6);
    o.connect(lp).connect(g).connect(this._out(ac, 0, t)); o.start(t); o.stop(t + 0.62);
    return true;
  }
  /** noise burst + quick sine drop — respawn / arrival promote (80 ms) */
  pop(pan = 0) {
    const ac = this._ready('pop'); if (!ac) return false;
    const t = ac.currentTime, out = this._out(ac, pan, t);
    const o = ac.createOscillator(); o.type = 'sine';
    o.frequency.setValueAtTime(600, t); o.frequency.exponentialRampToValueAtTime(200, t + 0.08);
    const g = this._env(ac, t, 0.003, 0.6, 0.08);
    const n = this._noise(ac, 0.03, false), ng = ac.createGain(); ng.gain.setValueAtTime(0.2, t); ng.gain.exponentialRampToValueAtTime(0.001, t + 0.03);
    o.connect(g).connect(out); n.connect(ng).connect(out);
    o.start(t); o.stop(t + 0.1); n.start(t); n.stop(t + 0.035);
    return true;
  }

  dispose() { if (this.ctx) { try { this.ctx.close(); } catch { /* already closed */ } } this.ctx = null; this.master = null; }
}
