/**
 * sdk/game/voice-commands.js — VOICE COMMANDS: the microphone actively listens, a
 * small grammar fires game commands ("ball" → the ball comes to your hands).
 * ─────────────────────────────────────────────────────────────────────────────
 * Two layers:
 *   · PURE (Node-safe, tested): normalize(), matchCommand(), parseResults() — the
 *     grammar and the de-duplication of a continuous recogniser's rolling results.
 *   · BROWSER: VoiceCommands — wraps SpeechRecognition (continuous, interim
 *     results, auto-restart on silence), reports a state the UI can show, and an
 *     RMS meter from the mic so the banner can pulse with your voice.
 *
 *   const V = new VoiceCommands({ grammar: GRAMMAR, onCommand: (cmd, heard) => …, onState: s => … });
 *   V.start()   // from a user gesture — the browser asks for the microphone once
 *   V.inject('ball')   // probes and keyboard fallbacks run the same pipeline
 *
 * States: off · starting · listening · paused (browser ended a session, restarting)
 *         · denied (mic permission) · unsupported (no SpeechRecognition) · error
 */

/** the game grammar: command → the words that mean it (whole words, any order, lower-case) */
export const GRAMMAR = {
  ball:  ['ball', 'pass', 'pass it', 'give me the ball', 'ball please', 'throw it', 'toss it', 'bol', 'bowl', 'paul', 'bald'],
  go:    ['go', 'start', 'play', 'round', 'lets go', "let's go", 'begin'],
  stop:  ['stop', 'end', 'enough', 'pause', 'quit'],
  hoop:  ['hoop', 'basket', 'net', 'rim'],
  drop:  ['drop', 'reset', 'again', 'down'],
  cube:  ['cube', 'rubik', 'rubiks', "rubik's", 'rubix'],
  rug:   ['rug', 'cloth', 'carpet', 'blanket'],
  slime: ['slime', 'glass', 'glass ball', 'jelly'],
  bow:   ['bow', 'arrow', 'bow and arrow', 'archery'],
};

/** lower-case, punctuation out, one space between words */
export function normalize(t) {
  return String(t || '').toLowerCase().replace(/[^a-z0-9' ]+/g, ' ').replace(/\s+/g, ' ').trim();
}

/**
 * Which command does this transcript carry? Phrases match as whole words (so
 * "basketball" never fires "ball" by accident, but "the ball" does). Longer
 * phrases win over shorter ones at the same spot; the match that ENDS latest wins,
 * since a continuous transcript grows at its end ("ball go" → go).
 */
export function matchCommand(transcript, grammar = GRAMMAR) {
  const t = ' ' + normalize(transcript) + ' ';
  let best = null;
  for (const [cmd, phrases] of Object.entries(grammar)) {
    for (const ph of phrases) {
      const p = ' ' + normalize(ph) + ' ';
      const at = t.lastIndexOf(p);
      if (at < 0) continue;
      const score = (at + p.length) * 1000 + p.length;         // the phrase that ENDS latest wins (a rolling transcript grows at its end); longer breaks ties
      if (!best || score > best.score) best = { cmd, phrase: ph.trim(), at, score };
    }
  }
  return best ? { cmd: best.cmd, phrase: best.phrase } : null;
}

/**
 * A continuous recogniser hands back a ROLLING list of results, each interim or
 * final, re-sent every time it changes. This turns one such list into the
 * commands that should fire NOW, exactly once each:
 *   results: [{ transcript, isFinal }]   (index = result slot, as SpeechRecognition gives it)
 *   state:   { fired: Map(slot → phrase), last: Map(cmd → time) }  (kept by the caller)
 *   opts:    { cooldown (s) per command, now (s) }
 * A slot fires once for a given phrase (an interim "ba" → "ball" fires when "ball"
 * appears; the final "ball" for the same slot does not fire again). When the
 * recogniser restarts, slots reset — call state.fired.clear().
 */
export function parseResults(results, state, { grammar = GRAMMAR, cooldown = 1.2, now = 0 } = {}) {
  const out = [];
  for (let i = 0; i < results.length; i++) {
    const r = results[i]; if (!r) continue;
    const m = matchCommand(r.transcript, grammar);
    if (!m) continue;
    const key = i + ':' + m.cmd;
    if (state.fired.has(key)) continue;                        // this slot already fired this command
    const last = state.last.get(m.cmd) ?? -1e9;
    if (now - last < cooldown) { state.fired.set(key, m.phrase); continue; }   // swallow the echo, but remember it
    state.fired.set(key, m.phrase); state.last.set(m.cmd, now);
    out.push({ cmd: m.cmd, phrase: m.phrase, heard: normalize(r.transcript), final: !!r.isFinal, slot: i });
  }
  return out;
}

export class VoiceCommands {
  constructor(o = {}) {
    this.grammar = o.grammar || GRAMMAR;
    this.lang = o.lang || 'en-US';
    this.cooldown = o.cooldown ?? 1.2;
    this.onCommand = o.onCommand || (() => {});
    this.onState = o.onState || (() => {});
    this.onHeard = o.onHeard || (() => {});                    // every transcript change (for the "heard: …" read-out)
    this.meter = o.meter !== false;                            // RMS from the mic (AudioContext) for the pulse
    this.state = 'off'; this.heard = ''; this.level = 0; this.lastCmd = null; this.lastCmdT = 0;
    this._rec = null; this._want = false; this._restartT = 0; this._fired = { fired: new Map(), last: new Map() };
    this._audio = null; this._an = null; this._buf = null; this._stream = null; this._raf = 0;
    this.log = [];
  }
  static supported() { return typeof window !== 'undefined' && !!(window.SpeechRecognition || window.webkitSpeechRecognition); }
  _set(s, why = '') { if (this.state !== s) { this.state = s; this.log.push([Date.now(), s, why]); if (this.log.length > 60) this.log.shift(); this.onState(s, why); } }
  /** start listening — call from a user gesture (the microphone prompt) */
  start() {
    this._want = true;
    if (!VoiceCommands.supported()) { this._set('unsupported'); return false; }
    if (this._rec) { try { this._rec.start(); } catch (_) {} return true; }
    const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
    const rec = this._rec = new SR();
    rec.lang = this.lang; rec.continuous = true; rec.interimResults = true; rec.maxAlternatives = 2;
    rec.onstart = () => { this._fired.fired.clear(); this._set('listening'); };
    rec.onresult = (e) => {
      const list = [];
      for (let i = 0; i < e.results.length; i++) {
        const r = e.results[i]; let best = r[0];
        for (let a = 1; a < r.length; a++) if (r[a].confidence > best.confidence) best = r[a];
        list[i] = { transcript: best.transcript, isFinal: r.isFinal };
      }
      const tail = list.length ? list[list.length - 1].transcript : '';
      this.heard = normalize(tail); this.onHeard(this.heard);
      for (const c of parseResults(list, this._fired, { grammar: this.grammar, cooldown: this.cooldown, now: performance.now() / 1000 })) this._fire(c);
    };
    rec.onerror = (e) => {
      const err = e && e.error;
      if (err === 'not-allowed' || err === 'service-not-allowed') { this._want = false; this._set('denied', err); return; }
      if (err === 'no-speech' || err === 'aborted' || err === 'network') { this._set('paused', err); return; }   // onend restarts
      this._set('error', err || 'error');
    };
    rec.onend = () => {                                        // Chrome ends a session after silence — keep listening
      if (!this._want) { this._set('off'); return; }
      this._set('paused', 'restart');
      clearTimeout(this._restartT);
      this._restartT = setTimeout(() => { if (this._want) { try { rec.start(); } catch (_) {} } }, 250);
    };
    this._set('starting');
    try { rec.start(); } catch (e) { this._set('error', String(e && e.message || e)); return false; }
    if (this.meter) this._meterStart();
    return true;
  }
  stop() {
    this._want = false; clearTimeout(this._restartT);
    if (this._rec) { try { this._rec.stop(); } catch (_) {} }
    this._meterStop(); this._set('off');
  }
  toggle() { return this.state === 'off' || this.state === 'denied' || this.state === 'error' ? this.start() : (this.stop(), false); }
  /** run a phrase through the same pipeline as a heard one (probes, keyboard) */
  inject(text) {
    const m = matchCommand(text, this.grammar);
    this.heard = normalize(text); this.onHeard(this.heard);
    if (m) this._fire({ cmd: m.cmd, phrase: m.phrase, heard: this.heard, final: true, slot: -1, injected: true });
    return m ? m.cmd : null;
  }
  _fire(c) { this.lastCmd = c.cmd; this.lastCmdT = performance.now(); this.log.push([Date.now(), 'cmd', c.cmd, c.heard]); if (this.log.length > 60) this.log.shift(); this.onCommand(c.cmd, c); }
  // ── the RMS meter: the banner pulses with your voice ──
  async _meterStart() {
    if (this._audio || typeof navigator === 'undefined' || !navigator.mediaDevices) return;
    try {
      const AC = window.AudioContext || window.webkitAudioContext; if (!AC) return;
      this._stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } });
      this._audio = new AC(); const src = this._audio.createMediaStreamSource(this._stream);
      this._an = this._audio.createAnalyser(); this._an.fftSize = 512; this._buf = new Uint8Array(this._an.fftSize);
      src.connect(this._an);
      const tick = () => { if (!this._an) return; this._an.getByteTimeDomainData(this._buf); let s = 0; for (let i = 0; i < this._buf.length; i++) { const v = (this._buf[i] - 128) / 128; s += v * v; }
        const rms = Math.sqrt(s / this._buf.length); this.level += (Math.min(1, rms * 4) - this.level) * 0.3; this._raf = requestAnimationFrame(tick); };
      this._raf = requestAnimationFrame(tick);
    } catch (_) { /* no meter: the state pulse still shows listening */ }
  }
  _meterStop() {
    cancelAnimationFrame(this._raf); this._raf = 0;
    if (this._stream) { for (const t of this._stream.getTracks()) t.stop(); this._stream = null; }
    if (this._audio) { try { this._audio.close(); } catch (_) {} this._audio = null; }
    this._an = null; this.level = 0;
  }
}
