/**
 * hopeOS SDK — rig-presets: packaged standard movements
 * ═══════════════════════════════════════════════════════════════
 * Pre-scripted animation generators. Each takes the RIG ROLES resolved by
 * skeleton-align.js (classifySkeleton → roles: head, neck[], spine[],
 * tail[], frontL[], frontR[], hindL[], hindR[], root, hip) and returns a
 * plain rig-script — the SAME format riglab's editor and dragged path
 * tracks use, so any preset can be REMIXED with a user path via
 * composeScripts() or chained into a film via sequenceScripts().
 *
 * Movement grounding (search-refined):
 * - walk: lizard lateral-couplet footfall FR → HL → FL → HR, each 25%
 *   phase apart, with lateral spine undulation phase-locked so ipsilateral
 *   forelimb touchdown lands at max lateral convexity (Farley & Ko 1997,
 *   J Exp Biol 200; arXiv:2201.09312 geometric mechanics of undulatory
 *   lizard locomotion). Tail continues the body wave with growing
 *   amplitude and phase lag.
 * - tremble: physiological tremor band ~8–12 Hz, sub-degree amplitude,
 *   phase-scattered per bone so it reads as shiver, not metronome.
 *
 * Roles a preset needs but the rig lacks are skipped silently — presets
 * degrade to whatever the skeleton offers.
 */

const seg = (arr, i) => (Array.isArray(arr) ? arr[i] : null);
const chain = arr => (Array.isArray(arr) ? arr : arr ? [arr] : []);

/** Deterministic phase scatter (no Math.random — repeatable scripts). */
const scatter = i => ((i * 2.399963) % (2 * Math.PI));   // golden-angle hop

// ── the presets ─────────────────────────────────────────────────

export function tremble(rig, { amp = 0.7, freq = 9 } = {}) {
  const bones = [...chain(rig.spine), ...chain(rig.neck), rig.head,
                 seg(rig.frontL, 0), seg(rig.frontR, 0),
                 seg(rig.hindL, 0), seg(rig.hindR, 0)].filter(Boolean);
  return {
    name: 'tremble', duration: 2, loop: true, tracks: [],
    oscillators: bones.flatMap((b, i) => [
      { bone: b, ch: 'rx', amp: amp * 0.8, freq: freq + (i % 3) * 0.7, phase: scatter(i) },
      { bone: b, ch: 'rz', amp, freq: freq + ((i + 1) % 3) * 0.6, phase: scatter(i + 7) },
    ]),
  };
}

export function breathe(rig, { amp = 1.6, freq = 0.28 } = {}) {
  const spine = chain(rig.spine), neck = chain(rig.neck);
  return {
    name: 'breathe', duration: 1 / freq, loop: true, tracks: [],
    oscillators: [
      ...spine.map((b, i) => ({ bone: b, ch: 'rx', amp: amp / Math.max(1, spine.length - i), freq })),
      ...neck.map(b => ({ bone: b, ch: 'rx', amp: amp * 0.4, freq, phase: 0.6 })),
    ],
  };
}

/** Lizard lateral-couplet walk-in-place: FR 0% → HL 25% → FL 50% → HR 75%,
 *  spine lateral wave phase-locked to the forelimbs, tail trailing. */
export function walk(rig, { freq = 1.3, swing = 14, lift = 8, wave = 7 } = {}) {
  const w = 2 * Math.PI;
  const legs = [
    { chain: rig.frontR, phase: 0.00, side: +1 },
    { chain: rig.hindL,  phase: 0.25, side: -1 },
    { chain: rig.frontL, phase: 0.50, side: -1 },
    { chain: rig.hindR,  phase: 0.75, side: +1 },
  ];
  const osc = [];
  for (const l of legs) {
    const hip = seg(l.chain, 0), knee = seg(l.chain, 1);
    if (!hip) continue;
    // protraction/retraction swing …
    osc.push({ bone: hip, ch: 'ry', amp: swing, freq, phase: w * l.phase });
    // … and a lift peaking mid-swing (quarter cycle later)
    if (knee) osc.push({ bone: knee, ch: 'rx', amp: lift, freq, phase: w * (l.phase + 0.25) });
  }
  // spine standing wave: FR footfall (phase 0) at max right-side convexity;
  // phase advances along the chain so the body S-bends
  const spine = chain(rig.spine);
  spine.forEach((b, i) => osc.push({
    bone: b, ch: 'rz', amp: wave, freq,
    phase: w * (0.25 + (i / Math.max(1, spine.length)) * 0.5),
  }));
  // tail continues the wave, bigger and later the further back
  const tail = chain(rig.tail);
  tail.forEach((b, i) => osc.push({
    bone: b, ch: 'rz', amp: wave * (1.2 + i * 0.5), freq,
    phase: w * (0.75 + (i / Math.max(1, tail.length)) * 0.6),
  }));
  // head counter-yaw keeps the gaze steadier than the shoulders
  for (const h of [rig.head, ...chain(rig.neck)].filter(Boolean))
    osc.push({ bone: h, ch: 'rz', amp: wave * 0.5, freq, phase: w * 0.75 });
  return { name: 'walk', duration: 1 / freq, loop: true, tracks: [], oscillators: osc };
}

export function tailSway(rig, { amp = 12, freq = 0.5 } = {}) {
  const tail = chain(rig.tail);
  return {
    name: 'tail-sway', duration: 1 / freq, loop: true, tracks: [],
    oscillators: tail.map((b, i) => ({
      bone: b, ch: 'rz', amp: amp * (1 + i * 0.6), freq,
      phase: (i / Math.max(1, tail.length)) * Math.PI,
    })),
  };
}

/** Keyframed look-around: left, hold, right, return. */
export function headLook(rig, { yaw = 28, pitch = 8 } = {}) {
  const bones = [rig.head, ...chain(rig.neck)].filter(Boolean);
  const share = 1 / Math.max(1, bones.length);
  return {
    name: 'head-look', duration: 4, loop: true,
    tracks: bones.flatMap(b => [
      { bone: b, ch: 'ry', keys: [[0, 0], [0.7, yaw * share], [1.6, yaw * share],
                                  [2.4, -yaw * share], [3.2, -yaw * share], [4, 0]] },
      { bone: b, ch: 'rx', keys: [[0, 0], [0.7, pitch * share], [2.4, -pitch * share], [4, 0]] },
    ]),
    oscillators: [],
  };
}

/** Mouth open/close — pure jaw-hinge rotation, no mesh distortion.
 *  NOTE the lizard's REST pose is sculpted mouth-OPEN, so "closed" is a
 *  negative rx on the lower-jaw hinge (−34° verified visually) and 0 is
 *  open. Cycle: close → hold → open → hold, with a small skull counter-tilt
 *  so the head participates naturally. */
export function mouth(rig, { close = 34, wider = 5 } = {}) {
  const hinge = seg(rig.jawLower || rig.jaw, 0);
  if (!hinge) return null;
  const tracks = [
    { bone: hinge, ch: 'rx',
      keys: [[0, -close], [0.9, -close], [1.5, wider], [2.2, wider], [2.8, -close], [3.2, -close]] },
  ];
  if (rig.head) tracks.push(
    { bone: rig.head, ch: 'rx', weight: 0.6,
      keys: [[0, 3], [0.9, 3], [1.5, -4], [2.2, -4], [2.8, 3], [3.2, 3]] });
  const upper = seg(rig.jawUpper, 0);
  if (upper) tracks.push(
    { bone: upper, ch: 'rx', weight: 0.5,
      keys: [[0, -6], [0.9, -6], [1.5, 4], [2.2, 4], [2.8, -6], [3.2, -6]] });
  return { name: 'mouth', duration: 3.2, loop: true, tracks, oscillators: [] };
}

/** Tongue flick — targets bones named *tongue* (e.g. Tongue_Mid/Tongue_Tip). */
export function tongueFlick(rig, { snap = 55 } = {}) {
  const [mid, tip] = rig.tongue || [];
  const tracks = [];
  if (mid) tracks.push(
    { bone: mid, ch: 'rx', keys: [[0, 0], [0.5, 0], [0.65, snap * 0.9], [0.85, -14], [1.1, 6], [1.35, 0]] },
    { bone: mid, ch: 'ry', keys: [[0, 0], [1.4, 0], [1.6, 18], [1.9, -18], [2.2, 0]] });
  if (tip) tracks.push(
    { bone: tip, ch: 'rx', keys: [[0, 0], [0.55, 0], [0.75, snap * 1.1], [1.0, -20], [1.3, 0]] });
  return { name: 'tongue-flick', duration: 2.4, loop: true, tracks, oscillators: [] };
}

// ── registry ────────────────────────────────────────────────────

export const PRESETS = {
  tremble:       { label: '〰 tremble',       build: tremble,     needs: ['spine'] },
  breathe:       { label: '◠ breathe',        build: breathe,     needs: ['spine'] },
  walk:          { label: '🦎 walk',          build: walk,        needs: ['frontL', 'hindL'] },
  'tail-sway':   { label: '∿ tail sway',      build: tailSway,    needs: ['tail'] },
  'head-look':   { label: '👀 head look',     build: headLook,    needs: ['head'] },
  mouth:         { label: '🗣 mouth',         build: mouth,       needs: ['jawLower'] },
  'tongue-flick':{ label: '👅 tongue flick',  build: tongueFlick, needs: ['tongue'] },
};

/** Build a preset by id against resolved roles; null if the rig can't. */
export function buildPreset(id, rig, opts) {
  const p = PRESETS[id];
  if (!p) return null;
  const has = r => { const v = rig[r]; return Array.isArray(v) ? v.length : !!v; };
  if (!p.needs.every(has)) return null;
  return p.build(rig, opts);
}
