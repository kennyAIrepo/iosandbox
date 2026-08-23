/** Ground-truth clip evaluation: plays real ASL Citizen validation clips
 *  (filename carries the gloss) through signlab's ?video= adapter with the
 *  default trained model, and reports every token/lowconf emitted per clip.
 *  This is the serve-path truth test: if validation clips score near the
 *  offline 74.5% here, the browser pipeline is faithful; if they score
 *  garbage, there's a train/serve feature mismatch. Server on :3333 required.
 */
import puppeteer from 'puppeteer-core';
import { readdirSync } from 'node:fs';

const CLIPS = readdirSync('tests/fixtures/clips').filter(f => f.endsWith('.mp4'));
const browser = await puppeteer.launch({
  executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe',
  headless: 'new',
  args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream',
         '--window-size=1400,900', '--no-sandbox', '--autoplay-policy=no-user-gesture-required'],
});

let hits = 0, total = 0;
for (const clip of CLIPS) {
  const truth = clip.replace(/\.mp4$/, '').split('-').pop().toUpperCase();
  const page = await browser.newPage();
  const events = [];
  page.on('console', m => {
    const t = m.text();
    if (t.startsWith('[signlab]')) events.push(t);
  });
  // tokens land in the tokens pane via tokLog; capture them via the signer events
  await page.evaluateOnNewDocument(() => {
    window.__tokens = [];
  });
  await page.goto(`http://localhost:3333/signlab.html?video=/tests/fixtures/clips/${encodeURIComponent(clip)}`,
    { waitUntil: 'domcontentloaded', timeout: 20000 });
  await new Promise(r => setTimeout(r, 24000));   // model load + clip loops a few times
  const toks = await page.evaluate(() => document.getElementById('tokens')?.textContent || '');
  await page.close();
  const lines = toks.split('\n').filter(Boolean);
  const allText = lines.join(' ');
  // strip trailing digits: ASL Citizen glosses like SHARK2/YES1 count as their base word
  const hit = new RegExp(`\\b${truth}\\d?\\b`, 'i').test(allText);
  total++;
  if (hit) hits++;
  console.log(`\n═══ ${clip}  (truth: ${truth})  →  ${hit ? 'HIT ✓' : 'MISS ✗'}`);
  lines.slice(0, 8).forEach(l => console.log('   ' + l));
  if (!lines.length) console.log('   (no tokens emitted at all)');
}
console.log(`\nRESULT: ${hits}/${total} clips produced the ground-truth gloss`);
await browser.close();
process.exit(0);
