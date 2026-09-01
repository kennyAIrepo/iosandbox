#!/usr/bin/env node
/**
 * extract-anim — split a rigged+animated GLB (Meshy export) into reusable parts.
 * ═══════════════════════════════════════════════════════════════════════════════
 * Meshy ships ONE clip per GLB, each file carrying the full 17-40MB model. This
 * tool separates them so the engine ships ONE rig master + tiny animation
 * packages that graft back on by bone name (validated: glTF clips target nodes
 * by name; identical-skeleton exports recombine losslessly).
 *
 *   node tools/extract-anim.mjs <in.glb> --anim-out sdk/assets/anims/walk.anim.json
 *   node tools/extract-anim.mjs <in.glb> --rig-out sdk/assets/avatars/master.glb
 *   (both flags may be combined; --name overrides the clip name in the JSON)
 *
 * .anim.json format (consumed by the engine's avatar class, engRebuildClip):
 *   { name, duration, source, tracks: [{ bone, path, interpolation, times[], values[] }] }
 *   path ∈ translation | rotation | scale  (rotation values are quaternion XYZW)
 */
import { readFileSync, writeFileSync, statSync } from 'node:fs';

const args = process.argv.slice(2);
const src = args[0];
const opt = (f) => { const i = args.indexOf(f); return i >= 0 ? args[i + 1] : null; };
if (!src) { console.error('usage: extract-anim <in.glb> [--anim-out x.anim.json] [--rig-out y.glb] [--name clipName]'); process.exit(1); }

const buf = readFileSync(src);
if (buf.slice(0, 4).toString() !== 'glTF') { console.error('not a GLB'); process.exit(1); }
const jsonLen = buf.readUInt32LE(12);
const g = JSON.parse(buf.slice(20, 20 + jsonLen).toString());
const binStart = 20 + jsonLen + 8;
const binLen = buf.readUInt32LE(20 + jsonLen);

const accArr = (i) => {
  const a = g.accessors[i], bv = g.bufferViews[a.bufferView];
  const off = binStart + (bv.byteOffset || 0) + (a.byteOffset || 0);
  const comps = { SCALAR: 1, VEC3: 3, VEC4: 4 }[a.type];
  return Array.from(new Float32Array(buf.buffer, buf.byteOffset + off, a.count * comps));
};

const animOut = opt('--anim-out');
if (animOut) {
  const anim = (g.animations || [])[0];
  if (!anim) { console.error('no animation in ' + src); process.exit(1); }
  const tracks = anim.channels.map(c => {
    const s = anim.samplers[c.sampler];
    return {
      bone: g.nodes[c.target.node].name,
      path: c.target.path,
      interpolation: s.interpolation || 'LINEAR',
      times: accArr(s.input),
      values: accArr(s.output),
    };
  });
  const duration = Math.max(...tracks.map(t => t.times[t.times.length - 1]));
  const name = opt('--name') || anim.name;
  writeFileSync(animOut, JSON.stringify({ name, duration, source: src.split(/[\\/]/).pop(), tracks }));
  console.log('anim →', animOut, '|', tracks.length, 'tracks |', duration.toFixed(3) + 's |', (statSync(animOut).size / 1024).toFixed(1) + 'KB');
}

const rigOut = opt('--rig-out');
if (rigOut) {
  const g2 = JSON.parse(JSON.stringify(g));
  delete g2.animations;                       // rig/mesh/skin untouched; loaders ignore unused accessors
  let js = JSON.stringify(g2);
  while (js.length % 4) js += ' ';
  const jb = Buffer.from(js);
  const bin = buf.slice(binStart, binStart + binLen);
  const total = 12 + 8 + jb.length + 8 + bin.length;
  const out = Buffer.alloc(total);
  out.write('glTF', 0); out.writeUInt32LE(2, 4); out.writeUInt32LE(total, 8);
  out.writeUInt32LE(jb.length, 12); out.write('JSON', 16); jb.copy(out, 20);
  out.writeUInt32LE(bin.length, 20 + jb.length); out.write('BIN\0', 24 + jb.length);
  bin.copy(out, 28 + jb.length);
  writeFileSync(rigOut, out);
  console.log('rig  →', rigOut, '|', (total / 1048576).toFixed(1) + 'MB | animations stripped');
}
