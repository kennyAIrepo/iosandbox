#!/usr/bin/env node
// Prints the LIVE cloud-lane URLs for mpgames (quick-tunnel hostnames change on
// every relaunch; the node's watchdog publishes the current ones to
// ~/hopeos/tunnels.json). Usage: node tools/b3iq-url.mjs [--open]
import { execSync } from 'node:child_process';
let j;
try { j = JSON.parse(execSync('ssh -o ConnectTimeout=10 -o BatchMode=yes b3iq cat ~/hopeos/tunnels.json', { encoding: 'utf8' })); }
catch (e) { console.error('could not read tunnels.json from b3iq —', e.message.split('\n')[0]); process.exit(1); }
const age = Math.round((Date.now() - Date.parse(j.updated)) / 60000);
const page = process.env.MPGAMES_URL || 'http://localhost:3333/mpgames.html';
console.log(`b3iq lanes (published ${age} min ago by the watchdog on ${j.host}):`);
console.log(`  tracking/IDs (:8765, NBA gate + BoT-SORT ReID) → ${j.yolo}`);
console.log(`  SAM3 + pose  (:8766, concepts/rig, all people) → ${j.sam3}`);
console.log(`\nmpgames (tracking lane): ${page}?server=${encodeURIComponent(j.yolo)}`);
console.log(`mpgames (SAM3 lane):     ${page}?server=${encodeURIComponent(j.sam3)}`);
if (process.argv.includes('--open')) execSync(`start "" "${page}?server=${encodeURIComponent(j.yolo)}"`, { shell: 'cmd.exe' });
