/**
 * remote-tile.js — the receiver chain for a REMOTE participant's tile (research/gaps/wire-protocol/hopeos-wire.md §7,
 * line for line; the same order tile-pipeline.js:86-97 runs for a local tile). Browser only.
 *
 *   rd = remote.read(seat, clock.now())                       // RemoteHands: {hands:{left,right}, ageMs, alpha, present, hold}
 *   tile.setSlotsToDrop(remote.slotsToDrop(seat, now))        // 400 ms rule → views.dropSlot(slot), latches reset
 *   tile.feed(rd, now, dt, cols)                              // views.resolve → rigs pose (conform to cols) → HandBody per slot
 *   tile.setAlpha(rd.alpha)                                   // stale cue 1 → 0.5 between 150 and 400 ms (handAgeAlpha)
 *
 * [C1'] Chirality is MEASURED here again, on this tile's own HandViews({mode:'mirror'}), from the received img
 * landmarks: nothing on the wire is flipped, relabelled or re-filtered, and no MediaPipe side label is ever read.
 * The received `hands` keep the raw PlayerPipeline shape ({left:{img,world}, right:{img,world}}) so the same
 * `views.resolve([left, right], camera)` call a local tile makes reproduces the sender's world packs.
 */
import { HandViews } from '../core/hand-views.js';             // hand-views.js:138 — the ONLY chirality authority
import { HoloHandRig } from '../core/hand-rig.js';              // hand-rig.js:152
import { HandBody } from '../core/game-physics.js';             // game-physics.js:54
import { REST_R42, REST_L42 } from '../core/hands.js';          // hands.js:19-20
import { setRigAlpha } from './stage-renderer.js';

const EMPTY_HANDS = Object.freeze({ left: null, right: null });

export class RemoteTile {
  /**
   * @param {string} id   stable tile id (the remote clientId) — becomes the HandBody slot suffix (unique per tile)
   * @param {{scene:THREE.Scene|null, camera:THREE.Camera, style?:string, occluder?:boolean, cover?:{x:number,y:number}}} o
   */
  constructor(id, { scene = null, camera, style = 'smooth', occluder = true, cover } = {}) {
    this.id = id;
    this.scene = scene;
    this.camera = camera;
    this.views = new HandViews({ mode: 'mirror' });
    if (cover) { this.views.cfg.cover.x = cover.x; this.views.cfg.cover.y = cover.y; }
    this.rigR = scene ? new HoloHandRig(REST_R42, scene, { style }).build() : null;
    this.rigL = scene ? new HoloHandRig(REST_L42, scene, { style }).build() : null;
    if (this.rigR && occluder) { this.rigR.setOccluder(true); this.rigL.setOccluder(true); }
    this.handL = new HandBody('left#' + id);
    this.handR = new HandBody('right#' + id);
    this.packs = { R: null, L: null, hands: [] };
    this.hands = { left: null, right: null };
    this.alpha = 1;
    this.ageMs = Infinity;
    this.frameCount = 0;
    this._drop = [];
  }

  /** Slots whose absence crossed the drop rule since the last frame (RemoteHands.slotsToDrop); applied at the next feed(). */
  setSlotsToDrop(slots) { if (slots && slots.length) for (const s of slots) this._drop.push(s); }

  /** Cover-fit for the avatar box: the twin's tiles are 16:9 media boxes (same maths as TilePipeline.setCover). */
  setCover(boxW, boxH, videoAspect = 16 / 9) {
    const A = boxW / boxH, Av = videoAspect;
    this.views.cfg.cover.x = Math.min(1, A / Av);
    this.views.cfg.cover.y = Math.min(1, Av / A);
  }

  /**
   * One frame. `rd` = RemoteHands.read(seat, clock.now()) (or null: nothing received yet).
   * @param {number} now   performance.now() (rig shader time)
   * @param {number} dt    seconds
   * @param {Array|null} cols   conform colliders for the rigs ([ball.collider, …])
   * @returns {{packs:{R,L,hands:Array}, handL:HandBody, handR:HandBody}}
   */
  feed(rd, now, dt, cols = null) {
    this.frameCount++;
    if (this._drop.length) { for (const s of this._drop) this.views.dropSlot(s); this._drop.length = 0; }
    const hands = rd && rd.hands ? rd.hands : EMPTY_HANDS;
    this.hands = hands;
    this.ageMs = rd ? rd.ageMs : Infinity;
    // [C1'] measured chirality, this tile's own z-sign latch — the received img is the sender's mirrored display space
    this.packs = this.views.resolve([hands.left, hands.right], this.camera);
    if (this.rigR) { this.rigR.tick(now * 0.001); this.rigR.pose(this.packs.R, cols); }
    if (this.rigL) { this.rigL.tick(now * 0.001); this.rigL.pose(this.packs.L, cols); }
    for (const slot of ['left', 'right']) {                                 // physics bodies from the SAME packs the rigs render
      const h = this.packs.hands.find(x => x.slot === slot);
      const hb = slot === 'left' ? this.handL : this.handR;
      if (h) hb.update(h.points, dt, h.img); else hb.drop();
    }
    return { packs: this.packs, handL: this.handL, handR: this.handR };
  }

  /** Stale cue on both rigs (1 → 0.5 between 150 and 400 ms via handAgeAlpha, read from rd.alpha). */
  setAlpha(a) {
    this.alpha = a;
    if (this.rigR) setRigAlpha(this.rigR, a);
    if (this.rigL) setRigAlpha(this.rigL, a);
  }

  dispose() {
    if (this.rigR) { this.rigR.dispose(); this.rigR = null; }
    if (this.rigL) { this.rigL.dispose(); this.rigL = null; }
    this.handL.drop(); this.handR.drop();
    this.packs = { R: null, L: null, hands: [] };
  }
}
