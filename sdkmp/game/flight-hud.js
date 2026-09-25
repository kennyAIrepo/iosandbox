/**
 * sdk/game/flight-hud.js — the FLIGHT panel: the ball's live physics on screen, and its predicted arc.
 * A component like GameCues: mounts its own DOM + CSS, reads a PropBall's recorder / simulator / intent.
 *   const F = new FlightHud({ id: 'engFlight', scene, THREE, onToggle });
 *   F.show() / F.hide()    — the panel EXISTS only while the ball game is on: the host shows it when a
 *                            ball is born, hides it when the last ball is deleted or the lane is left
 *   F.open / F.setOpen(v)  — COLLAPSED to its title bar by default (the bar carries a live state chip);
 *                            a click on the bar (or F.toggle()) opens the read-out and the predicted arc
 *   F.update(ball); F.arc(points)
 */
export class FlightHud {
  constructor({ id = 'engFlight', scene = null, THREE = null, open = false, onToggle = null } = {}) {
    this.id = id; this.scene = scene; this.THREE = THREE; this.onToggle = onToggle;
    this.on = false; this.open = !!open; this.el = null; this.line = null; this._last = ''; this._lastHead = '';
    if (typeof document !== 'undefined') this._mount();
  }
  _mount() {
    if (!document.getElementById(this.id + 'Css')) {
      const st = document.createElement('style'); st.id = this.id + 'Css';
      st.textContent = `
#${this.id}{position:fixed;left:14px;bottom:14px;z-index:26;font:11px/1.45 ui-monospace,Menlo,Consolas,monospace;color:#d9f3ff;background:rgba(6,10,18,.74);border:1px solid rgba(159,240,255,.25);border-radius:10px;padding:6px 10px;min-width:262px;pointer-events:none;backdrop-filter:blur(6px);display:none}
#${this.id}.open{padding:8px 10px}
#${this.id} .fl-h{font-weight:800;letter-spacing:.14em;font-size:10px;color:#9ff0ff;display:flex;justify-content:space-between;align-items:center;gap:12px;pointer-events:auto;cursor:pointer;user-select:none}
#${this.id} .fl-h:hover{color:#eaf6ff}
#${this.id} .fl-c{display:inline-block;width:11px;color:#8fa3b8;transition:transform .15s}
#${this.id}.open .fl-c{transform:rotate(90deg)}
#${this.id} .fl-s{font-weight:600;letter-spacing:.04em}
#${this.id} .fl-b{display:none;margin-top:4px}
#${this.id}.open .fl-b{display:block}
#${this.id} .fl-row{display:flex;justify-content:space-between;gap:10px}
#${this.id} .fl-k{color:#8fa3b8}#${this.id} .fl-v{color:#eaf6ff;text-align:right}
#${this.id} .good{color:#a6ff5d}#${this.id} .warn{color:#ffe08a}#${this.id} .bad{color:#ff8a8a}#${this.id} .cool{color:#9ff0ff}#${this.id} .hot{color:#ffb15d}`;
      document.head.appendChild(st);
    }
    const el = document.createElement('div'); el.id = this.id;
    el.innerHTML = '<div class="fl-h" title="click: open / collapse the live physics read-out"><span><span class="fl-c">▸</span>FLIGHT</span><span class="fl-s"><span class="cool">physics</span></span></div><div class="fl-b"></div>';
    document.body.appendChild(el); this.el = el;
    el.querySelector('.fl-h').addEventListener('click', () => this.setOpen(!this.open));
    this._applyOpen();
  }
  /** the panel exists only while there is a ball to read: shown at spawn, hidden at delete / clear / exit */
  show() { this.on = true; if (this.el) this.el.style.display = 'block'; }
  hide() { this.on = false; if (this.el) this.el.style.display = 'none'; if (this.line) this.line.visible = false; }
  /** collapsed (the title bar + a live state chip) ↔ open (the full read-out + the predicted arc) */
  setOpen(v) { v = !!v; if (v === this.open) return this.open; this.open = v; this._applyOpen(); if (this.onToggle) this.onToggle(this.open); return this.open; }
  toggle() { return this.setOpen(!this.open); }
  _applyOpen() { if (!this.el) return; this.el.classList.toggle('open', this.open); this._lastHead = ''; if (!this.open && this.line) this.line.visible = false; }
  /** ball = a PropBall with .sim / .rec (and optionally .intent) */
  update(ball) {
    if (!this.on || !this.el || !ball || !ball.rec) return;
    const L = ball.rec.live, S = ball.sim, held = !!(ball.hold || ball.cradle);
    const f = (v, d = 2) => (v == null || !isFinite(v)) ? '—' : (+v).toFixed(d);
    const state = held ? 'HELD · ' + (ball.hold ? ball.hold.slot : 'cradle') : S.asleep ? 'REST' : 'FLIGHT';
    const cls = held ? 'warn' : S.asleep ? 'cool' : 'hot';
    // the title bar: "physics" when open; the live state (and the speed in flight) when collapsed
    const head = this.open ? '<span class="cool">physics</span>' : `<span class="${cls}">${state}${!held && !S.asleep ? ' · ' + f(L.speed, 1) + ' m/s' : ''}</span>`;
    if (head !== this._lastHead) { this.el.querySelector('.fl-s').innerHTML = head; this._lastHead = head; }
    if (!this.open) return;                                   // collapsed: the body is not rendered (it refreshes the frame it opens)
    const rows = [];
    rows.push(['state', `<span class="${cls}">${state}</span>`]);
    rows.push(['height', `${f(S.pos.y - S.r)} m · above release ${f(L.h)} m`]);
    rows.push(['speed', `${f(L.speed)} m/s · elev ${f(L.elev, 0)}° · azim ${f(L.azim, 0)}°`]);
    rows.push(['contacts', `${S.contacts} · substep ≤ ${(S.maxStep * 100).toFixed(0)} cm · drag k ${f(S.k, 4)}`]);
    const I = L.impact;
    if (I) rows.push(['last hit', `<span class="cool">${I.surface}</span> in ${f(I.vin)} → out ${f(I.vout)} m/s · e ${f(I.eEff)} (mat ${f(I.e)})`]);
    if (I) rows.push(['rebound', `predicted ${f(I.predictedRebound)} m` + (L.apex && L.apex.measuredRebound != null ? ` · measured ${f(L.apex.measuredRebound)} m · <span class="${L.check != null && Math.abs(L.check - 1) < 0.08 ? 'good' : 'warn'}">check ${f(L.check, 2)}</span>` : '')]);
    const Rl = L.release;
    if (Rl) rows.push(['release', `${Rl.source || ''} ${f(Rl.speed)} m/s · elev ${f(Rl.elev, 0)}°` + (Rl.handSpeed != null ? ` · hand ${f(Rl.handSpeed)} m/s${Rl.gain ? ' ×' + Rl.gain : ''} (${Rl.why || ''})` : '') + (Rl.assist ? ` · <span class="good">${Rl.assist}</span>` : '')]);
    if (ball.intent) { const it = ball.intent; rows.push(['intent', `<span class="${it.state === 'push' || it.state === 'throw' ? 'hot' : it.state === 'claw' ? 'good' : 'cool'}">${it.state}</span> · conf ${f(it.conf, 2)}${it.blockAttract ? ' · <span class="warn">no-glue</span>' : ''}`]); }
    rows.push(['events', `${ball.rec.events.length} · impacts ${ball.rec.of('impact').length}`]);
    const html = rows.map(([k, v]) => `<div class="fl-row"><span class="fl-k">${k}</span><span class="fl-v">${v}</span></div>`).join('');
    if (html !== this._last) { this.el.querySelector('.fl-b').innerHTML = html; this._last = html; }
  }
  /** the predicted arc (points [[x,y,z], …]); [] hides it — drawn only while the panel is open */
  arc(points) {
    const T = this.THREE; if (!T || !this.scene) return;
    if (!this.line) {
      const g = new T.BufferGeometry(); g.setAttribute('position', new T.Float32BufferAttribute(new Float32Array(3 * 128), 3));
      this.line = new T.Line(g, new T.LineDashedMaterial({ color: 0x9ff0ff, dashSize: 0.06, gapSize: 0.05, transparent: true, opacity: 0.75, depthTest: false }));
      this.line.frustumCulled = false; this.line.renderOrder = 20; this.scene.add(this.line);
    }
    if (!this.on || !this.open || !points || points.length < 2) { this.line.visible = false; return; }
    const n = Math.min(128, points.length), a = this.line.geometry.getAttribute('position');
    for (let i = 0; i < n; i++) { a.setXYZ(i, points[i][0], points[i][1], points[i][2]); }
    a.needsUpdate = true; this.line.geometry.setDrawRange(0, n); this.line.computeLineDistances(); this.line.visible = true;
  }
}
