// verify the engine FOX BUST face puppet end-to-end in a real browser through
// the synthetic face seam (AVSYNC.ovFace): spawns via the SPAWN row, lists 🦊,
// the strip shows 🎭 mirror me, going live calibrates a neutral, then jaw open /
// smile / pucker / brows / head turn each move the right bones, the PiP shows,
// and stopping releases. Screenshots per expression land in PROBE_SHOTS.
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

await page.goto(process.env.PROBE_URL || 'http://localhost:3333/mpbrowser.html', { waitUntil: 'domcontentloaded' });
await page.waitForSelector('#engBtn', { timeout: 30000 });
await page.click('#engBtn');
await page.waitForFunction(() => document.body.classList.contains('engine-view'), { timeout: 30000 });
await sleep(600);
await page.click('#engSpawnRow [data-sp="fox"]');
await page.waitForFunction(() => window.__eng.objects.some(o => o.userData.eng.type === 'fox'), { timeout: 90000 });
await sleep(400);

// synthetic MediaPipe face generator in the page (same convention as the node smoke)
await page.evaluate(() => {
  const BS = ['jawOpen', 'mouthSmileLeft', 'mouthSmileRight', 'mouthPucker', 'mouthFunnel', 'cheekPuff', 'eyeBlinkLeft', 'eyeBlinkRight', 'eyeWideLeft', 'eyeWideRight', 'browInnerUp', 'browDownLeft', 'browDownRight', 'mouthFrownLeft', 'mouthFrownRight', 'noseSneerLeft', 'noseSneerRight'];
  window.__face = ({ open = 0, smile = 0, pucker = 0, browUp = 0, blinkL = 0, yaw = 0, puff = 0 } = {}) => {
    const lm = new Array(478).fill(0).map(() => ({ x: 0.5, y: 0.5, z: 0 }));
    const set = (i, x, y) => { lm[i] = { x, y, z: 0 }; };
    const W = 0.3, cx = 0.5, yawS = yaw / 90 * 0.5;
    set(234, cx - W / 2, 0.5); set(454, cx + W / 2, 0.5); set(10, cx, 0.30); set(152, cx, 0.72 + open * 0.05);
    set(1, cx + yawS * W * 0.6, 0.52); set(168, cx, 0.45); set(33, cx - 0.08, 0.45); set(263, cx + 0.08, 0.45);
    const sm = smile * 0.03, pk = pucker * 0.03;
    set(61, cx - 0.05 - sm + pk, 0.62 - sm * 0.6); set(291, cx + 0.05 + sm - pk, 0.62 - sm * 0.6);
    set(78, cx - 0.045 - sm + pk, 0.62); set(308, cx + 0.045 + sm - pk, 0.62);
    set(0, cx, 0.60); set(13, cx, 0.615); set(14, cx, 0.625 + open * 0.05); set(17, cx, 0.645 + open * 0.05);
    const UP = [61, 185, 40, 39, 37, 0, 267, 269, 270, 409, 291], LO = [61, 146, 91, 181, 84, 17, 314, 405, 321, 375, 291];
    const hw = 0.05 + sm - pk;
    UP.forEach((i, k) => { const t = k / 10 * 2 - 1; set(i, cx + t * hw, 0.60 + 0.02 * t * t - smile * 0.02 * t * t); });
    LO.forEach((i, k) => { const t = k / 10 * 2 - 1; set(i, cx + t * hw, 0.645 + open * 0.05 - 0.025 * t * t - smile * 0.02 * t * t); });
    set(50, cx - 0.08, 0.56 - sm * 0.5); set(280, cx + 0.08, 0.56 - sm * 0.5);
    set(105, cx - 0.07, 0.40 - browUp * 0.03); set(334, cx + 0.07, 0.40 - browUp * 0.03);
    const scores = { jawOpen: open, mouthSmileLeft: smile, mouthSmileRight: smile, mouthPucker: pucker, cheekPuff: puff, eyeBlinkLeft: blinkL, browInnerUp: browUp };
    return { landmarks: lm, blendshapes: BS.map(n => ({ categoryName: n, score: scores[n] || 0 })), matrix: null };
  };
  window.__feedFace = (p) => { window.__lab.AVSYNC.ovFace = window.__face(p); window.__lab.AVSYNC.faceAspect = 1; };
});
const fox = () => page.evaluate(() => {
  const g = window.__eng.objects.find(o => o.userData.eng.type === 'fox');
  const rec = window.__eng.foxes.get(g.userData.eng.id), F = rec.driver, V = window.__lab.THREE.Vector3;
  const inv = g.matrixWorld.clone().invert();
  const P = n => { const v = new V().setFromMatrixPosition(F.bones[n].matrixWorld).applyMatrix4(inv); return [+v.x.toFixed(3), +v.y.toFixed(3), +v.z.toFixed(3)]; };
  const J = F.c.joints;
  const S = F.seam && F.seam.stats, E = S ? S.edgeList : [], O = F.seam ? F.seam.orig : null, A = F.seam ? F.seam.pos.array : null;
  const mo = (list, k) => list.length ? +(list.reduce((s, e) => s + (A[e.v * 3 + k] - O[e.v * 3 + k]), 0) / list.length).toFixed(4) : 0;
  const tip = E.filter(e => Math.abs(e.u) < 0.12), corner = E.filter(e => Math.abs(e.u) > 0.75);
  return { live: rec.live, calibrated: F.calibrated, seen: F.seen, seam: S ? { sharpened: S.sharpened, edge: S.edge } : null, tipZ: mo(tip, 2), cornerZ: mo(corner, 2), cornerY: mo(corner, 1), open: +F.ch.open.toFixed(2), smile: +F.ch.smile.toFixed(2), yaw: +F.head.yaw.toFixed(1),
           lip: P(J.lipLowerTip), snout: P(J.snoutTip), cL: P(J.cornerL), cR: P(J.cornerR), browL: P(J.browL), eyeScaleR: +F.bones[J.browR].scale.y.toFixed(2),
           listed: [...document.querySelectorAll('.engRow')].some(r => /🦊|🎭/.test(r.textContent)),
           strip: [...document.querySelectorAll('#engAvCtl .opt')].map(b => b.textContent), label: document.getElementById('engAvCtlLbl').textContent,
           pip: getComputedStyle(document.getElementById('engCamPip')).display, foxClass: document.body.classList.contains('eng-fox') };
});
const out = {};
out.spawn = await fox();
await page.evaluate(async () => { const g = window.__eng.objects.find(o => o.userData.eng.type === 'fox'); await window.__eng.foxSetLive(g, true, { sdk: false }); });
await page.evaluate(() => window.__feedFace({}));
await sleep(1800);                                             // neutral capture
out.neutral = await fox();
await shot('fox-neutral.png');
const closeup = () => page.evaluate(() => { const g = window.__eng.objects.find(o => o.userData.eng.type === 'fox'); const rec = window.__eng.foxes.get(g.userData.eng.id); const V = window.__lab.THREE.Vector3; const t = new V().setFromMatrixPosition(rec.driver.bones['Bone_037'].matrixWorld); const E = window.__eng; E.orbit.target.copy(t); E.camera.position.set(t.x + 0.35, t.y + 0.05, t.z + 0.55); E.camera.lookAt(t); });
const expr = async (name, p, ms = 900) => { await page.evaluate(p => window.__feedFace(p), p); await sleep(ms); out[name] = await fox(); await shot('fox-' + name + '.png'); await closeup(); await sleep(150); await shot('fox-' + name + '-close.png'); await page.evaluate(() => { const g = window.__eng.objects.find(o => o.userData.eng.type === 'fox'); window.__eng.orbit.enabled = false; }); await page.evaluate(() => { const g = window.__eng.objects.find(o => o.userData.eng.type === 'fox'); const rec = window.__eng.foxes.get(g.userData.eng.id); const E = window.__eng; const s = g.scale.x || 1, h = g.rotation.y; E.orbit.target.set(g.position.x, g.position.y + rec.headY * s, g.position.z); E.camera.position.set(g.position.x + Math.sin(h) * 1.9 * s, g.position.y + rec.headY * s + 0.15, g.position.z + Math.cos(h) * 1.9 * s); E.camera.lookAt(E.orbit.target); }); await page.evaluate(() => window.__feedFace({})); await sleep(600); };
await expr('open', { open: 0.9 });
await expr('smile', { smile: 1 });
await expr('pucker', { pucker: 1 });
await expr('brows', { browUp: 1, blinkL: 1 });
await expr('turn', { yaw: 30 }, 1200);
await page.evaluate(() => { window.__lab.AVSYNC.ovFace = null; });
await sleep(2500);
out.lost = await fox();
await page.evaluate(async () => { window.__lab.AVSYNC.ovFace = undefined; const g = window.__eng.objects.find(o => o.userData.eng.type === 'fox'); await window.__eng.foxSetLive(g, false); });
await sleep(300);
out.off = await fox();

console.log(JSON.stringify(out, null, 1));
console.log('errors:', errors.length ? errors : 'none');
const n = out.neutral;
const ok = out.spawn.listed && out.spawn.strip.some(t => /mirror me/.test(t)) && /FOX/.test(out.spawn.label)
  && n.live && n.calibrated && n.pip === 'block' && n.foxClass
  && out.open.lip[1] < n.lip[1] - 0.012 && out.open.open > 0.5
  && n.seam && n.seam.sharpened > 300 && n.seam.edge > 150
  && out.smile.cornerZ < -0.004 && out.smile.cornerY > 0.001          // smile: lip edge back along the muzzle + up
  && out.pucker.tipZ > 0.003 && out.pucker.cornerZ > 0.001            // pucker: tip pouts out, edge slides toward the tip
  && out.brows.browL[1] > n.browL[1] + 0.006 && out.brows.eyeScaleR < 0.7
  && out.turn.yaw > 8 && out.turn.snout[0] < n.snout[0] - 0.02
  && Math.abs(out.lost.lip[1] - n.lip[1]) < 0.006 && !out.lost.seen
  && !out.off.live && out.off.pip === 'none' && errors.length === 0;
console.log(ok ? 'FOX PROBE OK' : 'FOX PROBE FAILED');
await browser.close();
process.exit(ok ? 0 : 1);
