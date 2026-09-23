// How many cloth particles fit a frame on THIS box? Flat-array XPBD, the loop we'd actually ship.
// structural + shear + bend constraints, Gauss-Seidel, N substeps, plus sphere-collision probes.
function build(nx, ny, spacing) {
  const n = nx * ny;
  const x = new Float32Array(n * 3), p = new Float32Array(n * 3), v = new Float32Array(n * 3), w = new Float32Array(n).fill(1);
  for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
    const k = (j * nx + i) * 3; x[k] = i * spacing; x[k + 1] = 0; x[k + 2] = j * spacing;
  }
  const A = [], B = [], L = [], C = [];   // i, j, restlen, compliance
  const add = (a, b, c) => { const ka = a * 3, kb = b * 3;
    const dx = x[ka] - x[kb], dy = x[ka + 1] - x[kb + 1], dz = x[ka + 2] - x[kb + 2];
    A.push(a); B.push(b); L.push(Math.hypot(dx, dy, dz)); C.push(c); };
  const id = (i, j) => j * nx + i;
  for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
    if (i + 1 < nx) add(id(i, j), id(i + 1, j), 0);          // structural
    if (j + 1 < ny) add(id(i, j), id(i, j + 1), 0);
    if (i + 1 < nx && j + 1 < ny) { add(id(i, j), id(i + 1, j + 1), 1e-7); add(id(i + 1, j), id(i, j + 1), 1e-7); } // shear
    if (i + 2 < nx) add(id(i, j), id(i + 2, j), 2e-6);        // bend
    if (j + 2 < ny) add(id(i, j), id(i, j + 2), 2e-6);
  }
  return { n, x, p, v, w, A: Int32Array.from(A), B: Int32Array.from(B), L: Float32Array.from(L), C: Float32Array.from(C) };
}
function step(S, dt, subs, spheres) {
  const { n, x, p, v, w, A, B, L, C } = S, h = dt / subs, m = A.length;
  for (let s = 0; s < subs; s++) {
    for (let i = 0; i < n; i++) { const k = i * 3;
      v[k + 1] -= 9.81 * h; p[k] = x[k] + v[k] * h; p[k + 1] = x[k + 1] + v[k + 1] * h; p[k + 2] = x[k + 2] + v[k + 2] * h; }
    for (let c = 0; c < m; c++) {
      const a = A[c] * 3, b = B[c] * 3, rest = L[c], al = C[c] / (h * h);
      const dx = p[a] - p[b], dy = p[a + 1] - p[b + 1], dz = p[a + 2] - p[b + 2];
      const d = Math.sqrt(dx * dx + dy * dy + dz * dz); if (d < 1e-9) continue;
      const wa = w[A[c]], wb = w[B[c]], s2 = (d - rest) / (d * (wa + wb + al));
      p[a] -= dx * s2 * wa; p[a + 1] -= dy * s2 * wa; p[a + 2] -= dz * s2 * wa;
      p[b] += dx * s2 * wb; p[b + 1] += dy * s2 * wb; p[b + 2] += dz * s2 * wb;
    }
    for (const sp of spheres) {                       // 42 joint spheres = two hands
      const cx = sp[0], cy = sp[1], cz = sp[2], r = sp[3];
      for (let i = 0; i < n; i++) { const k = i * 3;
        const dx = p[k] - cx, dy = p[k + 1] - cy, dz = p[k + 2] - cz;
        const d2 = dx * dx + dy * dy + dz * dz;
        if (d2 < r * r && d2 > 1e-12) { const d = Math.sqrt(d2), f = (r - d) / d;
          p[k] += dx * f; p[k + 1] += dy * f; p[k + 2] += dz * f; } }
    }
    for (let i = 0; i < n; i++) { const k = i * 3;
      v[k] = (p[k] - x[k]) / h; v[k + 1] = (p[k + 1] - x[k + 1]) / h; v[k + 2] = (p[k + 2] - x[k + 2]) / h;
      x[k] = p[k]; x[k + 1] = p[k + 1]; x[k + 2] = p[k + 2]; }
  }
}
const W = 1.3213, H = 1.8976;
const spheres = [];
for (let i = 0; i < 42; i++) spheres.push([0.3 + (i % 7) * 0.02, 0.1, 0.4 + ((i / 7) | 0) * 0.03, 0.011]);
console.log('spacing  grid      particles constraints  substeps  ms/frame  (target < 4 ms)');
for (const sp of [0.05, 0.04, 0.03, 0.025, 0.02, 0.015, 0.01]) {
  const nx = Math.round(W / sp) + 1, ny = Math.round(H / sp) + 1;
  const S = build(nx, ny, sp);
  for (const subs of [8]) {
    for (let i = 0; i < 20; i++) step(S, 1 / 60, subs, spheres);   // warm
    const t0 = process.hrtime.bigint();
    const REP = 60; for (let i = 0; i < REP; i++) step(S, 1 / 60, subs, spheres);
    const ms = Number(process.hrtime.bigint() - t0) / 1e6 / REP;
    console.log(`${(sp*1000).toFixed(0).padStart(5)}mm  ${String(nx+'x'+ny).padEnd(9)} ${String(S.n).padStart(7)} ${String(S.A.length).padStart(11)} ${String(subs).padStart(9)} ${ms.toFixed(2).padStart(9)}`);
  }
}
