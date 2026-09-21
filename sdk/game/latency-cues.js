/**
 * latency-cues.mjs — the tricks that hide what latency is left (latency-feel.md §5). Browser-only (three.js 0.160).
 * ─────────────────────────────────────────────────────────────────────────────
 *   GhostBall        predicted-arrival ball in the receiving tile's three.js scene (35 % alpha → real at tEdge')
 *   ArrivalRing      2D ring on the gallery overlay at the exact edge coordinate, shrinking 3R → R to tEdge'
 *   boundaryStretch  tEdge' = max(tEdge, now + minLeadMs); gutterTimeScale for the visible slow-mo
 *   EntryBlend       100 ms exponential blend from gutter speed to the capped entry speed
 *   AudioCues        WebAudio whoosh panned toward the receiving tile, thud on support/cradle, chime on goal
 *   handAgeAlpha     fade a remote holohand whose packets are stale
 *
 * Real APIs only: three.js 0.160 (Mesh, SphereGeometry, MeshBasicMaterial), CanvasRenderingContext2D,
 * AudioContext / StereoPannerNode / BiquadFilterNode / OscillatorNode / GainNode
 * (https://developer.mozilla.org/docs/Web/API/Web_Audio_API).
 */
import * as THREE from 'three';
import { integrateCourt } from './court-map.js';

/** tEdge' — never let the ball appear sooner than minLeadMs after the receiver learned of it. (Racer used a 75 ms threshold to decide adjust-vs-jump, https://web.dev/racer; we use 80.) */
export function boundaryStretch(tEdge, nowSession, minLeadMs = 80) {
  const min = nowSession + minLeadMs;
  return ((tEdge - min) | 0) < 0 ? min : tEdge;              // wrap-safe u32 compare
}
/** Time scale for the gutter segment when a stretch happened: 0.4× reads as deliberate slow-mo; never applied inside a tile. */
export function gutterTimeScale(stretchedMs) { return stretchedMs > 0 ? 0.4 : 1; }

/** Entry shaping: blend the ball's speed from what it had in the gutter to the capped entry speed over ~100 ms (latency-feel.md §5.5). */
export class EntryBlend {
  constructor({ capUnitsPerS = 2.0, tauMs = 100 } = {}) { this.cap = capUnitsPerS; this.tau = tauMs; this.t0 = 0; this.v0 = 0; }
  start(vx, vy, nowMs) { this.t0 = nowMs; this.v0 = Math.hypot(vx, vy); }
  /** returns the speed multiplier to apply to (vx, vy) this frame */
  factor(vx, vy, nowMs) {
    const s = Math.hypot(vx, vy); if (s <= this.cap || s < 1e-6) return 1;
    const a = 1 - Math.exp(-(nowMs - this.t0) / this.tau);      // 0 → 1 over ~3 tau
    const target = this.v0 + (this.cap - this.v0) * a;
    return target / s;
  }
}

// ── GhostBall (three.js, in the receiving tile's scene) ─────────────────────
export class GhostBall {
  constructor(scene, radiusWorld, color = 0xff4d4d) {
    this.mesh = new THREE.Mesh(new THREE.SphereGeometry(radiusWorld, 24, 16),
      new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.35, depthWrite: false }));
    this.mesh.visible = false; scene.add(this.mesh);
    this.state = null;   // {x,y,vx,vy,tl}
  }
  /** Start from a LAUNCH (court units, already wrap-shifted) at session time; `toWorld(x,y)` maps court → this tile's world at the hand plane. */
  start(launch, sessionNow, toWorld, floorY, R) {
    this.state = { x: launch.x, y: launch.y, vx: launch.vx, vy: launch.vy, tl: performance.now() - Math.max(0, (sessionNow - launch.t) | 0) };
    this.floorY = floorY; this.R = R; this.toWorld = toWorld; this.mesh.visible = true;
  }
  update() {
    const s = this.state; if (!s) return;
    const now = performance.now(); let remain = (now - s.tl) / 1000; s.tl = now;
    while (remain > 1e-6) { const dt = Math.min(1 / 60, remain); integrateCourt(s, dt, this.floorY, this.R); remain -= dt; }
    const p = this.toWorld(s.x, s.y); this.mesh.position.set(p.x, p.y, p.z);
  }
  /** At tEdge' the ghost becomes the real ball: fade opacity to 1 over 80 ms, then hide (the real ball takes over). */
  promote() {
    const m = this.mesh.material, t0 = performance.now();
    const step = () => { const a = Math.min(1, (performance.now() - t0) / 80); m.opacity = 0.35 + 0.65 * a; if (a < 1) requestAnimationFrame(step); else { this.mesh.visible = false; this.state = null; m.opacity = 0.35; } };
    step();
  }
  cancel() { this.mesh.visible = false; this.state = null; }
}

// ── ArrivalRing (2D overlay over the whole gallery) ─────────────────────────
export class ArrivalRing {
  /** @param {CanvasRenderingContext2D} ctx overlay canvas covering the gallery; `courtToPx(x,y)` → {px,py,pr} from CourtMap.courtToViewerPx */
  constructor(ctx, courtToPx) { this.ctx = ctx; this.toPx = courtToPx; this.active = null; }
  /** edge: 0 L, 1 R, 2 T; cEdge = court coordinate along the edge; tEdgeEff session ms; leadMs = how long before arrival the ring shows (≥ 300 ms per latency-feel.md §3) */
  show({ rect, edge, cEdge, tEdgeEff, color = '#ff4d4d', leadMs = 400, dashed = false }) {
    const x = edge === 0 ? rect.x0 : edge === 1 ? rect.x0 + rect.w : cEdge;
    const y = edge === 2 ? rect.y0 + rect.h : cEdge;
    this.active = { x, y, tEdgeEff, color, leadMs, dashed };   // dashed = PREDICTED (ArrivalPredictor, from BALL_STATE); solid = confirmed by a LAUNCH
  }
  draw(sessionNow) {
    const a = this.active; if (!a) return;
    const remain = (a.tEdgeEff - sessionNow) | 0;
    if (remain < -120) { this.active = null; return; }
    const p = this.toPx(a.x, a.y);
    const f = Math.max(0, Math.min(1, remain / a.leadMs));  // 1 = far away, 0 = now
    const r = p.pr * (1 + 2 * f);                            // 3R → R: tells the hand WHERE to be
    const c = this.ctx; c.save(); c.strokeStyle = a.color; c.globalAlpha = 0.85; c.lineWidth = Math.max(2, p.pr * 0.25);
    if (a.dashed) c.setLineDash([6, 6]);
    c.beginPath(); c.arc(p.px, p.py, r, 0, Math.PI * 2); c.stroke();
    if (remain <= 0) { c.globalAlpha = 0.35; c.beginPath(); c.arc(p.px, p.py, p.pr * 1.2, 0, Math.PI * 2); c.fillStyle = a.color; c.fill(); }
    c.restore();
  }
  clear() { this.active = null; }
}

// ── AudioCues ───────────────────────────────────────────────────────────────
export class AudioCues {
  constructor() { this.ctx = null; }
  /** call once from a user gesture (autoplay policy) */
  unlock() { if (!this.ctx) this.ctx = new AudioContext(); if (this.ctx.state === 'suspended') this.ctx.resume(); }
  /** pan: -1 left … +1 right, from the receiving tile's centre in viewer px (panForTile) */
  whoosh(pan = 0, durMs = 350) {
    if (!this.ctx) return; const ac = this.ctx, t = ac.currentTime;
    const src = ac.createBufferSource(); const n = Math.floor(ac.sampleRate * durMs / 1000);
    const buf = ac.createBuffer(1, n, ac.sampleRate); const d = buf.getChannelData(0);
    for (let i = 0; i < n; i++) d[i] = (Math.random() * 2 - 1) * Math.sin(Math.PI * i / n);   // windowed noise
    src.buffer = buf;
    const bp = ac.createBiquadFilter(); bp.type = 'bandpass'; bp.frequency.setValueAtTime(600, t); bp.frequency.exponentialRampToValueAtTime(2400, t + durMs / 1000);
    const g = ac.createGain(); g.gain.setValueAtTime(0.25, t);
    const p = ac.createStereoPanner(); p.pan.setValueAtTime(pan, t);
    src.connect(bp).connect(g).connect(p).connect(ac.destination); src.start(t);
  }
  thud(pan = 0) {
    if (!this.ctx) return; const ac = this.ctx, t = ac.currentTime;
    const o = ac.createOscillator(); o.type = 'sine'; o.frequency.setValueAtTime(140, t); o.frequency.exponentialRampToValueAtTime(50, t + 0.12);
    const g = ac.createGain(); g.gain.setValueAtTime(0.4, t); g.gain.exponentialRampToValueAtTime(0.001, t + 0.15);
    const p = ac.createStereoPanner(); p.pan.setValueAtTime(pan, t);
    o.connect(g).connect(p).connect(ac.destination); o.start(t); o.stop(t + 0.16);
  }
  goal() {
    if (!this.ctx) return; const ac = this.ctx, t = ac.currentTime;
    [523.25, 659.25, 783.99].forEach((f, i) => {
      const o = ac.createOscillator(); o.frequency.value = f; const g = ac.createGain();
      g.gain.setValueAtTime(0.0001, t + i * 0.08); g.gain.exponentialRampToValueAtTime(0.3, t + i * 0.08 + 0.02); g.gain.exponentialRampToValueAtTime(0.0001, t + i * 0.08 + 0.5);
      o.connect(g).connect(ac.destination); o.start(t + i * 0.08); o.stop(t + i * 0.08 + 0.5);
    });
  }
}

/** Remote holohand alpha from packet age: 1 until 150 ms, then linear to 0.5 at 400 ms (an honest "stale" cue, not a frozen hand). */
export function handAgeAlpha(ageMs) { return ageMs <= 150 ? 1 : Math.max(0.5, 1 - (ageMs - 150) / 500); }

/** Pan value for a tile: -1..+1 from its centre px across the gallery width. */
export function panForTile(domRect, galleryWidthPx) { return Math.max(-1, Math.min(1, ((domRect.left + domRect.width / 2) / galleryWidthPx) * 2 - 1)); }

// ═══════════════════════════════════════════════════════════════════════════════════════════════════════════════
// T4 appends (teamslab twin, CONTRACTS §3.7). Nothing above this line changed except the optional `dashed` flag on
// ArrivalRing.show/draw (setLineDash([6, 6]) for a PREDICTED arrival).
// ═══════════════════════════════════════════════════════════════════════════════════════════════════════════════
import { SEAT_NONE } from './court-map.js';
import { HOLD, dt32 } from './ball-net.js';

/**
 * ArrivalPredictor — turns the cue lead from "gutter time" (27-80 ms) into "in-tile flight time" (hundreds of ms) with zero
 * extra packets (game-feel-first DESIGN §7.4.1, latency-feel.md §3): every non-owner runs CourtMap.predictExit on each
 * FREE-flight BALL_STATE (the same integrator every client shares, so the estimate is reproducible); when the predicted
 * neighbour is me the ring shows at cEdge with tEdgeEst, dashed. The LAUNCH later confirms it (solid, tEdgeEff).
 * Node-safe: no DOM, no three.js, plain numbers.
 */
export class ArrivalPredictor {
  /** @param {{court:import('./court-map.js').CourtMap, mySeat:number, minLeadMs?:number}} o */
  constructor({ court, mySeat, minLeadMs = 300 }) {
    this.court = court; this.mySeat = mySeat; this.minLeadMs = minLeadMs;
    this.pred = null;                                           // { seat, edge, cEdge, tEdgeEst, predicted, since }
    this.stats = { predictions: 0, confirmed: 0, moved: 0 };   // moved = the edge point moved > 0.2 u between successive predictions
  }
  /** BALL_STATE from BallNet.hooks.onRemoteState. Ignored while in transit / in a gutter; a held ball clears the prediction. */
  onState(s, nowMs) {
    if (!s || s.inTransit || s.seat === SEAT_NONE || s.seat === undefined) return;
    if (s.hold && s.hold.mode !== HOLD.FREE) { this.clear(); return; }
    if (!this.court.rectOf(s.seat)) return;
    const p = this.court.predictExit(s.seat, s.x, s.y, s.vx, s.vy, s.t);
    if (!p || p.to !== this.mySeat) { this.clear(); return; }
    const prev = this.pred;
    if (prev && prev.predicted) {
      if (prev.edge !== p.edge || Math.abs(prev.cEdge - p.cEdge) > 0.2) this.stats.moved++;
    } else this.stats.predictions++;
    this.pred = { seat: s.seat, edge: p.edge, cEdge: p.cEdge, tEdgeEst: p.tEdge, predicted: true, since: prev && prev.predicted ? prev.since : nowMs };
  }
  /** LAUNCH seen (BallNet.hooks.onLaunchSeen): confirms (solid ring, tEdgeEff) when it is headed to me, else clears. */
  onLaunch(l) {
    if (!l || l.to !== this.mySeat) { this.clear(); return; }
    if (this.pred && this.pred.predicted) this.stats.confirmed++;
    this.pred = { seat: l.from, edge: l.edge, cEdge: l.cEdge, tEdgeEst: l.tEdgeEff ?? l.tEdge, predicted: false, since: this.pred ? this.pred.since : 0 };
  }
  /** @returns {{seat, edge, cEdge, tEdgeEst, predicted, leadMs}|null} leadMs = tEdgeEst - nowMs (session clock, wrap-safe) */
  read(nowMs) {
    const p = this.pred; if (!p) return null;
    return { seat: p.seat, edge: p.edge, cEdge: p.cEdge, tEdgeEst: p.tEdgeEst, predicted: p.predicted, leadMs: dt32(p.tEdgeEst, nowMs) };
  }
  clear() { this.pred = null; }
}

/**
 * MissCue — a 200 ms tile-edge ring fade + halo on the 2D overlay: 'miss' (danger), 'catch' (success), 'save' (brand),
 * 'goal' (marigold). `domRect` is the tile's rect relative to the overlay canvas ({left, top, width, height}).
 */
export class MissCue {
  constructor(ctx) { this.ctx = ctx; this.active = []; this.durMs = 200; }
  static COLORS = Object.freeze({ miss: '#c4314b', catch: '#13a10e', save: '#5b5fc7', goal: '#eaa300' });
  show(domRect, kind = 'miss', color = null) {
    if (!domRect) return;
    const now = (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();
    this.active.push({ rect: { left: domRect.left, top: domRect.top, width: domRect.width, height: domRect.height }, kind, color: color || MissCue.COLORS[kind] || MissCue.COLORS.miss, t0: now });
  }
  draw(nowLocal) {
    if (!this.active.length || !this.ctx) return;
    const c = this.ctx, keep = [];
    for (const a of this.active) {
      const f = (nowLocal - a.t0) / this.durMs;                  // 0 → 1 over 200 ms
      if (f >= 1) continue;
      keep.push(a);
      const r = a.rect, w = Math.max(3, Math.min(r.width, r.height) * 0.02);
      c.save();
      c.globalAlpha = 0.18 * (1 - f); c.fillStyle = a.color;     // halo
      c.fillRect(r.left, r.top, r.width, r.height);
      c.globalAlpha = 0.9 * (1 - f); c.strokeStyle = a.color; c.lineWidth = w * (1 + f * 2);   // ring fade + grow
      c.strokeRect(r.left + w / 2, r.top + w / 2, r.width - w, r.height - w);
      c.restore();
    }
    this.active = keep;
  }
  clear() { this.active.length = 0; }
}
