// verify BECOME THE DRAGON end-to-end in a real browser through the synthetic
// pose seam (AVSYNC.ovPose): the user's arms pose the wings (T-pose lays them
// flat, arms up raises them), fast flapping charges the HUD ring and LIFTS OFF,
// the dolly rides the shot, the dragon climbs while flapping, the environment
// switches to sky + clouds with altitude, arms down brings it back to LAND.
// Screenshots land in PROBE_SHOTS (or the OS temp dir). Dev server on :3333.
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
const shot = n => page.screenshot({ path: path.join(SP, n) });

await page.goto('http://localhost:3333/mpbrowser.html', { waitUntil: 'domcontentloaded' });
await page.waitForSelector('#engBtn', { timeout: 30000 });
await page.click('#engBtn');
await page.waitForFunction(() => document.body.classList.contains('engine-view'), { timeout: 30000 });
await sleep(600);
await page.click('#engSpawnRow [data-sp="dragon"]');
await page.waitForFunction(() => window.__eng.objects.some(o => o.userData.eng.type === 'dragon'), { timeout: 90000 });
await sleep(400);

// a synthetic BlazePose-33 world pose generator lives in the page: arm elevation
// (deg above the shoulder line) per side, lean, head yaw — same convention as the
// wing-smoke node test (x = user's left, y down, z toward camera −)
await page.evaluate(() => {
  const D2R = Math.PI / 180;
  window.__pose = ({ elevL = 0, elevR = 0, lean = 0, headYaw = 0, facing = 0, bend = 0 } = {}) => {
    const P = (x, y, z) => ({ x, y, z, visibility: 1 });
    const w = new Array(33).fill(0).map(() => P(0, 0.3, 0));
    const lr = lean * D2R;
    w[23] = P(0.1, 0, 0); w[24] = P(-0.1, 0, 0);
    w[11] = P(0.16, -0.5 + Math.sin(lr) * 0.16, 0); w[12] = P(-0.16, -0.5 - Math.sin(lr) * 0.16, 0);
    const arm = (s, sh, e) => {
      const el = P(sh.x + s * 0.3 * Math.cos(e * D2R), sh.y - 0.3 * Math.sin(e * D2R), sh.z);
      const wr = P(el.x + s * 0.28 * Math.cos(e * D2R), el.y - 0.28 * Math.sin(e * D2R), el.z);
      return [el, wr];
    };
    [w[13], w[15]] = arm(1, w[11], elevL); [w[14], w[16]] = arm(-1, w[12], elevR);
    const hy = headYaw * D2R;
    w[7] = P(0.07, -0.66, 0.1); w[8] = P(-0.07, -0.66, 0.1);
    w[0] = P(Math.sin(hy) * 0.12, -0.68, 0.1 - Math.cos(hy) * 0.12);
    for (const i of [1, 2, 3, 4, 5, 6, 9, 10]) w[i] = P(0, -0.66, 0.1);
    w[25] = P(0.1, 0.45, 0); w[26] = P(-0.1, 0.45, 0); w[27] = P(0.1, 0.85, 0); w[28] = P(-0.1, 0.85, 0);
    // torso facing (rotate shoulders/arms/hips about the vertical; left = left shoulder away, +z)
    const fy = facing * D2R;
    for (const i of [11, 12, 13, 14, 15, 16, 23, 24]) { const p = w[i]; const x = p.x * Math.cos(fy), z = p.z + p.x * Math.sin(fy); p.x = x; p.z = z; }
    // torso bend forward (everything above the hips tips toward the camera, −z)
    const by = bend * D2R, tl = 0.5;
    for (const i of [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16]) { const p = w[i]; const h = -p.y; p.y = -(h * Math.cos(by)); p.z += -(tl * Math.sin(by)) * (h / tl); }
    return w;
  };
  // feed: a function of time (s) → pose params, sampled at ~60 Hz into the seam
  window.__feed = (fn) => {
    if (window.__feedT) clearInterval(window.__feedT);
    const t0 = performance.now();
    window.__feedT = setInterval(() => { window.__lab.AVSYNC.ovPose = window.__pose(fn((performance.now() - t0) / 1000)); }, 16);
  };
});
const dragon = () => page.evaluate(() => {
  const g = window.__eng.objects.find(o => o.userData.eng.type === 'dragon');
  const rec = window.__eng.dragons.get(g.userData.eng.id);
  const tip = rec.driver.bones['Bone_064'], V = window.__lab.THREE.Vector3;
  const inv = g.matrixWorld.clone().invert();
  const tipY = new V().setFromMatrixPosition(tip.matrixWorld).applyMatrix4(inv).y;
  const shY = new V().setFromMatrixPosition(rec.driver.bones['Bone_049'].matrixWorld).applyMatrix4(inv).y;
  const snoutX = new V().setFromMatrixPosition(rec.driver.bones['Bone_024'].matrixWorld).applyMatrix4(inv).x;
  const c = rec.user && rec.user.ctl;
  return { user: !!rec.user, mode: rec.driver.mode, userW: +rec.driver.userW.toFixed(2), tipY: +tipY.toFixed(2), shY: +shY.toFixed(2), snoutX: +snoutX.toFixed(2),
           alt: +rec.driver.altitude.toFixed(2), y: +g.position.y.toFixed(2), cruise: +rec.driver.cruiseAlt.toFixed(1),
           phase: c && c.phase, meter: c && +c.meter.toFixed(2), rate: c && +c.rate.toFixed(2), climb: c && +c.climb.toFixed(2), turn: c && +c.turn.toFixed(2), dive: c && +c.dive.toFixed(2),
           heading: +rec.driver.heading.toFixed(2),
           hud: { shown: getComputedStyle(document.getElementById('engFlapHud')).display, big: document.getElementById('engFlapBig').textContent, lift: document.getElementById('engFlapHud').classList.contains('lift') },
           dragonClass: document.body.classList.contains('eng-dragon'),
           env: { alt: +window.__eng.env.alt.toFixed(1), high: +window.__eng.env.high.toFixed(2), clouds: window.__eng.env.clouds ? window.__eng.env.clouds.children[0].material.opacity.toFixed(2) : null },
           cam: window.__eng.camera.position.toArray().map(v => +v.toFixed(1)),
           strip: [...document.querySelectorAll('#engAvCtl .opt.sel')].map(b => b.textContent) };
});
const out = {};

// become the dragon through the real strip chip (SDK boot skipped: synthetic feed)
await page.evaluate(async () => {
  const g = window.__eng.objects.find(o => o.userData.eng.type === 'dragon');
  await window.__eng.dragonSetUser(g, true, { sdk: false });
});
await page.evaluate(() => window.__feed(() => ({ elevL: 0, elevR: 0 })));       // T-pose: arms straight out
await sleep(1500);
out.tpose = await dragon();
await shot('dragon-user-tpose.png');
await page.evaluate(() => window.__feed(() => ({ elevL: 80, elevR: 80 })));     // arms up
await sleep(1200);
out.armsUp = await dragon();
await shot('dragon-user-armsup.png');
await page.evaluate(() => window.__feed(() => ({ elevL: 0, elevR: 0, headYaw: 35 })));   // head turned left
await sleep(1200);
out.headLeft = await dragon();

// slow flapping must NOT lift off
await page.evaluate(() => window.__feed(t => { const e = 5 + 45 * Math.sin(2 * Math.PI * 0.5 * t); return { elevL: e, elevR: e }; }));
await sleep(4000);
out.slow = await dragon();
// fast flapping → charge → LIFT OFF
await page.evaluate(() => window.__feed(t => { const e = 5 + 45 * Math.sin(2 * Math.PI * 2.0 * t); return { elevL: e, elevR: e }; }));
await sleep(2000);
out.charging = await dragon();
await shot('dragon-user-charging.png');
await page.waitForFunction(() => { const g = window.__eng.objects.find(o => o.userData.eng.type === 'dragon'); return window.__eng.dragons.get(g.userData.eng.id).user.ctl.phase === 'flying'; }, { timeout: 8000 }).catch(() => {});
await sleep(700);
out.liftoff = await dragon();
await shot('dragon-user-liftoff.png');
// keep flapping (climb hard for the probe) — into the sky + clouds
await page.evaluate(() => { const g = window.__eng.objects.find(o => o.userData.eng.type === 'dragon'); const r = window.__eng.dragons.get(g.userData.eng.id); r.driver.climbMul = 8; });
await page.evaluate(() => window.__feed(t => { const e = 5 + 45 * Math.sin(2 * Math.PI * 1.6 * t); return { elevL: e, elevR: e, facing: 30 }; }));   // body turned left = steer left
for (let i = 0; i < 8; i++) {                                        // ~8 s of climbing
  await sleep(1000);
  await page.evaluate(() => { const g = window.__eng.objects.find(o => o.userData.eng.type === 'dragon'); const r = window.__eng.dragons.get(g.userData.eng.id); r.driver.cruiseAlt = Math.min(42, r.driver.cruiseAlt + 4); });
}
out.high = await dragon();
await shot('dragon-user-high.png');
// bend forward → DIVE (arms out, body pitched toward the camera)
await page.evaluate(() => window.__feed(() => ({ elevL: 0, elevR: 0, bend: 40 })));
await sleep(2500);
out.dive = await dragon();
await shot('dragon-user-dive.png');
// arms down → descend → land
await page.evaluate(() => window.__feed(() => ({ elevL: -70, elevR: -70 })));
await page.evaluate(() => { const g = window.__eng.objects.find(o => o.userData.eng.type === 'dragon'); const r = window.__eng.dragons.get(g.userData.eng.id); r.driver.climbMul = 12; });
await page.waitForFunction(() => { const g = window.__eng.objects.find(o => o.userData.eng.type === 'dragon'); return window.__eng.dragons.get(g.userData.eng.id).user.ctl.phase === 'ground'; }, { timeout: 30000 }).catch(() => {});
await sleep(800);
out.landed = await dragon();
// release
await page.evaluate(async () => { clearInterval(window.__feedT); window.__lab.AVSYNC.ovPose = undefined; const g = window.__eng.objects.find(o => o.userData.eng.type === 'dragon'); await window.__eng.dragonSetUser(g, false); });
await sleep(400);
out.released = await dragon();

console.log(JSON.stringify(out, null, 1));
console.log('errors:', errors.length ? errors : 'none');
const ok = out.tpose.user && out.tpose.dragonClass && out.tpose.hud.shown === 'flex' && out.tpose.userW > 0.95
  && out.armsUp.tipY > out.tpose.tipY + 0.4                       // arms up raise the wings
  && out.headLeft.snoutX > 0.12                                   // head turn → dragon looks left
  && out.slow.phase === 'ground' && out.slow.mode === 'idle'      // slow flapping stays grounded
  && out.charging.meter > 0.1 && /FLAPPING/.test(out.charging.hud.big)
  && out.liftoff.phase === 'flying' && out.liftoff.mode === 'fly' && out.liftoff.hud.lift
  && out.high.alt > 10 && out.high.env.high > 0.2 && +out.high.env.clouds > 0.3 && out.high.turn > 0.2
  && out.high.cam[1] > out.high.y                                 // dolly rides above the dragon
  && out.high.heading > 0.3                                       // facing left actually curved the flight left
  && out.dive.phase === 'flying' && out.dive.dive > 0.5 && out.dive.hud.big === 'DIVING' && out.dive.y < out.high.y - 1
  && out.landed.phase === 'ground' && out.landed.alt < 0.1
  && !out.released.user && !out.released.dragonClass && errors.length === 0;
console.log(ok ? 'DRAGON USER PROBE OK' : 'DRAGON USER PROBE FAILED');
await browser.close();
process.exit(ok ? 0 : 1);
