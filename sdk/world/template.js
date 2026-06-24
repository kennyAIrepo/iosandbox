/**
 * hopeOS SDK — World Template (L5 Plugin Layer)
 * ═══════════════════════════════════════════════════════════════
 *
 * The drop-in spatial scene engine. Give it a GLB URL and it:
 *   - loads & auto-centers the scene
 *   - generates Rapier trimesh colliders from every mesh (walls/floor)
 *   - auto-fits the sun's shadow camera to the model bounds
 *   - creates a kinematic capsule character controller (the avatar)
 *   - exposes move()/look()/jump() so any navigator (keyboard OR gesture)
 *     can drive the avatar identically
 *
 * This is the SAME engine that hosted the basketball court and art gallery,
 * refactored into an SDK module so the next scene is literally one line:
 *
 *   const world = await WorldTemplate.create({
 *     scene, renderer,
 *     modelUrl: './worlds/my_scene.glb',
 *     scale: 10, spawn: { x: 0, y: 1.5, z: 0 }
 *   });
 *
 * Coordinate system: right-hand Y-up (matches Three.js + Unity).
 */

import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { DRACOLoader } from 'three/addons/loaders/DRACOLoader.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { SelectionManager } from './selection.js';
import { registerMeshAsync, removeCollider } from '../interaction/colliders.js';
import RAPIER from '@dimforge/rapier3d-compat';

const DEFAULTS = {
  gravity:        { x: 0, y: -9.81, z: 0 },
  capsuleRadius:  0.28,
  capsuleHalfH:   0.50,    // total avatar height ≈ 1.56m
  eyeHeight:      1.05,    // added to capsule centre → eye ≈ 1.8m above the floor
  moveSpeed:      3.4,
  sprintSpeed:    6.0,
  jumpSpeed:      5.0,
  spawn:          { x: 0, y: 1.5, z: 0 },
  scale:          1.0,
  autoScale:      false,  // normalize an arbitrary scene's footprint to targetSpan (any source units → playable)
  targetSpan:     24,     // metres the longest horizontal dimension is fit to when autoScale is on
  autoCenter:     false,  // shift the model so its footprint centre sits at world (0,0,0) — guarantees a reachable spawn
  offset:         { x: 0, y: 0, z: 0 },
  autoGround:     true,   // shift model so its lowest point sits at groundY
  groundY:        0,      // world Y the floor is pinned to
  autoSpawn:      true,   // raycast-find an open ground-floor spot to start on
  shadowMapSize:  2048,
  groundDamping:  10.0,
  airDamping:     2.0,
};

export class WorldTemplate {
  constructor() {
    this.scene = null;
    this.renderer = null;
    this.world = null;            // Rapier world
    this.charController = null;
    this.playerBody = null;
    this.playerCollider = null;
    this.model = null;
    this.sun = null;
    this.cfg = { ...DEFAULTS };

    // Avatar kinematic state (driven by navigator)
    this.yaw = 0;
    this.pitch = 0;
    this.velocity = new THREE.Vector3();
    this.grounded = false;
    this.bounds = new THREE.Box3();

    this.navTarget = null;        // AI auto-walk waypoint {x,z,radius}
    this.assetLayer = null;       // L5 creator objects (set after scene exists)
    this._assets = [];            // [{id, mesh}]
    this._assetId = 0;
    this._sceneColliders = [];    // Rapier colliders for the base environment (rebuilt if it's transformed)
    this.sceneIsObject = false;   // the base scene GLB is a fixed backdrop until promoted to a game object
    this.modelLabel = 'world';    // original name of the base GLB (uploaded/downloaded source), shown in the object menu
    this.scripts = [];            // agent run_script snippets, saved + replayed with the world
    this.gridSelection = null;    // current 3D-grid pick (dots/path/surface/volume) for the AI
    this.sel = null;              // SelectionManager (spatial/surface marking)
    this._skyLocked = false;      // lock toggles — a locked object can't be moved/scaled/edited until unlocked
    this._sceneLocked = false;
  }

  static async create(opts = {}) {
    const w = new WorldTemplate();
    w.scene = opts.scene;
    w.renderer = opts.renderer;
    w.cfg = { ...DEFAULTS, ...opts };

    // Init Rapier
    await RAPIER.init();
    w.world = new RAPIER.World(w.cfg.gravity);

    // Renderer shadow setup
    if (w.renderer) {
      w.renderer.shadowMap.enabled = true;
      w.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    }

    w._setupLights();

    // Invisible floor fallback (in case the GLB has no floor mesh)
    w._createStaticBox({ x: 0, y: -0.05, z: 0 }, { x: 50, y: 0.05, z: 50 });

    // Load the scene model
    if (w.cfg.modelUrl) await w._loadModel(w.cfg.modelUrl);

    // Build the avatar
    w._setupCharacter();

    return w;
  }

  // ── Lighting + shadows ──
  _setupLights() {
    // Image-based lighting: a neutral room environment so PBR materials
    // actually read (a single directional light leaves GLB interiors black).
    if (this.renderer) {
      const pmrem = new THREE.PMREMGenerator(this.renderer);
      const envTex = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
      this.scene.environment = envTex;
      this._envTex = envTex;
      this.renderer.toneMappingExposure = 1.0;     // was washing out to grey
    }

    // Even, slightly cool fill — but lower now so textures keep their colour.
    const hemi = new THREE.HemisphereLight(0xbcd0ec, 0x586070, 0.7);
    this.scene.add(hemi);
    const ambient = new THREE.AmbientLight(0xffffff, 0.4);
    this.scene.add(ambient);

    // Key sun — softened so it doesn't burn a white hotspot into the floor
    const sun = new THREE.DirectionalLight(0xfff4e6, 0.9);
    sun.position.set(20, 35, 15);
    sun.castShadow = true;
    sun.shadow.mapSize.set(this.cfg.shadowMapSize, this.cfg.shadowMapSize);
    sun.shadow.bias = -0.0005;
    sun.shadow.normalBias = 0.02;
    this.scene.add(sun);
    this.scene.add(sun.target);
    this.sun = sun;

    const fill = new THREE.DirectionalLight(0xaecbff, 0.5);
    fill.position.set(-15, 12, -10);
    this.scene.add(fill);

    // Keep refs so the atmosphere system can drive time-of-day / mood at runtime.
    this._hemi = hemi; this._ambient = ambient; this._fill = fill;
    this.environment = { hour: null, sky: null, fog: null, exposure: 1.0, shadowsEnabled: true, shadowQuality: 'high' };
  }

  // ── ATMOSPHERE / TIME / LIGHTING (game-maker environment controls) ──────────
  // Native, named controls (savable) so the agent can say "make it golden-hour"
  // or "noon, sharp shadows" and the whole scene relights + recasts accordingly.

  _hex(c, fallback) { if (c == null) return fallback; if (typeof c === 'number') return c; const s = String(c).replace('#', ''); const n = parseInt(s, 16); return isNaN(n) ? fallback : n; }

  /** Aim the sun by azimuth (0-360°, 90=E, 180=S, 270=W) + elevation (° above horizon). */
  setSunAzEl(azimuthDeg, elevationDeg) {
    const az = THREE.MathUtils.degToRad(azimuthDeg), el = THREE.MathUtils.degToRad(elevationDeg);
    const size = this.bounds.getSize(new THREE.Vector3());
    const R = (Math.max(size.x, size.y, size.z) || 40) * 1.4 + 20;
    const ce = Math.cos(el);
    this.sun.position.set(R * ce * Math.sin(az), R * Math.sin(el), R * ce * Math.cos(az));
    this.sun.target.position.copy(this.bounds.getCenter(new THREE.Vector3()));
    this.sun.target.updateMatrixWorld();
    if (this.bounds) this._fitShadowToBounds(this.bounds);   // keep shadow frustum over the scene
    this.environment.sunAz = azimuthDeg; this.environment.sunEl = elevationDeg;
  }

  /**
   * Set time of day (0–24h): moves the sun along a realistic arc (rise ~6, noon
   * overhead, set ~18, night below the horizon), warms/cools the key light and
   * sky, and recasts every shadow from the new sun direction.
   */
  setTimeOfDay(hour) {
    hour = ((hour % 24) + 24) % 24;
    this.environment.hour = hour;
    // Arc: elevation peaks at noon, dips below 0 at night; azimuth swings E→W.
    const dayT = Math.sin(((hour - 6) / 12) * Math.PI);     // +1 noon, 0 at 6/18, −1 midnight
    const elevation = dayT * 72;
    const azimuth = 90 + ((hour - 6) / 12) * 180;           // 90 (E) at 6h → 270 (W) at 18h
    this.setSunAzEl(azimuth, Math.max(elevation, -10));

    const above = Math.max(0, dayT);                        // 0 night → 1 noon
    const golden = above > 0 && above < 0.28;               // low sun = warm rim
    const warm = new THREE.Color(0xff8a3c), noon = new THREE.Color(0xfff4e6), moon = new THREE.Color(0x5a78c0);
    if (dayT > 0) { this.sun.color.copy(warm).lerp(noon, Math.min(1, above / 0.4)); this.sun.intensity = 0.2 + above * 1.15; }
    else { this.sun.color.copy(moon); this.sun.intensity = 0.12; }

    this._hemi.intensity = 0.18 + above * 0.62;
    this._ambient.intensity = 0.12 + above * 0.34;
    this._fill.intensity = 0.15 + above * 0.4;
    if (this.renderer) this.renderer.toneMappingExposure = (this.environment.exposure || 1.0) * (dayT > 0 ? 1.0 : 0.8);

    // Sky / fog colour follows the sun: night → day-blue, golden at the edges.
    const night = new THREE.Color(0x0b1020), dayBlue = new THREE.Color(0x8fb4e0), horizon = new THREE.Color(0xe9a96b);
    const sky = dayT <= 0 ? night : (golden ? horizon.clone().lerp(dayBlue, above / 0.28) : dayBlue);
    this.setAtmosphere({ sky: '#' + sky.getHexString() });
  }

  /** Tune mood: sky/background colour, fog colour/range, tone-mapping exposure. */
  setAtmosphere({ sky, fog, fogNear, fogFar, exposure } = {}) {
    if (sky != null) { const c = new THREE.Color(this._hex(sky, 0x2b313d)); this.scene.background = c; if (!fog && this.scene.fog) this.scene.fog.color.copy(c); this.environment.sky = '#' + c.getHexString(); }
    if (fog != null || fogNear != null || fogFar != null) {
      if (!this.scene.fog) this.scene.fog = new THREE.Fog(0x2b313d, 60, 220);
      if (fog != null) this.scene.fog.color.set(this._hex(fog, this.scene.fog.color.getHex()));
      if (fogNear != null) this.scene.fog.near = fogNear;
      if (fogFar != null) this.scene.fog.far = fogFar;
      this.environment.fog = { color: '#' + this.scene.fog.color.getHexString(), near: this.scene.fog.near, far: this.scene.fog.far };
    }
    if (exposure != null && this.renderer) { this.renderer.toneMappingExposure = exposure; this.environment.exposure = exposure; }
  }

  /** Toggle shadows + quality. quality: low|medium|high|ultra (1024…8192 shadow map). */
  setShadows({ enabled, quality } = {}) {
    const Q = { low: 1024, medium: 2048, high: 4096, ultra: 8192 };
    if (enabled != null) { this.environment.shadowsEnabled = enabled; this.sun.castShadow = enabled; if (this.renderer) this.renderer.shadowMap.enabled = enabled; }
    if (quality && Q[quality]) { this.environment.shadowQuality = quality; this.sun.shadow.mapSize.set(Q[quality], Q[quality]); if (this.sun.shadow.map) { this.sun.shadow.map.dispose(); this.sun.shadow.map = null; } }
  }

  /** Record an agent script so it persists with the world and replays on load. */
  recordScript(code, explanation) { if (code) this.scripts.push({ code, explanation: explanation || '' }); }

  /** Current environment settings (for saving in a world snapshot). */
  getEnvironment() { return { ...this.environment, skyboxUrl: this._skyboxUrl || null, skyboxScale: this._skyboxUserScale || 1 }; }

  /** Re-apply a saved environment after a world loads. */
  applyEnvironment(env) {
    if (!env) return;
    if (env.exposure != null && this.renderer) this.renderer.toneMappingExposure = env.exposure;
    if (env.shadowsEnabled != null || env.shadowQuality) this.setShadows({ enabled: env.shadowsEnabled, quality: env.shadowQuality });
    if (env.hour != null) this.setTimeOfDay(env.hour);
    else if (env.sunAz != null) this.setSunAzEl(env.sunAz, env.sunEl);
    if (env.sky || env.fog) this.setAtmosphere({ sky: env.sky, fog: env.fog && env.fog.color, fogNear: env.fog && env.fog.near, fogFar: env.fog && env.fog.far });
    if (env.skyboxUrl) this.addSkybox(env.skyboxUrl, { scale: env.skyboxScale || 1 }).catch(() => {});
  }

  /**
   * Union AABB of EVERYTHING the sky must wrap — the base environment GLB AND every
   * placed asset (imported church, props, …). This is why the sky reliably surrounds
   * the whole set: it tracks all content, not just the base model.
   */
  _contentBounds() {
    const box = new THREE.Box3();
    if (this.model && this.bounds && !this.bounds.isEmpty()) box.union(this.bounds);
    for (const a of this._assets) {
      if (!a.mesh || a.mesh === this._skybox) continue;
      const b = new THREE.Box3().setFromObject(a.mesh);
      if (!b.isEmpty() && isFinite(b.min.x) && isFinite(b.max.x)) box.union(b);
    }
    return box.isEmpty() ? null : box;
  }

  /** Bounding sphere of all content — the sky's natural CENTRE + radius. A sphere
   *  (half the box diagonal) guarantees every corner of every model is inside. */
  _contentSphere() {
    const box = this._contentBounds();
    if (!box) return { center: new THREE.Vector3(0, this.cfg.groundY || 0, 0), radius: 15 };
    return { center: box.getCenter(new THREE.Vector3()), radius: Math.max(box.getSize(new THREE.Vector3()).length() / 2, 5) };
  }

  /** Centre the sky wraps around (the centre of all content). */
  _sceneCenter() { return this._contentSphere().center; }

  /**
   * Diameter the sky shell needs to fully ENCLOSE all content at userScale=1, with a
   * ×1.5 margin so nothing ever touches the shell, clamped under the camera far plane
   * (6000) so it's never clipped. Grows automatically when a big model is added.
   */
  _skyEnclosingDiameter() {
    return THREE.MathUtils.clamp(this._contentSphere().radius * 2 * 1.5, 80, 5600);
  }

  /**
   * Re-fit the sky shell so it is centred on the environment and large enough to
   * enclose it. Called on creation AND whenever the world is moved/scaled, so the
   * sky ALWAYS tracks the environment — it can never be left tiny or off-centre.
   * _skyboxUserScale (≥1) is the user/AI multiplier on top of the auto-enclose;
   * the final size is clamped to [enclosing, far-plane] so it always wraps the
   * world yet never gets clipped.
   */
  _anchorSkybox() {
    if (!this._skybox || !this._skyboxBaseSize) return;
    const enclose = this._skyEnclosingDiameter();
    const diameter = THREE.MathUtils.clamp(enclose * (this._skyboxUserScale || 1), enclose, 5800);
    this._skybox.scale.setScalar(diameter / this._skyboxBaseSize);
    this._skybox.position.copy(this._sceneCenter());
    this._skybox.updateMatrixWorld(true);
  }

  /**
   * Wrap the scene in a SKY/environment shell — a GLB dome/sphere viewed from the
   * INSIDE. Auto-centred on the world and auto-scaled to ENCLOSE it (and re-fit
   * whenever the world changes — see _anchorSkybox / onSceneEdited), rendered first,
   * with back-face materials + fog off so it always shows. The GLB is wrapped in a
   * group whose pivot is the geometric centre, so off-centre sky exports still sit
   * dead-centre on the world. Not collidable; recallable as the object "sky"
   * (id __sky__); persists with the world via skyboxUrl + skyboxScale.
   */
  async addSkybox(url, opts = {}) {
    if (this._skybox) { this.scene.remove(this._skybox); this._skybox = null; }
    const gltf = await this._gltf().loadAsync(url);
    const inner = gltf.scene;

    // Re-centre the geometry on its own origin so the shell wraps symmetrically
    // (many sky GLBs have an off-centre pivot that would shove the dome off-world).
    const box = new THREE.Box3().setFromObject(inner);
    const c0 = box.getCenter(new THREE.Vector3());
    inner.position.sub(c0);
    const dim = box.getSize(new THREE.Vector3());
    this._skyboxBaseSize = Math.max(dim.x, dim.y, dim.z) || 1;

    const shell = new THREE.Group();
    shell.name = 'L5_skybox';
    shell.add(inner);
    shell.renderOrder = -1;
    shell.traverse(c => {
      if (!c.isMesh) return;
      c.castShadow = c.receiveShadow = false; c.frustumCulled = false;
      (Array.isArray(c.material) ? c.material : [c.material]).forEach(m => { if (m) { m.side = THREE.BackSide; m.fog = false; m.depthWrite = false; } });
    });

    this.scene.add(shell);
    this._skybox = shell; this._skyboxUrl = url;
    this._skyboxUserScale = Math.max(1, opts.scale || 1);
    this._anchorSkybox();                       // size + centre it to fully enclose the scene
    return 'sky shell set — enclosing & centred on the world (recall it as "sky")';
  }

  /** Scale the sky shell by a factor (relative). Stays centred + always encloses (min ×1). */
  scaleSkybox(factor) {
    if (!this._skybox || !(factor > 0)) return false;
    this._skyboxUserScale = Math.max(1, (this._skyboxUserScale || 1) * factor);
    this._anchorSkybox();
    return true;
  }

  /** Set the sky shell's absolute enclose-multiplier (1 = snug fit; clamped ≥1). */
  setSkyboxScale(s) {
    if (!this._skybox || !(s > 0)) return false;
    this._skyboxUserScale = Math.max(1, s);
    this._anchorSkybox();
    return true;
  }

  /** Back out the user multiplier from a gizmo-scaled sky mesh, then re-anchor. */
  syncSkyboxScaleFromMesh() {
    if (!this._skybox || !this._skyboxBaseSize) return;
    const auto = this._skyEnclosingDiameter() / this._skyboxBaseSize;   // mesh scale at userScale=1
    this._skyboxUserScale = Math.max(1, (this._skybox.scale.x || auto) / auto);
    this._anchorSkybox();
  }

  /** Remove the sky shell entirely. */
  removeSkybox() {
    if (!this._skybox) return false;
    this.scene.remove(this._skybox);
    this._skybox = null; this._skyboxUrl = null; this._skyboxBaseSize = 0;
    return true;
  }

  _fitShadowToBounds(box) {
    const sun = this.sun;
    const center = box.getCenter(new THREE.Vector3());
    const size = box.getSize(new THREE.Vector3());
    const maxDim = Math.max(size.x, size.y, size.z);
    const half = maxDim * 0.65;
    sun.shadow.camera.left = -half;
    sun.shadow.camera.right = half;
    sun.shadow.camera.top = half;
    sun.shadow.camera.bottom = -half;
    sun.shadow.camera.near = 0.5;
    sun.shadow.camera.far = maxDim * 3;
    sun.shadow.camera.updateProjectionMatrix();
    sun.target.position.copy(center);
    sun.target.updateMatrixWorld();
  }

  // ── Model loading + collider extraction ──
  async _loadModel(url) {
    const loader = new GLTFLoader();
    const draco = new DRACOLoader();
    draco.setDecoderPath('https://cdn.jsdelivr.net/npm/three@0.160.0/examples/jsm/libs/draco/');
    loader.setDRACOLoader(draco);

    return new Promise((resolve) => {
      loader.load(url, (gltf) => {
        const model = gltf.scene;
        model.scale.setScalar(this.cfg.scale);
        model.position.set(this.cfg.offset.x, this.cfg.offset.y, this.cfg.offset.z);
        model.traverse((c) => {
          if (!c.isMesh) return;
          c.castShadow = true;
          c.receiveShadow = true;
          const name = (c.name || '').toLowerCase();
          const mats = Array.isArray(c.material) ? c.material : [c.material];
          for (const m of mats) {
            if (!m) continue;
            m.side = THREE.DoubleSide;                       // interior never culls to see-through
            if ('envMapIntensity' in m) m.envMapIntensity = 1.0; // reflections, not blowout
            if ('roughness' in m && typeof m.roughness === 'number') {
              if (name.includes('floor') || name.includes('marble')) m.roughness = 0.35; // glossy but no hotspot
              else if (name.includes('tree') || m.metalness > 0.4)    m.roughness = Math.min(m.roughness, 0.35);
              else                                                     m.roughness = Math.min(m.roughness, 0.7);
            }
            m.needsUpdate = true;
          }
        });
        this.scene.add(model);
        this.model = model;
        // Original name from the uploaded/downloaded source, for the object menu.
        this.modelLabel = String(this.cfg.worldName || this._labelFromURL(url) || 'world')
          .replace(/\.(glb|gltf)$/i, '').replace(/[_-]+/g, ' ').trim() || 'world';

        // ── AUTO-SCALE: normalize any scene (cm/inch/giant exports) to a walkable
        //    size so a user-supplied GLB is instantly playable, platform-style. ──
        this.bounds.setFromObject(model);
        if (this.cfg.autoScale) {
          const sz = this.bounds.getSize(new THREE.Vector3());
          const span = Math.max(sz.x, sz.z) || 1;
          const f = THREE.MathUtils.clamp((this.cfg.targetSpan || 24) / span, 0.0001, 10000);
          model.scale.multiplyScalar(f);
          model.updateMatrixWorld(true);
          this.bounds.setFromObject(model);
          console.log('[world] autoScale ×' + f.toFixed(3) + ' → span ' + Math.max(...this.bounds.getSize(new THREE.Vector3()).toArray()).toFixed(1) + 'm');
        }

        // ── AUTO-CENTER: slide the footprint centre to world (0,0,0) so the avatar
        //    always spawns in a reachable spot, never blocked off-origin. ──
        if (this.cfg.autoCenter) {
          const c = this.bounds.getCenter(new THREE.Vector3());
          model.position.x -= c.x; model.position.z -= c.z;
          model.updateMatrixWorld(true);
          this.bounds.setFromObject(model);
        }

        // ── AUTO-GROUND: shift the model so its lowest point pins to groundY ──
        if (this.cfg.autoGround) {
          const drop = this.cfg.groundY - this.bounds.min.y;
          model.position.y += drop;
          model.updateMatrixWorld(true);
          this.bounds.setFromObject(model);
        }

        // ── AUTO-SPAWN: raycast down across the footprint and start the avatar on
        //    the lowest OPEN floor (the ground-floor atrium), never embedded in a slab. ──
        if (this.cfg.autoSpawn) this.cfg.spawn = this._findSpawn(model);

        this._extractColliders(model);
        this._fitShadowToBounds(this.bounds);
        this.sel = new SelectionManager(this.scene);
        this.sel.setModel(model);

        console.log('[world] scene loaded — bounds',
          this.bounds.min.toArray().map(n => n.toFixed(1)), '→',
          this.bounds.max.toArray().map(n => n.toFixed(1)),
          '| spawn', Object.values(this.cfg.spawn).map(n => n.toFixed(1)));
        resolve();
      }, undefined, (err) => {
        console.warn('[world] model load failed, using empty floor:', err);
        resolve();
      });
    });
  }

  /** Raycast down across the footprint; start on the lowest OPEN floor (atrium),
   *  so the avatar never spawns outside the building or on the ceiling. */
  _findSpawn(model) {
    const ray = new THREE.Raycaster();
    const down = new THREE.Vector3(0, -1, 0);
    const b = this.bounds;
    const top = b.max.y + 2;
    const standH = (this.cfg.capsuleHalfH + this.cfg.capsuleRadius) * 2 + 0.3;
    const dirs = [[1, 0], [-1, 0], [0, 1], [0, -1]];
    const cx = (b.min.x + b.max.x) / 2, cz = (b.min.z + b.max.z) / 2;

    // Land cleanly on the floor below a given (x,z): pick the LOWEST surface that
    // has standing headroom above it (skips ceilings / upper slabs).
    const floorAt = (x, z) => {
      ray.set(new THREE.Vector3(x, top, z), down);
      const hits = ray.intersectObject(model, true);
      if (!hits.length) return null;
      for (let k = hits.length - 1; k >= 0; k--) {       // lowest → up
        const y = hits[k].point.y;
        let clear = true;
        for (const h of hits) { if (h.point.y > y + 0.25 && h.point.y < y + standH) { clear = false; break; } }
        if (clear) return y;
      }
      return hits[hits.length - 1].point.y;
    };
    // Enclosed test: walls on most horizontal sides → we're INSIDE the building.
    const enclosed = (x, y, z) => {
      const o = new THREE.Vector3(x, y + 1.3, z);
      let walls = 0;
      for (const [dx, dz] of dirs) {
        ray.set(o, new THREE.Vector3(dx, 0, dz).normalize());
        const h = ray.intersectObject(model, true);
        if (h.length && h[0].distance < Math.max(b.max.x - b.min.x, b.max.z - b.min.z)) walls++;
      }
      return walls >= 3;
    };

    // 1) Explicit verified override (per-scene), if provided.
    if (this.cfg.spawnXZ) {
      const fy = floorAt(this.cfg.spawnXZ.x, this.cfg.spawnXZ.z);
      if (fy !== null) return { x: this.cfg.spawnXZ.x, y: fy + this.cfg.capsuleHalfH + this.cfg.capsuleRadius + 0.05, z: this.cfg.spawnXZ.z };
    }

    // 2) Search: interior points only, lowest walkable floor, nearest centre.
    const inX = (b.max.x - b.min.x) * 0.15, inZ = (b.max.z - b.min.z) * 0.15;
    let best = null;
    for (let i = 0; i <= 6; i++) for (let j = 0; j <= 6; j++) {
      const x = THREE.MathUtils.lerp(b.min.x + inX, b.max.x - inX, i / 6);
      const z = THREE.MathUtils.lerp(b.min.z + inZ, b.max.z - inZ, j / 6);
      const fy = floorAt(x, z);
      if (fy === null) continue;
      const inside = enclosed(x, fy, z);
      // prefer inside, then lower floor, then closer to centre
      const score = (inside ? 0 : 1000) + fy + Math.hypot(x - cx, z - cz) * 0.02;
      if (!best || score < best.score) best = { x, z, fy, score, inside };
    }
    const sx = best ? best.x : cx, sz = best ? best.z : cz, fy = best ? best.fy : b.min.y;
    console.log('[world] spawn', best && best.inside ? '(interior)' : '(fallback)', sx.toFixed(1), fy.toFixed(1), sz.toFixed(1));
    return { x: sx, y: fy + this.cfg.capsuleHalfH + this.cfg.capsuleRadius + 0.05, z: sz };
  }


  _extractColliders(model) {
    let count = 0;
    model.traverse((c) => {
      if (!c.isMesh || !c.geometry) return;
      const geo = c.geometry.clone();
      c.updateWorldMatrix(true, false);
      geo.applyMatrix4(c.matrixWorld);
      const pos = geo.getAttribute('position');
      if (!pos) return;
      const verts = new Float32Array(pos.array);
      let idx;
      if (geo.index) idx = new Uint32Array(geo.index.array);
      else { idx = new Uint32Array(pos.count); for (let i = 0; i < pos.count; i++) idx[i] = i; }
      if (verts.length < 9 || idx.length < 3) return;
      try {
        const cd = RAPIER.ColliderDesc.trimesh(verts, idx).setFriction(0.8);
        this._sceneColliders.push(this.world.createCollider(cd));
        count++;
      } catch (e) { /* skip degenerate */ }
    });
    console.log('[world] generated', count, 'trimesh colliders');
  }

  _createStaticBox(pos, half) {
    const bd = RAPIER.RigidBodyDesc.fixed().setTranslation(pos.x, pos.y, pos.z);
    const body = this.world.createRigidBody(bd);
    const cd = RAPIER.ColliderDesc.cuboid(half.x, half.y, half.z).setFriction(0.8);
    this.world.createCollider(cd, body);
    return body;
  }

  // ── Character controller (the avatar capsule) ──
  _setupCharacter() {
    const { spawn, capsuleHalfH, capsuleRadius } = this.cfg;
    const bd = RAPIER.RigidBodyDesc.kinematicPositionBased().setTranslation(spawn.x, spawn.y, spawn.z);
    this.playerBody = this.world.createRigidBody(bd);
    const cd = RAPIER.ColliderDesc.capsule(capsuleHalfH, capsuleRadius).setFriction(0);
    this.playerCollider = this.world.createCollider(cd, this.playerBody);

    this.charController = this.world.createCharacterController(0.02);
    this.charController.setSlideEnabled(true);
    this.charController.setMaxSlopeClimbAngle(60 * Math.PI / 180);  // climb steep stairs/ramps
    this.charController.setMinSlopeSlideAngle(65 * Math.PI / 180);  // don't slide back on them
    this.charController.enableAutostep(0.5, 0.2, true);             // step up stair treads
    this.charController.enableSnapToGround(0.5);                    // stick to steps going down
    this.charController.setApplyImpulsesToDynamicBodies(true);
  }

  // ── PUBLIC NAVIGATION API (driven by keyboard OR gesture navigator) ──

  /**
   * Drive the avatar one physics tick.
   * @param {Object} intent - { forward, strafe, yawDelta, pitchDelta, jump, sprint }
   *   forward/strafe: -1..1 movement axes
   *   yawDelta/pitchDelta: radians to add to look this frame
   *   jump: boolean (one-shot)
   *   sprint: boolean
   */
  step(dt, intent = {}) {
    // ── Apply look (absolute from navigator; falls back to deltas if provided) ──
    if (intent.yaw !== undefined)   this.yaw = intent.yaw;
    else                            this.yaw += intent.yawDelta || 0;
    if (intent.pitch !== undefined) this.pitch = intent.pitch;
    else                            this.pitch += intent.pitchDelta || 0;
    this.pitch = Math.max(-Math.PI / 2 + 0.05, Math.min(Math.PI / 2 - 0.05, this.pitch));

    let forward = intent.forward || 0;
    let strafe = intent.strafe || 0;

    // ── AI auto-walk: steer toward a target point until reached or stuck ──
    if (this.navTarget) {
      const p = this.playerBody.translation();
      const dx = this.navTarget.x - p.x, dz = this.navTarget.z - p.z;
      const dist = Math.hypot(dx, dz);
      this._navTicks = (this._navTicks || 0) + 1;
      if (this._navBest === undefined || dist < this._navBest - 0.05) { this._navBest = dist; this._navStale = 0; }
      else this._navStale = (this._navStale || 0) + 1;
      if (dist < (this.navTarget.radius || 1.2) || this._navStale > 150 || this._navTicks > 1200) {
        this.navTarget = null; this._navTicks = 0; this._navBest = undefined; this._navStale = 0;  // arrived or gave up
      } else {
        this.yaw = Math.atan2(dx, dz) + Math.PI;
        forward = 1; strafe = 0;
      }
    }

    // ── Movement direction in world space (relative to yaw) ──
    const forwardVec = new THREE.Vector3(0, 0, -1).applyAxisAngle(new THREE.Vector3(0, 1, 0), this.yaw);
    forwardVec.y = 0; forwardVec.normalize();
    const rightVec = new THREE.Vector3().crossVectors(forwardVec, new THREE.Vector3(0, 1, 0)).normalize();

    const speed = intent.sprint ? this.cfg.sprintSpeed : this.cfg.moveSpeed;
    const wish = new THREE.Vector3();
    wish.addScaledVector(forwardVec, forward);
    wish.addScaledVector(rightVec, strafe);
    if (wish.lengthSq() > 0) wish.normalize().multiplyScalar(speed);

    // Is movement actually being requested this frame?
    const wantsMove = Math.abs(forward) > 0.02 || Math.abs(strafe) > 0.02 || !!this.navTarget;

    if (!wantsMove) {
      // HARD STOP — no residual velocity, no creep, no slope micro-slide.
      this.velocity.x = 0;
      this.velocity.z = 0;
    } else {
      const damp = this.grounded ? this.cfg.groundDamping : this.cfg.airDamping;
      this.velocity.x += (wish.x - this.velocity.x) * Math.min(1, damp * dt);
      this.velocity.z += (wish.z - this.velocity.z) * Math.min(1, damp * dt);
    }

    // Gravity
    this.velocity.y += this.cfg.gravity.y * dt;

    // Jump
    if (intent.jump && this.grounded) {
      this.velocity.y = this.cfg.jumpSpeed;
      this.grounded = false;
    }

    // Character controller resolves collisions
    const desired = { x: this.velocity.x * dt, y: this.velocity.y * dt, z: this.velocity.z * dt };
    // Wheel/touchpad dolly: an instant nudge along the look-forward (resolved by the controller, so it still collides).
    if (intent.dolly) { desired.x += forwardVec.x * intent.dolly; desired.z += forwardVec.z * intent.dolly; }
    this.charController.computeColliderMovement(this.playerCollider, desired);
    const corrected = this.charController.computedMovement();
    this.grounded = this.charController.computedGrounded();
    if (this.grounded && this.velocity.y < 0) this.velocity.y = 0;

    const p = this.playerBody.translation();
    let ny = p.y + corrected.y;

    // ── HARD GROUND SAFETY NET ──────────────────────────────────────
    // Arbitrary imported scenes (photogrammetry shells, scenes with gaps or no
    // real floor mesh) can leave the avatar over the void. groundY is the scene's
    // lowest point (autoGround), so clamp the capsule so it can never sink below
    // standing-on-the-ground — you land instead of falling forever. Walls/objects
    // still collide normally via the controller above.
    const floorY = (this.cfg.groundY || 0) + this.cfg.capsuleHalfH + this.cfg.capsuleRadius;
    if (ny < floorY) { ny = floorY; this.velocity.y = 0; this.grounded = true; }

    this.playerBody.setNextKinematicTranslation({ x: p.x + corrected.x, y: ny, z: p.z + corrected.z });

    this.world.step();
  }

  /** Get the avatar eye transform — apply to the SDK camera */
  applyToCamera(camera) {
    const p = this.playerBody.translation();
    camera.position.set(p.x, p.y + this.cfg.eyeHeight, p.z);
    camera.quaternion.setFromEuler(new THREE.Euler(this.pitch, this.yaw, 0, 'YXZ'));
  }

  getAvatarPosition() {
    const p = this.playerBody.translation();
    return new THREE.Vector3(p.x, p.y, p.z);
  }

  /** Forward direction the avatar is facing (for placing held objects, raycasts) */
  getForward() {
    return new THREE.Vector3(0, 0, -1).applyQuaternion(
      new THREE.Quaternion().setFromEuler(new THREE.Euler(this.pitch, this.yaw, 0, 'YXZ'))
    );
  }

  // ── AI AGENT SCENE API (navigation + L5 creator layer) ──────────

  /** Walk the avatar toward a world point (cleared automatically on arrival). */
  navigateTo(x, z, radius = 1.2) { this.navTarget = { x, z, radius }; }
  cancelNavigation() { this.navTarget = null; }

  /** Instantly move the avatar to a world point — gravity then takes over (land… or fall). */
  teleportTo(x, y, z) {
    this.navTarget = null;
    this.velocity.set(0, 0, 0);
    this.grounded = false;
    this.playerBody.setTranslation({ x, y, z }, true);   // immediate (so the next step() doesn't clobber it)
  }

  /** Drop the avatar standing ON a surface point (adds capsule height so feet land on it). */
  standOn(x, surfaceY, z) {
    const h = this.cfg.capsuleHalfH + this.cfg.capsuleRadius + 0.06;
    this.teleportTo(x, surfaceY + h, z);
  }

  /**
   * Teleport the avatar to a world (x,z), finding the floor beneath it so they land
   * standing — used by the AI "bring me to …", which IGNORES walls (it spawns the POV
   * straight there). Walking still collides; only this direct route passes through.
   */
  teleportNear(x, z) {
    let surfaceY = null;
    if (this.model) {
      const top = (this.bounds && !this.bounds.isEmpty()) ? this.bounds.max.y + 5 : 50;
      const ray = new THREE.Raycaster(new THREE.Vector3(x, top, z), new THREE.Vector3(0, -1, 0));
      const hits = ray.intersectObject(this.model, true);
      if (hits.length) surfaceY = hits[0].point.y;
    }
    if (surfaceY !== null) { this.standOn(x, surfaceY, z); return true; }
    this.teleportTo(x, (this.cfg.groundY || 0) + this.cfg.capsuleHalfH + this.cfg.capsuleRadius + 0.1, z);
    return false;
  }

  // ── THE WHOLE ENVIRONMENT (base scene GLB) as a manipulable object ──────────
  // "the world / scene / environment / whole place" = this.model. Transforming it
  // rebuilds the scene colliders so walking still collides with the new shape.

  _rebuildSceneColliders() {
    for (const c of this._sceneColliders) { try { this.world.removeCollider(c, false); } catch (e) { /* gone */ } }
    this._sceneColliders = [];
    if (this.model) this._extractColliders(this.model);
  }

  /** Recompute bounds, rebuild colliders, refit shadows after the environment moves/scales/rotates. */
  onSceneEdited() {
    if (!this.model) return;
    this.model.updateMatrixWorld(true);
    this.bounds.setFromObject(this.model);
    this._rebuildSceneColliders();
    this._fitShadowToBounds(this.bounds);
    this._anchorSkybox();    // sky re-centres + re-encloses with the new world size (never left tiny/off-centre)
  }

  /** Transform the whole environment. scaleFactor multiplies; scale sets absolute; position/rotationDeg set absolute. */
  setSceneTransform({ scaleFactor, scale, position, rotationDeg } = {}) {
    if (!this.model) return false;
    const m = this.model;
    if (typeof scaleFactor === 'number') m.scale.multiplyScalar(scaleFactor);
    else if (typeof scale === 'number') m.scale.setScalar(scale);
    if (position) m.position.set(position.x ?? m.position.x, position.y ?? m.position.y, position.z ?? m.position.z);
    if (rotationDeg) m.rotation.set(
      THREE.MathUtils.degToRad(rotationDeg.x ?? THREE.MathUtils.radToDeg(m.rotation.x)),
      THREE.MathUtils.degToRad(rotationDeg.y ?? THREE.MathUtils.radToDeg(m.rotation.y)),
      THREE.MathUtils.degToRad(rotationDeg.z ?? THREE.MathUtils.radToDeg(m.rotation.z)));
    this.onSceneEdited();
    return true;
  }

  scaleScene(factor) { return this.setSceneTransform({ scaleFactor: factor }); }

  /** Weather presets — compose light + fog for mood (clear/cloudy/foggy/storm). Savable. */
  setWeather(kind) {
    this.environment.weather = kind;
    switch (String(kind || '').toLowerCase()) {
      case 'clear': case 'sunny':           this.setAtmosphere({ fogNear: 60, fogFar: 280 }); this._hemi.intensity = Math.max(this._hemi.intensity, 0.5); break;
      case 'cloudy': case 'overcast':       this.setAtmosphere({ sky: '#9aa6b2', fog: '#9aa6b2', fogNear: 35, fogFar: 200 }); this.sun.intensity *= 0.55; break;
      case 'foggy': case 'mist':            this.setAtmosphere({ fog: '#c8d2dc', fogNear: 3, fogFar: 45 }); break;
      case 'storm': case 'rain':            this.setAtmosphere({ sky: '#3a4250', fog: '#3a4250', fogNear: 8, fogFar: 75 }); this.sun.intensity *= 0.35; this._ambient.intensity = 0.22; break;
    }
  }

  /** Named landmarks the agent can route to (gallery-specific, in grounded coords). */
  getLandmarks() {
    const c = this.bounds.getCenter(new THREE.Vector3());
    return {
      stairs:    { x: 14,  z: 6 },    // side staircase up to the 2nd floor
      stairs_left:  { x: 14, z: -6 },
      atrium:    { x: 16,  z: 0 },    // open ground-floor centre
      center:    { x: c.x, z: c.z },
      entrance:  { x: this.bounds.max.x - 3, z: 0 },
    };
  }

  /** L5 asset layer — lazily created group that holds creator objects. */
  _ensureAssetLayer() {
    if (!this.assetLayer) { this.assetLayer = new THREE.Group(); this.assetLayer.name = 'L5_assets'; this.scene.add(this.assetLayer); }
    return this.assetLayer;
  }

  /** Spawn a primitive in front of the avatar. type: box|sphere|cylinder|cone */
  addObject(type = 'box', opts = {}) {
    const g = this._ensureAssetLayer();
    let geo;
    switch (type) {
      case 'sphere':   geo = new THREE.SphereGeometry(0.5, 24, 16); break;
      case 'cylinder': geo = new THREE.CylinderGeometry(0.4, 0.4, 1, 24); break;
      case 'cone':     geo = new THREE.ConeGeometry(0.5, 1, 24); break;
      default:         geo = new THREE.BoxGeometry(1, 1, 1);
    }
    const color = opts.color !== undefined ? opts.color : 0x4a7fb5;
    const mat = new THREE.MeshStandardMaterial({ color, roughness: 0.4, metalness: 0.1 });
    const mesh = new THREE.Mesh(geo, mat);
    mesh.castShadow = mesh.receiveShadow = true;
    // place ~2m in front of the avatar at eye-ish level
    const pos = opts.position
      ? new THREE.Vector3(opts.position.x, opts.position.y, opts.position.z)
      : this.getAvatarPosition().add(this.getForward().setY(0).normalize().multiplyScalar(2)).setY((this.cfg.groundY || 0) + 0.5);
    mesh.position.copy(pos);
    if (opts.scale) mesh.scale.setScalar(opts.scale);
    g.add(mesh);
    return this._registerAsset(mesh, type, { label: opts.label || type, source: 'primitive' }).id;
  }

  /** Build/rebuild a static collider matching the object's current transform. */
  _syncCollider(a) {
    if (!this.world) return;
    if (a.body) { this.world.removeRigidBody(a.body); a.body = null; }
    const m = a.mesh;

    if (a.ptype === 'import') {
      // axis-aligned box collider sized to the model's current world bounds (cheap + scale-safe)
      m.updateWorldMatrix(true, true);
      const box = new THREE.Box3().setFromObject(m);
      const c = box.getCenter(new THREE.Vector3());
      const h = box.getSize(new THREE.Vector3()).multiplyScalar(0.5);
      const bd = RAPIER.RigidBodyDesc.fixed().setTranslation(c.x, c.y, c.z);
      a.body = this.world.createRigidBody(bd);
      this.world.createCollider(RAPIER.ColliderDesc.cuboid(Math.max(h.x, 0.02), Math.max(h.y, 0.02), Math.max(h.z, 0.02)).setFriction(0.8), a.body);
      return;
    }

    const s = m.scale;
    const q = new THREE.Quaternion().setFromEuler(m.rotation);
    const bd = RAPIER.RigidBodyDesc.fixed()
      .setTranslation(m.position.x, m.position.y, m.position.z)
      .setRotation({ x: q.x, y: q.y, z: q.z, w: q.w });
    a.body = this.world.createRigidBody(bd);
    let cd;
    if (a.ptype === 'sphere')        cd = RAPIER.ColliderDesc.ball(0.5 * s.x);
    else if (a.ptype === 'cylinder') cd = RAPIER.ColliderDesc.cylinder(0.5 * s.y, 0.4 * s.x);
    else if (a.ptype === 'cone')     cd = RAPIER.ColliderDesc.cone(0.5 * s.y, 0.5 * s.x);
    else                             cd = RAPIER.ColliderDesc.cuboid(0.5 * s.x, 0.5 * s.y, 0.5 * s.z);
    this.world.createCollider(cd.setFriction(0.8), a.body);
  }

  // Synthetic ids (__sky__, __scene__) are handled by the routing in the transform
  // methods below — never resolve them to a random asset via the most-recent fallback.
  _find(id) {
    if (id === '__sky__' || id === '__scene__') return null;
    return this._assets.find(a => a.id === id) || this._assets[this._assets.length - 1];
  }

  // ── ASSET REGISTRY (lightweight label + log so objects are recallable) ──
  // Every spawned/imported object flows through here: it gets a stable id, a
  // human label (for voice/AI recall — "make the dragon bigger"), is logged,
  // wired into the live collider, and indexed by label. One place, no clutter.
  _registerAsset(mesh, ptype, meta = {}) {
    const id = `obj_${++this._assetId}`;
    mesh.userData.id = id;
    const label = this._uniqueLabel(meta.label || ptype);
    mesh.userData.label = label;
    const asset = { id, mesh, body: null, handColliders: [], label, ptype, url: meta.url || null, blob: meta.blob || null, source: meta.source || ptype, locked: false, createdAt: Date.now() };
    this._assets.push(asset);
    this._syncCollider(asset);                 // Rapier body → avatar can't walk through it
    this._registerHandColliders(asset);        // BVH mesh colliders → holo HANDS can't pass through it
    this._anchorSkybox();                      // new model added → sky grows/re-centres to keep surrounding everything
    console.log(`[world] +asset ${id} "${label}" (${asset.source}) — ${this._assets.length} live`);
    return asset;
  }

  /**
   * MESH COLLISION for hands (interaction ⇄ world). Register every mesh of the
   * object as a BVH collider in the shared interaction registry, so the holo
   * hands deform around the real surface — you can touch and caress it, fingers
   * don't sink through (the same path the basketball uses, but mesh-accurate).
   * The collider reads the mesh's live matrixWorld, so moving/scaling the object
   * needs no rebuild. Toggled on for ALL incoming objects, Unity-style.
   */
  _registerHandColliders(asset) {
    asset.mesh.traverse((c) => {
      if (!c.isMesh || !c.geometry) return;
      registerMeshAsync(c).then((col) => { if (col) asset.handColliders.push(col); });
    });
  }
  _removeHandColliders(asset) {
    for (const col of asset.handColliders || []) removeCollider(col);
    asset.handColliders = [];
  }

  /** Ensure a label is unique so recall is unambiguous (dragon, dragon 2, …). */
  _uniqueLabel(base) {
    const clean = String(base).trim().toLowerCase().replace(/\.(glb|gltf)$/,'').replace(/[_-]+/g,' ').slice(0, 40) || 'object';
    if (!this._assets.some(a => a.label === clean)) return clean;
    let n = 2; while (this._assets.some(a => a.label === `${clean} ${n}`)) n++;
    return `${clean} ${n}`;
  }

  /** Derive a readable label from a .glb URL (filename, minus query/extension). */
  _labelFromURL(url) {
    try { const p = new URL(url, 'http://x/').pathname.split('/').pop() || 'import'; return decodeURIComponent(p); }
    catch { return 'import'; }
  }

  /** Rename an object so it can be recalled by a friendlier word. */
  nameObject(id, label) { const a = this._find(id); if (a) { a.label = this._uniqueLabel(label); a.mesh.userData.label = a.label; } return a ? a.label : null; }

  /** Resolve an object id from a spoken/typed label (fuzzy contains, most-recent wins).
   *  The sky shell and the base environment are recallable too (so "make the sky
   *  bigger" / "scale the world" reach the right thing instead of a random prop). */
  findByLabel(query) {
    if (!query) return null;
    const q = String(query).trim().toLowerCase();
    if (this._skybox && /\b(sky\s*box|sky\s*shell|sky\s*dome|skybox|sky|heavens?|horizon|firmament)\b/.test(q)) return '__sky__';
    if (this.model && /\b(world|environment|scene|whole\s+place|the\s+map|terrain|landscape)\b/.test(q)) return '__scene__';
    const hit = [...this._assets].reverse().find(a =>
      a.label === q || a.id === q || a.label.includes(q) || q.includes(a.label));
    return hit ? hit.id : null;
  }

  /** Set an asset's world position (used by hand-grab) and re-sync its collider. */
  setAssetPosition(id, x, y, z) { if (this.isLocked(id)) return false; const a = this._find(id); if (a) { a.mesh.position.set(x, y, z); this._syncCollider(a); } return !!a; }
  /** Set an asset's absolute uniform scale and re-sync its collider. */
  setAssetScale(id, s)          { if (this.isLocked(id)) return false; const a = this._find(id); if (a) { a.mesh.scale.setScalar(s); this._syncCollider(a); } return !!a; }
  /** The grabbable L5 assets (scene fixtures/walls are NOT in here). */
  get assets() { return this._assets; }

  // ── LOCK: freeze a game object so it can't be moved/scaled/edited until unlocked.
  // Works on props, the base environment (__scene__) and the sky shell (__sky__).
  isLocked(id) {
    if (id === '__sky__') return !!this._skyLocked;
    if (id === '__scene__') return !!this._sceneLocked;
    const a = this._assets.find(x => x.id === id);
    return a ? !!a.locked : false;
  }
  setLocked(id, on) {
    const v = !!on;
    if (id === '__sky__') this._skyLocked = v;
    else if (id === '__scene__') this._sceneLocked = v;
    else { const a = this._assets.find(x => x.id === id); if (!a) return null; a.locked = v; }
    return v;
  }
  toggleLock(id) { return this.setLocked(id, !this.isLocked(id)); }

  // The sky shell (__sky__) and the base environment (__scene__) are addressable by
  // the same per-object tools as props, but route to their dedicated handlers: the
  // sky always re-encloses + re-centres; the environment rebuilds its colliders.
  // A locked object refuses every transform until it is unlocked.
  moveObject(id, dx, dy, dz)  {
    if (this.isLocked(id)) return false;
    if (id === '__sky__') return false;   // the sky is locked to the world centre — it can't be shoved off
    if (id === '__scene__') { if (!this.model) return false; this.model.position.add(new THREE.Vector3(dx, dy, dz)); this.sceneIsObject = true; this.onSceneEdited(); return true; }
    const a = this._find(id); if (a) { a.mesh.position.add(new THREE.Vector3(dx, dy, dz)); this._syncCollider(a); this._anchorSkybox(); } return !!a;
  }
  scaleObject(id, factor)     {
    if (this.isLocked(id)) return false;
    if (id === '__sky__') return this.scaleSkybox(factor);
    if (id === '__scene__') { this.sceneIsObject = true; return this.setSceneTransform({ scaleFactor: factor }); }
    const a = this._find(id); if (a) { a.mesh.scale.multiplyScalar(factor); this._syncCollider(a); this._anchorSkybox(); } return !!a;
  }
  rotateObject(id, degY)      {
    if (this.isLocked(id)) return false;
    if (id === '__sky__') { if (!this._skybox) return false; this._skybox.rotation.y += THREE.MathUtils.degToRad(degY); return true; }
    if (id === '__scene__') { if (!this.model) return false; this.model.rotation.y += THREE.MathUtils.degToRad(degY); this.sceneIsObject = true; this.onSceneEdited(); return true; }
    const a = this._find(id); if (a) { a.mesh.rotation.y += THREE.MathUtils.degToRad(degY); this._syncCollider(a); } return !!a;
  }
  setObjectColor(id, hex)     { if (this.isLocked(id) || id === '__sky__' || id === '__scene__') return false; const a = this._find(id); if (a) { a.mesh.traverse(o => { if (o.material && o.material.color) { o.material = o.material.clone(); o.material.color.set(hex); } }); } return !!a; }
  deleteObject(id)            {
    if (this.isLocked(id)) return false;
    if (id === '__sky__') return this.removeSkybox();
    if (id === '__scene__') return false;   // can't delete the world itself
    const a = this._find(id); if (a) { this._removeHandColliders(a); a.mesh.parent?.remove(a.mesh); if (a.body) this.world.removeRigidBody(a.body); this._assets = this._assets.filter(x => x !== a); this._anchorSkybox(); } return !!a;
  }

  /** Seat an object at the absolute world centre (x,z → 0) resting on the ground,
   *  then re-fit the sky around it — for "situate the church at the centre". */
  centerObject(id) {
    if (this.isLocked(id) || id === '__sky__' || id === '__scene__') return false;
    const a = this._find(id); if (!a) return false;
    const box = new THREE.Box3().setFromObject(a.mesh);
    const c = box.getCenter(new THREE.Vector3());
    a.mesh.position.x += -c.x;
    a.mesh.position.z += -c.z;
    a.mesh.position.y += (this.cfg.groundY || 0) - box.min.y;   // rest its base on the ground
    this._syncCollider(a);
    this._anchorSkybox();          // sky re-centres + re-encloses around the now-centred model
    return true;
  }

  /** Shared GLTF loader (DRACO-enabled). */
  _gltf() {
    if (!this._loader) {
      this._loader = new GLTFLoader();
      const d = new DRACOLoader(); d.setDecoderPath('https://cdn.jsdelivr.net/npm/three@0.160.0/examples/jsm/libs/draco/');
      this._loader.setDRACOLoader(d);
    }
    return this._loader;
  }

  /**
   * Import ANY .glb URL (Sketchfab download link, Meshy, self-hosted) as a live
   * L5 asset: normalised to fit the marked selection, dropped onto it, lit by the
   * scene IBL, shadow-casting, and immediately collidable. Returns a Promise<id>.
   */
  importGLBFromURL(url, opts = {}) {
    return new Promise((resolve, reject) => {
      this._gltf().load(url, (gltf) => {
        const obj = gltf.scene;
        obj.traverse(c => { if (c.isMesh) { c.castShadow = c.receiveShadow = true;
          (Array.isArray(c.material) ? c.material : [c.material]).forEach(m => { if (m) { m.side = THREE.DoubleSide; m.envMapIntensity = 1.0; } });   // DoubleSide → interiors/domes visible from inside
        } });

        // normalise: scale longest dimension to fit the selection (or ~1.5m)
        const box = new THREE.Box3().setFromObject(obj);
        const dim = box.getSize(new THREE.Vector3());
        const longest = Math.max(dim.x, dim.y, dim.z) || 1;
        const fit = opts.fit || (this.sel && this.sel.has() ? this.sel.selection.size * 0.8 : 1.5);
        const s = (opts.scale || 1) * (fit / longest);
        obj.scale.setScalar(s);

        // place: into the selection (lifted so it rests on the surface) or in front
        const half = (dim.y * s) / 2;
        let pos;
        if (opts.position) pos = new THREE.Vector3(opts.position.x, opts.position.y, opts.position.z);
        else if (this.sel && this.sel.has()) pos = this.sel.pointAt(0, 0, half);
        else pos = this.getAvatarPosition().add(this.getForward().setY(0).normalize().multiplyScalar(2)).setY((this.cfg.groundY || 0) + half);
        obj.position.copy(pos);

        this._ensureAssetLayer().add(obj);
        const asset = this._registerAsset(obj, 'import', { label: opts.label || this._labelFromURL(url), source: 'import', url, blob: opts.blob || null });
        this._lastImport = asset.id;
        resolve(asset.id);
      }, undefined, (err) => reject(err));
    });
  }

  /** Clone the last-imported model across the marked region as miniatures. */
  fillSelectionWithImport(rows = 3, cols = 3, opts = {}) {
    const src = this._find(opts.id || this._lastImport);
    if (!src || !this.sel || !this.sel.has()) return [];
    const ids = [];
    const mini = opts.scale || 0.3;
    for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) {
      const u = cols > 1 ? (c / (cols - 1) - 0.5) * 0.8 : 0;
      const v = rows > 1 ? (r / (rows - 1) - 0.5) * 0.8 : 0;
      const clone = src.mesh.clone(true);
      clone.scale.multiplyScalar(mini);
      const box = new THREE.Box3().setFromObject(clone);
      const half = box.getSize(new THREE.Vector3()).y / 2;
      clone.position.copy(this.sel.pointAt(u, v, half));
      this._ensureAssetLayer().add(clone);
      ids.push(this._registerAsset(clone, 'import', { label: (src.label || 'import') + ' mini', source: 'clone', url: src.url }).id);
    }
    return ids;
  }

  /** Choose the marking shape: 'surface' (snaps to wall/floor) or 'box' (free region). */
  setSelectionShape(kind, size = 2.0) {
    if (kind === 'box') { const p = this.getAvatarPosition().add(this.getForward().setY(0).normalize().multiplyScalar(3)).setY((this.cfg.groundY || 0) + size / 2); return this.markRegion(p.x, p.y, p.z, size); }
    return this.markSurfaceInView(size);
  }

  /** Move + scale an asset onto the current selection (used by two-hand gesture). */
  situateInSelection(id, scale) {
    const a = this._find(id); if (!a || !this.sel || !this.sel.has()) return false;
    if (scale) a.mesh.scale.setScalar(scale);
    const box = new THREE.Box3().setFromObject(a.mesh);
    const half = box.getSize(new THREE.Vector3()).y / 2;
    a.mesh.position.copy(this.sel.pointAt(0, 0, half));
    this._syncCollider(a);
    return true;
  }

  /** Absolute transform set (any subset). position {x,y,z}, rotationDeg {x,y,z}, scale number|{x,y,z} */
  setObjectTransform(id, t = {}) {
    if (this.isLocked(id)) return false;
    if (id === '__sky__') {
      if (typeof t.scale === 'number') this.setSkyboxScale(t.scale);
      if (t.rotationDeg && this._skybox) this._skybox.rotation.y = THREE.MathUtils.degToRad(t.rotationDeg.y ?? 0);
      return !!this._skybox;
    }
    if (id === '__scene__') { this.sceneIsObject = true; return this.setSceneTransform({ scale: typeof t.scale === 'number' ? t.scale : undefined, position: t.position, rotationDeg: t.rotationDeg }); }
    const a = this._find(id); if (!a) return false;
    if (t.position) a.mesh.position.set(t.position.x ?? a.mesh.position.x, t.position.y ?? a.mesh.position.y, t.position.z ?? a.mesh.position.z);
    if (t.rotationDeg) a.mesh.rotation.set(
      THREE.MathUtils.degToRad(t.rotationDeg.x ?? 0),
      THREE.MathUtils.degToRad(t.rotationDeg.y ?? 0),
      THREE.MathUtils.degToRad(t.rotationDeg.z ?? 0));
    if (typeof t.scale === 'number') a.mesh.scale.setScalar(t.scale);
    else if (t.scale) a.mesh.scale.set(t.scale.x ?? 1, t.scale.y ?? 1, t.scale.z ?? 1);
    this._syncCollider(a);
    this._anchorSkybox();          // moving/scaling a model re-fits the sky around the new extent
    return true;
  }

  duplicateObject(id) {
    const a = this._find(id); if (!a) return null;
    const mesh = a.mesh.clone(); if (a.mesh.material) mesh.material = a.mesh.material.clone();
    mesh.position.x += 1.2;
    this._ensureAssetLayer().add(mesh);
    return this._registerAsset(mesh, a.ptype, { label: (a.label || a.id) + ' copy', source: 'duplicate', url: a.url }).id;
  }

  /**
   * Serialise every L5 asset to a plain snapshot (label, kind, source URL for
   * imports / type+colour for primitives, and world transform). Combine with the
   * base scene + avatar state to persist a whole built world. See WorldStore.
   */
  snapshot() {
    const r3 = (n) => +n.toFixed(3), r1 = (n) => +n.toFixed(1);
    return this._assets.map((a) => {
      const m = a.mesh, isImport = a.ptype === 'import';
      const mat = !isImport && m.material && m.material.color ? '#' + m.material.color.getHexString() : null;
      return {
        id: a.id,
        label: a.label,
        kind: isImport ? 'import' : 'primitive',
        url: isImport ? (a.url || null) : null,
        blob: isImport ? (a.blob || null) : null,   // uploaded local GLB bytes → persist so it reloads
        ptype: isImport ? null : a.ptype,
        color: mat,
        position: m.position.toArray().map(r3),
        rotationDeg: [THREE.MathUtils.radToDeg(m.rotation.x), THREE.MathUtils.radToDeg(m.rotation.y), THREE.MathUtils.radToDeg(m.rotation.z)].map(r1),
        scale: m.scale.toArray().map(r3),
      };
    });
  }

  /** Raycast from the avatar's eye along the look direction; return the L5 id hit. */
  selectInView() {
    if (!this.assetLayer || !this._assets.length) return null;
    const origin = this.getAvatarPosition().setY(this.playerBody.translation().y + this.cfg.eyeHeight);
    const ray = new THREE.Raycaster(origin, this.getForward().normalize(), 0.1, 60);
    const hits = ray.intersectObjects(this.assetLayer.children, true);
    return hits.length ? (hits[0].object.userData.id || null) : null;
  }

  // Every game object the user can mean — the sky shell and the base environment
  // are first-class entries (id __sky__ / __scene__) alongside placed props, so the
  // AI and the object menu can list, select and transform ALL of them.
  listObjects() {
    const c = this._sceneCenter();
    const list = [];
    if (this._skyboxUrl) list.push({
      id: '__sky__', label: 'sky', type: 'skybox', special: 'sky', locked: !!this._skyLocked,
      position: [+c.x.toFixed(2), +c.y.toFixed(2), +c.z.toFixed(2)],
      scale: +(this._skyboxUserScale || 1).toFixed(2), color: null,
      note: 'environment shell — always encloses & stays centred on the world; scale_object {label:"sky"} to grow it',
    });
    if (this.model) list.push({
      id: '__scene__', label: this.modelLabel || 'world', type: 'environment', special: 'scene', locked: !!this._sceneLocked,
      position: this.model.position.toArray().map(n => +n.toFixed(2)),
      scale: +this.model.scale.x.toFixed(2), color: null, editable: !!this.sceneIsObject,
    });
    for (const a of this._assets) list.push({
      id: a.id,
      label: a.label,
      type: a.ptype === 'import' ? 'import' : (a.mesh.geometry ? a.mesh.geometry.type.replace('Geometry', '').toLowerCase() : 'group'),
      position: a.mesh.position.toArray().map(n => +n.toFixed(2)),
      scale: +a.mesh.scale.x.toFixed(2),
      color: a.mesh.material && a.mesh.material.color ? '#' + a.mesh.material.color.getHexString() : null,
      locked: !!a.locked,
    });
    return list;
  }

  // ── SPATIAL SELECTION (L5 marking) ──────────────────────────────
  /** Mark the surface the user is looking at (raycast from the eye). */
  markSurfaceInView(size = 2.0) {
    if (!this.sel) return null;
    const eye = this.getAvatarPosition().setY(this.playerBody.translation().y + this.cfg.eyeHeight);
    return this.sel.markFromRay(eye, this.getForward(), size);
  }
  /** Mark a surface from an arbitrary ray (e.g. a pointing hand). */
  markSurfaceFromRay(origin, dir, size = 2.0) { return this.sel ? this.sel.markFromRay(origin, dir, size) : null; }
  markRegion(x, y, z, size = 2.0)             { return this.sel ? this.sel.markRegion({ x, y, z }, size) : null; }
  getSelection()                              { return this.sel ? this.sel.get() : null; }
  clearSelection()                            { if (this.sel) this.sel.clear(); }

  /** Drop one object onto the marked selection at (u,v) ∈ [-0.5,0.5]. */
  placeInSelection(type = 'box', opts = {}) {
    if (!this.sel || !this.sel.has()) return null;
    const lift = 0.5 * (opts.scale || 1);
    const p = this.sel.pointAt(opts.u || 0, opts.v || 0, lift);
    return this.addObject(type, { color: opts.color, scale: opts.scale, position: { x: p.x, y: p.y, z: p.z } });
  }

  /** Fill the marked region with a rows×cols grid of objects. */
  fillSelection(type = 'box', rows = 3, cols = 3, opts = {}) {
    if (!this.sel || !this.sel.has()) return [];
    const ids = [];
    const lift = 0.5 * (opts.scale || 1);
    for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) {
      const u = cols > 1 ? (c / (cols - 1) - 0.5) * 0.8 : 0;
      const v = rows > 1 ? (r / (rows - 1) - 0.5) * 0.8 : 0;
      const p = this.sel.pointAt(u, v, lift);
      ids.push(this.addObject(type, { color: opts.color, scale: opts.scale, position: { x: p.x, y: p.y, z: p.z } }));
    }
    return ids;
  }

  /** Full snapshot the AI can read to understand the world before acting. */
  getSceneState() {
    const p = this.getAvatarPosition();
    const r2 = (n) => +n.toFixed(2);
    const min = this.bounds.min, max = this.bounds.max, c = this.bounds.getCenter(new THREE.Vector3()), s = this.bounds.getSize(new THREE.Vector3());
    return {
      avatar: { x: +p.x.toFixed(2), y: +p.y.toFixed(2), z: +p.z.toFixed(2),
                yawDeg: +THREE.MathUtils.radToDeg(this.yaw).toFixed(0),
                pitchDeg: +THREE.MathUtils.radToDeg(this.pitch).toFixed(0) },
      // Whole-scene spatial extent (metres, Y up) so placement is situationally aware.
      scene: {
        name: this.modelLabel || 'world',
        boundsMin: [r2(min.x), r2(min.y), r2(min.z)],
        boundsMax: [r2(max.x), r2(max.y), r2(max.z)],
        center: [r2(c.x), r2(c.y), r2(c.z)],
        size: [r2(s.x), r2(s.y), r2(s.z)],
        groundY: this.cfg.groundY || 0,
      },
      // Bounding sphere of ALL content (base + every placed model) + the sky shell,
      // so the agent can centre a model and grow the sky to truly surround everything.
      content: (() => { const sp = this._contentSphere(); return { center: sp.center.toArray().map(r2), radius: +sp.radius.toFixed(2) }; })(),
      sky: this._skyboxUrl ? {
        center: this._sceneCenter().toArray().map(r2),
        radius: +(this._skyEnclosingDiameter() / 2).toFixed(1),
        userScale: +(this._skyboxUserScale || 1).toFixed(2),
        surroundsAllContent: true,
        locked: !!this._skyLocked,
      } : null,
      lookingAt: this.selectInView(),
      selection: this.getSelection(),
      landmarks: this.getLandmarks(),
      environment: this.getEnvironment(),
      gridSelection: this.gridSelection,
      objects: this.listObjects(),
    };
  }
}
