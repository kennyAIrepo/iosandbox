/**
 * hopeOS SDK — In-runtime AI Agent (Claude-powered)
 * ═══════════════════════════════════════════════════════════════
 * Turns natural-language commands (typed or voice-transcribed) into real
 * actions on the world — for BOTH navigating and creating. Claude decides
 * which tools to call; this module executes them against the live scene.
 *
 *   const agent = new WorldAgent({ apiKey, model, world, nav, scene });
 *   await agent.command("take me to the stairs");
 *   await agent.command("make me face up, not the floor");
 *   await agent.command("add a gold sphere in front of me and make it bigger");
 *
 * Navigation intent uses Claude (this module). Whisper (OpenAI) only does the
 * speech→text step upstream; its transcript is fed straight into command().
 */

import { searchModels, resolveGLB } from './sketchfab.js';

const TOOLS = [
  // ── Understanding ──
  { name: 'get_scene', description: 'Read the full world state: avatar transform, what the user is looking at, landmarks, and every object with its id/type/position/rotation/scale/color. Call this first when you need to know what exists or which object the user means.',
    input_schema: { type: 'object', properties: {} } },
  { name: 'select_in_view', description: 'Return the id of the object the user is currently looking at (raycast from their eyes). Use for "this"/"that".',
    input_schema: { type: 'object', properties: {} } },

  // ── Spatial selection (mark a wall/floor/region for editing) ──
  { name: 'mark_surface_in_view', description: 'Mark the wall/floor/ceiling the user is looking at as the active selection. Returns its centre, normal, tangent basis, size and area — the spatial matrix to build against.',
    input_schema: { type: 'object', properties: { size: { type: 'number', description: 'edge length of the marked square (m), default 2' } } } },
  { name: 'mark_region', description: 'Mark a free box region floating at a world coordinate.',
    input_schema: { type: 'object', properties: { x: { type: 'number' }, y: { type: 'number' }, z: { type: 'number' }, size: { type: 'number' } }, required: ['x', 'y', 'z'] } },
  { name: 'get_selection', description: 'Read the active spatial selection (centre/normal/basis/size/area/type).',
    input_schema: { type: 'object', properties: {} } },
  { name: 'clear_selection', description: 'Clear the active selection.', input_schema: { type: 'object', properties: {} } },
  { name: 'place_in_selection', description: 'Place one object on the active selection at grid coords u,v ∈ [-0.5,0.5] (0,0 = centre). Sits it on the surface.',
    input_schema: { type: 'object', properties: { type: { type: 'string', enum: ['box', 'sphere', 'cylinder', 'cone'] }, color: { type: 'string' }, scale: { type: 'number' }, u: { type: 'number' }, v: { type: 'number' } }, required: ['type'] } },
  { name: 'fill_selection', description: 'Fill the active selection with a rows×cols grid of primitive objects (e.g. tile a wall).',
    input_schema: { type: 'object', properties: { type: { type: 'string', enum: ['box', 'sphere', 'cylinder', 'cone'] }, rows: { type: 'number' }, cols: { type: 'number' }, color: { type: 'string' }, scale: { type: 'number' } }, required: ['type', 'rows', 'cols'] } },
  { name: 'set_selection_shape', description: 'Choose the marking shape: "surface" snaps to the wall/floor you face; "box" marks a free region in front of you.',
    input_schema: { type: 'object', properties: { kind: { type: 'string', enum: ['surface', 'box'] }, size: { type: 'number' } }, required: ['kind'] } },

  // ── Import real 3D assets (Sketchfab / direct GLB / Meshy) ──
  { name: 'import_sketchfab', description: 'Search Sketchfab for a downloadable model matching the query and import the best match into the active selection (collidable, lit, shadowed).',
    input_schema: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] } },
  { name: 'import_glb_url', description: 'Import any direct .glb URL (Meshy export, self-hosted, etc.) into the active selection.',
    input_schema: { type: 'object', properties: { url: { type: 'string' }, label: { type: 'string', description: 'recall name for the object, e.g. "lamp"' } }, required: ['url'] } },
  { name: 'fill_selection_with_import', description: 'Clone the most recently imported model across the marked region as miniatures.',
    input_schema: { type: 'object', properties: { rows: { type: 'number' }, cols: { type: 'number' }, scale: { type: 'number' } }, required: ['rows', 'cols'] } },

  // ── Navigation / camera ──
  { name: 'navigate_to', description: 'Instantly BRING the avatar to a place — teleports the POV straight there, THROUGH walls (unlike walking, which collides). Target a named landmark, an OBJECT by its label (e.g. "the cat", "tree"), or x/z coordinates. It lands them standing on the floor beneath the target.',
    input_schema: { type: 'object', properties: {
      target: { type: 'string', description: 'a landmark name, or an object label like "cat" / "tree"' },
      x: { type: 'number' }, z: { type: 'number' } } } },
  { name: 'look', description: 'Aim the camera vertically.',
    input_schema: { type: 'object', properties: { direction: { type: 'string', enum: ['up', 'down', 'level'] }, degrees: { type: 'number' } }, required: ['direction'] } },
  { name: 'turn', description: 'Rotate the view. + = right, − = left (degrees).',
    input_schema: { type: 'object', properties: { degrees: { type: 'number' } }, required: ['degrees'] } },
  { name: 'set_walk', description: 'Start or stop walking.',
    input_schema: { type: 'object', properties: { state: { type: 'string', enum: ['go', 'stop'] } }, required: ['state'] } },

  // ── L5 creator layer (full CRUD + transform) ──
  { name: 'create_object', description: 'Create a primitive. Defaults to ~2m in front of the avatar if no position given.',
    input_schema: { type: 'object', properties: {
      type: { type: 'string', enum: ['box', 'sphere', 'cylinder', 'cone'] },
      color: { type: 'string', description: 'hex like #d4a843' },
      scale: { type: 'number' },
      position: { type: 'object', properties: { x: { type: 'number' }, y: { type: 'number' }, z: { type: 'number' } } } },
      required: ['type'] } },
  { name: 'set_transform', description: 'Set an object\'s ABSOLUTE position / rotation(deg) / scale. Any subset. Target by id OR label; omit both = most recent.',
    input_schema: { type: 'object', properties: {
      id: { type: 'string' }, label: { type: 'string', description: 'recall name, e.g. "dragon"' },
      position: { type: 'object', properties: { x: { type: 'number' }, y: { type: 'number' }, z: { type: 'number' } } },
      rotationDeg: { type: 'object', properties: { x: { type: 'number' }, y: { type: 'number' }, z: { type: 'number' } } },
      scale: { type: 'number' } } } },
  { name: 'translate_object', description: 'Move an object by a delta (metres). Target by id OR label; omit both = most recent.',
    input_schema: { type: 'object', properties: { id: { type: 'string' }, label: { type: 'string' }, dx: { type: 'number' }, dy: { type: 'number' }, dz: { type: 'number' } } } },
  { name: 'rotate_object', description: 'Rotate an object around Y by degrees (relative). Target by id OR label; omit both = most recent.',
    input_schema: { type: 'object', properties: { id: { type: 'string' }, label: { type: 'string' }, degrees: { type: 'number' } }, required: ['degrees'] } },
  { name: 'scale_object', description: 'Scale an object by a factor (relative). Target by id OR label; omit both = most recent.',
    input_schema: { type: 'object', properties: { id: { type: 'string' }, label: { type: 'string' }, factor: { type: 'number' } }, required: ['factor'] } },
  { name: 'set_color', description: 'Recolor an object (hex). Target by id OR label; omit both = most recent.',
    input_schema: { type: 'object', properties: { id: { type: 'string' }, label: { type: 'string' }, color: { type: 'string' } }, required: ['color'] } },
  { name: 'rename_object', description: 'Give an object a new recall name so the user can refer to it by word later. Target it by id or by its current name (target); omit both = most recent.',
    input_schema: { type: 'object', properties: { id: { type: 'string' }, target: { type: 'string', description: 'current name to find' }, label: { type: 'string', description: 'new name' } }, required: ['label'] } },
  { name: 'duplicate_object', description: 'Clone an object. Target by id OR label; omit both = most recent.',
    input_schema: { type: 'object', properties: { id: { type: 'string' }, label: { type: 'string' } } } },
  { name: 'delete_object', description: 'Delete an object. Target by id OR label; omit both = most recent.',
    input_schema: { type: 'object', properties: { id: { type: 'string' }, label: { type: 'string' } } } },

  // ── Atmosphere / time / lighting (realistic environment, savable) ──
  { name: 'set_time_of_day', description: 'Set the scene time of day (0–24h). Moves the sun on a realistic arc (sunrise ~6, noon overhead, sunset ~18, night below the horizon), warms/cools the key light and sky, and recasts every shadow from the sun direction. Use for "make it golden hour", "sunrise", "midnight".',
    input_schema: { type: 'object', properties: { hour: { type: 'number', description: '0–24' } }, required: ['hour'] } },
  { name: 'set_sun', description: 'Aim the sun directly: azimuth 0–360° (90=east, 180=south, 270=west) and elevation° above the horizon. Shadows follow the new direction.',
    input_schema: { type: 'object', properties: { azimuth: { type: 'number' }, elevation: { type: 'number' } }, required: ['azimuth', 'elevation'] } },
  { name: 'set_atmosphere', description: 'Set mood: sky/background colour, fog colour + near/far distance, and tone-mapping exposure. Hex colours like #87b0e0.',
    input_schema: { type: 'object', properties: { sky: { type: 'string' }, fog: { type: 'string' }, fogNear: { type: 'number' }, fogFar: { type: 'number' }, exposure: { type: 'number' } } } },
  { name: 'set_shadows', description: 'Toggle shadows and set their quality for realism. quality: low|medium|high|ultra.',
    input_schema: { type: 'object', properties: { enabled: { type: 'boolean' }, quality: { type: 'string', enum: ['low', 'medium', 'high', 'ultra'] } } } },
  { name: 'set_weather', description: 'Set weather mood (composes light + fog): clear, cloudy, foggy, or storm. Combine with set_time_of_day for full atmosphere.',
    input_schema: { type: 'object', properties: { kind: { type: 'string', enum: ['clear', 'cloudy', 'foggy', 'storm'] } }, required: ['kind'] } },
  { name: 'make_scene_editable', description: 'Promote (or demote) the base world ENVIRONMENT to a manipulable game object. By default the scene GLB is a fixed backdrop — NOT clickable/selectable. Only call this with editable:true when the user explicitly asks to "make the world/scene a game object" or to make the whole environment movable/editable. After that it can be click-selected with a gizmo and transformed like any object.',
    input_schema: { type: 'object', properties: { editable: { type: 'boolean' } }, required: ['editable'] } },
  { name: 'transform_scene', description: 'Transform the WHOLE world ENVIRONMENT — the base scene GLB itself (the building / landscape / room you walk inside), NOT a placed object. Use this whenever the user means "the world / scene / environment / whole place / the map / the floor (as a whole)". scaleFactor multiplies its overall size (2 = twice as big), rotationDegY spins it, position moves it. Colliders rebuild automatically so walking still works. (This also promotes the environment to an editable object.)',
    input_schema: { type: 'object', properties: { scaleFactor: { type: 'number' }, rotationDegY: { type: 'number' }, position: { type: 'object', properties: { x: { type: 'number' }, y: { type: 'number' }, z: { type: 'number' } } } } } },

  // ── Live frontend scripting (escape hatch for anything the tools can't express) ──
  { name: 'run_script', description: 'Run a small JavaScript snippet to make a custom LIVE change the other tools cannot express — animate something, wire a custom interaction, tweak materials/lights, batch-edit objects. Your snippet body runs with these in scope: world (WorldTemplate), scene, camera, THREE, hope (the SDK), nav. You may use await. Return a short status string. Keep it small, reversible, and only when no dedicated tool fits.',
    input_schema: { type: 'object', properties: { code: { type: 'string', description: 'JS to execute (function body; may use await; can return a string)' }, explanation: { type: 'string', description: 'one line on what it does' } }, required: ['code'] } },
];

// Loaded into the system prompt if agent-guide.md can't be fetched (file://, offline).
const FALLBACK_GUIDE =
  'You are a co-creator and spatial designer in a Three.js + Rapier world (metres, Y-up; human ≈1.7m). ' +
  'Converse AND act. Understand first (get_scene/select_in_view), mark surfaces before placing, import real ' +
  'assets by query (name them), edit by label, and use run_script only when no tool fits. Design with a clear ' +
  'focal point, leading lines, negative space, human-readable scale, warm/cool light, a small palette, and ' +
  'walkable flow. Match imported assets to the scene\'s style and the space they fill.';

// Loaded into the BUILD agent's system prompt — deep, ready-to-use scene/game construction know-how.
const BUILD_KNOWLEDGE = [
  "GAME-SCENE CONSTRUCTION PLAYBOOK — you are the BUILD AGENT, running at maximum capability. Be ambitious, decisive and thorough; build complete, polished, playable scenes, not fragments.",
  "• Plan then mass: state the concept in a phrase, block out the big forms (ground plane, walls/horizon, major landmarks) before details. Keep the base model's floor centered near origin so the spawn is reachable; keep human eye level (~1.7m) and real-world scale in mind (doorway ~2m, chair ~0.5m).",
  "• Composition: one clear focal point, leading lines toward it, walkable lanes, deliberate negative space, foreground/mid/background depth. Compose situationally from scene.bounds/center/size and the existing objects[].",
  "• Light & atmosphere: a tight palette; warm key + cool fill; set_time_of_day / set_sun to rake light and set mood; set_atmosphere (sky/fog/exposure) for depth; set_shadows for grounding; set_weather to unify. Golden hour and gentle fog flatter most scenes.",
  "• Sourcing real assets (your supply chain): import_sketchfab(query) pulls downloadable models — use concrete VISUAL queries combining material + object + style (e.g. 'weathered bronze statue', 'lowpoly pine tree', 'sci-fi crate scuffed'). import_glb_url for a direct .glb / Meshy export. Always name what you add so it's recallable; duplicate/scatter to build sets and crowds.",
  "• Materials & believability: vary surface finish (matte vs glossy), avoid uniform scale/spacing, sit objects ON surfaces (use groundY / mark_surface_in_view → place_in_selection / fill_selection), never leave props floating or clipping.",
  "• Spatial selection & the grid: when the user has marked the neon grid (gridSelection) or you mark a wall/region, treat it as 'here / along this / in this region' and place, line up, or fill accordingly.",
  "• Custom behaviour: run_script is your escape hatch (scope: world, scene, camera, THREE, hope, nav; await ok; hope.onFrame(cb) for animation) — wire interactions, animate, batch-edit materials/lights, author simple game logic. Keep snippets small and reversible.",
  "• Environment vs props: the base scene GLB is a FIXED backdrop unless the user explicitly asks to make the world a game object (make_scene_editable / transform_scene). Use per-object tools for props; don't grab the whole world by accident.",
  "• Finish pass: check scale, grounding, lighting, and that there's a focal moment and somewhere to walk. Narrate briefly what you built and offer one concrete next step.",
].join('\n');

export class WorldAgent {
  constructor({ apiKey, model, models, mode, world, nav, onSay, sketchfabToken, env, allowScripting, guideUrl, endpoint }) {
    this.apiKey = apiKey || '';                          // unused — key lives server-side
    this.endpoint = endpoint || '/api/claude';           // proxy that holds the Claude key
    // Two tiers (never named to the user): 'build' = max-capability construct agent,
    // 'converse' = lighter design/chat pal. The host swaps modes by context + a toggle.
    this.models = models || { build: model || 'claude-opus-4-8', converse: model || 'claude-sonnet-4-6' };
    this.mode = (mode === 'build' || mode === 'converse') ? mode : 'converse';
    this.model = this.models[this.mode] || model || 'claude-sonnet-4-6';
    this.world = world;
    this.nav = nav;
    this.onSay = onSay || (() => {});
    this.sketchfabToken = sketchfabToken || '';
    this.env = env || null;                              // { scene, camera, THREE, hope } for run_script
    this.allowScripting = allowScripting !== false;     // live frontend scripting (on by default)
    this.guideUrl = guideUrl || new URL('./agent-guide.md', import.meta.url).href;
    this._guide = undefined;                             // cached design-knowledge doc
    this.busy = false;
  }

  /** Switch capability tier: 'build' (max) or 'converse' (design pal). Returns the active mode. */
  setMode(mode) {
    if (mode !== 'build' && mode !== 'converse') return this.mode;
    this.mode = mode; this.model = this.models[mode];
    return this.mode;
  }

  /** Fetch the design-knowledge doc once (falls back to an embedded summary). */
  async _loadGuide() {
    if (this._guide !== undefined) return this._guide;
    this._guide = '';
    try { const r = await fetch(this.guideUrl); if (r.ok) this._guide = (await r.text()).trim(); } catch { /* file:// or offline */ }
    if (!this._guide) this._guide = FALLBACK_GUIDE;
    return this._guide;
  }

  _system(guide) {
    const s = this.world.getSceneState();
    return [
      this.mode === 'build'
        ? "You are operating as the BUILD AGENT for hopeOS — the user is in the construction/template environment and you run at MAXIMUM capability to construct worlds, scenes and games. Be ambitious, decisive and thorough; take initiative and build complete, polished, playable results — no hold back. You converse too, but your default is to MAKE."
        : "You are operating as the conversation & design companion for hopeOS — warm, concise and helpful. Brainstorm, advise and make light edits; for heavy construction, suggest the user switch to the build agent.",
      "You are the in-world AI co-creator for hopeOS, a browser-native 3D world. You are a designer and builder partner: you CONVERSE (brainstorm, pitch options, explain choices) AND you ACT on the live scene through tools. When the user is just talking, talk back and propose ideas; when they ask for something concrete, do it and narrate briefly.",
      "You can move/aim the user (navigate, look, turn, walk) and fully edit the creator layer: create primitives, set absolute transforms, translate/rotate/scale/recolor/duplicate/delete, mark a wall/floor/region, and IMPORT real 3D models (import_sketchfab by query, or import_glb_url for a direct .glb/Meshy link) straight onto the marked selection — already collidable and lit. You can also run_script for custom live changes no other tool covers (animation, custom interactions, materials/lights).",
      "Everything you add is live and physics-ready immediately; there is no build/compile step. Objects are real touchable surfaces (hands and the avatar collide with their meshes).",
      "The user can draw on a neon 3D GRID CANVAS — marking dots, a trajectory path, a flat surface, or a 3D volume. Their current pick is in LIVE STATE as `gridSelection` (exact world coordinates). Treat it as 'here / along this / in this region': place or move objects to those coordinates, animate along the path, or fill the surface/volume. When they say 'put it here' / 'move it along this' / 'fill this', read gridSelection.",
      "You also direct the ENVIRONMENT like a game engine: set_time_of_day (realistic sun arc + recast shadows), set_sun (aim azimuth/elevation), set_atmosphere (sky/fog/exposure), set_shadows (quality), set_weather (clear/cloudy/foggy/storm). For anything bespoke — animation, custom lights, shaders, materials, gameplay — use run_script (you get world/scene/camera/THREE/hope/nav; hope.onFrame(cb) animates per frame). Prefer the named tools when they fit; reach for run_script for the rest.",
      "SPATIAL AWARENESS: scene.boundsMin/boundsMax/center/size (metres, Y up) describe the whole set, and objects[] gives every item's position/scale/label. Use them to place lights, sun, weather and objects SITUATIONALLY — a lamp tucked in a corner near a wall, the sun angled to rake light across the room, an object on the floor (groundY) not floating, spaced with good interior- and game-design sense (focal point, walkable lanes, human scale). Read the scene before placing; don't guess coordinates blindly.",
      "THE ENVIRONMENT vs OBJECTS: the base scene GLB IS the world/environment — the building, room, landscape or 'whole place' the user walks inside (its extent = scene.size/bounds). It is a FIXED BACKDROP by default — NOT a clickable/selectable game object, so the user can't accidentally grab the whole world. Only when the user EXPLICITLY asks to 'make the world/scene a game object' (or make the whole environment movable/editable) do you call make_scene_editable(editable:true) — then it can be click-selected and transformed. To move/scale/rotate the environment on request use transform_scene (scaleFactor 2 = double the world); that also promotes it. The separate placed items in objects[] are individual props — use the per-object tools for those. Don't confuse the two.",
      "BRING-ME-TO: navigate_to teleports the avatar's POV straight to a landmark, an object by its label ('the cat', 'tree'), or x/z coordinates — it passes THROUGH walls and lands them standing on the floor there. (Walking with keys/hands still collides normally; only this is a direct jump.)",
      "Every object has a short recall NAME (label) — imports are named after what was searched (e.g. 'dragon'). Act on an object by passing its label instead of its id (e.g. scale_object {label:'dragon', factor:2}); use select_in_view for 'this/that', or get_scene to read all labels. rename_object gives something a friendlier name.",
      "Chain multiple tool calls for multi-step requests (create → position → colour). Keep spoken text short and natural — the user hears it.",
      "When asked for an object that fits a vibe, turn it into a specific Sketchfab query (material+object+style), import the best match, name it, and place it well. Offer an alternative if it feels off.",
      (this.mode === 'build' ? "── BUILD PLAYBOOK ──\n" + BUILD_KNOWLEDGE + "\n\n" : "") + "── DESIGN GUIDE ──\n" + (guide || FALLBACK_GUIDE),
      "── LIVE SCENE STATE ──\n" + JSON.stringify(s),
    ].join('\n\n');
  }

  async _exec(name, input = {}) {
    const w = this.world, nav = this.nav;
    // Resolve a target object id from an explicit id OR a spoken label ("the dragon").
    // Falls back to undefined so the world's "most-recent" default still applies.
    const rid = (inp) => inp.id || (inp.label ? (w.findByLabel(inp.label) || undefined) : undefined);
    try {
      switch (name) {
        case 'get_scene':       return JSON.stringify(w.getSceneState());
        case 'select_in_view':  return w.selectInView() || 'nothing in view';
        case 'mark_surface_in_view': { const s = w.markSurfaceInView(input.size || 2); return s ? JSON.stringify(s) : 'no surface in view'; }
        case 'mark_region':     { const s = w.markRegion(input.x, input.y, input.z, input.size || 2); return s ? JSON.stringify(s) : 'failed'; }
        case 'set_selection_shape': { const s = w.setSelectionShape(input.kind, input.size || 2); return s ? JSON.stringify(s) : 'failed'; }
        case 'get_selection':   { const s = w.getSelection(); return s ? JSON.stringify(s) : 'no active selection'; }
        case 'clear_selection': w.clearSelection(); return 'cleared';
        case 'place_in_selection': {
          const color = input.color ? parseInt(input.color.replace('#', ''), 16) : undefined;
          const id = w.placeInSelection(input.type, { color, scale: input.scale, u: input.u, v: input.v });
          return id ? `placed ${input.type} → ${id}` : 'no active selection';
        }
        case 'fill_selection': {
          const color = input.color ? parseInt(input.color.replace('#', ''), 16) : undefined;
          const ids = w.fillSelection(input.type, input.rows, input.cols, { color, scale: input.scale });
          return ids.length ? `filled with ${ids.length} ${input.type}s` : 'no active selection';
        }
        case 'import_glb_url': { const id = await w.importGLBFromURL(input.url, { label: input.label }); return `imported → ${id}`; }
        case 'import_sketchfab': {
          const hits = await searchModels(input.query, this.sketchfabToken, 12);
          if (!hits.length) return 'no downloadable models found';
          const url = await resolveGLB(hits[0].uid, this.sketchfabToken);
          const id = await w.importGLBFromURL(url, { label: input.query });
          return `imported "${input.query}" → ${id} (call it "${input.query}")`;
        }
        case 'fill_selection_with_import': {
          const ids = w.fillSelectionWithImport(input.rows, input.cols, { scale: input.scale });
          return ids.length ? `placed ${ids.length} miniatures` : 'import a model and mark a region first';
        }
        case 'navigate_to': {
          let { target, x, z } = input;
          if (typeof x !== 'number' || typeof z !== 'number') {
            const lm = target && w.getLandmarks()[target];
            if (lm) { x = lm.x; z = lm.z; }
            else if (target) { const id = w.findByLabel(target); const a = id && w._find(id); if (a) { x = a.mesh.position.x; z = a.mesh.position.z; } }
          }
          if (typeof x === 'number' && typeof z === 'number') { w.teleportNear(x, z); return `brought you to ${target || `(${x.toFixed(1)}, ${z.toFixed(1)})`}`; }
          return 'no such place — give a landmark, an object name, or x/z coordinates';
        }
        case 'look':
          if (input.direction === 'up') nav.faceUp(input.degrees ?? 35);
          else if (input.direction === 'down') nav.faceDown(input.degrees ?? 35);
          else nav.faceLevel();
          return `looking ${input.direction}`;
        case 'turn':     nav.turnBy(input.degrees || 0); return `turned ${input.degrees}°`;
        case 'set_walk': input.state === 'go' ? nav.go() : nav.stop(); return input.state === 'go' ? 'walking' : 'stopped';
        case 'create_object': {
          const color = input.color ? parseInt(input.color.replace('#', ''), 16) : undefined;
          const id = w.addObject(input.type, { color, scale: input.scale, position: input.position });
          return `created ${input.type} → ${id}`;
        }
        case 'set_transform':    return w.setObjectTransform(rid(input), input) ? 'transformed' : 'no object';
        case 'translate_object': return w.moveObject(rid(input), input.dx || 0, input.dy || 0, input.dz || 0) ? 'moved' : 'no object';
        case 'rotate_object':    return w.rotateObject(rid(input), input.degrees || 0) ? 'rotated' : 'no object';
        case 'scale_object':     return w.scaleObject(rid(input), input.factor) ? 'scaled' : 'no object';
        case 'set_color':        return w.setObjectColor(rid(input), input.color) ? 'recolored' : 'no object';
        case 'rename_object':    { const l = w.nameObject(input.id || (input.target ? w.findByLabel(input.target) : undefined), input.label); return l ? `renamed → "${l}"` : 'no object'; }
        case 'duplicate_object': { const nid = w.duplicateObject(rid(input)); return nid ? `duplicated → ${nid}` : 'no object'; }
        case 'delete_object':    return w.deleteObject(rid(input)) ? 'deleted' : 'no object';
        case 'set_time_of_day':  w.setTimeOfDay(input.hour); return `time set to ${(((input.hour % 24) + 24) % 24).toFixed(1)}h — sun + shadows recast`;
        case 'set_sun':          w.setSunAzEl(input.azimuth, input.elevation); return `sun → az ${input.azimuth}°, el ${input.elevation}°`;
        case 'set_atmosphere':   w.setAtmosphere(input); return 'atmosphere updated';
        case 'set_shadows':      w.setShadows(input); return 'shadows updated';
        case 'set_weather':      w.setWeather(input.kind); return `weather: ${input.kind}`;
        case 'make_scene_editable': w.sceneIsObject = !!input.editable; return input.editable ? 'the world is now a game object — click it or transform it' : 'the world is a fixed backdrop again';
        case 'transform_scene':  { w.sceneIsObject = true; return w.setSceneTransform({ scaleFactor: input.scaleFactor, rotationDeg: input.rotationDegY != null ? { y: input.rotationDegY } : undefined, position: input.position }) ? 'transformed the whole environment' : 'no scene model loaded'; }
        case 'run_script': {
          // Live frontend edit hatch. Runs in the user's own browser/session against
          // the live scene — the in-world equivalent of an engine script console.
          if (!this.allowScripting) return 'scripting is disabled';
          if (!this.env) return 'no scene environment wired for scripting';
          const { scene, camera, THREE, hope } = this.env;
          try {
            const fn = new Function('world', 'scene', 'camera', 'THREE', 'hope', 'nav',
              `return (async () => { ${input.code}\n })();`);
            const r = await fn(w, scene, camera, THREE, hope, nav);
            w.recordScript(input.code, input.explanation);   // persist so it saves + replays with the world
            return 'ran' + (input.explanation ? ` (${input.explanation})` : '') + (r !== undefined ? `: ${String(r).slice(0, 200)}` : '');
          } catch (e) { return 'script error: ' + e.message; }
        }
        default: return `unknown tool ${name}`;
      }
    } catch (e) { return `error: ${e.message}`; }
  }

  /** Run one natural-language command. Loops through Claude tool calls. */
  async command(text) {
    if (!text || !text.trim()) return;
    if (this.busy) return;
    this.busy = true;
    const guide = await this._loadGuide();
    const messages = [{ role: 'user', content: text }];
    try {
      for (let turn = 0; turn < 6; turn++) {
        const res = await fetch(this.endpoint, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ model: this.model, max_tokens: 1024, system: this._system(guide), tools: TOOLS, messages }),
        });
        const data = await res.json();
        if (data.error) { this.onSay('AI error: ' + data.error.message); break; }
        const content = data.content || [];
        const says = content.filter(b => b.type === 'text').map(b => b.text).join(' ').trim();
        if (says) this.onSay(says);
        const toolUses = content.filter(b => b.type === 'tool_use');
        if (!toolUses.length) break;                       // done
        messages.push({ role: 'assistant', content });
        const results = await Promise.all(toolUses.map(async tu => ({
          type: 'tool_result', tool_use_id: tu.id, content: String(await this._exec(tu.name, tu.input)),
        })));
        messages.push({ role: 'user', content: results });
      }
    } catch (e) {
      this.onSay('AI request failed: ' + e.message);
    } finally {
      this.busy = false;
    }
  }
}
