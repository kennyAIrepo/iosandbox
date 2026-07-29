// st-22 dollhouse interpolation — continuity check on the exact rigPacket
// freeze math: when a new packet lands mid-blend, the displayed (interpolated)
// state must be frozen into aPrev so the mesh never snaps back.
const N = 4;                       // toy vertex count (xyz each)
const S = { rig: { seen: 0, span: 0, lastPkt: 0, tPrev: 0 } };
const geo = { pos: new Float32Array(N * 3), prev: new Float32Array(N * 3) };
const rigSpan = () => Math.max(120, Math.min(1000, S.rig.span || 400));
const displayed = (now) => {
  const m = S.rig.lastPkt ? Math.min(1, (now - S.rig.lastPkt) / rigSpan()) : 1;
  return geo.pos.map((v, i) => geo.prev[i] + (v - geo.prev[i]) * m);
};
function rigPacket(target, now) {           // mirrors studio.html rigPacket
  if (S.rig.seen) {
    const m = Math.min(1, (now - S.rig.lastPkt) / rigSpan());
    for (let i = 0; i < N * 3; i++) geo.prev[i] += (geo.pos[i] - geo.prev[i]) * m;
  }
  geo.pos.set(target);
  if (!S.rig.seen) { geo.prev.set(geo.pos); S.rig.seen = 1; }
  const dt = now - (S.rig.lastPkt || now);
  if (dt > 0 && dt < 3000) S.rig.span = S.rig.span ? S.rig.span * 0.7 + dt * 0.3 : dt;
  S.rig.tPrev = S.rig.lastPkt || now; S.rig.lastPkt = now;
}
let pass = 0, fail = 0;
const ok = (c, n) => c ? (pass++, console.log('  ✔ ' + n)) : (fail++, console.error('  ✘ ' + n));

const T = (v) => new Float32Array(N * 3).fill(v);
rigPacket(T(0), 1000);
ok(displayed(1000).every(v => v === 0), 'first packet appears in place (no lerp-in)');

rigPacket(T(100), 1200);                     // second packet, span EMA starts (200)
const justBefore = displayed(1399.9);        // mid-blend toward 100
rigPacket(T(50), 1400);                      // NEW target arrives mid-blend
const justAfter = displayed(1400);
const jump = Math.max(...justBefore.map((v, i) => Math.abs(v - justAfter[i])));
ok(jump < 0.5, `no snap at packet arrival (jump=${jump.toFixed(3)})`);

const late = displayed(1400 + rigSpan() + 1);
ok(late.every(v => Math.abs(v - 50) < 1e-4), 'blend converges to new target');
ok(S.rig.span > 100 && S.rig.span < 400, `span EMA tracks cadence (${S.rig.span.toFixed(0)}ms)`);

// pump pacing: interval is half the packet span, clamped
const iv = Math.max(80, Math.min(300, (S.rig.span || 400) * 0.5));
ok(iv >= 80 && iv <= 300, `pump interval sane (${iv.toFixed(0)}ms)`);
console.log(`\n${pass} pass, ${fail} fail`);
process.exit(fail ? 1 : 0);
