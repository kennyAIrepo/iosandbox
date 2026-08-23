/**
 * hopeOS SDK — Skeleton Align (body contract stage 2→3 machinery)
 * ═══════════════════════════════════════════════════════════════
 * The BODY sibling of PuppetStage._extract/_align (sdk/lab/puppet-stage.js):
 * given ANY rigged model's skeleton, detect its rig landmarks and assign
 * the body-contract channels to them — so the human→puppet translation
 * binds seamlessly on load, and accurately (every guess is reported with
 * its evidence, overridable, and freezable into the contract handshake).
 *
 * Faces align by NAME rules alone (morph naming is standardized-ish).
 * Body rigs are named chaotically (b_LeftUpperArm / mixamorigLeftArm /
 * Thigh.L / bone_007) — but bodies have STRUCTURE faces don't:
 *
 *   · four limb chains hang symmetrically off a spine
 *   · limb bases mirror across ONE lateral axis        → left/right
 *   · limb bases spread along the body axis (quadruped)
 *     or stack vertically (biped)                      → front/hind
 *   · midline chains run forward (neck→head) and
 *     backward (tail) from the spine                   → head/tail
 *
 * So classification is STRUCTURE-FIRST (tier S), then names corroborate
 * or veto (tier N — names win for left/right, since anatomical naming is
 * authored truth; structure wins for front/hind, since quadruped rigs
 * name their front legs "Arm"). Each role reports its evidence:
 * 'name+structure' (both agree) > 'structure' > 'name'. Conflicts are
 * surfaced, never silently resolved.
 *
 * PURE MODULE: works on a plain bone graph [{name, parent, pos:[x,y,z]}]
 * — no three.js import, so it runs in node smoke tests against real
 * extracted skeletons (tests/skeleton-smoke.mjs, fox fixture). The
 * three.js adapter lives in quadruped.js (graphFromThree).
 *
 * Anatomical frame: with up=+Y (glTF/three world) and the body facing
 * `forward`, anatomical LEFT = up × forward (right-handed) — verified
 * against the Khronos Fox's authored Left/Right bone names.
 */

const AX = { x: 0, y: 1, z: 2 };

// name evidence (tier N)
const RX_LEFT = /left|(^|[_.\-])l([_.\-]|$)|\.l$|_l\d*$/i;
const RX_RIGHT = /right|(^|[_.\-])r([_.\-]|$)|\.r$|_r\d*$/i;
const RX_FRONT = /front|fore|arm|hand|clavicle|shoulder|wrist|paw_?f/i;
const RX_HIND = /hind|rear|back_?leg|leg|thigh|calf|shin|foot|ankle|paw_?b/i;
const RX_HEAD = /head|skull/i;
const RX_NECK = /neck/i;
const RX_TAIL = /tail/i;
const RX_SPINE = /spine|chest|torso|body/i;
const RX_ROOT = /root|hips?|pelvis|cog|armature/i;

const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const mean = arr => arr.reduce((s, v) => s + v, 0) / (arr.length || 1);

/**
 * Classify a skeleton graph into quadruped body roles.
 * @param {Array<{name, parent, pos:[x,y,z]}>} graph  rest-pose WORLD positions
 * @param {Object} opts  { up:'y', forwardHint:[x,y,z]|null }
 * @returns {{ stance, axes, roles, evidence, conflicts, unassigned }}
 */
export function classifySkeleton(graph, opts = {}) {
  const up = AX[opts.up || 'y'];
  const byName = new Map(graph.map(n => [n.name, n]));
  const children = new Map(graph.map(n => [n.name, []]));
  for (const n of graph) if (n.parent && children.has(n.parent)) children.get(n.parent).push(n.name);

  const conflicts = [], evidence = {};

  // ── SEGMENTS: maximal single-child paths between branch points. Leaf-walk
  // chains break on real humanoids (finger chains look like limbs; the arm
  // itself never ends at a leaf because the hand branches into fingers).
  const chains = [];
  for (const n of graph) {
    const p = n.parent && byName.get(n.parent);
    const startsSegment = !p || children.get(p.name).length > 1;
    if (!startsSegment) continue;
    const seg = [n.name];
    let cur = n;
    while (children.get(cur.name).length === 1) {
      cur = byName.get(children.get(cur.name)[0]);
      seg.push(cur.name);
    }
    chains.push({ bones: seg, branch: n.parent || null });
  }

  // ── lateral axis: the non-up axis where segment bases best mirror in ± pairs ──
  const bases = chains.map(c => byName.get(c.bones[0]).pos);
  const latCandidates = [0, 1, 2].filter(a => a !== up);
  let lateral = latCandidates[0], bestScore = -1;
  for (const a of latCandidates) {
    const offs = bases.map(p => p[a]).filter(v => Math.abs(v) > 1e-4);
    let paired = 0;
    for (const v of offs) {
      if (offs.some(w => Math.abs(w + v) < Math.abs(v) * 0.25)) paired++;
    }
    const score = offs.length ? paired / offs.length : 0;
    if (score > bestScore) { bestScore = score; lateral = a; }
  }
  const forward = [0, 1, 2].find(a => a !== up && a !== lateral);

  // ── midline test: bones sit at ~zero lateral offset in authored rigs.
  // eps is absolute (2% of bone-cloud diagonal), NOT relative to max lateral
  // — T-pose hands would otherwise drag the threshold past the shoulders.
  const lo = [0, 1, 2].map(a => Math.min(...graph.map(n => n.pos[a])));
  const hi = [0, 1, 2].map(a => Math.max(...graph.map(n => n.pos[a])));
  const diag = Math.hypot(hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2]) || 1;
  const eps = diag * 0.02;
  const onMid = name => Math.abs(byName.get(name).pos[lateral]) <= eps;

  // limb = off-midline segment of len ≥ 2 whose PARENT is on the midline
  // trunk (fingers hang off the hand — excluded; eyes are len-1 — excluded)
  const limbs = [], midline = [];
  for (const c of chains) {
    if (onMid(c.bones[0])) { midline.push(c); continue; }
    if (c.bones.length >= 2 && c.branch && onMid(c.branch)) limbs.push(c);
  }

  // ── stance: quadruped if limb bases spread along forward; biped if they stack ──
  const fVals = limbs.map(c => byName.get(c.bones[0]).pos[forward]);
  const uVals = limbs.map(c => byName.get(c.bones[0]).pos[up]);
  const fSpread = fVals.length ? Math.max(...fVals) - Math.min(...fVals) : 0;
  const uSpread = uVals.length ? Math.max(...uVals) - Math.min(...uVals) : 0;
  const stance = fSpread >= uSpread ? 'quadruped' : 'biped';
  const frontAxis = stance === 'quadruped' ? forward : up;
  const frontMid = mean(limbs.map(c => byName.get(c.bones[0]).pos[frontAxis]));

  // ── forward SIGN: head-side midline chain extends opposite the tail.
  // Prefer name evidence (head/tail), fall back to "necks go up, tails go down".
  let fSign = 0;
  for (const c of midline) {
    const base = byName.get(c.bones[0]).pos, tip = byName.get(c.bones.at(-1)).pos;
    const d = sub(tip, base);
    const isHeadName = c.bones.some(b => RX_HEAD.test(b) || RX_NECK.test(b));
    const isTailName = c.bones.some(b => RX_TAIL.test(b));
    if (isHeadName) fSign += Math.sign(d[forward]);
    else if (isTailName) fSign -= Math.sign(d[forward]);
    else fSign += Math.sign(d[forward]) * (d[up] >= 0 ? 0.5 : -0.5);
  }
  fSign = fSign >= 0 ? 1 : -1;
  if (opts.forwardHint) {
    const hinted = Math.sign(opts.forwardHint[forward]) || fSign;
    if (hinted !== fSign) conflicts.push({ role: 'forward', note: 'forwardHint disagrees with head/tail evidence; using hint' });
    fSign = hinted;
  }

  // anatomical left = up × forward (right-handed), verified on Khronos Fox
  const leftSign = ((up === 1 && forward === 2) || (up === 2 && forward === 0) || (up === 0 && forward === 1))
    ? fSign : -fSign;

  // ── label limbs: structure first, names corroborate/veto ──
  const roles = { root: null, spine: [], neck: [], head: null, tail: [],
                  frontL: [], frontR: [], hindL: [], hindR: [] };
  for (const c of limbs) {
    const base = byName.get(c.bones[0]).pos;
    const structFront = (base[frontAxis] - frontMid) * (stance === 'quadruped' ? fSign : 1) >= 0;
    const structLeft = Math.sign(base[lateral]) === Math.sign(leftSign);
    const joined = c.bones.join(' ');
    const nameLeft = RX_LEFT.test(joined) ? true : RX_RIGHT.test(joined) ? false : null;
    const nameFront = RX_FRONT.test(joined) ? true : RX_HIND.test(joined) ? false : null;

    let isLeft = structLeft, sideVia = 'structure';
    if (nameLeft !== null) {
      if (nameLeft !== structLeft) conflicts.push({ role: 'limb-side', bones: c.bones,
        note: `name says ${nameLeft ? 'L' : 'R'}, structure says ${structLeft ? 'L' : 'R'} — name wins` });
      isLeft = nameLeft; sideVia = nameLeft === structLeft ? 'name+structure' : 'name';
    }
    let isFront = structFront, fbVia = 'structure';
    if (nameFront !== null) {
      if (nameFront !== structFront) conflicts.push({ role: 'limb-frontback', bones: c.bones,
        note: `name suggests ${nameFront ? 'front' : 'hind'}, structure says ${structFront ? 'front' : 'hind'} — structure wins` });
      else fbVia = 'name+structure';
    }
    const role = (isFront ? 'front' : 'hind') + (isLeft ? 'L' : 'R');
    if (roles[role].length) conflicts.push({ role, note: 'multiple chains matched; keeping longer', bones: c.bones });
    if (!roles[role].length || c.bones.length > roles[role].length) roles[role] = c.bones;
    evidence[role] = fbVia === sideVia ? fbVia : 'structure';
  }

  // ── midline chains → neck/head vs tail ──
  // Trunk segments (they contain a limb branch point) are spine territory —
  // resolved by the branch-to-branch path walk below, never head/tail.
  const branchNodes = new Set(limbs.map(c => c.branch));
  for (const c of midline) {
    if (c.bones.some(b => branchNodes.has(b))) continue;
    if (c.bones.length < 2 && !RX_HEAD.test(c.bones[0]) && !RX_TAIL.test(c.bones[0])) continue;
    const base = byName.get(c.bones[0]).pos, tip = byName.get(c.bones.at(-1)).pos;
    const dirF = Math.sign(tip[forward] - base[forward]) * fSign;
    const joined = c.bones.join(' ');
    const isHead = RX_HEAD.test(joined) || RX_NECK.test(joined) || (dirF > 0);
    const isTail = RX_TAIL.test(joined) || (!isHead && dirF < 0);
    if (isHead && !RX_TAIL.test(joined)) {
      if (roles.head && evidence.head === 'name+structure' && !RX_HEAD.test(joined)) continue;
      roles.head = c.bones.at(-1);
      roles.neck = c.bones.slice(0, -1).length ? c.bones.slice(0, -1) : [c.bones[0]];
      evidence.head = (RX_HEAD.test(joined) ? 'name+structure' : 'structure');
    } else if (isTail) {
      if (roles.tail.length && evidence.tail === 'name+structure' && !RX_TAIL.test(joined)) continue;
      roles.tail = c.bones;
      evidence.tail = (RX_TAIL.test(joined) ? 'name+structure' : 'structure');
    }
  }

  // ── spine: path from the hind-branch node up to the front-branch node ──
  const frontBranch = roles.frontL[0] ? byName.get(roles.frontL[0]).parent : null;
  const hindBranch = roles.hindL[0] ? byName.get(roles.hindL[0]).parent : null;
  if (frontBranch && hindBranch && frontBranch !== hindBranch) {
    const path = [];
    let cur = byName.get(frontBranch);
    while (cur && cur.name !== hindBranch) { path.unshift(cur.name); cur = byName.get(cur.parent); }
    if (cur) { roles.spine = path; evidence.spine = 'structure'; }
  }
  if (!roles.spine.length) {
    roles.spine = graph.filter(n => RX_SPINE.test(n.name)).map(n => n.name);
    if (roles.spine.length) evidence.spine = 'name';
  }
  // hip = the hind branch node itself; root = nearest root-named ancestor
  // that is not the topmost scene wrapper (wrappers like _rootJoint sit at
  // origin with no parent — walking into them loses the usable rig root)
  roles.hip = hindBranch ?? null;
  let rootCand = hindBranch ? byName.get(hindBranch) : null;
  while (rootCand?.parent && RX_ROOT.test(rootCand.parent)
         && byName.get(rootCand.parent)?.parent) {
    rootCand = byName.get(rootCand.parent);
  }
  roles.root = (rootCand && rootCand.name !== hindBranch ? rootCand.name : null)
    ?? rootCand?.name ?? graph.find(n => RX_ROOT.test(n.name))?.name ?? null;
  evidence.root = evidence.hip = 'structure';

  const assigned = new Set([roles.root, roles.head,
    ...roles.spine, ...roles.neck, ...roles.tail,
    ...roles.frontL, ...roles.frontR, ...roles.hindL, ...roles.hindR].filter(Boolean));
  const axes = { up: 'xyz'[up], forward: 'xyz'[forward], forwardSign: fSign,
                 lateral: 'xyz'[lateral], leftSign };
  return { stance, axes, roles, evidence, conflicts,
           unassigned: graph.map(n => n.name).filter(n => !assigned.has(n)) };
}

/**
 * Build a classification graph from a loaded three.js hierarchy (rest pose).
 * Reads matrixWorld elements directly — no three import, module stays pure.
 * Call BEFORE any animation/mixer has posed the skeleton.
 */
export function graphFromScene(root) {
  root.updateMatrixWorld(true);
  const out = [];
  (function walk(o, parentBone) {
    const isBone = !!o.isBone;
    if (isBone) {
      const e = o.matrixWorld.elements;
      out.push({ name: o.name, parent: parentBone, pos: [e[12], e[13], e[14]] });
    }
    for (const c of o.children || []) walk(c, isBone ? o.name : parentBone);
  })(root, null);
  return out;
}

/** channel id → which classified role/bone drives it (contract stage 3) */
export const BODY_CHANNEL_RULES = [
  { id: 'limb.armL.raise', role: 'frontL', index: 0 },
  { id: 'limb.armR.raise', role: 'frontR', index: 0 },
  { id: 'limb.legL.raise', role: 'hindL', index: 0 },
  { id: 'limb.legR.raise', role: 'hindR', index: 0 },
  { id: 'body.crouch', role: 'spine', index: 0 },
  { id: 'head.rot', role: 'neck', index: 0 }
];

/**
 * Merge a classification into a body contract:
 *  · authored contract.puppet.joints entries WIN (they are the frozen
 *    handshake); detection fills gaps and VERIFIES the authored map
 *  · returns per-channel matches {bone, via, agree} for panels/handshake —
 *    same shape idea as PuppetStage.alignment()
 */
export function alignBodyContract(contract, cls) {
  const authored = contract.puppet.joints || {};
  const joints = {};
  const verify = {};
  for (const role of Object.keys(cls.roles)) {
    const det = cls.roles[role];
    const auth = authored[role.replace(/^(frontL|frontR|hindL|hindR|neck|head|tail|spine|root)$/, m => m)];
    const detEmpty = det == null || (Array.isArray(det) && !det.length);
    joints[role] = auth ?? (detEmpty ? null : det);
    if (auth != null && !detEmpty) {
      const a = JSON.stringify(auth), d = JSON.stringify(det);
      verify[role] = { agree: a === d || a.includes(Array.isArray(det) ? det[0] : det), detected: det };
    } else if (auth == null && !detEmpty) {
      verify[role] = { agree: null, detected: det, note: 'detection-only' };
    }
  }
  const matches = {};
  for (const rule of BODY_CHANNEL_RULES) {
    const chain = joints[rule.role];
    const bone = Array.isArray(chain) ? chain[rule.index] ?? null : chain;
    matches[rule.id] = {
      bone,
      via: authored[rule.role] != null ? 'contract' : (cls.evidence[rule.role] || 'structure'),
      agree: verify[rule.role]?.agree ?? null
    };
  }
  return { joints, matches, verify, conflicts: cls.conflicts, stance: cls.stance, axes: cls.axes };
}
