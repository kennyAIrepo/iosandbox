/** riglab LIVE attach — screenshot + state of YOUR actual browser tab.
 *
 *  Requires your Chrome to be started with a CDP debug port, e.g.:
 *    & "C:/Program Files/Google/Chrome/Application/chrome.exe" `
 *      --remote-debugging-port=9222 http://localhost:3333/riglab
 *  (a normal Chrome window — just launched with the extra flag; if Chrome is
 *   already running without it, close it fully first or use a fresh
 *   --user-data-dir)
 *
 *    node tests/_riglablive.mjs
 *
 *  Without the flag, use the journal instead: node tests/_riglabwatch.mjs
 */
import puppeteer from 'puppeteer-core';

const SHOT_DIR = 'C:/Users/hanna/AppData/Local/Temp/claude/c--Users-hanna-iosandbox/d1691736-d038-4eac-b4a5-2f5470f754f5/scratchpad';

let browser;
try {
  browser = await puppeteer.connect({ browserURL: 'http://127.0.0.1:9222', defaultViewport: null });
} catch {
  console.log('no debuggable Chrome on :9222 — start Chrome with --remote-debugging-port=9222');
  console.log('(fallback: node tests/_riglabwatch.mjs reads the journal instead)');
  process.exit(1);
}

const pages = await browser.pages();
const page = pages.find(p => p.url().includes('/riglab'));
if (!page) {
  console.log('no /riglab tab found. open tabs:');
  for (const p of pages) console.log('  ' + p.url());
  browser.disconnect();
  process.exit(1);
}

const state = await page.evaluate(() => ({
  sid: window.__riglab?.sid,
  status: document.getElementById('status')?.textContent,
  selected: document.querySelector('#boneList .sel')?.textContent || null,
  sessions: window.__riglab?.sessions?.map(s => s.name),
  script: (() => { try { return JSON.parse(document.getElementById('script').value); } catch { return null; } })(),
}));
console.log('LIVE tab state:');
console.log('  sid:      ', state.sid);
console.log('  status:   ', state.status);
console.log('  selected: ', state.selected);
console.log('  film stack:', state.sessions?.join(' → ') || '(empty)');
console.log('  script:   ', state.script ? `"${state.script.name}" ${state.script.duration}s, ` +
  `${state.script.tracks?.length || 0} tracks, ${state.script.oscillators?.length || 0} osc` : '(invalid)');

await page.screenshot({ path: `${SHOT_DIR}/riglab_live.png` });
console.log(`\nlive screenshot: ${SHOT_DIR}/riglab_live.png`);
browser.disconnect();
