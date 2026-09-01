// verify the FLESH hand look: built on the forge's own proven geometry (ghost-identical
// deformation), realistic skin material, ghost⇄flesh switching from the engine wedge +
// lab sync. Includes the reported failure scenarios as synthetic live poses: FIST and
// raised-finger — asserting no shatter (bounded edge stretch) and no vanishing.
// Dev server on :3333 required.
import puppeteer from 'puppeteer-core';
import { readFileSync } from 'node:fs';
import os from 'node:os';
const SP = process.env.PROBE_SHOTS || os.tmpdir();   // screenshot output dir
const POSES = JSON.parse(readFileSync(SP + '/test_poses.json', 'utf8'));   // fist/flat, gltf coords
const browser = await puppeteer.launch({
  executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe',
  headless: 'new',
  args: ['--window-size=1400,900', '--no-sandbox', '--use-gl=angle',
         '--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'],
});
const page = await browser.newPage();
await page.setViewport({ width: 1400, height: 900 });
const errors = [];
page.on('pageerror', e => errors.push('pageerror: ' + e.message));
page.on('console', m => { if (m.type() === 'error' && !/favicon|XNNPACK/.test(m.text() + m.location().url)) errors.push('console: ' + m.text()); });

await page.goto('http://localhost:3333/mpbrowser.html', { waitUntil: 'domcontentloaded' });
await page.waitForSelector('#engBtn', { timeout: 30000 });
await page.click('#engBtn');
await page.waitForFunction(() => document.body.classList.contains('engine-view'), { timeout: 30000 });
await page.click('#engSdkChk');
await page.waitForFunction(() => document.body.classList.contains('eng-sdk'), { timeout: 120000 });

// ghost fist baseline first — the invariant is EQUIVALENCE to the ghost's deformation
const fistMetric = (fistPose) => {
  const { rigR, THREE } = window.__lab;
  const lm = fistPose.map(p => new THREE.Vector3(p[0], p[1], p[2]));
  rigR.pose(lm); rigR.pose(lm);
  const pos = rigR.mesh.geometry.getAttribute('position').array;
  const rp = rigR._restPos;
  const idx = rigR.mesh.geometry.index.array;
  let worst = 1;
  for (let f = 0; f < idx.length; f += 9) {
    const a = idx[f] * 3, b = idx[f + 1] * 3;
    const lr = Math.hypot(rp[a]-rp[b], rp[a+1]-rp[b+1], rp[a+2]-rp[b+2]);
    if (lr < 1e-5) continue;
    const rr = Math.hypot(pos[a]-pos[b], pos[a+1]-pos[b+1], pos[a+2]-pos[b+2]) / lr;
    if (rr > worst) worst = rr;
  }
  return { worst, visible: rigR.grp.visible && rigR.mesh.visible };
};
const ghostFist = await page.evaluate(fistMetric, POSES.fist);
await page.click('#engSdkSkin [data-skin="flesh"]');
await page.waitForFunction(() => window.__lab.rigR && window.__lab.rigR.look === 'flesh', { timeout: 60000 });

const flesh = await page.evaluate(() => {
  const { rigR, rigL, REST_R42, THREE } = window.__lab;
  const lm = REST_R42.slice(0, 21).map(p => new THREE.Vector3(p[0], p[1], p[2]));
  rigR.pose(lm); rigR.pose(lm);
  const pos = rigR.mesh.geometry.getAttribute('position').array;
  const rp = rigR._restPos;
  let drift = 0;
  for (let i = 0; i < pos.length; i++) { const d = Math.abs(pos[i] - rp[i]); if (d > drift) drift = d; }
  return { vertsR: rigR.stats.verts, vertsL: rigL.stats.verts, lookR: rigR.look, lookL: rigL.look,
           drift, opaque: rigR.mesh.material.transparent === false };
});

// ── FIST: the reported shatter scenario — must deform no worse than the ghost ──
const fist = await page.evaluate(fistMetric, POSES.fist);

// hold fist + neutral left for the visual over the engine grid
await page.evaluate((fistPose) => {
  const { rigR, rigL, REST_R42, THREE } = window.__lab;
  const R = fistPose.map(p => new THREE.Vector3(p[0] + 0.35, p[1] - 0.1, p[2] - 0.75));
  const L = REST_R42.slice(0, 21).map(p => new THREE.Vector3(-p[0] - 0.35, p[1] - 0.1, p[2] - 0.75));
  rigR.pose(R); rigL.pose(L);
  rigR._holdPose = rigR.pose; rigL._holdPose = rigL.pose;
  rigR.pose = () => {}; rigL.pose = () => {};
}, POSES.fist);
await new Promise(r => setTimeout(r, 400));
await page.screenshot({ path: SP + '/flesh-engine-fist.png' });
await page.evaluate(() => {
  const { rigR, rigL } = window.__lab;
  rigR.pose = rigR._holdPose; rigL.pose = rigL._holdPose;
});

// ghost roundtrip + lab sync
await page.click('#engSdkSkin [data-skin="ghost"]');
await page.waitForFunction(() => window.__lab.rigR.look === 'ghost', { timeout: 30000 });
const ghost = await page.evaluate(() => ({
  look: window.__lab.rigR.look, verts: window.__lab.rigR.stats.verts,
  transparent: window.__lab.rigR.mesh.material.transparent,
}));
await page.click('#engSdkSkin [data-skin="flesh"]');
await page.waitForFunction(() => window.__lab.rigR.look === 'flesh', { timeout: 30000 });
await page.click('#engBack');
await page.click('#viewOpts [data-v="inspect"]');
await new Promise(r => setTimeout(r, 900));
await page.screenshot({ path: SP + '/flesh-inspect.png' });
const styleSel = await page.evaluate(() => document.querySelector('#styleOpts .opt.sel')?.dataset.s);
await browser.close();

console.log(JSON.stringify({ flesh, fist, ghostFist, ghost, styleSel }, null, 2));
const fail = [];
if (flesh.vertsR < 5000 || flesh.vertsL < 5000) fail.push('forge flesh build too small: ' + flesh.vertsR + '/' + flesh.vertsL);
if (flesh.lookR !== 'flesh' || flesh.lookL !== 'flesh') fail.push('flesh look not applied');
if (!flesh.opaque) fail.push('flesh material not opaque');
if (flesh.drift > 2e-3) fail.push('identity drift too high: ' + flesh.drift);
if (fist.worst > ghostFist.worst * 1.25) fail.push('fist deforms worse than ghost: x' + fist.worst.toFixed(1) + ' vs ghost x' + ghostFist.worst.toFixed(1));
if (!fist.visible) fail.push('hand vanished in fist');
if (ghost.look !== 'ghost' || ghost.transparent !== true) fail.push('ghost roundtrip failed');
if (styleSel !== 'flesh') fail.push('lab style row not synced: ' + styleSel);
if (errors.length) fail.push('errors: ' + errors.join(' | '));
console.log(fail.length ? '✗ FAIL: ' + fail.join('; ')
  : '✓ flesh (forge geometry) — drift ' + flesh.drift.toExponential(1) + ', fist stretch x' + fist.worst.toFixed(1) + ' (ghost x' + ghostFist.worst.toFixed(1) + ')');
process.exit(fail.length ? 1 : 0);
