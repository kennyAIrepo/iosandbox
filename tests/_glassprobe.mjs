// GLASS SLIME probe — mpbrowser mirror lane. Contracts:
//   · spawns as GLASS: transmission material, softness 0, medium vertex density
//   · mirror mode gets the live-video BACKDROP plane (the room passes through)
//   · MESH-TRUE shape: a PropHull + stats() (mass, volume, bbox, hull json)
//     readable any moment; conform collider streams so fingers wrap it
//   · an OPEN hand cannot pass through it (resistance) and does not grab it
//   · a pressing joint sphere DENTS rigid glass, never sinks inside, springs back
//   · SCALE: UI ± drives mesh, physics radius, collider radius and mass (∝ s³)
//   · MAKE IT SLIME: density jumps, softness RAMPS to melt, the blob SAGS —
//     same mesh, same position; MAKE IT GLASS re-rounds · lens uniform · no errors
import puppeteer from 'puppeteer-core';
const browser = await puppeteer.launch({ executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: 'new',
  args: ['--window-size=1300,900', '--no-sandbox', '--use-gl=angle', '--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'] });
const page = await browser.newPage(); await page.setViewport({ width: 1300, height: 900 });
const errors = [];
page.on('pageerror', e => errors.push('pageerror: ' + e.message));
page.on('console', m => { if (m.type() === 'error' && !/favicon|XNNPACK|404/.test(m.text() + m.location().url)) errors.push('console: ' + m.text()); });
await page.goto('http://localhost:3333/mpbrowser.html', { waitUntil: 'domcontentloaded' });
await page.waitForSelector('#startBtn', { timeout: 30000 }); await page.click('#startBtn');
await page.waitForFunction(() => window.__lab && window.__lab.S && window.__lab.S.running, { timeout: 120000 });
await new Promise(r => setTimeout(r, 500));
await page.click('#slimeBtn');
await page.waitForFunction(() => window.__lab.slime.on && window.__lab.slime.mesh, { timeout: 30000 });
await new Promise(r => setTimeout(r, 800));
const out = await page.evaluate(async () => {
  const T3 = window.__lab.THREE, G = window.__lab.slime, S = window.__lab.S;
  const verts = () => G.mesh.geometry.getAttribute('position').count;
  const wait = ms => new Promise(r => setTimeout(r, ms));
  const V = (x, y, z) => ({ x, y, z });
  const mk = base => new Array(21).fill(0).map(() => V(base.x, base.y, base.z));
  const open = (x, y, z) => {                                  // closure ~0 (fingers extended)
    const p = mk(V(x, y, z));
    p[0] = V(x, y - 0.05, z); p[9] = V(x, y + 0.05, z);
    p[5] = V(x + 0.035, y + 0.04, z); p[17] = V(x - 0.035, y + 0.04, z);
    for (const i of [8, 12, 16, 20]) p[i] = V(x, y + 0.16, z);
    p[4] = V(x + 0.1, y, z);
    return p;
  };
  const glass = { transmission: G.mat.transmission, ior: +G.mat.ior.toFixed(2), softness: G.soft.softness, state: G.state,
                  verts: verts(), backdrop: !!(G.backdrop && G.backdrop.visible && S.mode === 'mirror'), envMap: !!G.mat.envMap,
                  collider: window.__lab.slimeCol ? window.__lab.slimeCol.active : 'n/a' };
  // ── SHAPE + STATS any moment ──
  const st = G.stats();
  const r = 0.16, vIdeal = 4 / 3 * Math.PI * r ** 3;
  const stats = { mass: st.mass_kg, volume: st.volume_m3, volErr: +Math.abs(st.volume_m3 - vIdeal) / vIdeal, hullSegs: st.hull && st.hull.segs,
                  hullJson: !!(st.hull && st.hull.json && st.hull.json.segs && st.hull.json.segs.length), bbox: st.bbox };
  // ── RESISTANCE: an OPEN hand pressed into the ball is stopped at its surface ──
  const c0 = G.sphere.pos.clone();
  window.__lab.AVSYNC.ovPose = null;
  window.__lab.AVSYNC.ovPacks = { L: open(c0.x, c0.y, c0.z), R: null };     // palm centre AT the ball centre
  await wait(600);
  G.mesh.updateWorldMatrix(true, false); G.hull.begin(G.mesh);
  const Lp = window.__lab.AVSYNC.packs.L; let minGap = 9;
  for (let i = 0; i < 21; i++) { const g = G.hull.surfaceDistance(new T3.Vector3(Lp[i].x, Lp[i].y, Lp[i].z)); if (g < minGap) minGap = g; }
  const resist = { minGap: +minGap.toFixed(3), grabbed: G.sphere.grabbed() };
  window.__lab.AVSYNC.ovPacks = { L: null, R: null };
  await wait(300);
  // ── rigid press: a finger-sized sphere pushed into the top of the ball ──
  const pr = 0.02;
  const top = G.mesh.position.clone().add(new T3.Vector3(0, r - 0.012, 0));
  let squash = 0, minGapP = 9;
  for (let k = 0; k < 40; k++) { const m = G.soft.update(1 / 60, [{ p: top, r: pr }], null); squash = Math.max(squash, m.squash); }
  const P = G.mesh.geometry.getAttribute('position'); G.mesh.updateMatrixWorld(true);
  const v = new T3.Vector3(), inv = new T3.Matrix4().copy(G.mesh.matrixWorld).invert(), tl = top.clone().applyMatrix4(inv);
  for (let i = 0; i < P.count; i++) { v.fromBufferAttribute(P, i); const d = v.distanceTo(tl); if (d < minGapP) minGapP = d; }
  const press = { squash: +squash.toFixed(4), minGapToPressCentre: +minGapP.toFixed(4), pressR: pr };
  for (let k = 0; k < 90; k++) G.soft.update(1 / 60, [], null);
  let back = 0; for (let i = 0; i < P.count; i++) { v.fromBufferAttribute(P, i); const rr = new T3.Vector3().fromArray(G.soft.rest, i * 3); back = Math.max(back, v.distanceTo(rr)); }
  press.reboundResidual = +back.toFixed(4);
  // ── SCALE via UI: mesh, physics radius, collider radius, mass ∝ s³ ──
  document.getElementById('slimeSizeUp').click();
  await wait(200);
  const st2 = G.stats();
  const scale = { userS: +G.userS.toFixed(3), mesh: +G.mesh.scale.x.toFixed(3), physR: +G.sphere.radius.toFixed(4),
                  colR: window.__lab.slimeCol ? +window.__lab.slimeCol.radius.toFixed(4) : null, massRatio: +(st2.mass_kg / st.mass_kg).toFixed(3) };
  document.getElementById('slimeSizeDn').click();
  await wait(200);
  // ── MAKE IT SLIME ──
  const p0 = G.mesh.position.clone();
  document.getElementById('slimeMorphBtn').click();
  await wait(120);
  const early = { softness: +G.soft.softness.toFixed(2), verts: verts(), state: G.state };
  await wait(3000);
  const slime = { state: G.state, softness: +G.soft.softness.toFixed(2), verts: verts(), sag: +G.metrics.sag.toFixed(4), moved: +G.mesh.position.distanceTo(p0).toFixed(3),
                  transmission: G.mat.transmission, hullSegs: G.hull.segs.length };
  document.querySelector('#slimeLensRow [data-lens="ball-lens"]').click();
  const lens = G.mat.userData.lens.mode.value;
  document.getElementById('slimeMorphBtn').click();
  await wait(3500);
  const reglass = { softness: +G.soft.softness.toFixed(3), sag: +G.metrics.sag.toFixed(4), state: G.state, verts: verts() };
  return { glass, stats, resist, press, scale, early, slime, lens, reglass };
});
await browser.close();
console.log(JSON.stringify(out, null, 1));
const fail = [];
const g = out.glass;
if (g.transmission < 0.99 || g.softness !== 0 || g.state !== 'glass') fail.push('did not spawn as rigid transmission glass: ' + JSON.stringify(g));
if (!g.backdrop) fail.push('mirror backdrop plane not showing (room cannot pass through)');
if (!g.envMap) fail.push('no live reflection env map');
if (g.collider !== true) fail.push('conform collider not streaming (fingers cannot wrap the ball): ' + g.collider);
if (!out.stats.hullJson || !(out.stats.mass > 0)) fail.push('no live shape/mass stats: ' + JSON.stringify(out.stats));
if (out.stats.volErr > 0.15) fail.push('stats volume off from a sphere by ' + (out.stats.volErr * 100).toFixed(0) + '%');
if (out.resist.minGap < -0.006) fail.push('RESISTANCE: open hand passed INTO the ball: minGap ' + out.resist.minGap);
if (out.resist.grabbed) fail.push('an OPEN hand must not grab the ball');
if (out.press.squash < 0.003) fail.push('rigid glass did not dent under a pressing finger: ' + out.press.squash);
if (out.press.minGapToPressCentre < out.press.pressR * 0.9) fail.push('vertices sank INSIDE the pressing joint sphere: ' + JSON.stringify(out.press));
if (out.press.reboundResidual > 0.004) fail.push('glass did not spring back round after release: ' + out.press.reboundResidual);
if (Math.abs(out.scale.userS - 1.25) > 0.01 || Math.abs(out.scale.mesh - 1.25) > 0.01) fail.push('UI scale did not apply: ' + JSON.stringify(out.scale));
if (Math.abs(out.scale.physR - 0.2) > 0.002 || (out.scale.colR !== null && Math.abs(out.scale.colR - 0.2) > 0.002)) fail.push('scale did not reach physics/conform radius: ' + JSON.stringify(out.scale));
if (Math.abs(out.scale.massRatio - 1.953) > 0.05) fail.push('mass did not scale with volume (expected ×1.953): ' + out.scale.massRatio);
if (out.early.verts <= g.verts) fail.push('MAKE IT SLIME did not bump vertex density: ' + out.early.verts + ' vs ' + g.verts);
if (out.early.softness > 0.6) fail.push('softness CUT instead of ramping (' + out.early.softness + ' at 120ms)');
if (out.slime.softness < 0.85 || out.slime.state !== 'slime') fail.push('did not reach slime: ' + JSON.stringify(out.slime));
if (out.slime.sag < 0.03) fail.push('slime did not SAG under gravity: sag ' + out.slime.sag);
if (out.slime.transmission < 0.99) fail.push('lost the glass transparency while slime');
if (out.lens !== 2) fail.push('ball-lens mode not applied to the shader: ' + out.lens);
if (out.reglass.softness > 0.05 || out.reglass.sag > 0.01 || out.reglass.state !== 'glass') fail.push('MAKE IT GLASS did not re-solidify: ' + JSON.stringify(out.reglass));
if (errors.length) fail.push('errors: ' + errors.join(' | '));
console.log(fail.length ? '✗ FAIL: ' + fail.join('; ') : '✓ glass slime works — shape/mass stats, conform, resistance, dent/rebound, scale, morph ramp, sag, re-glass, lens');
process.exit(fail.length ? 1 : 0);
