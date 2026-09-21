/**
 * pack-gen.js — synthetic 21-point hand packs for headless doctrine tests, bots and probes (Node + browser, plain
 * `{x,y,z}` objects, no three import). The three shapes are the tests/_glassprobe.mjs:36-58 generators verbatim: what
 * matters is a NON-degenerate palm block (wrist 0, index MCP 5, middle MCP 9, pinky MCP 17, thumb 1-4) so
 * prop-ball.js palmPose / closure read a real normal and a real curl, in tile WORLD metres (hand plane z = -D).
 *
 * `packToHands` is the inverse of HandViews.mirrorPoint (hand-views.js:241-256) at the hand plane: it turns a world
 * pack into the `{img, world}` slot the wire encoder (sdk/net/hand-stream.js) takes, so a bot's packs travel exactly
 * like a tracked person's and the remote tile's HandViews.resolve reproduces the same world pack (measured chirality
 * included — nothing here flips, relabels or filters).
 */

const V = (x, y, z) => ({ x, y, z });
const mk = base => new Array(21).fill(0).map(() => V(base.x, base.y, base.z));

export const PackGen = {
  /** closure ~0 (fingers extended, in the screen plane) — _glassprobe.mjs:36-42 */
  open(x, y, z) {
    const p = mk(V(x, y, z));
    p[0] = V(x, y - 0.05, z); p[9] = V(x, y + 0.05, z);
    p[5] = V(x + 0.035, y + 0.04, z); p[17] = V(x - 0.035, y + 0.04, z);
    for (const i of [8, 12, 16, 20]) p[i] = V(x, y + 0.16, z);
    p[4] = V(x + 0.1, y, z);
    return p;
  },
  /** fingers curling to wrap (closure ~0.5) — _glassprobe.mjs:43-49 */
  cup(x, y, z) {
    const p = mk(V(x, y, z));
    p[0] = V(x, y - 0.05, z); p[9] = V(x, y + 0.05, z);
    p[5] = V(x + 0.035, y + 0.04, z); p[17] = V(x - 0.035, y + 0.04, z);
    for (const i of [8, 12, 16, 20]) p[i] = V(x, y + 0.075, z + 0.06);
    p[4] = V(x + 0.07, y, z + 0.02);
    return p;
  },
  /** palm-up hand lying in the x/z plane (a shelf); k = workspace hand scale — _glassprobe.mjs:50-58 */
  flat(x, y, z, k = 2.2) {
    const p = mk(V(x, y, z));
    const xs = [-0.045, -0.02, 0.005, 0.03];                   // index…pinky columns across x
    const P = (dx, dz) => V(x + dx * k, y, z + dz * k);
    p[0] = P(0, 0.06);
    p[1] = P(-0.04, 0.04); p[2] = P(-0.07, 0.02); p[3] = P(-0.09, 0); p[4] = P(-0.105, -0.02);
    [[5, 6, 7, 8], [9, 10, 11, 12], [13, 14, 15, 16], [17, 18, 19, 20]].forEach((f, q) => {
      p[f[0]] = P(xs[q], -0.02); p[f[1]] = P(xs[q], -0.055); p[f[2]] = P(xs[q], -0.085); p[f[3]] = P(xs[q], -0.11);
    });
    return p;
  },
  /** translated copy */
  shift(pack, dx, dy, dz) { return pack.map(p => V(p.x + dx, p.y + dy, p.z + dz)); },
  /** per-point linear blend */
  lerp(a, b, t) { return a.map((p, i) => V(p.x + (b[i].x - p.x) * t, p.y + (b[i].y - p.y) * t, p.z + (b[i].z - p.z) * t)); },
  /**
   * A throw: `frames` cup packs starting at `from`, moving along `dir` (normalised here) at `speedMps`, `dt` s apart;
   * the LAST frame is an `open` hand at the final position (open hand = release, prop doctrine).
   */
  throwSeq(from, dir, speedMps, frames, dt) {
    const l = Math.hypot(dir.x, dir.y, dir.z) || 1;
    const vx = dir.x / l * speedMps, vy = dir.y / l * speedMps, vz = dir.z / l * speedMps;
    const seq = [];
    for (let i = 0; i < frames; i++) {
      const t = i * dt, x = from.x + vx * t, y = from.y + vy * t, z = from.z + vz * t;
      seq.push(i === frames - 1 ? PackGen.open(x, y, z) : PackGen.cup(x, y, z));
    }
    return seq;
  },
};

// ── world pack → wire slot (inverse of HandViews.mirrorPoint) ──────────────────────────────────────────────────
const _m = { x: 0, y: 0, z: 0 };
function toCam(p, e, o) {                                    // camera.matrixWorldInverse (column-major, w = 1)
  const x = p.x, y = p.y, z = p.z;
  o.x = e[0] * x + e[4] * y + e[8] * z + e[12];
  o.y = e[1] * x + e[5] * y + e[9] * z + e[13];
  o.z = e[2] * x + e[6] * y + e[10] * z + e[14];
  return o;
}

/**
 * World pack → `{img, world}` for `encodeHandStream` (hand-stream.js:83). Exact inverse of mirrorPoint with cover 1:
 * camera-space `depth = -z`, `s = depth / mirrorDist`, `u = 0.5 + x/(sW·s)`, `v = 0.5 - y/(sH·s)`,
 * `z_img = (depth - mirrorDist)/(sW·mirrorDepth)` (0 for a pack ON the hand plane); `world` = the pack itself.
 * @param {Array<{x,y,z}>} pack        21 points, tile world metres
 * @param {object} camera              the tile's uv camera (fov, aspect, matrixWorldInverse.elements) — makeUvCamera
 * @param {{slot?:'left'|'right', mirrorDist?:number, mirrorDepth?:number}} o
 * @returns {{left:{img,world}|null, right:{img,world}|null}}
 */
export function packToHands(pack, camera, { slot = 'right', mirrorDist = 2.0, mirrorDepth = 1.0 } = {}) {
  const d = mirrorDist;
  const halfH = Math.tan(camera.fov * 0.5 * Math.PI / 180) * d;
  const sH = halfH * 2, sW = sH * camera.aspect;
  const e = camera.matrixWorldInverse.elements;
  const img = new Array(21), world = new Array(21);
  for (let i = 0; i < 21; i++) {
    const c = toCam(pack[i], e, _m);
    const depth = -c.z, s = (depth / d) || 1;
    img[i] = V(0.5 + c.x / (sW * s), 0.5 - c.y / (sH * s), (depth - d) / (sW * mirrorDepth));
    world[i] = V(pack[i].x, pack[i].y, pack[i].z);
  }
  const out = { left: null, right: null };
  out[slot === 'left' ? 'left' : 'right'] = { img, world };
  return out;
}

/** The fixture set every headless test shares (tests/fixtures/hand-packs.json). */
export function makeFixtures() {
  const D = 2.0;
  const open = PackGen.open(0, 0, -D), cup = PackGen.cup(0, 0, -D), flat = PackGen.flat(0, -0.2, -D);
  const wave = [];                                            // 60 frames: an open hand sweeping x = ±0.35 m, one full cycle
  for (let i = 0; i < 60; i++) { const a = i / 60 * Math.PI * 2; wave.push(PackGen.open(Math.sin(a) * 0.35, Math.cos(a) * 0.05, -D)); }
  const throwRight = PackGen.throwSeq({ x: -0.3, y: -0.05, z: -D }, { x: 1, y: 0.3, z: 0 }, 2.0, 20, 1 / 60);   // 20 frames
  return { open, cup, flat, wave, throwRight };
}

/** Node only: write the fixture set as JSON (async — node:fs is imported on demand so the module stays browser-safe). */
export async function writeFixtures(path) {
  const [fs, { dirname }] = await Promise.all([import('node:fs'), import('node:path')]);
  const fx = makeFixtures();
  fs.mkdirSync(dirname(path), { recursive: true });
  fs.writeFileSync(path, JSON.stringify(fx));
  return fx;
}
