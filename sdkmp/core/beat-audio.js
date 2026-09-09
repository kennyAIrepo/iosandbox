/**
 * hopeOS SDK — Beat Audio
 * ═══════════════════════════════════════════════════════════════
 * The audio side of the beat game: a soundtrack + a BEAT MAP (when
 * every punchable object should arrive at the player's hands).
 *
 * Two track sources, one interface:
 *
 *   1. BUILT-IN SYNTH — "NEON DRIVE 139": an ORIGINAL driving
 *      rock/synth track at 139 BPM (the "Beat It" tempo — the actual
 *      Michael Jackson recording is copyright Epic Records, NOT open
 *      source, so it cannot be bundled; drop your own MP3 in instead).
 *      Fully procedural Web Audio (kick/snare/hats/bass riff/stabs),
 *      zero download, and the beat map is EXACT by construction —
 *      every note event is scheduled on the same AudioContext clock
 *      the game reads.
 *
 *   2. ANY MP3/AUDIO FILE — decoded, then analyzed offline:
 *      onset detection (spectral-energy flux, low band + broadband),
 *      BPM via autocorrelation of the onset envelope, grid phase fit —
 *      then a beat map is generated from the strongest onsets.
 *
 * Pattern generation, DSP analysis and beat-map building are PURE
 * functions (no AudioContext) so they run under Node for smoke tests.
 *
 * The game reads time as `track.time()` — AudioContext-clock seconds
 * since play() — which is THE master clock for spawning/judging.
 */

export const SYNTH_BPM = 139;
export const SYNTH_NAME = 'NEON DRIVE 139 (built-in)';

// ── 1. Built-in track: pattern (pure) ───────────────────────────
// 68 bars of 4/4 @139. Sections: intro → verse → build → DROP A →
// breakdown (walls) → DROP B → outro.  Events carry a `kind` used by
// both the synthesizer and the beat-map builder.
const RIFF_A = [28, 28, 40, 28, 35, 28, 26, 31];   // E1-rooted eighth riff (original)
const RIFF_B = [28, 28, 40, 41, 43, 40, 35, 31];
const STABS = { em: [52, 55, 59], c: [48, 52, 55], d: [50, 54, 57], b: [47, 51, 54] };
const midiHz = (m) => 440 * Math.pow(2, (m - 69) / 12);

export function sections(bar) {
  if (bar < 4) return 'intro';
  if (bar < 12) return 'verse';
  if (bar < 20) return 'build';
  if (bar < 36) return 'dropA';
  if (bar < 44) return 'breakdown';
  if (bar < 60) return 'dropB';
  return 'outro';
}

/** Build the full event list for the built-in track. Pure. */
export function buildSynthPattern(bpm = SYNTH_BPM, bars = 68) {
  const spb = 60 / bpm;               // seconds per beat
  const ev = [];
  const push = (t, kind, o = {}) => ev.push({ t: +t.toFixed(4), kind, ...o });

  for (let bar = 0; bar < bars; bar++) {
    const t0 = bar * 4 * spb;
    const sec = sections(bar);
    const drop = sec === 'dropA' || sec === 'dropB';
    const chord = [STABS.em, STABS.c, STABS.d, STABS.b][(bar >> 1) & 3];

    // kick
    if (sec === 'intro' || sec === 'outro') {
      push(t0, 'kick'); push(t0 + 2 * spb, 'kick');
    } else if (sec === 'breakdown') {
      if (bar % 2 === 0) push(t0, 'kick', { soft: true });
    } else {
      for (let b = 0; b < 4; b++) push(t0 + b * spb, 'kick');
      if (sec === 'dropB' && bar % 2 === 1) push(t0 + 3.5 * spb, 'kick');   // double-kick drive
    }
    // snare on 2 & 4
    if (sec !== 'intro' && sec !== 'breakdown' && sec !== 'outro') {
      push(t0 + 1 * spb, 'snare'); push(t0 + 3 * spb, 'snare');
      if ((sec === 'build' && bar === 19) || (sec === 'dropB' && bar === 59)) {
        for (let s = 0; s < 8; s++) push(t0 + (2 + s * 0.25) * spb, 'snare', { roll: true });   // fill
      }
    }
    // hats
    const hatStep = drop ? 0.5 : sec === 'breakdown' ? 1 : 0.5;
    for (let h = 0; h * hatStep < 4; h++) {
      const t = t0 + h * hatStep * spb;
      push(t, 'hat', { open: drop && h % 2 === 1 });
    }
    // bass riff (eighths)
    if (sec !== 'intro' && sec !== 'outro') {
      const riff = (sec === 'dropB' || (drop && bar % 4 >= 2)) ? RIFF_B : RIFF_A;
      if (sec === 'breakdown') {
        push(t0, 'bass', { midi: riff[0], dur: 2 * spb });
        push(t0 + 2 * spb, 'bass', { midi: riff[4], dur: 2 * spb });
      } else {
        for (let e = 0; e < 8; e++) {
          push(t0 + e * 0.5 * spb, 'bass', { midi: riff[e], dur: 0.42 * spb, accent: e === 2 || e === 4 });
        }
      }
    }
    // stabs / pads
    if (drop) {
      push(t0 + 1.5 * spb, 'stab', { chord });
      if (sec === 'dropB') push(t0 + 3.5 * spb, 'stab', { chord });
    } else if (sec === 'breakdown' || sec === 'intro') {
      push(t0, 'pad', { chord, dur: 4 * spb });
    }
  }
  ev.sort((a, b) => a.t - b.t);
  return { bpm, bars, duration: bars * 4 * spb, events: ev };
}

// ── 2. Built-in track: synthesizer (Web Audio) ──────────────────
export class SynthTrack {
  constructor(ctx, pattern = buildSynthPattern()) {
    this.ctx = ctx;
    this.name = SYNTH_NAME;
    this.exactGrid = true;      // pattern IS the grid — conductor can use it
    this.bpm = pattern.bpm;
    this.duration = pattern.duration;
    this.pattern = pattern;
    this.master = ctx.createDynamicsCompressor();
    this.gain = ctx.createGain(); this.gain.gain.value = 0.82;
    this.analyser = ctx.createAnalyser(); this.analyser.fftSize = 256;
    this.gain.connect(this.master); this.master.connect(this.analyser); this.analyser.connect(ctx.destination);
    this._t0 = 0; this._idx = 0; this._timer = null; this._noise = this._noiseBuffer();
  }

  _noiseBuffer() {
    const b = this.ctx.createBuffer(1, this.ctx.sampleRate * 0.5, this.ctx.sampleRate);
    const d = b.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
    return b;
  }

  // HEARD-time clock: ctx.currentTime is when samples are handed to the
  // audio stack; the speakers play them outputLatency later (40–150ms on
  // Windows!). Game time must align with what the EAR gets, or every note
  // arrives visibly early — the classic "feels unsynced" offset.
  time() { return this.ctx.currentTime - this._t0 - (this.ctx.outputLatency || this.ctx.baseLatency || 0); }

  play(delay = 0.15) {
    this._t0 = this.ctx.currentTime + delay;
    this._idx = 0;
    // lookahead scheduler: schedule everything landing in the next 0.35s
    this._timer = setInterval(() => {
      const until = this.time() + 0.35;
      const evs = this.pattern.events;
      while (this._idx < evs.length && evs[this._idx].t <= until) {
        this._schedule(evs[this._idx], this._t0 + evs[this._idx].t);
        this._idx++;
      }
      if (this._idx >= evs.length) { clearInterval(this._timer); this._timer = null; }
    }, 90);
  }

  stop() {
    if (this._timer) { clearInterval(this._timer); this._timer = null; }
    this.gain.gain.setTargetAtTime(0, this.ctx.currentTime, 0.08);
    setTimeout(() => { try { this.gain.disconnect(); } catch (e) {} }, 400);
  }

  _env(t, a, peak, dec) {
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(peak, t + a);
    g.gain.exponentialRampToValueAtTime(0.0001, t + a + dec);
    return g;
  }

  _schedule(e, t) {
    const c = this.ctx;
    if (e.kind === 'kick') {
      const o = c.createOscillator(); o.type = 'sine';
      o.frequency.setValueAtTime(155, t); o.frequency.exponentialRampToValueAtTime(44, t + 0.11);
      const g = this._env(t, 0.002, e.soft ? 0.5 : 1.0, 0.19);
      o.connect(g); g.connect(this.gain); o.start(t); o.stop(t + 0.25);
    } else if (e.kind === 'snare') {
      const n = c.createBufferSource(); n.buffer = this._noise;
      const f = c.createBiquadFilter(); f.type = 'bandpass'; f.frequency.value = 1900; f.Q.value = 0.8;
      const g = this._env(t, 0.001, e.roll ? 0.3 : 0.55, 0.13);
      n.connect(f); f.connect(g); g.connect(this.gain); n.start(t); n.stop(t + 0.16);
      const o = c.createOscillator(); o.type = 'triangle'; o.frequency.value = 192;
      const g2 = this._env(t, 0.001, 0.35, 0.07);
      o.connect(g2); g2.connect(this.gain); o.start(t); o.stop(t + 0.09);
    } else if (e.kind === 'hat') {
      const n = c.createBufferSource(); n.buffer = this._noise;
      const f = c.createBiquadFilter(); f.type = 'highpass'; f.frequency.value = 7400;
      const g = this._env(t, 0.001, 0.16, e.open ? 0.13 : 0.035);
      n.connect(f); f.connect(g); g.connect(this.gain); n.start(t); n.stop(t + 0.16);
    } else if (e.kind === 'bass') {
      const o = c.createOscillator(); o.type = 'sawtooth'; o.frequency.value = midiHz(e.midi);
      const s = c.createOscillator(); s.type = 'square'; s.frequency.value = midiHz(e.midi - 12);
      const f = c.createBiquadFilter(); f.type = 'lowpass'; f.Q.value = 4;
      f.frequency.setValueAtTime(e.accent ? 1500 : 820, t);
      f.frequency.exponentialRampToValueAtTime(220, t + e.dur);
      const g = this._env(t, 0.004, e.accent ? 0.5 : 0.38, e.dur);
      const gs = c.createGain(); gs.gain.value = 0.5;
      o.connect(f); s.connect(gs); gs.connect(f); f.connect(g); g.connect(this.gain);
      o.start(t); o.stop(t + e.dur + 0.05); s.start(t); s.stop(t + e.dur + 0.05);
    } else if (e.kind === 'stab' || e.kind === 'pad') {
      const dur = e.dur || 0.28;
      for (const m of e.chord) {
        for (const det of [-6, 6]) {
          const o = c.createOscillator(); o.type = 'sawtooth';
          o.frequency.value = midiHz(m); o.detune.value = det;
          const f = c.createBiquadFilter(); f.type = 'lowpass';
          f.frequency.setValueAtTime(e.kind === 'pad' ? 900 : 2600, t);
          f.frequency.exponentialRampToValueAtTime(e.kind === 'pad' ? 500 : 700, t + dur);
          const g = this._env(t, e.kind === 'pad' ? 0.4 : 0.006, e.kind === 'pad' ? 0.05 : 0.10, dur);
          o.connect(f); f.connect(g); g.connect(this.gain);
          o.start(t); o.stop(t + dur + 0.5);
        }
      }
    }
  }
}

// ── 3. MP3/any-audio analysis (pure DSP over Float32) ───────────
/**
 * Onset + tempo analysis of a mono signal.
 * Returns { bpm, offset, onsets: [{ t, energy, low }] } — `low` = the
 * onset is low-band dominant (kick-like → low row in the beat map).
 */
export function analyzeSignal(data, sampleRate) {
  const hop = 512, frame = 1024;
  const nF = Math.max(0, Math.floor((data.length - frame) / hop));
  const full = new Float32Array(nF), low = new Float32Array(nF);
  // one-pole lowpass ≈150Hz tracks the kick band without an FFT
  const a = Math.exp(-2 * Math.PI * 150 / sampleRate);
  let lp = 0;
  const lowSig = new Float32Array(data.length);
  for (let i = 0; i < data.length; i++) { lp = a * lp + (1 - a) * data[i]; lowSig[i] = lp; }
  for (let f = 0; f < nF; f++) {
    let e = 0, el = 0;
    const off = f * hop;
    for (let i = 0; i < frame; i++) { const s = data[off + i]; e += s * s; const l = lowSig[off + i]; el += l * l; }
    full[f] = Math.sqrt(e / frame); low[f] = Math.sqrt(el / frame);
  }
  // flux (half-wave rectified difference)
  const flux = new Float32Array(nF), lflux = new Float32Array(nF);
  for (let f = 1; f < nF; f++) {
    flux[f] = Math.max(0, full[f] - full[f - 1]);
    lflux[f] = Math.max(0, low[f] - low[f - 1]);
  }
  const fps = sampleRate / hop;

  // adaptive-threshold peak picking
  const onsets = [];
  const W = Math.round(fps * 0.18);   // ±180ms neighbourhood
  let mean = 0; for (let f = 0; f < nF; f++) mean += flux[f]; mean /= Math.max(nF, 1);
  for (let f = 2; f < nF - 2; f++) {
    if (flux[f] < mean * 1.4) continue;
    let isMax = true;
    for (let k = Math.max(0, f - W); k <= Math.min(nF - 1, f + W); k++) if (flux[k] > flux[f]) { isMax = false; break; }
    if (!isMax) continue;
    onsets.push({ t: f / fps, energy: flux[f], low: lflux[f] > flux[f] * 0.55 });
  }

  // BPM: autocorrelation of the flux envelope over LAGS (searching integer
  // BPMs quantizes badly at this hop rate — many BPMs share one lag), with
  // parabolic sub-lag refinement and a half-lag harmonic bonus.
  const corr = (lag) => {
    if (lag < 1 || lag >= nF) return 0;
    let s = 0;
    for (let f = 0; f + lag < nF; f++) s += flux[f] * flux[f + lag];
    return s / (nF - lag);
  };
  const minLag = Math.max(2, Math.floor(fps * 60 / 200));
  const maxLag = Math.min(nF - 2, Math.ceil(fps * 60 / 60));
  let bestLag = minLag, bestScore = -1;
  for (let lag = minLag; lag <= maxLag; lag++) {
    const s = corr(lag) + 0.4 * corr(lag * 2);
    if (s > bestScore) { bestScore = s; bestLag = lag; }
  }
  // parabolic peak refinement between neighbouring lags
  const c0 = corr(bestLag - 1), c1 = corr(bestLag), c2 = corr(bestLag + 1);
  const denom = c0 - 2 * c1 + c2;
  const shift = Math.abs(denom) > 1e-12 ? 0.5 * (c0 - c2) / denom : 0;
  let bestBpm = fps * 60 / (bestLag + Math.max(-0.5, Math.min(0.5, shift)));
  // prefer the 90–180 octave (halving/doubling ambiguity)
  while (bestBpm < 90) bestBpm *= 2;
  while (bestBpm > 180) bestBpm /= 2;
  bestBpm = Math.round(bestBpm * 10) / 10;

  // grid phase: offset in [0, beat) maximizing onset alignment
  const beat = 60 / bestBpm;
  let bestOff = 0, bestFit = -1;
  for (let k = 0; k < 24; k++) {
    const off = (k / 24) * beat;
    let fit = 0;
    for (const o of onsets) {
      const ph = ((o.t - off) % beat + beat) % beat;
      const d = Math.min(ph, beat - ph);
      if (d < 0.05) fit += o.energy;
    }
    if (fit > bestFit) { bestFit = fit; bestOff = off; }
  }
  return { bpm: bestBpm, offset: bestOff, onsets };
}

// ── 4. Beat-map builder (pure) ──────────────────────────────────
export const DIFFICULTY = {
  chill: { minGap: 0.46, density: 0.55, doubles: 0.06, walls: true },
  rush: { minGap: 0.30, density: 0.8, doubles: 0.14, walls: true },
  insane: { minGap: 0.19, density: 1.0, doubles: 0.22, walls: true },
};

/**
 * Build punch notes + dodge walls from either a synth pattern or an
 * audio analysis. Notes: { time, lane 0..3, row 0|1, hand 'left'|'right'|'any' }.
 * Walls: { time, side 'left'|'right', dur }. Deterministic (seeded LCG).
 */
export function buildBeatMap(src, difficulty = 'rush') {
  const D = DIFFICULTY[difficulty] || DIFFICULTY.rush;
  let seed = 1337;
  const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;

  // candidate hit events: { t, low(bool), energy }
  let cands = [], walls = [], duration = 0, leadIn = 2.2;
  if (src.events) {                       // synth pattern
    duration = src.duration;
    for (const e of src.events) {
      if (e.t < leadIn) continue;
      if (e.kind === 'kick' && !e.soft) cands.push({ t: e.t, low: true, energy: 1 });
      else if (e.kind === 'snare' && !e.roll) cands.push({ t: e.t, low: false, energy: 0.9 });
      else if (e.kind === 'stab') cands.push({ t: e.t, low: false, energy: 1.2, double: true });
      else if (e.kind === 'bass' && e.accent) cands.push({ t: e.t, low: true, energy: 0.55 });
    }
    // walls live in the breakdown (bars 36–44) — spatial dodge section
    const spb = 60 / src.bpm;
    for (let bar = 36; bar < 44; bar += 2) {
      walls.push({ time: bar * 4 * spb, side: (bar >> 1) % 2 ? 'right' : 'left', dur: 4 * spb });
    }
  } else {                                // analyzed audio
    const { onsets } = src;
    duration = src.duration || (onsets.length ? onsets[onsets.length - 1].t + 4 : 60);
    const emax = onsets.reduce((m, o) => Math.max(m, o.energy), 1e-9);
    for (const o of onsets) {
      if (o.t < leadIn) continue;
      // NOTES ANCHOR TO THE ONSETS THEMSELVES — the transients you actually
      // hear. Snapping to one global BPM grid was the desync: a 0.1 BPM
      // estimate error drifts ~100ms by mid-song, and onsets far from the
      // drifted grid were silently DROPPED (dead sections). The min-gap
      // gate below already dedupes double-triggers.
      cands.push({ t: o.t, low: o.low, energy: o.energy / emax, double: o.energy / emax > 0.92 });
    }
    // walls in quiet stretches (no strong onsets for ≥ 3.5s)
    let lastStrong = 0, side = 0;
    for (const o of onsets) {
      if (o.energy / emax > 0.4) {
        if (o.t - lastStrong > 3.5 && lastStrong > leadIn) {
          walls.push({ time: lastStrong + 0.8, side: side++ % 2 ? 'right' : 'left', dur: Math.min(o.t - lastStrong - 1.2, 3) });
        }
        lastStrong = o.t;
      }
    }
  }
  cands.sort((a, b) => a.t - b.t);

  // density gate + lane flow
  const notes = [];
  let lastT = -9, lane = 1, streakSide = 0;
  for (const c of cands) {
    if (c.t - lastT < D.minGap) continue;
    if (c.energy < 0.35 && rnd() > D.density) continue;
    lastT = c.t;
    // lanes 0,1 = left hand · 2,3 = right hand; flow = walk ±1, bias inward
    const goRight = (streakSide = (streakSide + (rnd() < 0.55 ? 1 : 0)) % 2) === 1;
    lane = goRight ? (rnd() < 0.6 ? 2 : 3) : (rnd() < 0.6 ? 1 : 0);
    const row = c.low ? 0 : 1;
    if (c.double && rnd() < D.doubles + 0.5) {
      notes.push({ time: c.t, lane: 1, row, hand: 'left' });
      notes.push({ time: c.t, lane: 2, row, hand: 'right' });
    } else {
      notes.push({ time: c.t, lane, row, hand: lane < 2 ? 'left' : 'right' });
    }
  }
  if (!D.walls) walls = [];
  // no notes while a wall is passing (dodging is the whole job)
  const clear = notes.filter(n => !walls.some(w => n.time > w.time - 0.4 && n.time < w.time + w.dur + 0.4));
  return { notes: clear, walls, duration };
}

// ── 5. File track (browser) ─────────────────────────────────────
export class FileTrack {
  /** Pass a pre-baked `analysis` ({bpm, offset, onsets}) to skip the DSP. */
  constructor(ctx, audioBuffer, name, analysis = null) {
    this.ctx = ctx;
    this.name = name;
    this.exactGrid = false;     // real songs drift vs any single grid —
    this.buffer = audioBuffer;  // the game pulses off runtime transients
    this.duration = audioBuffer.duration;
    this.gain = ctx.createGain(); this.gain.gain.value = 0.95;
    this.analyser = ctx.createAnalyser(); this.analyser.fftSize = 256;
    this.gain.connect(this.analyser); this.analyser.connect(ctx.destination);
    this._src = null; this._t0 = 0;
    if (analysis) {
      this.analysis = analysis;
    } else {
      // mono downmix → analysis
      const ch0 = audioBuffer.getChannelData(0);
      let mono = ch0;
      if (audioBuffer.numberOfChannels > 1) {
        const ch1 = audioBuffer.getChannelData(1);
        mono = new Float32Array(ch0.length);
        for (let i = 0; i < ch0.length; i++) mono[i] = (ch0[i] + ch1[i]) * 0.5;
      }
      this.analysis = analyzeSignal(mono, audioBuffer.sampleRate);
    }
    this.analysis.duration = this.duration;
    this.bpm = this.analysis.bpm;
  }

  // HEARD-time clock — see SynthTrack.time()
  time() { return this.ctx.currentTime - this._t0 - (this.ctx.outputLatency || this.ctx.baseLatency || 0); }

  play(delay = 0.15) {
    this._src = this.ctx.createBufferSource();
    this._src.buffer = this.buffer;
    this._src.connect(this.gain);
    this._t0 = this.ctx.currentTime + delay;
    this._src.start(this._t0);
  }

  stop() {
    try { if (this._src) this._src.stop(); } catch (e) {}
    this._src = null;
  }
}

/** Browser helper: File/Blob → FileTrack (decoded + analyzed). */
export async function loadFileTrack(ctx, file) {
  const buf = await file.arrayBuffer();
  const audio = await ctx.decodeAudioData(buf);
  return new FileTrack(ctx, audio, file.name.replace(/\.[^.]+$/, ''));
}
