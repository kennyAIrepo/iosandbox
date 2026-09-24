// 🧶 CLOTHIFY as a COMPONENT — the engine's reusable "make this prop cloth" lane.
// Spawns a plain primitive, squashes it flat with its own transform, clothifies
// it from the selection strip, checks the lattice fits the prop, that it really
// simulates (hangs in folds without stretching), then un-cloths it back to the
// rigid prop. Also checks the creation-mode toggle (🧶 as cloth) and the
// lattice-cell choices are exposed.   needs: npm run serve
import puppeteer from 'puppeteer-core';
import os from 'node:os';
import path from 'node:path';
const SP = process.env.PROBE_SHOTS || os.tmpdir();
const URL = process.env.PROBE_URL || 'http://localhost:3333/mpbrowser.html';
const browser = await puppeteer.launch({ executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe',
  headless: 'new', args: ['--window-size=1300,900', '--no-sandbox', '--use-gl=angle'] });
const page = await browser.newPage(); await page.setViewport({ width: 1300, height: 900 });
const errors = [];
page.on('pageerror', e => errors.push('pageerror: ' + e.message));
page.on('console', m => { if (m.type() === 'error' && !/favicon|XNNPACK|404|Failed to load resource/.test(m.text() + m.location().url)) errors.push('console: ' + m.text()); });
const sleep = ms => new Promise(r => setTimeout(r, ms));
const shot = n => page.screenshot({ path: path.join(SP, 'clothify-' + n + '.png') });
const strip = () => page.evaluate(() => ({
  label: document.getElementById('engAvCtlLbl').textContent,
  buttons: [...document.querySelectorAll('#engAvCtl .opt')].map(b => b.textContent),
}));
const clickStrip = re => page.evaluate(r => {
  const b = [...document.querySelectorAll('#engAvCtl .opt')].find(x => new RegExp(r).test(x.textContent));
  if (!b) throw new Error('no strip button matching ' + r);
  b.click();
}, re.source || re);

await page.goto(URL, { waitUntil: 'domcontentloaded' });
await page.waitForSelector('#engBtn', { timeout: 30000 });
await page.click('#engBtn');
await page.waitForFunction(() => document.body.classList.contains('engine-view'), { timeout: 30000 });
await sleep(600);
const out = {};

// ── creation mode: the import row offers "as cloth" ──
out.creation = await page.evaluate(() => {
  const b = document.getElementById('engUrlCloth');
  if (!b) return { present: false };
  b.click();
  const on = b.classList.contains('sel');
  b.click();
  return { present: true, label: b.textContent, togglesOn: on, offAgain: !b.classList.contains('sel') };
});

// ── a plain primitive, squashed into a sheet by its own transform ──
await page.click('#engSpawnRow [data-sp="box"]');
await sleep(400);
await page.evaluate(() => {
  const E = window.__eng, o = E.objects[E.objects.length - 1];
  o.scale.set(1.4, 0.02, 1.0); o.position.set(0, 0.9, 0); o.updateMatrixWorld(true);
  E.select(o);
});
await sleep(300);
out.strip = await strip();
await shot('1-selected');

await clickStrip(/clothify/);
await sleep(800);
out.clothed = await page.evaluate(() => {
  const E = window.__eng, o = E.objects[E.objects.length - 1], rec = E.rugs.get(o.userData.eng.id);
  if (!rec) return { registered: false };
  const I = rec.piece.info;
  return { registered: true, clothified: !!rec.clothified, nodes: I.nodes, nx: I.nx, ny: I.ny,
           cell_mm: Math.round(I.cell * 1000), flat: I.flat, verts: I.verts, thickness_mm: +(I.thickness * 1000).toFixed(1),
           listed: [...document.querySelectorAll('.engRow')].some(r => /🧶/.test(r.textContent)),
           bound: rec.piece.skins.every(s => !!s.mesh.geometry.attributes.aCell && !!s.mesh.geometry.attributes.aNrm),
           lattice: o.children.some(c => c.name === 'ClothLattice') };
});
out.clothedStrip = await strip();

// ── it must SIMULATE: hang it and watch it fold ──
await clickStrip(/hang/);
await sleep(2400);
out.hang = await page.evaluate(() => {
  const E = window.__eng, o = E.objects[E.objects.length - 1], s = E.rugs.get(o.userData.eng.id).piece.sim;
  let lo = Infinity, hi = -Infinity;
  for (let i = 0; i < s.n; i++) { lo = Math.min(lo, s.x[i * 3 + 1]); hi = Math.max(hi, s.x[i * 3 + 1]); }
  let worst = 0;
  for (let c = 0; c < s.nStruct; c++) {
    const a = s.cA[c] * 3, b = s.cB[c] * 3;
    worst = Math.max(worst, Math.hypot(s.x[a] - s.x[b], s.x[a + 1] - s.x[b + 1], s.x[a + 2] - s.x[b + 2]) / s.cL[c]);
  }
  const V = window.__lab.THREE.Vector3;
  const bx = new window.__lab.THREE.Box3().setFromObject(o), c2 = bx.getCenter(new V());
  E.orbit.target.copy(c2); E.camera.position.copy(c2).add(new V(1.4, 0.4, 1.8)); E.camera.lookAt(c2); E.orbit.update();
  return { drop: +(hi - lo).toFixed(3), stretch: +worst.toFixed(3) };
});
await sleep(250); await shot('2-hanging');

// ── …and back to a rigid prop, exactly as it was ──
await clickStrip(/un-cloth/);
await sleep(600);
out.reverted = await page.evaluate(() => {
  const E = window.__eng, o = E.objects[E.objects.length - 1];
  let mesh = null; o.traverse(c => { if (c.isMesh) mesh = c; });
  return { gone: !E.rugs.has(o.userData.eng.id), noCellAttr: !mesh.geometry.attributes.aCell,
           noLattice: !o.children.some(c => c.name === 'ClothLattice'),
           verts: mesh.geometry.attributes.position.count };
});
out.revertedStrip = await strip();
await shot('3-reverted');

console.log(JSON.stringify(out, null, 1));
console.log('errors:', errors.length ? errors : 'none');
const checks = {
  'creation mode offers 🧶 as cloth': out.creation.present && out.creation.togglesOn && out.creation.offAgain,
  'a rigid prop offers 🧶 clothify': out.strip.buttons.some(t => /clothify/.test(t)) && /CLOTH/.test(out.strip.label),
  'lattice cell sizes are exposed': out.strip.buttons.some(t => /fine/.test(t)) && out.strip.buttons.some(t => /coarse/.test(t)),
  'clothify fits a lattice to the prop': out.clothed.registered && out.clothed.nodes > 200 && out.clothed.nodes < 4200,
  'it found the SHEET plane of a squashed box': out.clothed.flat < 0.2,
  'the mesh is embedded in it': out.clothed.bound && out.clothed.lattice,
  'listed as cloth, with the cloth strip': out.clothed.listed && /CLOTH/.test(out.clothedStrip.label) && out.clothedStrip.buttons.some(t => /hang/.test(t)),
  'it simulates — hangs in folds': out.hang.drop > 0.25,
  'without the weave stretching': out.hang.stretch < 1.08,
  'un-cloth restores the rigid prop': out.reverted.gone && out.reverted.noCellAttr && out.reverted.noLattice,
  'and clothify is offered again': out.revertedStrip.buttons.some(t => /clothify/.test(t)),
  'no page errors': errors.length === 0,
};
for (const [k, v] of Object.entries(checks)) console.log((v ? '  ok   ' : '  FAIL ') + k);
const ok = Object.values(checks).every(Boolean);
console.log(ok ? 'CLOTHIFY PROBE OK' : 'CLOTHIFY PROBE FAILED');
await browser.close();
process.exit(ok ? 0 : 1);
