/**
 * hopeOS SDK — JungleWorld (large intricate jungle environment)
 * ═══════════════════════════════════════════════════════════════
 * The 3D environment generator for the I-AM-LIZARD forward host — the
 * "much better" sibling of the 2D game's painted jungle. Real assets
 * (Poly Haven CC0: HDRI sky + PBR ground/bark, ambientCG leaf atlas in
 * assets/jungle/) + procedural assembly: terrain, big trees with leaf-card
 * canopies, undergrowth (ferns/bushes/rocks), hanging vines, light shafts,
 * dust + falling leaves.
 *
 * GAMEPLAY BRANCHES — the "3D chess board": addBranchSpan() grows a real
 * tapered branch from the LEFT or RIGHT edge of the play corridor toward
 * the middle at a chosen height/depth. Each span keeps its centreline
 * CURVE + radius so a crawler can anchor to it (crawl along t∈[0,1],
 * offset by radius) and higher spans are reached by jumping. Spans are
 * regular scene objects for the lab host: selectable, movable, lockable.
 *
 * All meshes that things can stand/settle on are in this.walkables —
 * the host's gravity/anchoring raycasts against exactly that list.
 */

import * as THREE from 'three';
import { RGBELoader } from 'three/addons/loaders/RGBELoader.js';

const TEX = './assets/jungle/tex/';
const HDRI = { day: './assets/jungle/sky_partlycloudy_2k.hdr', rainforest: './assets/jungle/rainforest_trail_2k.hdr' };

/* small deterministic noise (no deps) */
function hash(n) { const s = Math.sin(n) * 43758.5453; return s - Math.floor(s); }
function noise2(x, z) {
  const xi = Math.floor(x), zi = Math.floor(z), xf = x - xi, zf = z - zi;
  const u = xf * xf * (3 - 2 * xf), v = zf * zf * (3 - 2 * zf);
  const a = hash(xi * 157.31 + zi * 113.97), b = hash((xi + 1) * 157.31 + zi * 113.97);
  const c = hash(xi * 157.31 + (zi + 1) * 113.97), d = hash((xi + 1) * 157.31 + (zi + 1) * 113.97);
  return a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v;
}
const fbm = (x, z) => noise2(x, z) * 0.6 + noise2(x * 2.7, z * 2.7) * 0.28 + noise2(x * 6.1, z * 6.1) * 0.12;
let SEED = 1;
const rnd = (a = 1, b) => { SEED = (SEED * 16807) % 2147483647; const r = SEED / 2147483647; return b === undefined ? r * a : a + r * (b - a); };

/** Tapered tube with organic wobble along a curve — trunks & branches. */
function taperedTube(curve, r0, r1, rings = 14, radial = 9, wobble = 0.12) {
  const pos = [], norm = [], uv = [], idx = [];
  const P = new THREE.Vector3(), T = new THREE.Vector3(), N = new THREE.Vector3(), B = new THREE.Vector3();
  const frames = curve.computeFrenetFrames(rings, false);
  for (let i = 0; i <= rings; i++) {
    const t = i / rings;
    curve.getPointAt(t, P); T.copy(frames.tangents[i]); N.copy(frames.normals[i]); B.copy(frames.binormals[i]);
    const r = THREE.MathUtils.lerp(r0, r1, t) * (1 + (noise2(t * 7 + r0 * 31, r1 * 17) - 0.5) * wobble);
    for (let j = 0; j <= radial; j++) {
      const a = (j / radial) * Math.PI * 2;
      const nx = Math.cos(a), ny = Math.sin(a);
      const vN = N.clone().multiplyScalar(nx).addScaledVector(B, ny);
      pos.push(P.x + vN.x * r, P.y + vN.y * r, P.z + vN.z * r);
      norm.push(vN.x, vN.y, vN.z);
      uv.push(j / radial * 2, t * (curve.getLength() / (r0 * 6)));
    }
  }
  for (let i = 0; i < rings; i++) for (let j = 0; j < radial; j++) {
    const a = i * (radial + 1) + j, b = a + radial + 1;
    idx.push(a, b, a + 1, b, b + 1, a + 1);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(norm, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  g.setIndex(idx);
  return g;
}

export class JungleWorld {
  /** @param {THREE.WebGLRenderer} renderer @param {THREE.Scene} scene */
  static async create(renderer, scene, opts = {}) {
    const w = new JungleWorld();
    w.renderer = renderer; w.scene = scene;
    w.cfg = { size: 150, corridorHalf: 6.5, seed: 7, ...opts };
    SEED = w.cfg.seed;
    w.walkables = [];          // meshes gravity/crawl raycasts hit
    w.spans = [];              // gameplay branch spans {id,mesh,curve,r0,r1,side}
    w.trees = [];
    w._t = 0;
    w.group = new THREE.Group(); w.group.name = 'jungle';
    scene.add(w.group);

    const st = s => console.log('[jungle]', s);
    st('textures…'); await w._loadTextures();
    st('sky…'); await w.setSky('day');
    st('lights'); w._lights();
    st('terrain'); w._terrain();
    st('forest'); w._forest();
    st('undergrowth'); w._undergrowth();
    st('vines'); w._vines();
    st('backdrop'); w._backdrop();
    st('shafts'); w._lightShafts();
    st('particles'); w._particles();
    st('ready');
    return w;
  }

  async _loadTextures() {
    const tl = new THREE.TextureLoader();
    const load = (f, srgb = true, rep = 1) => new Promise(res => tl.load(TEX + f, t => {
      if (srgb) t.colorSpace = THREE.SRGBColorSpace;
      t.wrapS = t.wrapT = THREE.RepeatWrapping; t.repeat.set(rep, rep); res(t);
    }, undefined, () => res(null)));
    const [gDiff, gNor, bark, barkN, mud, leafC, leafA, leaves] = await Promise.all([
      load('forest_ground_diff.jpg', true, 20), load('forest_ground_nor.jpg', false, 20),
      load('bark_diff.jpg'), load('bark_nor.jpg', false),
      load('mud_leaves_diff.jpg', true), load('leaf_atlas.png'), load('leaf_atlas_alpha.png', false),
      load('forest_leaves_diff.jpg', true, 8)
    ]);
    this.tex = { gDiff, gNor, bark, barkN, mud, leafC, leafA, leaves };
    this.matBark = new THREE.MeshStandardMaterial({ map: bark, normalMap: barkN, roughness: 0.93, color: 0xc4ac90 });
    this.matBranch = new THREE.MeshStandardMaterial({ map: bark, normalMap: barkN, roughness: 0.9, color: 0xcbb79c });
    // leaf cards: crop single cells out of the 4x2-ish atlas
    this.leafMats = [0, 1, 2].map(i => {
      const c = leafC ? leafC.clone() : null, a = leafA ? leafA.clone() : null;
      for (const t of [c, a]) if (t) {
        t.wrapS = t.wrapT = THREE.ClampToEdgeWrapping;
        t.repeat.set(0.24, 0.45); t.offset.set(0.02 + (i % 3) * 0.25, i < 2 ? 0.52 : 0.03);
        t.needsUpdate = true;
      }
      return new THREE.MeshStandardMaterial({
        map: c, alphaMap: a, alphaTest: 0.42, side: THREE.DoubleSide,
        roughness: 0.8, color: new THREE.Color().setHSL(0.29 + i * 0.02, 0.55, 0.42)
      });
    });
  }

  /** 'day' (blue sky + clouds above the canopy) or 'rainforest' (enclosed). */
  async setSky(kind) {
    const url = HDRI[kind] || HDRI.day;
    const hdr = await new RGBELoader().loadAsync(url);
    hdr.mapping = THREE.EquirectangularReflectionMapping;
    this.scene.background = hdr;
    this.scene.environment = hdr;
    this.scene.backgroundBlurriness = 0.0;
    this.scene.backgroundIntensity = kind === 'day' ? 1.0 : 0.9;
    this.scene.fog = new THREE.FogExp2(kind === 'day' ? 0x9db98a : 0x6a7f5a, 0.016);
    this.sky = kind;
    return kind;
  }

  _lights() {
    this.sun = new THREE.DirectionalLight(0xfff2d8, 3.0);
    this.sun.position.set(18, 34, 10);
    this.sun.castShadow = true;
    const s = this.sun.shadow; s.mapSize.set(2048, 2048);
    s.camera.left = -30; s.camera.right = 30; s.camera.top = 30; s.camera.bottom = -30; s.camera.far = 90;
    s.bias = -0.0004;
    this.group.add(this.sun, this.sun.target);
    this.group.add(new THREE.HemisphereLight(0xbfd6ff, 0x2c3a1c, 0.55));
  }

  _terrain() {
    const S = this.cfg.size;
    const g = new THREE.PlaneGeometry(S, S, 120, 120);
    g.rotateX(-Math.PI / 2);
    const p = g.attributes.position;
    for (let i = 0; i < p.count; i++) {
      const x = p.getX(i), z = p.getZ(i);
      const d = Math.hypot(x, z) / (S * 0.5);
      // gentle undulation, flatter in the play corridor, rising at the rim
      let y = fbm(x * 0.06 + 9, z * 0.06) * 2.2 + d * d * 5.5;
      y *= THREE.MathUtils.smoothstep(Math.abs(x), 2, 10) * 0.85 + 0.15;
      p.setY(i, y - 0.4);
    }
    g.computeVertexNormals();
    const m = new THREE.Mesh(g, new THREE.MeshStandardMaterial({
      map: this.tex.gDiff, normalMap: this.tex.gNor, roughness: 1.0, color: 0xa4b48c   // mossy tint — dirt reads jungle, not desert
    }));
    m.receiveShadow = true; m.name = 'terrain';
    this.terrain = m; this.group.add(m); this.walkables.push(m);

    // leaf-litter decal patches break up the tiling
    if (this.tex.mud) {
      const dg = new THREE.PlaneGeometry(1, 1); dg.rotateX(-Math.PI / 2);
      const dm = new THREE.MeshStandardMaterial({ map: this.tex.mud, roughness: 1, transparent: true, opacity: 0.85, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -1 });
      const inst = new THREE.InstancedMesh(dg, dm, 70);
      const M = new THREE.Matrix4(), Q = new THREE.Quaternion(), E = new THREE.Euler();
      for (let i = 0; i < 70; i++) {
        const x = rnd(-S * 0.42, S * 0.42), z = rnd(-S * 0.42, S * 0.42);
        E.set(0, rnd(Math.PI * 2), 0); Q.setFromEuler(E);
        M.compose(new THREE.Vector3(x, this.groundY(x, z) + 0.03, z), Q,
          new THREE.Vector3(rnd(2.5, 7), 1, rnd(2.5, 7)));
        inst.setMatrixAt(i, M);
      }
      inst.receiveShadow = true; this.group.add(inst);
    }
  }

  /** Terrain height by resampling the same fbm (keeps placement cheap). */
  groundY(x, z) {
    const S = this.cfg.size, d = Math.hypot(x, z) / (S * 0.5);
    let y = fbm(x * 0.06 + 9, z * 0.06) * 2.2 + d * d * 5.5;
    y *= THREE.MathUtils.smoothstep(Math.abs(x), 2, 10) * 0.85 + 0.15;
    return y - 0.4;
  }

  /* ── trees ─────────────────────────────────────────────────── */
  makeTree(x, z, opts = {}) {
    const h = opts.height ?? rnd(14, 26);
    const r0 = opts.r0 ?? rnd(0.45, 1.0);
    const gy = this.groundY(x, z);
    const tree = new THREE.Group(); tree.name = 'tree';
    tree.position.set(x, gy, z);

    // trunk: gently curving spine
    const lean = rnd(0.06, 0.22), leanA = rnd(Math.PI * 2);
    const spine = new THREE.CatmullRomCurve3([0, 0.25, 0.5, 0.75, 1].map(t =>
      new THREE.Vector3(Math.cos(leanA) * lean * h * t * t + (noise2(t * 5, x) - 0.5) * 0.8,
        t * h, Math.sin(leanA) * lean * h * t * t + (noise2(t * 5, z) - 0.5) * 0.8)));
    const trunk = new THREE.Mesh(taperedTube(spine, r0, r0 * 0.22, 12, 9), this.matBark);
    trunk.castShadow = trunk.receiveShadow = true;
    tree.add(trunk);
    this.walkables.push(trunk);

    // buttress roots
    for (let i = 0; i < 4; i++) {
      const a = rnd(Math.PI * 2);
      const root = new THREE.Mesh(taperedTube(new THREE.CatmullRomCurve3([
        new THREE.Vector3(0, 1.1, 0),
        new THREE.Vector3(Math.cos(a) * r0 * 1.6, 0.35, Math.sin(a) * r0 * 1.6),
        new THREE.Vector3(Math.cos(a) * r0 * 3.2, -0.15, Math.sin(a) * r0 * 3.2)
      ]), r0 * 0.5, r0 * 0.14, 6, 7), this.matBark);
      root.castShadow = true; tree.add(root);
    }

    // limbs + canopy clusters
    const clusters = [];
    const limbN = opts.limbs ?? (3 + (rnd() * 3 | 0));
    for (let i = 0; i < limbN; i++) {
      const t0 = rnd(0.55, 0.95);
      const base = spine.getPointAt(t0);
      const a = rnd(Math.PI * 2), up = rnd(0.25, 0.7), len = rnd(2.5, 5.5) * (h / 20);
      const tip = base.clone().add(new THREE.Vector3(Math.cos(a) * len, up * len, Math.sin(a) * len));
      const limb = new THREE.Mesh(taperedTube(new THREE.CatmullRomCurve3([
        base, base.clone().lerp(tip, 0.5).add(new THREE.Vector3(0, len * 0.12, 0)), tip
      ]), r0 * 0.28 * (1 - t0 * 0.5) + 0.05, 0.045, 8, 7), this.matBark);
      limb.castShadow = true; tree.add(limb);
      clusters.push(tip);
    }
    clusters.push(spine.getPointAt(1));   // crown

    // canopy: instanced leaf cards in ellipsoid shells around each cluster tip
    const per = opts.leafDensity ?? 72;      // dense crowns — sparse cards read as confetti
    const card = new THREE.PlaneGeometry(1.6, 1.6);
    for (let mi = 0; mi < this.leafMats.length; mi++) {
      const count = clusters.length * Math.ceil(per / this.leafMats.length);
      const inst = new THREE.InstancedMesh(card, this.leafMats[mi], count);
      const M = new THREE.Matrix4(), Q = new THREE.Quaternion(), V = new THREE.Vector3(), E = new THREE.Euler();
      let n = 0;
      for (const c of clusters) {
        const rx = rnd(1.3, 2.4) * (h / 20), ry = rx * rnd(0.55, 0.8);
        for (let k = 0; k < per / this.leafMats.length; k++) {
          const th = rnd(Math.PI * 2), ph = Math.acos(rnd(-1, 1));
          const shell = rnd(0.65, 1);        // bias toward the shell but fill inside too
          V.set(Math.sin(ph) * Math.cos(th) * rx * shell, Math.cos(ph) * ry * shell, Math.sin(ph) * Math.sin(th) * rx * shell).add(c);
          E.set(rnd(-0.9, 0.9), rnd(Math.PI * 2), rnd(-0.9, 0.9)); Q.setFromEuler(E);
          M.compose(V, Q, new THREE.Vector3().setScalar(rnd(1.0, 1.9)));
          inst.setMatrixAt(n++, M);
        }
      }
      inst.count = n; inst.castShadow = true;
      tree.add(inst);
    }
    this.group.add(tree);
    this.trees.push(tree);
    return tree;
  }

  _forest() {
    const S = this.cfg.size, C = this.cfg.corridorHalf;
    // big trees flanking the corridor (these later carry the branch spans)…
    for (let z = -S * 0.4; z < S * 0.4; z += rnd(7, 12)) {
      for (const side of [-1, 1]) {
        const x = side * rnd(C + 1.5, C + 7);
        this.makeTree(x + rnd(-1, 1), z + rnd(-2, 2), { height: rnd(17, 28) });
      }
    }
    // …then scattered depth trees further out
    for (let i = 0; i < 26; i++) {
      const x = rnd(-S * 0.45, S * 0.45);
      if (Math.abs(x) < C + 8) continue;
      this.makeTree(x, rnd(-S * 0.45, S * 0.45), { height: rnd(12, 24), leafDensity: 34 });
    }
  }

  _undergrowth() {
    const S = this.cfg.size;
    // ferns: bent frond cards with a painted gradient
    const frondTex = (() => {
      const c = document.createElement('canvas'); c.width = 64; c.height = 256;
      const g = c.getContext('2d');
      const gr = g.createLinearGradient(0, 256, 0, 0);
      gr.addColorStop(0, '#2f5c1e'); gr.addColorStop(1, '#86b545');
      g.fillStyle = gr;
      // solid tapered blade with serrated edges (slats read as ladders)
      g.beginPath(); g.moveTo(32, 252);
      for (let y = 252; y > 8; y -= 12) {
        const w = 26 * (1 - (252 - y) / 300) + 3;
        g.lineTo(32 - w, y - 6); g.lineTo(32 - w * 0.7, y - 12);
      }
      g.lineTo(32, 4);
      for (let y = 8; y < 252; y += 12) {
        const w = 26 * (1 - (252 - y) / 300) + 3;
        g.lineTo(32 + w * 0.7, y); g.lineTo(32 + w, y + 6);
      }
      g.closePath(); g.fill();
      g.strokeStyle = '#274d18'; g.lineWidth = 2.5;
      g.beginPath(); g.moveTo(32, 250); g.lineTo(32, 6); g.stroke();
      const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; return t;
    })();
    const frond = new THREE.PlaneGeometry(0.5, 2.1, 1, 6);
    { const p = frond.attributes.position;                        // curl the frond
      for (let i = 0; i < p.count; i++) { const y = p.getY(i) + 1.05; p.setZ(i, y * y * 0.18); } }
    const fm = new THREE.MeshStandardMaterial({ map: frondTex, side: THREE.DoubleSide, roughness: 0.8, alphaTest: 0.1, transparent: true });
    const ferns = new THREE.InstancedMesh(frond, fm, 900);
    const M = new THREE.Matrix4(), Q = new THREE.Quaternion(), E = new THREE.Euler();
    let n = 0;
    for (let i = 0; i < 150; i++) {
      const x = rnd(-S * 0.44, S * 0.44), z = rnd(-S * 0.44, S * 0.44);
      if (Math.abs(x) < 1.2) continue;
      const y = this.groundY(x, z);
      for (let k = 0; k < 6; k++) {
        E.set(rnd(-0.55, -0.2), rnd(Math.PI * 2), 0); Q.setFromEuler(E);
        M.compose(new THREE.Vector3(x + rnd(-0.3, 0.3), y + 0.85, z + rnd(-0.3, 0.3)), Q, new THREE.Vector3().setScalar(rnd(0.6, 1.4)));
        if (n < 900) ferns.setMatrixAt(n++, M);
      }
    }
    ferns.count = n; ferns.receiveShadow = true; this.group.add(ferns);

    // mossy rocks
    const rockG = new THREE.IcosahedronGeometry(1, 1);
    { const p = rockG.attributes.position;
      for (let i = 0; i < p.count; i++) {
        const v = new THREE.Vector3(p.getX(i), p.getY(i), p.getZ(i));
        v.multiplyScalar(1 + (noise2(v.x * 3, v.y * 3 + v.z) - 0.5) * 0.5);
        p.setXYZ(i, v.x, v.y * 0.7, v.z);
      } rockG.computeVertexNormals(); }
    const rocks = new THREE.InstancedMesh(rockG,
      new THREE.MeshStandardMaterial({ color: 0x5a6b4a, roughness: 0.95, map: this.tex.leaves }), 40);
    for (let i = 0; i < 40; i++) {
      const x = rnd(-S * 0.42, S * 0.42), z = rnd(-S * 0.42, S * 0.42);
      const s = rnd(0.3, 1.6);
      E.set(rnd(0.3), rnd(Math.PI * 2), rnd(0.3)); Q.setFromEuler(E);
      M.compose(new THREE.Vector3(x, this.groundY(x, z) + s * 0.3, z), Q, new THREE.Vector3(s, s * 0.8, s));
      rocks.setMatrixAt(i, M);
    }
    rocks.castShadow = rocks.receiveShadow = true; this.group.add(rocks); this.walkables.push(rocks);
  }

  _vines() {
    // catenary vines between nearby tall trees
    const mat = new THREE.MeshStandardMaterial({ color: 0x3d5c22, roughness: 0.9 });
    let made = 0;
    for (let i = 0; i < this.trees.length && made < 14; i++) {
      const a = this.trees[i], b = this.trees[(i + 1) % this.trees.length];
      const d = a.position.distanceTo(b.position);
      if (d < 6 || d > 18) continue;
      const ha = rnd(9, 15), hb = rnd(9, 15);
      const pa = a.position.clone().setY(a.position.y + ha);
      const pb = b.position.clone().setY(b.position.y + hb);
      const mid = pa.clone().lerp(pb, 0.5); mid.y -= d * rnd(0.18, 0.3);   // sag
      const vine = new THREE.Mesh(taperedTube(new THREE.CatmullRomCurve3([pa, mid, pb]), 0.05, 0.035, 12, 5), mat);
      vine.castShadow = true; this.group.add(vine); made++;
    }
  }

  _backdrop() {
    // distant jungle wall: dark silhouetted tree cards in a ring (depth beyond the fog)
    const c = document.createElement('canvas'); c.width = 256; c.height = 256;
    const g = c.getContext('2d');
    g.fillStyle = '#1c2e14';
    g.beginPath(); g.moveTo(118, 256); g.lineTo(118, 110);
    for (let i = 0; i < 26; i++) { const a = (i / 26) * Math.PI * 2, r = 60 + hash(i * 3.7) * 55; g.ellipse(128 + Math.cos(a) * 52, 92 + Math.sin(a) * 40, r * 0.35, r * 0.28, 0, 0, 7); }
    g.fill();
    g.fillRect(118, 100, 20, 156);
    const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace;
    const m = new THREE.MeshBasicMaterial({ map: t, transparent: true, alphaTest: 0.3, side: THREE.DoubleSide, fog: true });
    const card = new THREE.PlaneGeometry(16, 22);
    const ring = new THREE.InstancedMesh(card, m, 46);
    const M = new THREE.Matrix4(), Q = new THREE.Quaternion();
    for (let i = 0; i < 46; i++) {
      const a = (i / 46) * Math.PI * 2 + rnd(0.08);
      const r = this.cfg.size * rnd(0.46, 0.55);
      const p = new THREE.Vector3(Math.cos(a) * r, 6.5, Math.sin(a) * r);
      Q.setFromEuler(new THREE.Euler(0, -a + Math.PI / 2, 0));
      M.compose(p, Q, new THREE.Vector3().setScalar(rnd(1.2, 2.2)));
      ring.setMatrixAt(i, M);
    }
    this.group.add(ring);
  }

  _lightShafts() {
    this.shafts = new THREE.Group();
    const m = new THREE.MeshBasicMaterial({
      color: 0xfff3c8, transparent: true, opacity: 0.022, blending: THREE.AdditiveBlending,
      depthWrite: false, side: THREE.DoubleSide, fog: false
    });
    for (let i = 0; i < 5; i++) {
      const gm = new THREE.CylinderGeometry(rnd(0.35, 0.8), rnd(1.4, 2.6), 26, 8, 1, true);
      const s = new THREE.Mesh(gm, m);
      s.position.set(rnd(-14, 14), 13, rnd(-24, 24));
      s.rotation.z = 0.24; s.rotation.x = rnd(-0.06, 0.06);
      this.shafts.add(s);
    }
    this.group.add(this.shafts);
  }

  _particles() {
    // dust motes
    const N = 260, pos = new Float32Array(N * 3);
    this._dustSeed = [];
    for (let i = 0; i < N; i++) {
      pos[i * 3] = rnd(-16, 16); pos[i * 3 + 1] = rnd(0.5, 14); pos[i * 3 + 2] = rnd(-26, 26);
      this._dustSeed.push(rnd(Math.PI * 2));
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    this.dust = new THREE.Points(g, new THREE.PointsMaterial({
      color: 0xfff6d8, size: 0.045, transparent: true, opacity: 0.5, sizeAttenuation: true, depthWrite: false
    }));
    this.group.add(this.dust);

    // falling leaves
    const leafG = new THREE.PlaneGeometry(0.14, 0.18);
    this.fallLeaves = new THREE.InstancedMesh(leafG, this.leafMats[1], 120);
    this._leafState = [];
    for (let i = 0; i < 120; i++) this._leafState.push({
      x: rnd(-16, 16), y: rnd(0, 18), z: rnd(-26, 26), vy: rnd(0.25, 0.6), ph: rnd(Math.PI * 2)
    });
    this.group.add(this.fallLeaves);
  }

  /* ── gameplay branch spans: the 3D chess board ─────────────── */
  /**
   * @param {Object} o {side:-1|1 (left|right screen edge), y height, z depth,
   *   len toward centre, rise, sag, r0} → mesh + registered span
   */
  addBranchSpan(o = {}) {
    const C = this.cfg.corridorHalf;
    const side = o.side ?? (this.spans.length % 2 ? 1 : -1);
    const y = o.y ?? 2, z = o.z ?? 0;
    const len = o.len ?? rnd(C * 0.9, C * 1.7);
    const rise = o.rise ?? rnd(-0.4, 0.7), sag = o.sag ?? rnd(0.15, 0.5);
    const r0 = o.r0 ?? rnd(0.16, 0.26);
    const x0 = side * (C + 2.5);
    const p0 = new THREE.Vector3(x0, y, z);
    const p1 = new THREE.Vector3(x0 - side * len, y + rise, z + (o.drift ?? rnd(-1.2, 1.2)));
    const mid = p0.clone().lerp(p1, 0.55); mid.y -= sag;
    const curve = new THREE.CatmullRomCurve3([p0, mid, p1]);
    const mesh = new THREE.Mesh(taperedTube(curve, r0, r0 * 0.4, 16, 9, 0.2), this.matBranch);
    mesh.castShadow = mesh.receiveShadow = true;
    mesh.name = 'branch-span';
    // a few twigs + leaf tufts near the tip make it read alive
    const tuft = new THREE.InstancedMesh(new THREE.PlaneGeometry(0.8, 0.8), this.leafMats[2], 10);
    const M = new THREE.Matrix4(), Q = new THREE.Quaternion(), E = new THREE.Euler();
    for (let i = 0; i < 10; i++) {
      const t = rnd(0.7, 1);
      const p = curve.getPointAt(t);
      E.set(rnd(-1, 1), rnd(Math.PI * 2), rnd(-1, 1)); Q.setFromEuler(E);
      M.compose(p.clone().add(new THREE.Vector3(rnd(-0.3, 0.3), rnd(0, 0.4), rnd(-0.3, 0.3))), Q, new THREE.Vector3().setScalar(rnd(0.5, 1)));
      tuft.setMatrixAt(i, M);
    }
    const grp = new THREE.Group(); grp.add(mesh, tuft); grp.name = 'branch-span';
    // re-centre: group origin ON the span so gizmos grab it where it is,
    // and pointAt() tracks the group if the lab moves it later
    const base = curve.getPointAt(0.5);
    grp.position.copy(base);
    mesh.position.copy(base).negate(); tuft.position.copy(base).negate();
    this.group.add(grp);
    const span = {
      id: 'span' + (this.spans.length + 1), group: grp, mesh, curve, r0, r1: r0 * 0.4, side, y, z, len,
      pointAt(t) { return curve.getPointAt(t).sub(base).add(grp.position); },
      tangentAt(t) { return curve.getTangentAt(t); },
      length() { return curve.getLength(); }
    };
    this.spans.push(span);
    this.walkables.push(mesh);
    return span;
  }

  /** A default climbable ladder of spans (preset route scaffold). */
  presetRoute(n = 8) {
    let y = 1.4, z = -4;
    const out = [];
    for (let i = 0; i < n; i++) {
      out.push(this.addBranchSpan({ side: i % 2 ? 1 : -1, y, z, len: this.cfg.corridorHalf * rnd(1.1, 1.6) }));
      y += rnd(0.6, 1.3);          // each next span a jump higher
      z += rnd(2.5, 5);            // and deeper into the jungle
    }
    return out;
  }

  /** Nearest span crawl-anchor for a world point: {span,t,point,tangent,dist}. */
  nearestSpanPoint(p, maxDist = 2.5) {
    let best = null;
    for (const s of this.spans) {
      for (let i = 0; i <= 24; i++) {
        const t = i / 24;
        const q = s.pointAt(t);              // group-aware world point
        const d = q.distanceTo(p);
        if (d < maxDist && (!best || d < best.dist)) {
          best = { span: s, t, point: q, tangent: s.tangentAt(t), dist: d };
        }
      }
    }
    return best;
  }

  update(dt) {
    this._t += dt;
    const t = this._t;
    if (this.dust) {
      const p = this.dust.geometry.attributes.position;
      for (let i = 0; i < p.count; i++) {
        p.setY(i, p.getY(i) + Math.sin(t * 0.5 + this._dustSeed[i]) * 0.0016);
        p.setX(i, p.getX(i) + Math.cos(t * 0.3 + this._dustSeed[i]) * 0.001);
      }
      p.needsUpdate = true;
    }
    if (this.fallLeaves) {
      const M = new THREE.Matrix4(), Q = new THREE.Quaternion(), E = new THREE.Euler();
      for (let i = 0; i < this._leafState.length; i++) {
        const L = this._leafState[i];
        L.y -= L.vy * dt; L.x += Math.sin(t * 1.7 + L.ph) * dt * 0.5;
        if (L.y < 0) { L.y = rnd(12, 18); L.x = rnd(-16, 16); L.z = rnd(-26, 26); }
        E.set(t * 1.3 + L.ph, L.ph, Math.sin(t + L.ph)); Q.setFromEuler(E);
        M.compose(new THREE.Vector3(L.x, L.y, L.z), Q, new THREE.Vector3(1, 1, 1));
        this.fallLeaves.setMatrixAt(i, M);
      }
      this.fallLeaves.instanceMatrix.needsUpdate = true;
    }
    if (this.shafts) this.shafts.children.forEach((s, i) => {
      s.material.opacity = 0.04 + Math.sin(t * 0.4 + i) * 0.015;
    });
  }
}
