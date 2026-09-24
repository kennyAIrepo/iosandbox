// dump whatever the page throws on boot
import puppeteer from 'puppeteer-core';
const b = await puppeteer.launch({ executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: 'new',
  args: ['--no-sandbox', '--use-gl=angle', '--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'] });
const p = await b.newPage();
const errs = [];
p.on('pageerror', e => errs.push('pageerror: ' + e.message + '\n' + (e.stack || '').split('\n').slice(0, 3).join('\n')));
p.on('console', m => { if (m.type() === 'error') errs.push('console: ' + m.text().slice(0, 300)); });
await p.goto(process.env.PROBE_URL || 'http://localhost:3333/mpbrowser.html', { waitUntil: 'domcontentloaded' });
await new Promise(r => setTimeout(r, 2500));
console.log('has __lab:', await p.evaluate(() => !!window.__lab));
try { await p.click('#startBtn'); } catch (e) { console.log('startBtn click failed:', e.message.slice(0, 80)); }
await new Promise(r => setTimeout(r, 25000));
console.log('running:', await p.evaluate(() => window.__lab && window.__lab.S && window.__lab.S.running));
console.log('errors:', errs.length ? errs.slice(0, 6) : 'none');
await b.close();
