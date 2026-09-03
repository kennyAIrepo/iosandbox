/**
 * hopeOS SDK — BowRig: procedural draw morph for a scanned/fused bow mesh.
 * ═══════════════════════════════════════════════════════════════════════════
 * The asset (bow.glb) is ONE fused mesh, no bones, modeled STRUNG AT REST:
 * the wood stave ARCS away from the chord (belly side) and the string runs
 * straight tip-to-tip on the chord. This rig adds the draw behavior without
 * touching the asset: rest positions are cached, so setDraw(0) restores the
 * original geometry bit-exact (physical-integrity contract).
 *
 * Classification is GEOMETRIC (the scan has one material):
 *   · spine axis   = longest bbox dimension; tips = extreme verts on it
 *   · chord        = tipA→tipB line
 *   · bellyDir     = dominant direction of LARGE deviations from the chord —
 *                    that is the WOOD's arc side (verified against the render:
 *                    the stave is the deviator, the string hugs the chord)
 *   · drawDir      = −bellyDir — the archer's side; the nock travels this way
 *   · string verts = the thin band deviating slightly TOWARD drawDir; a
 *                    smoothstep weight (not a hard cut) keeps tips seamless
 *
 * setDraw(d), d ∈ [0,1]:
 *   · STRING: rest slack arc → TWO TAUT SEGMENTS tip'→nock→tip' (the peak).
 *     Each vert keeps its rest offset from the measured string centerline, so
 *     the serving wrap and tube thickness ride along. The taut shape blends in
 *     early (E = min(1, 3d) — a real string tautens at the first inch of pull)
 *     and the nock keeps travelling with the pull.
 *   · WOOD: tips flex toward the string side with a quadratic profile s²
 *     (grip/middle stays put) plus a slight inward pull (arc shortening).
 *   · nock() reports the live nock point (arrow seat) in local space.
 */

import * as THREE from 'three';

const _v = new THREE.Vector3(), _w = new THREE.Vector3();
const smooth = (a, b, x) => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

export class BowRig {
  constructor(mesh, opts = {}) {
    this.mesh = mesh;
    this.opts = { drawMax: 0.38, bendMax: 0.06, inward: 0.35, ...opts };   // fractions of span
    const geo = mesh.geometry;
    // The morph works on a TIGHTLY PACKED [x,y,z…] Float32Array (raw-index
    // math in setDraw is the hot path). Optimized GLBs often ship INTERLEAVED
    // attributes (position+normal+uv sharing one strided buffer) — there
    // `array` is the whole interleaved block, so raw v*3 indexing reads
    // garbage. De-interleave once, up front, so every consumer is safe.
    let pos = geo.getAttribute('position');
    if (pos.isInterleavedBufferAttribute || pos.array.length !== pos.count * pos.itemSize) {
      const flat = new Float32Array(pos.count * 3);
      for (let v = 0; v < pos.count; v++) {
        flat[v * 3] = pos.getX(v); flat[v * 3 + 1] = pos.getY(v); flat[v * 3 + 2] = pos.getZ(v);
      }
      pos = new THREE.BufferAttribute(flat, 3);
      geo.setAttribute('position', pos);
      geo.computeBoundingBox(); geo.computeBoundingSphere();
    }
    this.rest = pos.array.slice();
    const n = pos.count;

    // ── spine axis + tips ──
    geo.computeBoundingBox();
    const size = geo.boundingBox.getSize(new THREE.Vector3()).toArray();
    const ax = size.indexOf(Math.max(...size));
    let iA = 0, iB = 0;
    for (let v = 1; v < n; v++) {
      if (this.rest[v * 3 + ax] < this.rest[iA * 3 + ax]) iA = v;
      if (this.rest[v * 3 + ax] > this.rest[iB * 3 + ax]) iB = v;
    }
    const tipA = new THREE.Vector3().fromArray(this.rest, iA * 3);
    const tipB = new THREE.Vector3().fromArray(this.rest, iB * 3);
    this.tipA = tipA; this.tipB = tipB;
    this.span = tipA.distanceTo(tipB);
    const chordDir = new THREE.Vector3().subVectors(tipB, tipA).normalize();
    this.chordDir = chordDir;

    // ── per-vert chord deviation; stringDir from the big deviators ──
    const dev = new Float32Array(n * 3);
    const t01 = new Float32Array(n);
    let maxDev = 0;
    for (let v = 0; v < n; v++) {
      _v.fromArray(this.rest, v * 3).sub(tipA);
      const along = _v.dot(chordDir);
      t01[v] = Math.min(1, Math.max(0, along / this.span));
      _w.copy(chordDir).multiplyScalar(along);
      _v.sub(_w);                                            // perpendicular offset
      dev[v * 3] = _v.x; dev[v * 3 + 1] = _v.y; dev[v * 3 + 2] = _v.z;
      const dl = _v.length();
      if (dl > maxDev) maxDev = dl;
    }
    const bellyDir = new THREE.Vector3();
    for (let v = 0; v < n; v++) {
      _v.fromArray(dev, v * 3);
      if (_v.length() > maxDev * 0.35) bellyDir.add(_v);
    }
    bellyDir.normalize();
    this.bellyDir = bellyDir;
    const drawDir = bellyDir.clone().negate();  // archer's side — the nock travels this way
    this.drawDir = drawDir;

    // ── string weight: the thin band slightly on the DRAW side of the chord
    // (the stave sits on the belly side or dead on the chord near the tips) ──
    const wLo = 0.002 * this.span, wHi = 0.005 * this.span;
    this.w = new Float32Array(n);
    this.t = t01;
    let sc = 0;
    for (let v = 0; v < n; v++) {
      const sdev = dev[v * 3] * drawDir.x + dev[v * 3 + 1] * drawDir.y + dev[v * 3 + 2] * drawDir.z;
      this.w[v] = smooth(wLo, wHi, sdev);
      if (this.w[v] > 0.5) sc++;
    }
    this.stats = { verts: n, stringVerts: sc, woodVerts: n - sc, span: this.span };

    // ── rest string centerline, binned by t (offsets ride the deformation) ──
    const BINS = this.BINS = 64;
    const cl = this.centerline = new Float32Array(BINS * 3);
    const cn = new Float32Array(BINS);
    for (let v = 0; v < n; v++) {
      if (this.w[v] < 0.5) continue;
      const b = Math.min(BINS - 1, Math.floor(t01[v] * BINS));
      cl[b * 3] += this.rest[v * 3]; cl[b * 3 + 1] += this.rest[v * 3 + 1]; cl[b * 3 + 2] += this.rest[v * 3 + 2];
      cn[b]++;
    }
    for (let b = 0; b < BINS; b++) {
      if (cn[b]) { cl[b * 3] /= cn[b]; cl[b * 3 + 1] /= cn[b]; cl[b * 3 + 2] /= cn[b]; }
    }
    for (let b = 0; b < BINS; b++) {                        // fill gaps from neighbours
      if (cn[b]) continue;
      let p = b - 1; while (p >= 0 && !cn[p]) p--;
      let q = b + 1; while (q < BINS && !cn[q]) q++;
      const P = p >= 0 ? p : q, Q = q < BINS ? q : p;
      const f = Q === P ? 0 : (b - P) / (Q - P);
      for (let d = 0; d < 3; d++) cl[b * 3 + d] = cl[P * 3 + d] * (1 - f) + cl[Q * 3 + d] * f;
    }
    // rest offset: where the string mid sits relative to the chord mid
    const mid = new THREE.Vector3().addVectors(tipA, tipB).multiplyScalar(0.5);
    this.chordMid = mid;
    _v.fromArray(cl, Math.floor(BINS / 2) * 3).sub(mid);
    this.stringRest = Math.max(0, _v.dot(drawDir));

    // grip anchor: centroid of the WOOD around mid-span (where a fist holds it)
    const grip = new THREE.Vector3();
    let gn = 0;
    for (let v = 0; v < n; v++) {
      if (this.w[v] > 0.2 || Math.abs(t01[v] - 0.5) > 0.06) continue;
      grip.add(_v.fromArray(this.rest, v * 3));
      gn++;
    }
    this.gripLocal = gn ? grip.multiplyScalar(1 / gn) : mid.clone();

    this.draw = 0;
  }

  /** Rest (undrawn) nock point in mesh-local space — the string-pinch target. */
  nockRest(out = new THREE.Vector3()) {
    return out.copy(this.chordMid).addScaledVector(this.drawDir, this.stringRest);
  }

  /** Live nock point (arrow seat) in mesh-local space for the current draw. */
  nock(out = new THREE.Vector3()) {
    const pull = this.stringRest + this.draw * this.opts.drawMax * this.span;
    return out.copy(this.chordMid).addScaledVector(this.drawDir, pull);
  }

  /** The ACTUAL nock: the off-axis hand-on-string target from the last
   *  setDraw when one was given, else the axial ideal. Arrow seats here. */
  nockLive(out = new THREE.Vector3()) {
    return this._nockLive ? out.copy(this._nockLive) : this.nock(out);
  }

  /**
   * @param {number} d draw fraction 0..1 — drives limb flex + shot power.
   * @param {THREE.Vector3} [nockLocal] mesh-local STRING TARGET: the hand on
   *   the string. The taut two-segment path runs THROUGH this point — the
   *   peak forms AT the fingers, on or off the draw axis, and keeps following
   *   past full power (the caller may overdraw the target). Without it the
   *   nock rides the axial draw line as before.
   */
  setDraw(d, nockLocal = null) {
    d = Math.min(1, Math.max(0, d));
    this.draw = d;
    if (nockLocal) (this._nockLive = this._nockLive || new THREE.Vector3()).copy(nockLocal);
    else this._nockLive = null;
    const pos = this.mesh.geometry.getAttribute('position');
    const P = pos.array, R = this.rest, n = pos.count;
    const o = this.opts, span = this.span;
    if (d === 0 && !nockLocal) {                            // integrity: bit-exact rest
      P.set(R);
    } else {
      // a hand ON the string owns it fully — a finger pressing a string makes
      // its kink immediately; the ramp-in is only for the axial (keyboard) lane
      const E = nockLocal ? 1 : Math.min(1, d * 3);
      const bend = o.bendMax * span * d;
      const nockP = nockLocal ? _w.copy(nockLocal) : this.nock(_w);
      // tips after the wood bend (the taut segments hang off the MOVED tips)
      const tA = _tmpA.copy(this.tipA).addScaledVector(this.drawDir, bend)
        .addScaledVector(this.chordDir, o.inward * bend);
      const tB = _tmpB.copy(this.tipB).addScaledVector(this.drawDir, bend)
        .addScaledVector(this.chordDir, -o.inward * bend);
      for (let v = 0; v < n; v++) {
        const i3 = v * 3, w = this.w[v], t = this.t[v];
        // WOOD: quadratic flex from the still middle toward the tips, bending
        // toward the archer (drawDir) as the string loads the limbs
        const s = Math.abs(t - 0.5) * 2, s2 = s * s;
        let wx = R[i3] + (this.drawDir.x * s2 + this.chordDir.x * o.inward * s2 * (t < 0.5 ? 1 : -1)) * bend;
        let wy = R[i3 + 1] + (this.drawDir.y * s2 + this.chordDir.y * o.inward * s2 * (t < 0.5 ? 1 : -1)) * bend;
        let wz = R[i3 + 2] + (this.drawDir.z * s2 + this.chordDir.z * o.inward * s2 * (t < 0.5 ? 1 : -1)) * bend;
        if (w > 0) {
          // STRING: point on the taut two-segment path + rest offset from the
          // slack centerline, blended in by E (and by w near the tips)
          const b = Math.min(this.BINS - 1, Math.floor(t * this.BINS));
          let px, py, pz;
          if (t < 0.5) {
            const f = t * 2;
            px = tA.x + (nockP.x - tA.x) * f; py = tA.y + (nockP.y - tA.y) * f; pz = tA.z + (nockP.z - tA.z) * f;
          } else {
            const f = (t - 0.5) * 2;
            px = nockP.x + (tB.x - nockP.x) * f; py = nockP.y + (tB.y - nockP.y) * f; pz = nockP.z + (tB.z - nockP.z) * f;
          }
          const sx = px + (R[i3] - this.centerline[b * 3]);
          const sy = py + (R[i3 + 1] - this.centerline[b * 3 + 1]);
          const sz = pz + (R[i3 + 2] - this.centerline[b * 3 + 2]);
          const m = w * E;
          wx += (sx - wx) * m; wy += (sy - wy) * m; wz += (sz - wz) * m;
        }
        P[i3] = wx; P[i3 + 1] = wy; P[i3 + 2] = wz;
      }
    }
    pos.needsUpdate = true;
    this.mesh.geometry.computeVertexNormals();
    this.mesh.geometry.computeBoundingBox();
    this.mesh.geometry.computeBoundingSphere();
  }
}
const _tmpA = new THREE.Vector3(), _tmpB = new THREE.Vector3();
