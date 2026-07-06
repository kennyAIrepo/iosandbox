import puppeteer from 'puppeteer-core';

const SHOT_DIR = 'C:/Users/hanna/AppData/Local/Temp/claude/c--Users-hanna-iosandbox/ff895d67-7e3d-4e61-a2a4-9e17d0578466/scratchpad';
const browser = await puppeteer.launch({
  executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe',
  headless: 'new',
  args: [
    '--use-fake-device-for-media-stream',
    '--use-fake-ui-for-media-stream',
    '--window-size=1400,900',
    '--no-sandbox',
  ],
});

async function probe(name, url, waitMs = 14000, actions = null) {
  const page = await browser.newPage();
  await page.setViewport({ width: 1400, height: 900 });
  const logs = [];
  page.on('console', m => { const t = m.type(); if (t === 'error' || t === 'warning' || t === 'log') logs.push(`[${t}] ${m.text()}`); });
  page.on('pageerror', e => logs.push(`[PAGEERROR] ${e.message}`));
  page.on('requestfailed', r => logs.push(`[REQFAIL] ${r.url().slice(0, 120)} ${r.failure()?.errorText}`));
  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 20000 });
    if (actions) await actions(page);
    await new Promise(r => setTimeout(r, waitMs));
    await page.screenshot({ path: `${SHOT_DIR}/${name}.png` });
    console.log(`\n═══ ${name} (${url}) ═══`);
    logs.slice(0, 40).forEach(l => console.log('  ' + l));
    if (!logs.length) console.log('  (no console output)');
  } catch (e) {
    console.log(`\n═══ ${name} FAILED: ${e.message}`);
  }
  await page.close();
}

await probe('play', 'http://localhost:3333/play');
await probe('handlab', 'http://localhost:3333/handlab', 16000, async (page) => {
  await new Promise(r => setTimeout(r, 1500));
  await page.click('#startBtn').catch(e => console.log('  startBtn click failed: ' + e.message));
});
await probe('landing-mirror', 'http://localhost:3333/', 12000, async (page) => {
  await new Promise(r => setTimeout(r, 1200));
  await page.click('[data-enter="mirror"]').catch(e => console.log('  mirror click failed: ' + e.message));
});

await browser.close();
console.log('\ndone');
