/**
 * hopeOS lab — GhostView + overlay (contract stage 2: MID, visual half)
 * ═══════════════════════════════════════════════════════════════
 * The "floating reconstruction": the live 478 landmarks rendered as an
 * orbitable 3D point cloud with the contract's feature loops and probe
 * points emphasized in channel colors. This is the cross-reference
 * surface — if the ghost's mouth gap opens with yours and the 4 mouth
 * points ride the lips, stage 1→2 is proven visually.
 *
 * Also exports drawOverlay() — same loops drawn flat on the video.
 */

import { HUMAN_POINTS } from '../interaction/face-measures.js';

export const CH_COLOR = {
  mouth: '#ff5370', eyeL: '#82aaff', eyeR: '#c792ea',
  head: '#ffcb6b', tongue: '#f07178'
};

// Inner-lip loop (mouth.js INNER_LIP) + EAR loops — the contract's geometry
export const LIP_LOOP = [78,191,80,81,82,13,312,311,310,415,308,324,318,402,317,14,87,178,88,95];
export const EYE_L_LOOP = [362,385,387,263,373,380];
export const EYE_R_LOOP = [33,160,158,133,153,144];
export const MOUTH_PTS = [
  HUMAN_POINTS.mouth.upperInner, HUMAN_POINTS.mouth.lowerInner,
  HUMAN_POINTS.mouth.cornerL, HUMAN_POINTS.mouth.cornerR
];

export class GhostView {
  /** @param {HTMLCanvasElement} canvas */
  constructor(canvas, height = 360) {
    this.g = canvas;
    this.gc = canvas.getContext('2d');
    this.h = height;
    this.orbit = { yaw: 0.35, pitch: 0.1, drag: null };
    canvas.addEventListener('pointerdown', e => {
      this.orbit.drag = [e.clientX, e.clientY]; canvas.setPointerCapture(e.pointerId);
    });
    canvas.addEventListener('pointermove', e => {
      const o = this.orbit;
      if (!o.drag) return;
      o.yaw += (e.clientX - o.drag[0]) * 0.008;
      o.pitch = Math.max(-1.2, Math.min(1.2, o.pitch + (e.clientY - o.drag[1]) * 0.008));
      o.drag = [e.clientX, e.clientY];
    });
    canvas.addEventListener('pointerup', () => this.orbit.drag = null);
  }

  draw(lm) {
    const g = this.g, gc = this.gc;
    const w = g.width = g.clientWidth || 400, h = g.height = this.h;
    gc.clearRect(0, 0, w, h);
    if (!lm) { gc.fillStyle = '#484f58'; gc.fillText('no face', w/2 - 20, h/2); return; }
    let cx = 0, cy = 0, cz = 0;
    for (const p of lm) { cx += p.x; cy += p.y; cz += p.z; }
    cx /= lm.length; cy /= lm.length; cz /= lm.length;
    const o = this.orbit;
    const cyw = Math.cos(o.yaw), syw = Math.sin(o.yaw);
    const cpt = Math.cos(o.pitch), spt = Math.sin(o.pitch);
    const S = h * 1.35;
    const proj = p => {
      let x = -(p.x - cx), y = p.y - cy, z = p.z - cz;   // mirror x = selfie parity
      let X = x*cyw + z*syw, Z = -x*syw + z*cyw;
      let Y = y*cpt - Z*spt; Z = y*spt + Z*cpt;
      return [w/2 + X*S, h/2 + Y*S, Z];
    };
    gc.fillStyle = 'rgba(139,148,158,0.55)';
    for (let i = 0; i < lm.length; i++) {
      const [x, y] = proj(lm[i]); gc.fillRect(x, y, 1.5, 1.5);
    }
    const loop = (ids, color) => {
      gc.strokeStyle = color; gc.lineWidth = 1.5; gc.beginPath();
      ids.forEach((id, k) => { const [x, y] = proj(lm[id]); k ? gc.lineTo(x, y) : gc.moveTo(x, y); });
      gc.closePath(); gc.stroke();
    };
    loop(LIP_LOOP, CH_COLOR.mouth); loop(EYE_L_LOOP, CH_COLOR.eyeL); loop(EYE_R_LOOP, CH_COLOR.eyeR);
    gc.fillStyle = CH_COLOR.mouth;
    for (const id of MOUTH_PTS) {
      const [x, y] = proj(lm[id]); gc.beginPath(); gc.arc(x, y, 3.5, 0, 7); gc.fill();
    }
  }
}

/** Flat overlay on the (CSS-mirrored) video pane. Coords are raw video-normalized. */
export function drawOverlay(oc, lm, w, h) {
  oc.clearRect(0, 0, w, h);
  if (!lm) return;
  const loop = (ids, color) => {
    oc.strokeStyle = color; oc.lineWidth = 1.5; oc.beginPath();
    ids.forEach((id, k) => {
      const x = lm[id].x * w, y = lm[id].y * h; k ? oc.lineTo(x, y) : oc.moveTo(x, y);
    });
    oc.closePath(); oc.stroke();
  };
  loop(LIP_LOOP, CH_COLOR.mouth); loop(EYE_L_LOOP, CH_COLOR.eyeL); loop(EYE_R_LOOP, CH_COLOR.eyeR);
  oc.fillStyle = CH_COLOR.mouth;
  for (const id of MOUTH_PTS) oc.fillRect(lm[id].x*w - 2.5, lm[id].y*h - 2.5, 5, 5);
}
