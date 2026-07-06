/** Bake a beat map for an embedded audio file: decode + analyze it in
 *  headless Chrome (Node has no MP3 decoder) using the EXACT same
 *  analyzeSignal the runtime uses, and write the analysis JSON next to it.
 *  Needs :3333. Usage: node tests/_bake-audio.mjs [audioUrl] [outFile] [name]
 */
import puppeteer from 'puppeteer-core';
import { writeFileSync } from 'fs';

const AUDIO_URL = process.argv[2] || '/assets/audio/beat-it.mp3';
const OUT = process.argv[3] || 'assets/audio/beat-it.map.json';
const NAME = process.argv[4] || 'Beat It ⭐ (baked)';

const browser = await puppeteer.launch({
  executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe',
  headless: 'new',
  args: ['--autoplay-policy=no-user-gesture-required', '--no-sandbox'],
});
const page = await browser.newPage();
page.on('pageerror', e => console.error('[PAGEERROR]', e.message));
await page.goto('http://localhost:3333/handlab', { waitUntil: 'domcontentloaded', timeout: 20000 });

const meta = await page.evaluate(async (audioUrl, name) => {
  const { analyzeSignal } = await import('/sdk/core/beat-audio.js');
  const res = await fetch(audioUrl);
  if (!res.ok) throw new Error('fetch ' + res.status);
  const ab = await res.arrayBuffer();
  const ctx = new (window.AudioContext || window.webkitAudioContext)();
  const audio = await ctx.decodeAudioData(ab);
  const ch0 = audio.getChannelData(0);
  let mono = ch0;
  if (audio.numberOfChannels > 1) {
    const ch1 = audio.getChannelData(1);
    mono = new Float32Array(ch0.length);
    for (let i = 0; i < ch0.length; i++) mono[i] = (ch0[i] + ch1[i]) * 0.5;
  }
  const a = analyzeSignal(mono, audio.sampleRate);
  return {
    name,
    bpm: a.bpm,
    offset: a.offset,
    duration: audio.duration,
    sampleRate: audio.sampleRate,
    bakedAt: new Date().toISOString(),
    onsets: a.onsets.map(o => ({ t: +o.t.toFixed(4), energy: +o.energy.toFixed(5), low: o.low })),
  };
}, AUDIO_URL, NAME);

writeFileSync(OUT, JSON.stringify(meta));
console.log(`baked: ${OUT} — ${meta.name} · ${meta.bpm} BPM · ${meta.onsets.length} onsets · ${Math.round(meta.duration)}s`);
await browser.close();
