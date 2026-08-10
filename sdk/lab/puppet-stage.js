/**
 * hopeOS lab — PuppetStage (contract stage 3: TAP)
 * ═══════════════════════════════════════════════════════════════
 * three.js viewer + the automated 2→3 machinery:
 *
 *   extract(root)  — pull the mediated model's spec: every morph-target
 *                    name, every bone name (the "landmark get" of the
 *                    puppet's design specs)
 *   align(spec)    — match contract channel ids onto that spec by name
 *                    rules (tier A). Unmatched = honest gap, overridable
 *                    by the human (tier B) or by marked-vertex response
 *                    curves (tier C, the lizard path).
 *   applyValues()  — push contract-keyed channel values into morph
 *                    influences / bone rotations each frame.
 *
 * NOTE: importing this module requires the page to provide an importmap
 * for 'three' (see studio.html / taplab.html idiom).
 */

import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';

/** Contract channel → puppet-target matching rules (tier A).
 *  rx is an ORDERED array: earlier patterns win. This matters — e.g. RPM
 *  avatars expose both jawOpen (the real jaw rotation) and mouthOpen (a
 *  weak lips-apart shape); matching mouthOpen first gives the barely-open
 *  avatar mouth while the user is wide open. */
export const CHANNEL_RULES = [
  { id: 'mouth.open',      kind: 'morph', rx: [/^jaw_?open$/i, /jaw_?open/i, /mouth_?open/i, /viseme_aa/i, /surprised/i] },
  { id: 'mouth.stretch.L', kind: 'morph', rx: [/mouth_?stretch_?l(eft)?$/i] },
  { id: 'mouth.stretch.R', kind: 'morph', rx: [/mouth_?stretch_?r(ight)?$/i] },
  { id: 'mouth.smile.L',   kind: 'morph', rx: [/mouth_?smile_?l(eft)?$/i, /smile/i] },
  { id: 'mouth.smile.R',   kind: 'morph', rx: [/mouth_?smile_?r(ight)?$/i] },
  { id: 'mouth.pucker',    kind: 'morph', rx: [/mouth_?pucker/i, /viseme_(u|ou)/i] },
  { id: 'tongue.out',      kind: 'morph', rx: [/tongue_?out/i] },
  { id: 'eye.blink.L',     kind: 'morph', rx: [/eye_?blink_?left/i, /blink_?l\b/i, /eyesclosed.*l/i] },
  { id: 'eye.blink.R',     kind: 'morph', rx: [/eye_?blink_?right/i, /blink_?r\b/i] },
  { id: 'eye.wide.L',      kind: 'morph', rx: [/eye_?wide_?l(eft)?$/i] },
  { id: 'eye.wide.R',      kind: 'morph', rx: [/eye_?wide_?r(ight)?$/i] },
  { id: 'brow.inner.up',   kind: 'morph', rx: [/brow_?inner_?up/i, /brows?_?up/i] },
  { id: 'brow.up.L',       kind: 'morph', rx: [/brow_?outer_?up_?l(eft)?$/i] },
  { id: 'brow.up.R',       kind: 'morph', rx: [/brow_?outer_?up_?r(ight)?$/i] },
  { id: 'brow.down.L',     kind: 'morph', rx: [/brow_?down_?l(eft)?$/i, /angry/i] },
  { id: 'brow.down.R',     kind: 'morph', rx: [/brow_?down_?r(ight)?$/i] },
  { id: 'cheek.raise.L',   kind: 'morph', rx: [/cheek_?squint_?l(eft)?$/i] },
  { id: 'cheek.raise.R',   kind: 'morph', rx: [/cheek_?squint_?r(ight)?$/i] },
  { id: 'cheek.puff',      kind: 'morph', rx: [/cheek_?puff/i] },
  { id: 'nose.sneer.L',    kind: 'morph', rx: [/nose_?sneer_?l(eft)?$/i] },
  { id: 'nose.sneer.R',    kind: 'morph', rx: [/nose_?sneer_?r(ight)?$/i] },
  { id: 'head.rot',        kind: 'bone',  rx: [/^(mixamorig)?head$/i, /_head(_\d+)?$/i, /^b_head/i] }
];

export class PuppetStage {
  /** @param {HTMLCanvasElement} canvas */
  constructor(canvas) {
    this.canvas = canvas;
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(0x0d1117);
    this.cam = new THREE.PerspectiveCamera(35, 1, 0.01, 5000);
    this.controls = new OrbitControls(this.cam, canvas);
    this.scene.add(new THREE.HemisphereLight(0xe6edf3, 0x30363d, 2.4));
    const key = new THREE.DirectionalLight(0xffffff, 2.0);
    key.position.set(1, 2, 3); this.scene.add(key);
    this.loader = new GLTFLoader();
    this.current = null;
    this._eu = new THREE.Euler(); this._q = new THREE.Quaternion();
  }

  async load(url, id) {
    if (this.current) this.scene.remove(this.current.root);
    const gltf = await this.loader.loadAsync(url);
    const root = gltf.scene;
    this.scene.add(root);
    this._frame(root);
    const spec = this._extract(root);
    const matches = this._align(spec);
    const restQ = {};
    for (const m of Object.values(matches)) {
      if (m.kind === 'bone' && m.target) restQ[m.target] = spec.bones[m.target].quaternion.clone();
    }
    this.current = { root, id, spec, matches, restQ };
    return this.current;
  }

  _frame(root) {
    const box = new THREE.Box3().setFromObject(root);
    const size = box.getSize(new THREE.Vector3()), ctr = box.getCenter(new THREE.Vector3());
    const span = Math.max(size.x, size.y, size.z);
    this.cam.position.set(ctr.x, ctr.y + size.y * 0.25, ctr.z + span * 1.15);
    this.controls.target.set(ctr.x, ctr.y + size.y * 0.25, ctr.z);
    this.cam.near = span / 100; this.cam.far = span * 20;
    this.cam.updateProjectionMatrix(); this.controls.update();
  }

  _extract(root) {
    const morphMeshes = {}, bones = {};
    let vtotal = 0, meshCount = 0;
    root.traverse(o => {
      if (o.isMesh) {
        meshCount++; vtotal += o.geometry.attributes.position?.count || 0;
        if (o.morphTargetDictionary) {
          for (const nm of Object.keys(o.morphTargetDictionary)) {
            (morphMeshes[nm] = morphMeshes[nm] || []).push(o);
          }
        }
      }
      if (o.isBone) bones[o.name] = o;
    });
    return { morphMeshes, bones, vtotal, meshCount,
             morphNames: Object.keys(morphMeshes), boneNames: Object.keys(bones) };
  }

  _align(spec) {
    const matches = {};
    for (const ch of CHANNEL_RULES) {
      const pool = ch.kind === 'morph' ? spec.morphNames : spec.boneNames;
      let target = null;
      for (const rx of ch.rx) {                    // ordered: first pattern wins
        target = pool.find(n => rx.test(n)) || null;
        if (target) break;
      }
      matches[ch.id] = { kind: ch.kind, target };
    }
    return matches;
  }

  /** Human decision layer: point a channel at any morph/bone by name. */
  setOverride(chId, target) {
    const m = this.current?.matches[chId];
    if (!m) return;
    m.target = target || null;
    if (m.kind === 'bone' && m.target && !this.current.restQ[m.target]) {
      this.current.restQ[m.target] = this.current.spec.bones[m.target].quaternion.clone();
    }
  }

  /** Alignment summary for panels/export: {channel: target|null}. */
  alignment() {
    if (!this.current) return null;
    const out = {};
    for (const [id, m] of Object.entries(this.current.matches)) out[id] = m.target;
    return out;
  }

  /** Push contract-keyed values into the puppet (call every frame). */
  applyValues(values) {
    const c = this.current;
    if (!c) return;
    for (const ch of CHANNEL_RULES) {
      const m = c.matches[ch.id];
      if (!m.target) continue;
      if (m.kind === 'morph') {
        const v = values[ch.id] || 0;
        for (const mesh of c.spec.morphMeshes[m.target] || []) {
          mesh.morphTargetInfluences[mesh.morphTargetDictionary[m.target]] = v;
        }
      } else {
        const hv = values[ch.id];
        const bone = c.spec.bones[m.target];
        if (!bone || !hv) continue;
        // mirrored-selfie: user's nose to screen-right → puppet turns to ITS screen-right
        this._eu.set(THREE.MathUtils.degToRad(-hv.pitch), THREE.MathUtils.degToRad(-hv.yaw),
                     THREE.MathUtils.degToRad(hv.roll));
        this._q.setFromEuler(this._eu);
        bone.quaternion.copy(c.restQ[m.target]).multiply(this._q);
      }
    }
  }

  render() {
    const c = this.canvas;
    const w = c.clientWidth, h = c.clientHeight;
    if (c.width !== w || c.height !== h) {
      this.renderer.setSize(w, h, false);
      this.cam.aspect = w / h; this.cam.updateProjectionMatrix();
    }
    this.renderer.render(this.scene, this.cam);
  }
}
