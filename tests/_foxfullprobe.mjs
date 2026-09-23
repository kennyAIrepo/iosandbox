// verify the engine FULL-BODY FOX (authored ARP-style face rig) end-to-end in a
// real browser through the synthetic face seam (AVSYNC.ovFace): spawns via the
// SPAWN row (🦊 Fox), lists it, the strip shows 🎭 mirror me, going live
// calibrates a neutral that CLOSES the modelled-open mouth, then jaw open /
// smile / pucker / brows+blink / gaze / head turn each move the right bones,
// the PiP shows, and stopping releases. Screenshots (head close-ups) per
// expression land in PROBE_SHOTS.   needs: npm run serve (port 3333)
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
await page.click('#engSpawnRow [data-sp="foxfull"]');
await page.waitForFunction(() => window.__eng.objects.some(o => o.userData.eng.type === 'fox'), { timeout: 120000 });
await sleep(400);

await page.evaluate(() => {
  const BS = ['jawOpen', 'mouthSmileLeft', 'mouthSmileRight', 'mouthPucker', 'mouthFunnel', 'cheekPuff', 'eyeBlinkLeft', 'eyeBlinkRight', 'eyeWideLeft', 'eyeWideRight', 'browInnerUp', 'browDownLeft', 'browDownRight', 'eyeLookInLeft', 'eyeLookOutLeft', 'eyeLookInRight', 'eyeLookOutRight', 'eyeLookUpLeft', 'eyeLookUpRight', 'eyeLookDownLeft', 'eyeLookDownRight', 'noseSneerLeft', 'noseSneerRight'];
  const UP = [61, 185, 40, 39, 37, 0, 267, 269, 270, 409, 291], LO = [61, 146, 91, 181, 84, 17, 314, 405, 321, 375, 291];
  window.__face = ({ open = 0, smile = 0, pucker = 0, browUp = 0, blinkL = 0, yaw = 0, gaze = 0 } = {}) => {
    const lm = new Array(478).fill(0).map(() => ({ x: 0.5, y: 0.5, z: 0 }));
    const set = (i, x, y) => { lm[i] = { x, y, z: 0 }; };
    const W = 0.3, cx = 0.5, yawS = yaw / 90 * 0.5;
    set(234, cx - W / 2, 0.5); set(454, cx + W / 2, 0.5); set(10, cx, 0.30); set(152, cx, 0.72 + open * 0.05);
    set(1, cx + yawS * W * 0.6, 0.52); set(168, cx, 0.45); set(33, cx - 0.08, 0.45); set(263, cx + 0.08, 0.45);
    set(13, cx, 0.615); set(14, cx, 0.625 + open * 0.05);
    const hw = 0.05 + smile * 0.03 - pucker * 0.03;
    UP.forEach((i, k) => { const t = k / 10 * 2 - 1; set(i, cx + t * hw, 0.60 + 0.02 * t * t - smile * 0.02 * t * t); });
    LO.forEach((i, k) => { const t = k / 10 * 2 - 1; const o = Math.abs(t) > 0.99 ? open * 0.012 : open * 0.05; set(i, cx + t * hw, 0.645 + o - 0.025 * t * t - smile * 0.02 * t * t); });
    set(50, cx - 0.08, 0.56 - smile * 0.015); set(280, cx + 0.08, 0.56 - smile * 0.015);
    for (const [i, x] of [[107, 0.46], [66, 0.44], [105, 0.43], [63, 0.41], [336, 0.54], [296, 0.56], [334, 0.57], [293, 0.59]]) set(i, x, 0.40 - browUp * 0.03);
    const scores = { jawOpen: open, mouthSmileLeft: smile, mouthSmileRight: smile, mouthPucker: pucker, eyeBlinkLeft: blinkL, browInnerUp: browUp,
      eyeLookOutLeft: Math.max(0, gaze), eyeLookInLeft: Math.max(0, -gaze), eyeLookInRight: Math.max(0, gaze), eyeLookOutRight: Math.max(0, -gaze) };
    return { landmarks: lm, blendshapes: BS.map(n => ({ categoryName: n, score: scores[n] || 0 })), matrix: null };
  };
  window.__feedFace = (p) => { window.__lab.AVSYNC.ovFace = window.__face(p); window.__lab.AVSYNC.faceAspect = 1; };
});
const fox = () => page.evaluate(() => {
  const g = window.__eng.objects.find(o => o.userData.eng.type === 'fox');
  const rec = window.__eng.foxes.get(g.userData.eng.id), F = rec.driver;
  const P = n => { const v = F.modelPos(n).clone(); return [+v.x.toFixed(4), +v.y.toFixed(4), +v.z.toFixed(4)]; };
  return { kind: rec.kind, live: rec.live, calibrated: F.calibrated, seen: F.seen, open: +F.ch.open.toFixed(2), yaw: +F.head.yaw.toFixed(1),
           gap: +(F.modelPos('lips_top.x').y - F.modelPos('lips_bot.x').y).toFixed(4), restGap: +F.ring.gapTip.toFixed(4),
           chin: P('chin_01.x'), cL: P('lips_smile.l'), top: P('lips_top.x'), brow: P('eyebrow_02.l'), lidR: P('eyelid_top_02.r'), nose: P('nose_tip.x'),
           eyeQ: +F.bones['eye.l'].quaternion.angleTo(F.rest['eye.l'].q).toFixed(3),
           listed: [...document.querySelectorAll('.engRow')].some(r => /🦊|🎭/.test(r.textContent)),
           strip: [...document.querySelectorAll('#engAvCtl .opt')].map(b => b.textContent), label: document.getElementById('engAvCtlLbl').textContent,
           pip: getComputedStyle(document.getElementById('engCamPip')).display, foxClass: document.body.classList.contains('eng-fox') };
});
const closeup = () => page.evaluate(() => {
  const g = window.__eng.objects.find(o => o.userData.eng.type === 'fox'); const rec = window.__eng.foxes.get(g.userData.eng.id);
  const V = window.__lab.THREE.Vector3; const t = new V().setFromMatrixPosition(rec.driver.bones['nose_tip.x'].matrixWorld);
  const h = new V().setFromMatrixPosition(rec.driver.bones['head'].matrixWorld); const c = t.clone().lerp(h, 0.35);
  const E = window.__eng; E.orbit.target.copy(c); const fwd = t.clone().sub(h).setY(0).normalize();
  E.camera.position.copy(c).addScaledVector(fwd, 0.55).add(new V(0.12, 0.02, 0)); E.camera.lookAt(c);
});
const out = {};
out.spawn = await fox();
await page.evaluate(async () => { const g = window.__eng.objects.find(o => o.userData.eng.type === 'fox'); await window.__eng.foxSetLive(g, true, { sdk: false }); });
await page.evaluate(() => window.__feedFace({}));
await sleep(1800);
out.neutral = await fox();
await closeup(); await sleep(150); await shot('foxfull-neutral.png');
const expr = async (name, p, ms = 900) => { await page.evaluate(p => window.__feedFace(p), p); await sleep(ms); out[name] = await fox(); await closeup(); await sleep(120); await shot('foxfull-' + name + '.png'); await page.evaluate(() => window.__feedFace({})); await sleep(600); };
await expr('open', { open: 0.9 });
await expr('smile', { smile: 1 });
await expr('pucker', { pucker: 1 });
await expr('brows', { browUp: 1, blinkL: 1 });
await expr('gaze', { gaze: 1 });
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
const ok = out.spawn.kind === 'full' && out.spawn.listed && out.spawn.strip.some(t => /mirror me/.test(t)) && /FOX/.test(out.spawn.label)
  && n.live && n.calibrated && n.pip === 'block' && n.foxClass
  && out.spawn.gap - n.gap > n.restGap * 0.75                             // neutral shuts the modelled lip slot
  && out.open.open > 0.5 && out.open.chin[1] < n.chin[1] - 0.015 && out.open.gap > n.restGap
  && out.smile.cL[2] < n.cL[2] - 0.004 && out.smile.cL[1] > n.cL[1] + 0.002   // commissure back along the muzzle + up
  && out.pucker.top[2] > n.top[2] + 0.003
  && out.brows.brow[1] > n.brow[1] + 0.003 && out.brows.lidR[1] < n.lidR[1] - 0.004
  && out.gaze.eyeQ > 0.08
  && out.turn.yaw > 8 && out.turn.nose[0] < n.nose[0] - 0.01
  && Math.abs(out.lost.gap - out.spawn.gap) < 0.004 && !out.lost.seen
  && !out.off.live && out.off.pip === 'none' && errors.length === 0;
console.log(ok ? 'FOXFULL PROBE OK' : 'FOXFULL PROBE FAILED');
await browser.close();
process.exit(ok ? 0 : 1);
