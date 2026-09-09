/**
 * hopeOS SDK — RigPuppet + rig-script player
 * ═══════════════════════════════════════════════════════════════
 * Loads any rigged GLB and drives its PRE-RIGGED POINTS (bones) from a
 * declarative animation script — the browser-native counterpart of the
 * Blender golfball rig view. No baked clips needed: the script speaks
 * bone names, the puppet applies additive offsets over the rest pose.
 *
 * SCRIPT FORMAT (JSON — "the script the JS takes in"):
 * {
 *   "name": "tongue-flick",
 *   "duration": 2.0,          // seconds; loop wraps here
 *   "loop": true,
 *   "tracks": [               // keyframed channels, degrees / local units
 *     { "bone": "Tongue_Mid", "ch": "rx", "keys": [[0,0],[0.15,45],[0.35,-10],[0.6,0]] },
 *     { "bone": "Bone_048", "path": [[0,0,0,0],[0.4,0.1,0.05,0]] }   // PATH track
 *   ],
 *   "oscillators": [          // continuous sway layered on top
 *     { "bone": "Bone_049", "ch": "rz", "amp": 3, "freq": 0.4, "phase": 0 }
 *   ]
 * }
 * Channels: rx ry rz (degrees, bone-local, additive over rest)
 *           px py pz (local translation offset, model units)
 * Keys interpolate with smoothstep; value holds after the last key.
 * PATH tracks: samples [[t, px,py,pz], ...] in bone-local units — a dragged
 * rig point recorded over time (linear interp, holds at the ends). Same
 * additive layer as everything else, so a path REMIXES onto any preset.
 *
 * PER-TRACK CONTROL (learned from Blender/Unity rig systems):
 *   weight: 0..1   — extent of the movement (Unity constraint weight /
 *                    Blender NLA influence). Scales this track's offsets.
 *   easing: "smooth" (default) | "linear" | "step" | "easeIn" | "easeOut"
 *                  — key interpolation shape (Blender F-curve easing)
 *   lag: seconds   — evaluate this track shifted back in time (Unity
 *                    Damped Transform feel: followers trail the leader)
 * Puppet-wide: puppet.weight (0..1) is the master influence dial scaling
 * ALL script motion (a Unity rig-layer weight). Direct setPose() drives
 * are never scaled — dragging must track the cursor 1:1.
 *
 * COMPOSE / SEQUENCE (the session model):
 *   composeScripts(name, a, b, ...)  → one script, tracks merged (remix —
 *                                      offsets add; duration = max)
 *   sequenceScripts(name, [a, b])    → one script, b's keys shifted after a
 *                                      (film — durations sum)
 *
 * Usage (see riglab.html):
 *   const puppet = new RigPuppet().bind(gltf.scene);
 *   puppet.showMarkers(true);            // golfball rig points, like Blender
 *   puppet.play(scriptJson);
 *   puppet.update(dt);                   // per frame
 *   puppet.setPose({ 'Tongue_Tip': { rx: 30 } });  // or drive directly
 */

import * as THREE from 'three';

const D2R = Math.PI / 180;
const CHANNELS = ['rx', 'ry', 'rz', 'px', 'py', 'pz'];

function smoothstep(a, b, x) {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
}

/** Interpolation shaping (Blender F-curve easing modes). */
const EASE = {
  smooth: x => x * x * (3 - 2 * x),
  linear: x => x,
  step: x => (x < 1 ? 0 : 1),
  easeIn: x => x * x,
  easeOut: x => 1 - (1 - x) * (1 - x),
};

/** Evaluate a key list [[t,v],...] at time t with an easing shape. */
function evalKeys(keys, t, easing) {
  if (!keys.length) return 0;
  if (t <= keys[0][0]) return keys[0][1];
  const shape = EASE[easing] || EASE.smooth;
  for (let i = 1; i < keys.length; i++) {
    if (t <= keys[i][0]) {
      const [t0, v0] = keys[i - 1], [t1, v1] = keys[i];
      const f = Math.min(1, Math.max(0, (t - t0) / (t1 - t0 || 1)));
      return v0 + (v1 - v0) * shape(f);
    }
  }
  return keys[keys.length - 1][1];
}

/** Evaluate a path sample list [[t,px,py,pz],...] at t → [px,py,pz]. */
function evalPath(samples, t) {
  if (!samples.length) return [0, 0, 0];
  if (t <= samples[0][0]) return samples[0].slice(1);
  for (let i = 1; i < samples.length; i++) {
    if (t <= samples[i][0]) {
      const a = samples[i - 1], b = samples[i];
      const f = (t - a[0]) / (b[0] - a[0] || 1);
      return [1, 2, 3].map(k => a[k] + (b[k] - a[k]) * f);
    }
  }
  return samples[samples.length - 1].slice(1);
}

/** Remix scripts into one: tracks/oscillators concatenated (offsets are
 *  additive), duration = max. Later args layer OVER earlier ones. */
export function composeScripts(name, ...scripts) {
  const list = scripts.filter(Boolean);
  return {
    name,
    duration: Math.max(...list.map(s => s.duration || 1), 0.01),
    loop: list.some(s => s.loop !== false),
    tracks: list.flatMap(s => s.tracks || []),
    oscillators: list.flatMap(s => s.oscillators || []),
  };
}

/** Film: play scripts back-to-back. Each segment's keys/paths are shifted by
 *  the summed durations before it; oscillators become windowed tracks so a
 *  segment's sway does not bleed into the next. */
export function sequenceScripts(name, scripts) {
  const out = { name, duration: 0, loop: true, tracks: [], oscillators: [] };
  for (const s of scripts.filter(Boolean)) {
    const t0 = out.duration, dur = s.duration || 1;
    for (const tr of s.tracks || []) {
      out.tracks.push(tr.path
        ? { bone: tr.bone, path: tr.path.map(p => [p[0] + t0, p[1], p[2], p[3]]) }
        : { bone: tr.bone, ch: tr.ch, keys: tr.keys.map(([t, v]) => [t + t0, v]) });
    }
    for (const os of s.oscillators || []) {
      // bake the oscillator into keys inside its window (8 keys per cycle)
      const keys = [];
      const n = Math.max(8, Math.ceil(dur * (os.freq || 1) * 8));
      for (let i = 0; i <= n; i++) {
        const t = (dur * i) / n;
        keys.push([t0 + t, os.amp * Math.sin(2 * Math.PI * (os.freq || 1) * t + (os.phase || 0))]);
      }
      out.tracks.push({ bone: os.bone, ch: os.ch, keys });
    }
    out.duration += dur;
  }
  return out;
}

export class RigPuppet {
  constructor() {
    this.root = null;
    this.bones = {};        // name → THREE.Bone
    this.rest = {};         // name → { quat, pos } captured at bind
    this.script = null;
    this.time = 0;
    this.playing = false;
    this.rate = 1;
    this.weight = 1;        // master influence 0..1 (Unity rig-layer weight)
    this.markers = null;    // THREE.Group of golfballs, children of bones
    this._pose = {};        // name → {rx..pz} external direct-drive layer
    this._euler = new THREE.Euler();
    this._q = new THREE.Quaternion();
  }

  /** Bind to a loaded GLB scene. Captures the rest pose. */
  bind(scene) {
    this.root = scene;
    scene.traverse(o => {
      if (o.isBone) {
        this.bones[o.name] = o;
        this.rest[o.name] = { quat: o.quaternion.clone(), pos: o.position.clone() };
      }
    });
    return this;
  }

  /** Rig points, hierarchy order. */
  points() { return Object.keys(this.bones); }

  /** Golfball markers on every bone — the Blender rig view, in-browser. */
  showMarkers(on, { size } = {}) {
    if (!on) {
      if (this.markers) { for (const m of this.markers) m.removeFromParent(); this.markers = null; }
      return;
    }
    if (this.markers) return;
    const box = new THREE.Box3().setFromObject(this.root);
    const r = size ?? box.getSize(new THREE.Vector3()).length() * 0.012;
    const geo = new THREE.IcosahedronGeometry(r, 1);
    const mat = new THREE.MeshStandardMaterial({ color: 0x9aa4ae, flatShading: true,
                                                depthTest: false, transparent: true, opacity: 0.9 });
    this.markers = [];
    for (const [name, bone] of Object.entries(this.bones)) {
      const m = new THREE.Mesh(geo, mat.clone());
      m.renderOrder = 5; m.userData.rigPoint = name;
      // counter the bone's world scale so all golfballs render equal-sized
      const ws = bone.getWorldScale(new THREE.Vector3());
      m.scale.set(1 / (ws.x || 1), 1 / (ws.y || 1), 1 / (ws.z || 1));
      bone.add(m);
      this.markers.push(m);
    }
  }

  /** Tint rig point(s) — name, array, or Set; null resets all. */
  highlight(sel, color = 0x82aaff) {
    if (!this.markers) return;
    const set = new Set(sel == null ? [] : (typeof sel === 'string' ? [sel] : [...sel]));
    for (const m of this.markers)
      m.material.color.set(set.has(m.userData.rigPoint) ? color : 0x9aa4ae);
  }

  /** CREATE a rig point at a world position (browser-side markup — no
   *  Blender round-trip). Parents to the nearest existing bone, then paints
   *  a radius-falloff weight map (Blender weight-painting, automated):
   *  vertices within `radius` blend toward the new bone by strength·
   *  smoothstep(1 - d/r), merged into the glTF 4-influence budget. */
  addRigPoint(name, worldPos, { radius = 0.15, strength = 1 } = {}) {
    if (this.bones[name]) throw new Error(`rig point exists: ${name}`);
    let parent = null, best = Infinity;
    const tmp = new THREE.Vector3();
    for (const b of Object.values(this.bones)) {
      const d = b.getWorldPosition(tmp).distanceToSquared(worldPos);
      if (d < best) { best = d; parent = b; }
    }
    const bone = new THREE.Bone();
    bone.name = name;
    parent.add(bone);
    bone.position.copy(parent.worldToLocal(worldPos.clone()));
    bone.updateMatrixWorld(true);

    const G = [ 'getX', 'getY', 'getZ', 'getW' ], S = [ 'setX', 'setY', 'setZ', 'setW' ];
    let touched = 0;
    this.root.traverse(o => {
      if (!o.isSkinnedMesh || !o.skeleton.bones.includes(parent)) return;
      // rebuild the skeleton (bone arrays + GPU texture are fixed-size)
      const inv = new THREE.Matrix4().copy(bone.matrixWorld).invert();
      o.bind(new THREE.Skeleton([...o.skeleton.bones, bone],
                                [...o.skeleton.boneInverses, inv]), o.bindMatrix);
      const idx = o.skeleton.bones.length - 1;
      const pos = o.geometry.attributes.position;
      const sI = o.geometry.attributes.skinIndex, sW = o.geometry.attributes.skinWeight;
      const local = o.worldToLocal(worldPos.clone());
      const v = new THREE.Vector3();
      for (let i = 0; i < pos.count; i++) {
        v.fromBufferAttribute(pos, i);
        const d = v.distanceTo(local);
        if (d > radius) continue;
        const x = 1 - d / radius;
        const w = Math.min(1, strength) * x * x * (3 - 2 * x);
        if (w < 0.01) continue;
        const inf = [[idx, w]];
        for (let k = 0; k < 4; k++) inf.push([sI[G[k]](i), sW[G[k]](i) * (1 - w)]);
        inf.sort((a, b) => b[1] - a[1]);
        const tot = inf[0][1] + inf[1][1] + inf[2][1] + inf[3][1] || 1;
        for (let k = 0; k < 4; k++) { sI[S[k]](i, inf[k][0]); sW[S[k]](i, inf[k][1] / tot); }
        touched++;
      }
      sI.needsUpdate = sW.needsUpdate = true;
    });

    this.bones[name] = bone;
    this.rest[name] = { quat: bone.quaternion.clone(), pos: bone.position.clone() };
    if (this.markers) { this.showMarkers(false); this.showMarkers(true); }
    return { name, parent: parent.name, weightedVerts: touched };
  }

  /** Load + start an animation script (see format above). */
  play(script) {
    const bad = [...(script.tracks || []), ...(script.oscillators || [])]
      .map(t => t.bone).filter(b => !this.bones[b]);
    if (bad.length) throw new Error(`script names unknown rig points: ${[...new Set(bad)].join(', ')}`);
    this.script = script;
    this.time = 0;
    this.playing = true;
    return this;
  }

  /** Full reset: clears the script and returns to rest pose. */
  stop() { this.playing = false; this.time = 0; this.script = null; this._apply({}); }
  /** Freeze at the current frame (script still evaluated at the held time). */
  pause() { this.playing = false; }
  resume() { if (this.script) this.playing = true; }

  /** Direct drive (external controller, e.g. body-drive): merged over script. */
  setPose(map) { this._pose = map || {}; }

  /** World position of a rig point (marker center). */
  getWorldPos(name, out = new THREE.Vector3()) {
    return this.bones[name].getWorldPosition(out);
  }

  /** Convert a world-space displacement of a rig point into the bone-local
   *  {px,py,pz} offset that reproduces it — exact under any parent rotation/
   *  scale. This is how a screen drag becomes a path sample. */
  worldToLocalOffset(name, worldFrom, worldTo) {
    const parent = this.bones[name].parent;
    const a = parent.worldToLocal(worldFrom.clone());
    const b = parent.worldToLocal(worldTo.clone());
    return { px: b.x - a.x, py: b.y - a.y, pz: b.z - a.z };
  }

  /** Advance and apply. Call every frame. Paused → holds the current frame
   *  (time frozen, script still evaluated); stopped → rest pose. */
  update(dt) {
    const offsets = {};
    if (this.script) {
      if (this.playing) {
        this.time += dt * this.rate;
        const dur = this.script.duration || 1;
        if (this.time > dur) this.time = this.script.loop === false ? dur : this.time % dur;
      }
      for (const tr of this.script.tracks || []) {
        const w = tr.weight ?? 1;
        const tt = this.time - (tr.lag || 0);
        if (tr.path) {
          const [px, py, pz] = evalPath(tr.path, tt);
          const o = offsets[tr.bone] ??= {};
          o.px = (o.px || 0) + px * w; o.py = (o.py || 0) + py * w; o.pz = (o.pz || 0) + pz * w;
        } else {
          (offsets[tr.bone] ??= {})[tr.ch] =
            (offsets[tr.bone]?.[tr.ch] || 0) + evalKeys(tr.keys, tt, tr.easing) * w;
        }
      }
      for (const os of this.script.oscillators || []) {
        const w = os.weight ?? 1;
        (offsets[os.bone] ??= {})[os.ch] = (offsets[os.bone]?.[os.ch] || 0) + w *
          os.amp * Math.sin(2 * Math.PI * (os.freq || 1) * (this.time - (os.lag || 0)) + (os.phase || 0));
      }
      if (this.weight !== 1) {
        for (const chs of Object.values(offsets))
          for (const k of Object.keys(chs)) chs[k] *= this.weight;
      }
    }
    for (const [bone, chs] of Object.entries(this._pose)) {
      for (const [ch, v] of Object.entries(chs))
        (offsets[bone] ??= {})[ch] = (offsets[bone]?.[ch] || 0) + v;
    }
    this._apply(offsets);
  }

  _apply(offsets) {
    for (const [name, rest] of Object.entries(this.rest)) {
      const b = this.bones[name], o = offsets[name];
      if (!o) {
        b.quaternion.copy(rest.quat);
        b.position.copy(rest.pos);
        continue;
      }
      this._euler.set((o.rx || 0) * D2R, (o.ry || 0) * D2R, (o.rz || 0) * D2R, 'XYZ');
      this._q.setFromEuler(this._euler);
      b.quaternion.copy(rest.quat).multiply(this._q);
      b.position.set(rest.pos.x + (o.px || 0), rest.pos.y + (o.py || 0), rest.pos.z + (o.pz || 0));
    }
  }
}
