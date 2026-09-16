// verify the engine DRAGON game object end-to-end in a real browser: spawns via
// the SPAWN row, lists with 🐉, selecting shows the motion strip, walk / run
// / fly each move the host and the bones, the head tracks the camera, and the
// dragon survives a save/clear/load round-trip with its mode. Screenshots of
// each mode land in PROBE_SHOTS (or the OS temp dir). Dev server on :3333.
import puppeteer from 'puppeteer-core';
import os from 'node:os';
import path from 'node:path';
const SP = process.env.PROBE_SHOTS || os.tmpdir();
const browser = await puppeteer.launch({
  executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe',
  headless: 'new', args: ['--window-size=1300,900', '--no-sandbox', '--use-gl=angle'],
});
const page = await browser.newPage();
await page.setViewport({ width: 1300, height: 900 });
const errors = [];
page.on('pageerror', e => errors.push('pageerror: ' + e.message));
page.on('console', m => { if (m.type() === 'error' && !/favicon|XNNPACK/.test(m.text() + m.location().url)) errors.push('console: ' + m.text()); });
const sleep = ms => new Promise(r => setTimeout(r, ms));

await page.goto('http://localhost:3333/mpbrowser.html', { waitUntil: 'domcontentloaded' });
await page.waitForSelector('#engBtn', { timeout: 30000 });
await page.click('#engBtn');
await page.waitForFunction(() => document.body.classList.contains('engine-view'), { timeout: 30000 });
await sleep(800);

await page.click('#engSpawnRow [data-sp="dragon"]');
await page.waitForFunction(() => window.__eng.objects.some(o => o.userData.eng.type === 'dragon'), { timeout: 90000 });
await sleep(600);

const out = {};
out.spawn = await page.evaluate(() => {
  const g = window.__eng.objects.find(o => o.userData.eng.type === 'dragon');
  const rec = window.__eng.dragons.get(g.userData.eng.id);
  let bones = 0; g.traverse(o => { if (o.isBone) bones++; });
  return {
    label: g.userData.eng.label, bones, mode: rec.driver.mode, auto: rec.driver.auto,
    listed: [...document.querySelectorAll('.engRow')].some(r => r.textContent.includes('🐉')),
    strip: [...document.querySelectorAll('#engAvCtl .opt')].map(b => b.textContent),
    stripLabel: document.getElementById('engAvCtlLbl').textContent,
    selected: window.__eng.sel === g,
    signs: rec.driver.sign,
    y: g.position.y,
  };
});
// frame the dragon for the screenshots (orbit target on it, camera pulled back)
await page.evaluate(() => {
  const g = window.__eng.objects.find(o => o.userData.eng.type === 'dragon');
  const E = window.__eng;
  E.orbit.target.set(g.position.x, 1.2, g.position.z);
  E.camera.position.set(g.position.x + 3.2, 2.2, g.position.z + 3.8);
  E.orbit.update();
});
await sleep(300);
await page.screenshot({ path: path.join(SP, 'dragon-idle.png') });

// head-look: camera tracking — snout should sit on the camera's side of the body
out.look = await page.evaluate(async () => {
  const g = window.__eng.objects.find(o => o.userData.eng.type === 'dragon');
  const rec = window.__eng.dragons.get(g.userData.eng.id);
  await new Promise(r => setTimeout(r, 900));
  return { mode: rec.lookMode, yaw: +rec.driver.look.yaw.toFixed(1), pitch: +rec.driver.look.pitch.toFixed(1), target: { ...rec.driver.lookTarget } };
});

// walk: the host translates; a foot bone moves
const boneMove = async (mode, ms) => page.evaluate(async (mode, ms) => {
  const g = window.__eng.objects.find(o => o.userData.eng.type === 'dragon');
  const rec = window.__eng.dragons.get(g.userData.eng.id);
  window.__eng.dragonSetMode(g, mode);
  const foot = rec.driver.bones['Bone_005'], tip = rec.driver.bones['Bone_064'];
  const p0 = g.position.clone();
  await new Promise(r => setTimeout(r, ms));
  const f0 = foot.quaternion.toArray().map(v => +v.toFixed(4)), t0 = tip.getWorldPosition(new (g.position.constructor)()).y;
  await new Promise(r => setTimeout(r, 180));
  const f1 = foot.quaternion.toArray().map(v => +v.toFixed(4)), t1 = tip.getWorldPosition(new (g.position.constructor)()).y;
  return { mode: rec.driver.mode, moved: +p0.distanceTo(g.position).toFixed(2), speed: +rec.driver.speed.toFixed(2),
           footAnimates: JSON.stringify(f0) !== JSON.stringify(f1), tipDy: +(t1 - t0).toFixed(3),
           y: +g.position.y.toFixed(2), alt: +rec.driver.altitude.toFixed(2), airborne: +rec.driver.airborne.toFixed(2),
           strip: [...document.querySelectorAll('#engAvCtl .opt.sel')].map(b => b.textContent) };
}, mode, ms);
out.walk = await boneMove('walk', 1800);
await page.screenshot({ path: path.join(SP, 'dragon-walk.png') });
out.run = await boneMove('run', 1500);
await page.screenshot({ path: path.join(SP, 'dragon-run.png') });
out.fly = await boneMove('fly', 3500);
await page.screenshot({ path: path.join(SP, 'dragon-fly.png') });
await sleep(250);
await page.screenshot({ path: path.join(SP, 'dragon-fly2.png') });
out.land = await boneMove('idle', 3500);

// save / clear / load — the dragon and its mode come back
out.roundTrip = await page.evaluate(async () => {
  const g = window.__eng.objects.find(o => o.userData.eng.type === 'dragon');
  window.__eng.dragonSetMode(g, 'walk');
  document.getElementById('engSave').click();
  document.getElementById('engClear').click();
  const gone = !window.__eng.objects.some(o => o.userData.eng.type === 'dragon');
  document.getElementById('engLoad').click();
  for (let i = 0; i < 300 && !window.__eng.objects.some(o => o.userData.eng.type === 'dragon'); i++) await new Promise(r => setTimeout(r, 100));
  await new Promise(r => setTimeout(r, 500));
  const g2 = window.__eng.objects.find(o => o.userData.eng.type === 'dragon');
  const rec = g2 && window.__eng.dragons.get(g2.userData.eng.id);
  return { gone, back: !!g2, mode: rec && rec.driver.mode, look: rec && rec.lookMode };
});

console.log(JSON.stringify(out, null, 1));
console.log('errors:', errors.length ? errors : 'none');
const ok = out.spawn.bones === 69 && out.spawn.listed && out.spawn.strip.length >= 9
  && out.walk.moved > 0.5 && out.walk.footAnimates && out.walk.y === 0
  && out.run.speed > 2 && out.fly.alt > 1.5 && out.fly.y > 1 && out.land.alt === 0
  && out.roundTrip.back && out.roundTrip.mode === 'walk' && errors.length === 0;
console.log(ok ? 'DRAGON PROBE OK' : 'DRAGON PROBE FAILED');
await browser.close();
process.exit(ok ? 0 : 1);
