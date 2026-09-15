// GLASS SLIME probe — mpbrowser mirror lane. Contracts:
//   · spawns as GLASS: transmission material, softness 0, medium vertex density
//   · mirror mode gets the live-video BACKDROP plane (the room passes through)
//   · a pressing joint sphere DENTS rigid glass (squash > 0) and never sinks
//     inside the sphere (collision-true), springs back when released
//   · MAKE IT SLIME: density jumps to high, softness RAMPS (not a cut) to melt,
//     the blob SAGS under gravity — same mesh, same position
//   · MAKE IT GLASS: ramps back, re-rounds (sag → 0)
//   · lens modes switch the shader uniform · zero page errors
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
  const glass = { transmission: G.mat.transmission, ior: +G.mat.ior.toFixed(2), softness: G.soft.softness, state: G.state,
                  verts: verts(), backdrop: !!(G.backdrop && G.backdrop.visible && S.mode === 'mirror'), envMap: !!G.mat.envMap };
  // ── rigid press: a finger-sized sphere pushed into the top of the ball ──
  const r = 0.16, pr = 0.02;
  const top = G.mesh.position.clone().add(new T3.Vector3(0, r - 0.012, 0));   // 1.2cm into the surface
  let squash = 0, minGap = 9;
  for (let k = 0; k < 40; k++) { const m = G.soft.update(1 / 60, [{ p: top, r: pr }], null); squash = Math.max(squash, m.squash); }
  const P = G.mesh.geometry.getAttribute('position'); G.mesh.updateMatrixWorld(true);
  const v = new T3.Vector3(), inv = new T3.Matrix4().copy(G.mesh.matrixWorld).invert(), tl = top.clone().applyMatrix4(inv);
  for (let i = 0; i < P.count; i++) { v.fromBufferAttribute(P, i); const d = v.distanceTo(tl); if (d < minGap) minGap = d; }
  const press = { squash: +squash.toFixed(4), minGapToPressCentre: +minGap.toFixed(4), pressR: pr };
  for (let k = 0; k < 90; k++) G.soft.update(1 / 60, [], null);               // release → springs back
  let back = 0; for (let i = 0; i < P.count; i++) { v.fromBufferAttribute(P, i); const rr = new T3.Vector3().fromArray(G.soft.rest, i * 3); back = Math.max(back, v.distanceTo(rr)); }
  press.reboundResidual = +back.toFixed(4);
  // ── MAKE IT SLIME: density jump + ramp + sag ──
  const p0 = G.mesh.position.clone();
  document.getElementById('slimeMorphBtn').click();
  await wait(120);
  const early = { softness: +G.soft.softness.toFixed(2), verts: verts(), state: G.state };
  await wait(3000);
  const slime = { state: G.state, softness: +G.soft.softness.toFixed(2), verts: verts(), sag: +G.metrics.sag.toFixed(4), moved: +G.mesh.position.distanceTo(p0).toFixed(3),
                  btn: document.getElementById('slimeMorphBtn').textContent, transmission: G.mat.transmission };
  // ── lens ──
  document.querySelector('#slimeLensRow [data-lens="ball-lens"]').click();
  const lens = G.mat.userData.lens.mode.value;
  // ── MAKE IT GLASS ──
  document.getElementById('slimeMorphBtn').click();
  await wait(3500);
  const reglass = { softness: +G.soft.softness.toFixed(3), sag: +G.metrics.sag.toFixed(4), state: G.state, verts: verts() };
  return { glass, press, early, slime, lens, reglass };
});
await browser.close();
console.log(JSON.stringify(out, null, 1));
const fail = [];
const g = out.glass;
if (g.transmission < 0.99 || g.softness !== 0 || g.state !== 'glass') fail.push('did not spawn as rigid transmission glass: ' + JSON.stringify(g));
if (!g.backdrop) fail.push('mirror backdrop plane not showing (room cannot pass through)');
if (!g.envMap) fail.push('no live reflection env map');
if (out.press.squash < 0.003) fail.push('rigid glass did not dent under a pressing finger: ' + out.press.squash);
if (out.press.minGapToPressCentre < out.press.pressR * 0.9) fail.push('vertices sank INSIDE the pressing joint sphere: ' + JSON.stringify(out.press));
if (out.press.reboundResidual > 0.004) fail.push('glass did not spring back round after release: ' + out.press.reboundResidual);
if (out.early.verts <= g.verts) fail.push('MAKE IT SLIME did not bump vertex density: ' + out.early.verts + ' vs ' + g.verts);
if (out.early.softness > 0.6) fail.push('softness CUT instead of ramping (' + out.early.softness + ' at 120ms)');
if (out.slime.softness < 0.85 || out.slime.state !== 'slime') fail.push('did not reach slime: ' + JSON.stringify(out.slime));
if (out.slime.sag < 0.03) fail.push('slime did not SAG under gravity: sag ' + out.slime.sag);
if (out.slime.transmission < 0.99) fail.push('lost the glass transparency while slime');
if (out.lens !== 2) fail.push('ball-lens mode not applied to the shader: ' + out.lens);
if (out.reglass.softness > 0.05 || out.reglass.sag > 0.01 || out.reglass.state !== 'glass') fail.push('MAKE IT GLASS did not re-solidify: ' + JSON.stringify(out.reglass));
if (errors.length) fail.push('errors: ' + errors.join(' | '));
console.log(fail.length ? '✗ FAIL: ' + fail.join('; ') : '✓ glass slime works — glass, dent/rebound, collision-true, morph ramp + density jump, sag, re-glass, lens');
process.exit(fail.length ? 1 : 0);
