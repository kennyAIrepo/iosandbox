/**
 * hopeOS SDK — Multiplayer Tracking (public orchestrator)
 * ═══════════════════════════════════════════════════════════════
 * Multi-person hands + body + identity from ONE webcam, browser-only.
 * Deliberately parallel to initTracking() so a game swaps one init
 * call and one detect() shape.
 *
 *   const mt = await initMultiplayerTracking(video, { maxPlayers: 4 });
 *   const frame = mt.detect(performance.now());
 *   // frame = { mode:'A'|'B', count, players:[ PlayerFrame ] }
 *
 * PlayerFrame = {
 *   id, bbox, body2D, wrists,          // MIRRORED display space
 *   hands: { left, right },            // each {img: 21 mirrored, world: 21 raw metric} | null
 *   bodyImg, bodyWorld                 // Mode B only (33-pt), else null
 * }
 *
 * ARCHITECTURE:
 *   • MoveNet MultiPose runs on an async background pump (multipose.js)
 *     — the base that finds players + hands out stable ids.
 *   • PlayerTracker turns that into calm crop boxes + the A/B decision.
 *   • A WARM POOL of PlayerPipelines (one busy per player) runs the
 *     per-crop MediaPipe. Pipelines are never torn down on an A/B
 *     switch — Mode A just stops asking for pose (wantPose=false).
 *   • detect() is SYNC (MoveNet is cached; MediaPipe detectForVideo is
 *     synchronous) so it drops into an existing rAF loop unchanged.
 *
 * Adaptive policy (from MULTIPLAYER_PLAN):
 *   ≤2 players → Mode B (3D body + 3D hands)
 *   >2 players → Mode A (2D body, 3D hands) — sheds the pose pass for latency
 */

import { initMultiPose } from './multipose.js';
import { PlayerTracker } from './player-tracker.js';
import { PlayerPipeline } from './player-pipeline.js';

export async function initMultiplayerTracking(video, opts = {}) {
  const maxPlayers = opts.maxPlayers || 4;
  const prewarm = Math.min(opts.prewarm ?? 2, maxPlayers);
  const poseEvery = opts.poseEvery || 2;
  const roundRobin = opts.roundRobin ?? true;   // stagger hands when >2 players
  const pipeOpts = { withPose: true, cropPx: opts.cropPx || 512, predMs: opts.predMs ?? 0 };

  // MoveNet at 24Hz, not 30: crop boxes are EMA-smoothed anyway, and the saved
  // GPU time goes straight to MediaPipe (all three runtimes share one GPU).
  const mp = await initMultiPose({ maxDim: opts.maxDim || 256, fpsCap: opts.moveNetFps || 24 });
  const tracker = new PlayerTracker(opts.tracker || {});

  // ── warm pipeline pool ──────────────────────────────────────────
  const free = [];
  const busy = new Map();       // player id -> pipeline
  const lastOut = new Map();    // player id -> last {hands,bodyImg,bodyWorld} (round-robin reuse)
  let creating = false;

  // prewarmed pipes carry an EAGER pose model (they serve Mode B, ≤2 players);
  // growth pipes lazy-load pose — at >2 players Mode A never asks for it, and
  // skipping it keeps us clear of the browser's WebGL-context ceiling.
  async function makePipe(eager) { const p = new PlayerPipeline({ ...pipeOpts, eagerPose: !!eager }); await p.init(); return p; }
  for (let i = 0; i < prewarm; i++) free.push(await makePipe(true));

  function acquire(id) {
    let pipe = busy.get(id);
    if (pipe) return pipe;
    pipe = free.pop();
    if (pipe) { pipe.drop(); busy.set(id, pipe); return pipe; }
    // none warm — grow lazily (async); this player is body-only until it lands
    if (!creating && busy.size < maxPlayers) {
      creating = true;
      makePipe(false).then(p => { free.push(p); creating = false; }).catch(() => { creating = false; });
    }
    return null;
  }
  function release(id) {
    const pipe = busy.get(id);
    if (!pipe) return;
    busy.delete(id); lastOut.delete(id); pipe.drop();
    if (free.length < maxPlayers) free.push(pipe); else pipe.dispose();
  }

  const stats = { moveNet: 0, mediapipe: 0, total: 0, players: 0, mode: 'B', poseEvery };
  let frameCount = 0;
  let running = true;
  let forceMode = null;   // benchmark override: 'A' | 'B' | null (auto)
  let handsEnabled = true;   // skeleton-only mode: bodies for up to 6 people, zero MediaPipe

  // ── pose-cadence governor ────────────────────────────────────────
  // Hand latency is the product; body-3D is the luxury. When the frame
  // budget blows (multi-player Mode B), stretch the pose cadence instead
  // of letting hands drop to 9fps; relax it back when there's headroom.
  const budgetMs = opts.budgetMs || 45;
  let poseEveryDyn = poseEvery;
  let lastGov = 0;

  mp.start(video);

  function detect(now) {
    frameCount++;
    const t0 = performance.now();
    const poses = mp.latest();
    const size = mp.videoSize();
    const players = tracker.update(poses, now);
    const mode = forceMode || tracker.mode;
    const wantPose = mode === 'B';

    // reconcile pool with the active id set
    const activeIds = new Set(players.map(p => p.id));
    for (const id of [...busy.keys()]) if (!activeIds.has(id)) release(id);

    // ── SKELETON-ONLY FAST PATH: bodies + ids for EVERYONE MoveNet sees
    // (up to 6), no per-player pipelines at all — the lowest-latency mode.
    if (!handsEnabled) {
      const outS = [];
      for (const pl of players) {
        outS.push({ id: pl.id, bbox: pl.bbox, body2D: pl.body2D, wrists: pl.wrists,
                    hands: { left: null, right: null }, bodyImg: null, bodyWorld: null });
      }
      stats.moveNet = mp.lastCostMs();
      stats.mediapipe += (0 - stats.mediapipe) * 0.15;
      stats.total += ((performance.now() - t0) - stats.total) * 0.15;
      stats.players = players.length;
      stats.mode = mode;
      return { mode, count: players.length, players: outS };
    }

    const solo = players.length === 1;   // 1 player → full-frame path (old-stack fidelity)

    // ── ACTIVITY-BASED SCHEDULER (replaces blind round-robin) ──────────
    // Players with LIVE hands get detection every frame (≤2 live) or every
    // 2nd frame (3-4 live, staggered); players with no hands up get PROBED
    // every 4th frame — a raised hand is discovered within ~130ms. Skipped
    // frames are bridged by predictOnly() (velocity extrapolation, no GPU),
    // so scheduling gaps never read as frozen hands.
    let liveRankNext = 0, liveCount = 0;
    for (const pl of players) {
      const pipe = busy.get(pl.id);
      pl._live = !!(pipe && pipe.ready && pipe.handsLive(now));
      if (pl._live) { pl._rank = liveRankNext++; liveCount++; }
    }

    let mpMs = 0;
    const out = [];
    for (let i = 0; i < players.length; i++) {
      const pl = players[i];
      const pipe = acquire(pl.id);
      let res = { hands: { left: null, right: null }, bodyImg: null, bodyWorld: null };

      // every other player's wrists + boxes → ownership gate + intruder mask
      let otherWrists = null, otherBoxes = null;
      if (players.length > 1) {
        otherWrists = []; otherBoxes = [];
        for (let j = 0; j < players.length; j++) {
          if (j === i) continue;
          for (const w of players[j].wrists) if (w) otherWrists.push(w);
          otherBoxes.push(players[j].bboxRaw);
        }
      }

      // cadence: live hands → full rate (≤2 live) / staggered half rate (3-4);
      // no hands → probe every 4th frame. Skips are prediction-bridged.
      let skip = false;
      if (roundRobin && !solo) {
        if (pl._live) skip = liveCount > 2 && ((frameCount + pl._rank) % 2 !== 0);
        else skip = (frameCount + i) % 4 !== 0;
      }
      if (pipe && pipe.ready && size.w && !skip) {
        const th = performance.now();
        res = pipe.detect(video, pl.bboxRaw, size, now, {
          wantPose, poseEvery: poseEveryDyn, posePhase: i, frameCount, predMs: opts.predMs,
          fullFrame: solo, wrists: pl.wrists, otherWrists, otherBoxes
        });
        mpMs += performance.now() - th;
        lastOut.set(pl.id, res);
      } else if (pipe && pipe.ready && skip) {
        res = pipe.predictOnly(now, { predMs: opts.predMs });   // keep moving between detects
      } else if (lastOut.has(pl.id)) {
        res = lastOut.get(pl.id);
      }

      out.push({
        id: pl.id, bbox: pl.bbox, body2D: pl.body2D, wrists: pl.wrists,
        hands: res.hands, bodyImg: res.bodyImg, bodyWorld: res.bodyWorld
      });
    }

    stats.moveNet = mp.lastCostMs();
    stats.mediapipe += (mpMs - stats.mediapipe) * 0.15;
    stats.total += ((performance.now() - t0) - stats.total) * 0.15;
    stats.players = players.length;
    stats.mode = mode;

    // govern pose cadence every ~600ms: stretch under pressure, relax with headroom
    if (now - lastGov > 600) {
      lastGov = now;
      if (stats.total > budgetMs && poseEveryDyn < 6) poseEveryDyn++;
      else if (stats.total < budgetMs * 0.55 && poseEveryDyn > poseEvery) poseEveryDyn--;
      stats.poseEvery = poseEveryDyn;
    }
    return { mode, count: players.length, players: out };
  }

  return {
    detect,
    mode: () => tracker.mode,
    setForceMode(m) { forceMode = (m === 'A' || m === 'B') ? m : null; },
    /** false → skeleton-only fast path (no MediaPipe; bodies for up to 6). */
    setHandsEnabled(on) { handsEnabled = !!on; },
    /** Retune MoveNet pump rate (skeleton mode runs hotter, e.g. 30). */
    setMoveNetFps(f) { mp.setFps?.(f); },
    /** Suspend the MoveNet pump (e.g. game switched to single-player) — models stay warm. */
    pause() { mp.stop(); },
    /** Resume after pause(). */
    resume() { mp.start(video); },
    stats: () => stats,
    videoSize: () => mp.videoSize(),
    poses: () => mp.latest(),          // raw MoveNet (debug/overlay)
    dispose() {
      running = false;
      mp.dispose();
      for (const p of free) p.dispose();
      for (const p of busy.values()) p.dispose();
      free.length = 0; busy.clear(); lastOut.clear();
    }
  };
}
