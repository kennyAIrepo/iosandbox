// open the LIVE Vercel pages with ?server= and prove each shell reaches its cloud lane
import puppeteer from 'puppeteer-core';
const SAM3 = 'wss://adam-commented-cholesterol-regards.trycloudflare.com', SAMLAB = 'wss://midi-relationship-curves-immigration.trycloudflare.com';
const b = await puppeteer.launch({ executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: 'new',
  args: ['--no-sandbox', '--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'] });
const sleep = ms => new Promise(r => setTimeout(r, ms));
// 1. samlab: the page itself reports the socket state in #stat
{ const p = await b.newPage(); const url = 'https://iosandbox.vercel.app/samlab.html?server=' + SAMLAB;
  await p.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 }); await sleep(6000);
  console.log('samlab   ', JSON.stringify(await p.evaluate(() => document.getElementById('stat')?.textContent || '(no #stat)')), '←', url); await p.close(); }
// 2. studio: ?server= is stored and a socket to it opens (S.ws in the page)
{ const p = await b.newPage(); const url = 'https://iosandbox.vercel.app/studio.html?server=' + SAM3;
  const seen = []; p.on('console', m => { const t = m.text(); if (/connect|LIVE|socket|ws/i.test(t)) seen.push(t.slice(0, 90)); });
  await p.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 }); await sleep(8000);
  const r = await p.evaluate(() => ({ stored: localStorage.getItem('hopeos-studio-server'), stat: (document.getElementById('stat') || document.querySelector('#hud, #status, .stat'))?.textContent?.slice(0, 90) || null }));
  console.log('studio   ', JSON.stringify(r), seen.slice(0, 3).join(' | ') || '', '←', url); await p.close(); }
// 3. mpbrowser: ?server= is saved as the tracking server the page will use
{ const p = await b.newPage(); const url = 'https://iosandbox.vercel.app/mpbrowser.html?server=' + SAM3;
  await p.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 }); await sleep(4000);
  console.log('mpbrowser', JSON.stringify(await p.evaluate(() => ({ stored: localStorage.getItem('hopeos-yolo-server'), box: document.getElementById('yoloSrv')?.value || document.getElementById('yoloSrv')?.placeholder }))), '←', url); await p.close(); }
await b.close();
