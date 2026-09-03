// verify povFaceAway — the MEASURED mirror→POV body normalizer. Whatever state
// the retargeted cloud arrives in (proper/mirrored × facing the dolly/away),
// the output must be PROPER (user's left = the figure's anatomical left, on
// screen-left when seen from behind) and FACING AWAY from the dolly, with
// forward-extended limbs going deeper, not toward the camera.
import puppeteer from 'puppeteer-core';
const browser = await puppeteer.launch({
  executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe',
  headless: 'new', args: ['--window-size=1200,800', '--no-sandbox', '--use-gl=angle'],
});
const page = await browser.newPage();
const errors = [];
page.on('pageerror', e => errors.push('pageerror: ' + e.message));
page.on('console', m => { if (m.type() === 'error' && !/favicon|XNNPACK/.test(m.text() + m.location().url)) errors.push('console: ' + m.text()); });
await page.goto('http://localhost:3333/mpbrowser.html', { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => window.__lab && window.__lab.povFaceAway && window.__lab.camera, { timeout: 30000 });

const out = await page.evaluate(() => {
  const T3 = window.__lab.THREE;
  const cam = window.__lab.camera;
  const C = new T3.Vector3(0, 0, -2.2);                    // hip center, ahead of the lab cam
  const away = C.clone().sub(cam.position); away.y = 0; away.normalize();
  const up = new T3.Vector3(0, 1, 0);
  const left = up.clone().cross(away);                     // out-view left when facing away
  // canonical PROPER cloud FACING AWAY: nose ahead of the ears, left arm
  // extended forward (deeper along away)
  const base = () => {
    const p = new Array(33).fill(null);
    const at = (i, l, u, f) => { p[i] = C.clone().addScaledVector(left, l).addScaledVector(up, u).addScaledVector(away, f); };
    at(23, 0.10, 0, 0); at(24, -0.10, 0, 0);               // hips
    at(11, 0.18, 0.5, 0); at(12, -0.18, 0.5, 0);           // shoulders
    at(7, 0.07, 0.66, -0.02); at(8, -0.07, 0.66, -0.02);   // ears
    at(0, 0, 0.62, 0.09);                                  // nose (protrudes forward)
    at(13, 0.25, 0.45, 0.25); at(15, 0.28, 0.42, 0.55);    // L elbow + wrist, reaching out
    at(14, -0.25, 0.45, 0.02); at(16, -0.28, 0.35, 0.02);  // R arm at the side
    at(27, 0.1, -0.9, 0); at(28, -0.1, -0.9, 0);           // ankles
    return p;
  };
  const reflectAcrossAway = p => {                         // improper (a mirror image)
    for (const q of p) { if (!q) continue;
      const d = 2 * ((q.x - C.x) * away.x + (q.z - C.z) * away.z);
      q.x -= d * away.x; q.z -= d * away.z; }
    return p;
  };
  const yaw180 = p => {                                    // proper turn-around
    for (const q of p) { if (!q) continue; q.x = 2 * C.x - q.x; q.z = 2 * C.z - q.z; }
    return p;
  };
  const CASES = {
    properAway: () => base(),
    properToward: () => yaw180(base()),
    mirrorToward: () => reflectAcrossAway(base()),         // classic webcam mirror
    mirrorAway: () => yaw180(reflectAcrossAway(base())),
  };
  const res = {};
  for (const [name, mk] of Object.entries(CASES)) {
    let p = null;
    for (let i = 0; i < 30; i++) p = window.__lab.povFaceAway(mk());   // let the latch settle
    const earMid = p[7].clone().lerp(p[8], 0.5);
    const nose = p[0].clone().sub(earMid).normalize();
    const shoulderFwd = p[11].clone().sub(p[12]).cross(up).normalize();
    const chest = p[11].clone().lerp(p[12], 0.5);
    res[name] = {
      facesAway: +nose.dot(away).toFixed(2),               // > 0: back to the dolly
      proper: +shoulderFwd.dot(nose).toFixed(2),           // > 0: left landmarks on the anatomical left
      reachDepth: +p[15].clone().sub(chest).dot(away).toFixed(2),   // > 0: extended arm goes DEEPER
      leftOnLeft: +p[15].clone().sub(C).dot(left).toFixed(2),       // > 0: left wrist on screen-left
    };
  }
  return res;
});
await browser.close();
console.log(JSON.stringify(out, null, 2));
const fail = [];
for (const [name, r] of Object.entries(out)) {
  if (r.facesAway < 0.05) fail.push(name + ': still faces the dolly (' + r.facesAway + ')');
  if (r.proper < 0.05) fail.push(name + ': mirrored output — left is not anatomical left (' + r.proper + ')');
  if (r.reachDepth < 0.3) fail.push(name + ': extended arm does not go deeper (' + r.reachDepth + ')');
  if (r.leftOnLeft < 0.1) fail.push(name + ': left wrist not on screen-left (' + r.leftOnLeft + ')');
}
if (errors.length) fail.push('errors: ' + errors.join(' | '));
console.log(fail.length ? '✗ FAIL: ' + fail.join('; ') : '✓ povFaceAway normalizes all four input states to proper + facing-away');
process.exit(fail.length ? 1 : 0);
