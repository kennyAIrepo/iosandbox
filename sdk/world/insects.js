/**
 * hopeOS SDK — Insects (fly · dragonfly · butterfly)
 * ═══════════════════════════════════════════════════════════════
 * Game-quality insects for the jungle host. Not high-poly — but built,
 * shaded and ANIMATED to read well: articulated bodies, translucent
 * veined wings, wing-blur at flight flap rates, leg tuck/fold, hover
 * jitter, dart-and-perch behaviour.
 *
 *   fly        — procedural (iridescent thorax, 2 wings, 6 legs)
 *   dragonfly  — procedural (segmented abdomen, 4 wings phase-offset)
 *   butterfly  — assets/butterfly.glb (rigged + animated, 62 joints);
 *                falls back to a procedural 2-card flapper if missing
 *
 * Behaviour states: 'fly' (waypoint wander around an anchor), 'hover',
 * 'perch' (fold wings, micro-idle on a surface point), 'dart' (escape).
 *   insect.update(dt)                 — per frame
 *   insect.perchOn(point, normal)     — land
 *   insect.takeOff()                  — back to wander
 *   insect.setAnchor(p, radius)       — wander home
 * InsectSystem spawns/updates a mixed population and hands out perch
 * points from the jungle's branch spans.
 */

import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';

const rnd = (a = 1, b) => b === undefined ? Math.random() * a : a + Math.random() * (b - a);

/* wing texture: translucent membrane + dark veins, painted once */
function wingTexture(veins = 5, tint = 'rgba(210,225,235,') {
  const c = document.createElement('canvas'); c.width = 128; c.height = 64;
  const g = c.getContext('2d');
  g.clearRect(0, 0, 128, 64);
  const grad = g.createLinearGradient(0, 0, 128, 0);
  grad.addColorStop(0, tint + '0.55)'); grad.addColorStop(0.7, tint + '0.30)'); grad.addColorStop(1, tint + '0.12)');
  g.fillStyle = grad;
  g.beginPath(); g.ellipse(64, 32, 62, 28, 0, 0, 7); g.fill();
  g.strokeStyle = 'rgba(40,44,52,0.55)'; g.lineWidth = 1.4;
  for (let i = 0; i < veins; i++) {
    g.beginPath(); g.moveTo(4, 32);
    g.quadraticCurveTo(64, 32 - 26 + i * (52 / (veins - 1)), 124, 32 - 20 + i * (40 / (veins - 1)));
    g.stroke();
  }
  g.lineWidth = 0.7;
  for (let i = 0; i < 7; i++) { g.beginPath(); g.moveTo(20 + i * 15, 8); g.lineTo(24 + i * 15, 56); g.stroke(); }
  const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

function wingMaterial(tex) {
  return new THREE.MeshPhysicalMaterial({
    map: tex, transparent: true, opacity: 0.9, side: THREE.DoubleSide,
    roughness: 0.25, metalness: 0.1, iridescence: 0.6, iridescenceIOR: 1.3,
    depthWrite: false, alphaTest: 0.05
  });
}

class Insect {
  constructor() {
    this.root = new THREE.Group();
    this.state = 'fly';
    this.anchor = new THREE.Vector3(); this.anchorR = 2;
    this.vel = new THREE.Vector3();
    this.target = new THREE.Vector3();
    this._retarget = 0;
    this.t = rnd(100);
    this.speed = 1.6;
    this.perchNormal = new THREE.Vector3(0, 1, 0);
    this.perchTimer = 0;
    this.onCatchable = true;      // the game reads position for hunting
  }
  setAnchor(p, r = 2) { this.anchor.copy(p); this.anchorR = r; if (this.state === 'fly') this._newTarget(); }
  _newTarget() {
    this.target.set(
      this.anchor.x + rnd(-this.anchorR, this.anchorR),
      Math.max(0.4, this.anchor.y + rnd(-this.anchorR * 0.5, this.anchorR * 0.6)),
      this.anchor.z + rnd(-this.anchorR, this.anchorR));
    this._retarget = rnd(0.7, 2.2);
  }
  perchOn(point, normal = new THREE.Vector3(0, 1, 0)) {
    this.state = 'landing';
    this.target.copy(point).addScaledVector(normal, 0.02);
    this.perchNormal.copy(normal);
  }
  takeOff() { this.state = 'fly'; this._newTarget(); this.vel.set(rnd(-1, 1), 1.4, rnd(-1, 1)); }
  dartFrom(p) { this.state = 'fly'; this.target.copy(this.root.position).sub(p).setLength(2.5).add(this.root.position); this._retarget = 0.8; }

  update(dt) {
    this.t += dt;
    if (this.state === 'fly' || this.state === 'landing') {
      const arrive = this.state === 'landing' ? 0.05 : 0.35;
      const to = this.target.clone().sub(this.root.position);
      const d = to.length();
      if (d < arrive) {
        if (this.state === 'landing') { this.state = 'perch'; this.perchTimer = rnd(2, 7); this.vel.set(0, 0, 0); }
        else this._newTarget();
      } else {
        to.normalize();
        this.vel.lerp(to.multiplyScalar(this.speed * (this.state === 'landing' ? 0.6 : 1)), Math.min(1, dt * 3.2));
        // hover jitter — the insect "buzz"
        this.vel.x += Math.sin(this.t * 13.7) * dt * 2.2;
        this.vel.y += Math.cos(this.t * 11.3) * dt * 1.8;
        this.root.position.addScaledVector(this.vel, dt);
        // face travel direction (bank a little)
        if (this.vel.lengthSq() > 0.01) {
          const yaw = Math.atan2(this.vel.x, this.vel.z);
          this.root.rotation.set(0, 0, 0);
          this.root.rotation.y = yaw;
          this.root.rotation.z = THREE.MathUtils.clamp(-this.vel.x * 0.18, -0.5, 0.5);
        }
      }
      this._retarget -= dt;
      if (this.state === 'fly' && this._retarget <= 0) this._newTarget();
      this._pose(dt, true);
    } else if (this.state === 'perch') {
      this.perchTimer -= dt;
      this._pose(dt, false);
      if (this.perchTimer <= 0) this.takeOff();
    }
  }
  _pose() {} // subclass: wings/legs
}

/* ── FLY ──────────────────────────────────────────────────────── */
export class Fly extends Insect {
  constructor(scale = 1) {
    super();
    this.speed = rnd(1.5, 2.2);
    const s = 0.06 * scale;                     // ~6cm gameplay fly (visible)
    const body = new THREE.Group();
    const mat = new THREE.MeshPhysicalMaterial({
      color: 0x232a1e, roughness: 0.35, metalness: 0.35,
      iridescence: 0.85, iridescenceIOR: 1.6, sheen: 0.4, sheenColor: 0x3a6e3a
    });
    const abdomen = new THREE.Mesh(new THREE.SphereGeometry(s * 0.62, 12, 10), mat);
    abdomen.scale.set(0.8, 0.75, 1.25); abdomen.position.z = -s * 0.8;
    const thorax = new THREE.Mesh(new THREE.SphereGeometry(s * 0.48, 12, 10), mat);
    thorax.scale.set(0.9, 0.85, 1);
    const headM = new THREE.MeshPhysicalMaterial({ color: 0x1c2016, roughness: 0.3, metalness: 0.2 });
    const head = new THREE.Mesh(new THREE.SphereGeometry(s * 0.34, 10, 8), headM);
    head.position.z = s * 0.62;
    const eyeM = new THREE.MeshPhysicalMaterial({ color: 0x7a1e12, roughness: 0.15, metalness: 0.3, clearcoat: 1 });
    for (const sd of [-1, 1]) {
      const e = new THREE.Mesh(new THREE.SphereGeometry(s * 0.2, 8, 8), eyeM);
      e.position.set(sd * s * 0.19, s * 0.08, s * 0.72); e.scale.set(0.9, 1.1, 0.9);
      body.add(e);
    }
    body.add(abdomen, thorax, head);

    // legs: 3 per side, thin bent tubes
    this.legs = [];
    const legM = new THREE.MeshStandardMaterial({ color: 0x181a12, roughness: 0.7 });
    for (const sd of [-1, 1]) for (let i = 0; i < 3; i++) {
      const leg = new THREE.Group();
      const up = new THREE.Mesh(new THREE.CylinderGeometry(s * 0.03, s * 0.022, s * 0.5), legM);
      up.position.y = -s * 0.25; up.rotation.z = sd * 0.9;
      const lo = new THREE.Mesh(new THREE.CylinderGeometry(s * 0.02, s * 0.012, s * 0.55), legM);
      lo.position.set(sd * s * 0.32, -s * 0.5, 0); lo.rotation.z = sd * 0.25;
      leg.add(up, lo);
      leg.position.set(sd * s * 0.3, -s * 0.15, s * 0.3 - i * s * 0.3);
      body.add(leg); this.legs.push(leg);
    }

    // wings
    const wTex = wingTexture(5);
    this.wings = [];
    for (const sd of [-1, 1]) {
      const w = new THREE.Mesh(new THREE.PlaneGeometry(s * 2.1, s * 0.9), wingMaterial(wTex));
      w.geometry.translate(sd * s * 1.05, 0, 0);
      w.position.set(sd * s * 0.15, s * 0.32, -s * 0.1);
      w.rotation.x = -Math.PI / 2.6;
      body.add(w); this.wings.push({ m: w, sd });
    }
    this.body = body; this.root.add(body);
    this.kind = 'fly';
  }
  _pose(dt, flying) {
    const t = this.t;
    if (flying) {
      for (const { m, sd } of this.wings) m.rotation.y = sd * (0.5 + Math.sin(t * 90) * 0.85);
      for (const l of this.legs) l.rotation.x = 0.85;                      // tucked
      this.body.position.y = Math.sin(t * 17) * 0.006;
    } else {
      for (const { m, sd } of this.wings) m.rotation.y = sd * 0.22;        // folded back
      for (const l of this.legs) l.rotation.x = 0;
      this.body.position.y = Math.sin(t * 3) * 0.0015;                     // breathing
      this.body.rotation.y = Math.sin(t * 0.9) * 0.2;                      // look-around
    }
  }
}

/* ── DRAGONFLY ───────────────────────────────────────────────── */
export class Dragonfly extends Insect {
  constructor(scale = 1) {
    super();
    this.speed = rnd(2.6, 3.4);
    const s = 0.09 * scale;
    const body = new THREE.Group();
    const mat = new THREE.MeshPhysicalMaterial({
      color: 0x1d5a8a, roughness: 0.3, metalness: 0.5, iridescence: 0.9, iridescenceIOR: 1.4
    });
    const thorax = new THREE.Mesh(new THREE.SphereGeometry(s * 0.42, 10, 8), mat);
    thorax.scale.set(0.85, 0.8, 1.15);
    body.add(thorax);
    // segmented needle abdomen
    this.tailSegs = [];
    for (let i = 0; i < 6; i++) {
      const seg = new THREE.Mesh(new THREE.CylinderGeometry(s * (0.13 - i * 0.012), s * (0.15 - i * 0.012), s * 0.5, 8), mat);
      seg.rotation.x = Math.PI / 2;
      seg.position.z = -s * (0.6 + i * 0.48);
      body.add(seg); this.tailSegs.push(seg);
    }
    const head = new THREE.Mesh(new THREE.SphereGeometry(s * 0.3, 10, 8), mat);
    head.position.z = s * 0.52; body.add(head);
    const eyeM = new THREE.MeshPhysicalMaterial({ color: 0x1a3a1e, roughness: 0.1, clearcoat: 1, metalness: 0.2 });
    for (const sd of [-1, 1]) {
      const e = new THREE.Mesh(new THREE.SphereGeometry(s * 0.19, 8, 8), eyeM);
      e.position.set(sd * s * 0.14, s * 0.1, s * 0.6); body.add(e);
    }
    // 4 long slender wings, two pairs
    const wTex = wingTexture(4, 'rgba(225,235,240,');
    this.wings = [];
    for (const sd of [-1, 1]) for (let p = 0; p < 2; p++) {
      const w = new THREE.Mesh(new THREE.PlaneGeometry(s * 3.4, s * 0.62), wingMaterial(wTex));
      w.geometry.translate(sd * s * 1.7, 0, 0);
      w.position.set(sd * s * 0.1, s * 0.3, p ? -s * 0.35 : s * 0.05);
      w.rotation.x = -Math.PI / 2.15;
      body.add(w); this.wings.push({ m: w, sd, p });
    }
    this.legs = [];
    this.body = body; this.root.add(body);
    this.kind = 'dragonfly';
  }
  _pose(dt, flying) {
    const t = this.t;
    if (flying) {
      // pairs beat in antiphase — the dragonfly signature
      for (const { m, sd, p } of this.wings) m.rotation.y = sd * Math.sin(t * 42 + (p ? Math.PI : 0)) * 0.55;
      this.tailSegs.forEach((seg, i) => { seg.position.y = Math.sin(t * 7 + i * 0.6) * 0.004 * i; });
    } else {
      for (const { m, sd } of this.wings) m.rotation.y = sd * 0.95;        // wings held OUT flat (dragonflies don't fold)
      this.tailSegs.forEach((seg, i) => { seg.position.y = Math.sin(t * 2 + i) * 0.002 * i; });
    }
  }
}

/* ── BUTTERFLY — rigged GLB with procedural fallback ─────────── */
export class Butterfly extends Insect {
  constructor(scale = 1, gltf = null) {
    super();
    this.speed = rnd(0.8, 1.3);
    this.kind = 'butterfly';
    this.mixer = null;
    if (gltf) {
      const model = gltf.scene.clone ? gltf.scene : gltf.scene;
      const box = new THREE.Box3().setFromObject(model);
      const span = box.getSize(new THREE.Vector3()).length() || 1;
      model.scale.setScalar((0.22 * scale) / span * 2);
      this.root.add(model);
      if (gltf.animations && gltf.animations.length) {
        this.mixer = new THREE.AnimationMixer(model);
        this.action = this.mixer.clipAction(gltf.animations[0]);
        this.action.play();
      }
    } else {
      // fallback: two flapping cards with a painted wing pattern
      const c = document.createElement('canvas'); c.width = c.height = 128;
      const g = c.getContext('2d');
      g.fillStyle = '#e8862a';
      g.beginPath(); g.ellipse(64, 44, 58, 40, 0, 0, 7); g.ellipse(70, 100, 40, 26, 0, 0, 7); g.fill();
      g.fillStyle = '#211a12';
      g.beginPath(); g.ellipse(64, 44, 58, 40, 0, 0, 7); g.fill('evenodd');
      g.strokeStyle = '#211a12'; g.lineWidth = 7; g.stroke();
      for (let i = 0; i < 6; i++) { g.fillStyle = '#fff'; g.beginPath(); g.arc(20 + i * 18, 30 + (i % 2) * 50, 4, 0, 7); g.fill(); }
      const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace;
      const m = new THREE.MeshStandardMaterial({ map: t, side: THREE.DoubleSide, alphaTest: 0.2, transparent: true, roughness: 0.7 });
      this.wings = [];
      for (const sd of [-1, 1]) {
        const w = new THREE.Mesh(new THREE.PlaneGeometry(0.16, 0.2), m);
        w.geometry.translate(sd * 0.08, 0, 0);
        w.rotation.x = -Math.PI / 2;
        this.root.add(w); this.wings.push({ m: w, sd });
      }
      const bodyM = new THREE.Mesh(new THREE.CapsuleGeometry(0.012, 0.12), new THREE.MeshStandardMaterial({ color: 0x241c12 }));
      bodyM.rotation.x = Math.PI / 2; this.root.add(bodyM);
    }
  }
  _newTarget() {  // floatier wander than the base class
    super._newTarget();
    this._retarget = rnd(1.5, 3.5);
  }
  update(dt) {
    super.update(dt);
    if (this.mixer) this.mixer.update(dt * (this.state === 'perch' ? 0.25 : 1));
    // butterfly bob — sinusoidal lift with each flap
    if (this.state === 'fly') this.root.position.y += Math.sin(this.t * 7) * dt * 0.35;
  }
  _pose(dt, flying) {
    if (this.wings) for (const { m, sd } of this.wings)
      m.rotation.y = sd * (flying ? Math.sin(this.t * 14) * 1.1 : 0.9 + Math.sin(this.t * 1.2) * 0.35);
  }
}

/* ── system ──────────────────────────────────────────────────── */
export class InsectSystem {
  /** @param {THREE.Scene|THREE.Group} parent  @param {JungleWorld|null} jungle */
  constructor(parent, jungle = null) {
    this.parent = parent; this.jungle = jungle;
    this.insects = [];
    this._butterflyGLTF = null;
    this._loading = new GLTFLoader().loadAsync('./assets/butterfly.glb')
      .then(g => { this._butterflyGLTF = g; })
      .catch(() => { this._butterflyGLTF = null; });
  }
  async ready() { await this._loading; return this; }

  spawn(kind, at, opts = {}) {
    let ins;
    if (kind === 'dragonfly') ins = new Dragonfly(opts.scale ?? 1);
    else if (kind === 'butterfly') ins = new Butterfly(opts.scale ?? 1, this._butterflyGLTF);
    else ins = new Fly(opts.scale ?? 1);
    ins.root.position.copy(at);
    ins.setAnchor(at, opts.anchorR ?? 2.2);
    this.parent.add(ins.root);
    this.insects.push(ins);
    return ins;
  }

  /** Populate around the jungle's branch spans (flies cluster near spans). */
  populate({ flies = 6, dragonflies = 2, butterflies = 2 } = {}) {
    const spanP = i => {
      const spans = this.jungle?.spans || [];
      if (!spans.length) return new THREE.Vector3(rnd(-3, 3), rnd(1, 4), rnd(-6, 6));
      const s = spans[i % spans.length];
      return s.pointAt(rnd(0.3, 0.9)).add(new THREE.Vector3(rnd(-0.8, 0.8), rnd(0.4, 1.4), rnd(-0.8, 0.8)));
    };
    for (let i = 0; i < flies; i++) this.spawn('fly', spanP(i));
    for (let i = 0; i < dragonflies; i++) this.spawn('dragonfly', spanP(i + 1).add(new THREE.Vector3(0, 1, 0)), { anchorR: 4 });
    for (let i = 0; i < butterflies; i++) this.spawn('butterfly', spanP(i + 2), { anchorR: 3 });
  }

  update(dt) {
    for (const ins of this.insects) {
      ins.update(dt);
      // occasional perch on a nearby span
      if (ins.state === 'fly' && Math.random() < dt * 0.06 && this.jungle) {
        const near = this.jungle.nearestSpanPoint(ins.root.position, 1.6);
        if (near) {
          const up = new THREE.Vector3(0, 1, 0);
          ins.perchOn(near.point.clone().addScaledVector(up, near.span.r0 * 0.9), up);
        }
      }
    }
  }
  remove(ins) {
    this.parent.remove(ins.root);
    this.insects = this.insects.filter(i => i !== ins);
  }
}
