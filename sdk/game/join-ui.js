/**
 * join-ui.js — Teams-style PRE-JOIN screen, invite dialog (link + Copy + QR), People-pane invite row and the
 * CONNECTION CHIP for the link-based multi-user flow (sdk/net/room-link.js + WsRelayTransport 'state' events).
 * ─────────────────────────────────────────────────────────────────────────────
 * Browser only, no three.js. Styles: sdk/ui/join.css (load after teams-tokens.css + teamslab.css); it reuses the
 * .tw-btn / .tw-input / .dlg / .roster__* conventions of teamslab.css. Reference layout: the Teams pre-join screen
 * (preview tile + device toggles left, name + "Join now" right; phones stack it). Not a Microsoft product.
 *
 *   import { JoinUI, ConnectionChip, NAME_KEY } from './sdk/game/join-ui.js';
 *
 *   const join = new JoinUI(frame, { room, relay, name, requestPreview: () => localSource.stream });
 *   join.chip.attach(transport, { room: roomObj });          // optional: live relay state on the pre-join top bar
 *   const { name, mic, camera, room } = await join.open();   // resolves on "Join now" (Enter in the name field too)
 *   join.close();                                            // removes the screen; the invite dialog stays usable
 *   join.mountPeopleInvite(document.getElementById('roster'));   // in-meeting "Invite" row for the People pane
 *   join.mountChip(document.getElementById('topbar'));           // the same chip on the meeting top bar
 *
 * Events (EventTarget): 'join' {name, mic, camera, room}, 'camera' {on}, 'mic' {on}, 'invite' {url}, 'copy' {url, ok}.
 *
 * Privacy: the screen NEVER calls getUserMedia itself — the consent dialog (C1) gates the camera; the integrator hands
 * a stream via `requestPreview()` / `setPreview(stream)` after consent. The display name is stored in
 * localStorage[NAME_KEY] ('hopeos.name') only.
 */
import { makeRoomCode, parseRoomFromUrl, normalizeRoomCode, buildInviteUrl, resolveRelayInfo, makeQrDataUrl, RELAY_DEFAULT, ROOM_CODE_ALPHABET } from '../net/room-link.js';

export const NAME_KEY = 'hopeos.name';

export const JOIN_STRINGS = {
  title: 'hopeOS Meeting Sandbox',
  sub: 'Cross-screen hands · sandbox, not a Microsoft product',
  heading: 'Ready to join?',
  roomLabel: 'Room',
  roomHint: 'Share the code or the link — everyone who opens it lands in the same room.',
  nameLabel: 'Your name',
  namePlaceholder: 'Type your name',
  nameRequired: 'Enter a name so others can see who you are.',
  roomInvalid: 'Enter a room code (5 letters, no I, L or O) or a room name without spaces.',
  join: 'Join now',
  invite: 'Invite',
  camOn: 'Camera on', camOff: 'Camera off', micOn: 'Mic on', micOff: 'Mic off',
  camUnavailable: 'No camera yet — it starts after you agree to the tracking notice.',
  previewPill: 'Preview · tracked on this device',
  foot: 'Hands are tracked on your device; only landmark packets leave it. hopeOS sandbox — not affiliated with Microsoft.',
  inviteTitle: 'Invite people',
  inviteLead: 'Anyone who opens this link joins the same room, from any device.',
  copy: 'Copy link', copied: 'Link copied', copyFailed: 'Copy failed — select the link and copy it',
  share: 'Share…', done: 'Done',
  qrHint: 'Point a phone camera at the code to open the link.',
  qrFallback: 'QR unavailable (offline or blocked) — send the link instead:',
  peopleInvite: 'Invite people', peopleInviteMeta: (code) => `Room ${code} · link or QR`,
  chip: { connecting: 'Connecting…', connected: (n) => `Connected · ${n}`, reconnecting: 'Reconnecting…', offline: 'Offline' },
};

const h = (tag, cls, attrs = {}, ...kids) => {
  const el = document.createElement(tag);
  if (cls) el.className = cls;
  for (const [k, v] of Object.entries(attrs)) { if (v == null) continue; if (k === 'text') el.textContent = v; else if (k === 'html') el.innerHTML = v; else el.setAttribute(k, v); }
  for (const k of kids) if (k != null) el.append(k);
  return el;
};
const initials = (name) => (String(name || '').trim().split(/\s+/).map(s => s[0]).filter(Boolean).slice(0, 2).join('') || '?').toUpperCase();

// static icon markup only (Fluent System Icons shapes, MIT — no user content goes through innerHTML)
const ICON = {
  cam: '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true"><rect x="2.5" y="5" width="11" height="10" rx="2"/><path d="M13.5 8.5l4-2v7l-4-2z"/></svg>',
  camOff: '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true"><rect x="2.5" y="5" width="11" height="10" rx="2"/><path d="M13.5 8.5l4-2v7l-4-2z"/><path d="M3 3l14 14"/></svg>',
  mic: '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true"><rect x="7" y="2.5" width="6" height="9" rx="3"/><path d="M4.5 9.5a5.5 5.5 0 0 0 11 0M10 15v2.5"/></svg>',
  micOff: '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true"><rect x="7" y="2.5" width="6" height="9" rx="3"/><path d="M4.5 9.5a5.5 5.5 0 0 0 11 0M10 15v2.5"/><path d="M3 3l14 14"/></svg>',
  link: '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true"><path d="M8.5 11.5l3-3M7 13l-1.5 1.5a2.5 2.5 0 0 1-3.5-3.5L4.5 8.5M13 7l1.5-1.5a2.5 2.5 0 0 1 3.5 3.5L15.5 11.5"/></svg>',
  plus: '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.6" aria-hidden="true"><path d="M10 4v12M4 10h12"/></svg>',
};

// ── connection chip ─────────────────────────────────────────────────────────
/** `data-state` connecting | connected | reconnecting | offline; text from JOIN_STRINGS.chip; role=status (polite). */
export class ConnectionChip {
  constructor(el = null, { strings = JOIN_STRINGS } = {}) {
    this.el = el || h('span', 'conn-chip', { role: 'status', 'aria-live': 'polite' });
    this.el.classList.add('conn-chip');
    this.s = strings; this.state = 'connecting'; this.peers = 0; this._detach = null;
    this.set('connecting');
  }
  /** @param {'connecting'|'connected'|'reconnecting'|'offline'} state */
  set(state, { peers = this.peers, attempt = 0, delayMs = 0 } = {}) {
    this.state = state; this.peers = Math.max(0, peers | 0);
    this.el.dataset.state = state;
    const c = this.s.chip;
    this.el.textContent = state === 'connected' ? c.connected(this.peers) : c[state] || state;
    this.el.title = state === 'reconnecting' && delayMs ? `Retrying in ${Math.round(delayMs / 1000)} s (attempt ${attempt})` : this.el.textContent;
    return this;
  }
  setPeers(n) { return this.set(this.state, { peers: n }); }
  /**
   * Follow a transport (WsRelayTransport 'state' events; LoopbackTransport has none → 'connected') and, when given,
   * a Room ('roster' → peer count). Returns a detach fn.
   */
  attach(transport, { room = null } = {}) {
    this.detach();
    const offs = [];
    const inner = transport?.inner || transport;
    if (inner && typeof inner.on === 'function') {
      const onState = ({ state, willReconnect, reconnecting, hello, attempt, delayMs }) => {
        if (state === 'open') this.set('connected', { peers: Math.max(this.peers, hello?.peers?.length || 0) });
        else if (state === 'connecting') this.set(reconnecting || inner.stats?.connects > 0 ? 'reconnecting' : 'connecting', { attempt });
        else if (state === 'closed') this.set(willReconnect ? 'reconnecting' : 'offline', { attempt, delayMs });
      };
      offs.push(inner.on('state', onState));
      if (inner.state === 'open') this.set('connected', { peers: Math.max(this.peers, inner.hello?.peers?.length || 0) });
    } else if (inner) this.set('connected');
    if (room && typeof room.on === 'function') {
      offs.push(room.on('roster', (roster) => { if (this.state === 'connected') this.setPeers(roster.length); else this.peers = roster.length; }));
      if (Array.isArray(room.roster) && room.roster.length) this.peers = room.roster.length;
    }
    this._detach = () => { for (const f of offs) { try { f(); } catch { /* ignore */ } } this._detach = null; };
    return this._detach;
  }
  detach() { this._detach?.(); }
}

// ── pre-join screen ─────────────────────────────────────────────────────────
export class JoinUI extends EventTarget {
  /**
   * @param {HTMLElement} root the `.tw-frame` element (the screen is absolutely positioned inside it)
   * @param {object} o
   * @param {string=} o.room            room code / name; default parseRoomFromUrl() or a fresh makeRoomCode()
   * @param {string=} o.relay           relay base URL; default resolveRelayInfo(location.href).relay
   * @param {string=} o.name            default display name (URL ?name= wins over localStorage)
   * @param {(()=>MediaStream|Promise<MediaStream>)=} o.requestPreview  called once on open(); null → avatar tile
   * @param {string=} o.origin          invite-link origin (default location.origin)
   * @param {object=} o.strings         overrides for JOIN_STRINGS
   */
  constructor(root, { room = null, relay = null, name = null, requestPreview = null, origin = null, strings = null, mic = true, camera = true } = {}) {
    super();
    this.root = root?.classList?.contains('tw-frame') ? root : (root ?? document).querySelector('.tw-frame') || document.body;
    this.s = strings ? { ...JOIN_STRINGS, ...strings, chip: { ...JOIN_STRINGS.chip, ...(strings.chip || {}) } } : JOIN_STRINGS;
    const fromUrl = parseRoomFromUrl();
    this.room = normalizeRoomCode(room) || fromUrl || makeRoomCode();
    this.roomFromLink = !!(room || fromUrl);
    const info = resolveRelayInfo();
    this.relay = relay || info.relay; this.relaySource = relay ? 'option' : info.source;
    this.origin = origin || location.origin;
    let stored = null; try { stored = localStorage.getItem(NAME_KEY); } catch { /* private mode */ }
    this.name = (new URL(location.href).searchParams.get('name') || name || stored || '').trim();
    this.mic = !!mic; this.camera = !!camera; this.cameraAvailable = false;
    this.requestPreview = requestPreview; this.stream = null;
    this.chip = new ConnectionChip(null, { strings: this.s });
    this.el = null; this.dlg = null; this._resolve = null; this._opened = false;
    this._build();
  }

  get inviteUrl() { return buildInviteUrl({ room: this.room, relay: this.relay, origin: this.origin }); }
  get wsUrl() { return `${this.relay.replace(/\/+$/, '')}/room/${encodeURIComponent(this.room)}`; }

  _build() {
    const s = this.s;
    // top bar
    const top = h('div', 'prejoin__top', {}, h('span', 'prejoin__logo', { text: 'h', 'aria-hidden': 'true' }),
      h('div', '', { style: 'min-width:0' }, h('div', 'prejoin__title', { text: s.title }), h('div', 'prejoin__sub', { text: s.sub })), this.chip.el);
    this.chip.el.classList.add('prejoin__chip');
    // preview tile + device row
    this.video = h('video', 'prejoin__video', { autoplay: '', muted: '', playsinline: '', 'aria-hidden': 'true' }); this.video.muted = true;
    this.initialsEl = h('span', 'prejoin__initials', { text: initials(this.name) });
    this.avatarNote = h('span', 'tw-caption1', { text: s.camUnavailable });
    this.tile = h('div', 'prejoin__tile is-camoff', { role: 'img', 'aria-label': 'Camera preview' }, this.video,
      h('div', 'prejoin__avatar', {}, this.initialsEl, this.avatarNote),
      h('span', 'prejoin__pill', { text: s.previewPill }), this.labelEl = h('span', 'prejoin__label', { text: this.name || '—' }));
    this.btnCam = h('button', 'prejoin__devbtn tw-focusable', { type: 'button', 'aria-pressed': String(this.camera), 'aria-label': 'Camera', html: `<span class="on">${ICON.cam}</span><span class="off">${ICON.camOff}</span>` }, this.camLabel = h('span', '', { text: this.camera ? s.camOn : s.camOff }));
    this.btnMic = h('button', 'prejoin__devbtn tw-focusable', { type: 'button', 'aria-pressed': String(this.mic), 'aria-label': 'Mic', html: `<span class="on">${ICON.mic}</span><span class="off">${ICON.micOff}</span>` }, this.micLabel = h('span', '', { text: this.mic ? s.micOn : s.micOff }));
    const devices = h('div', 'prejoin__devices', {}, this.btnCam, this.btnMic);
    const preview = h('div', 'prejoin__preview', {}, this.tile, devices);
    // card
    this.codeEl = h('span', 'prejoin__code', { text: this.room });
    this.roomInput = h('input', 'tw-input', { id: 'joinRoom', type: 'text', autocapitalize: 'characters', autocomplete: 'off', spellcheck: 'false', maxlength: '24', 'aria-label': s.roomLabel, value: this.room });
    this.roomInput.value = this.room;
    const roomField = h('div', 'prejoin__field', {}, h('label', '', { for: 'joinRoom', text: s.roomLabel }), this.roomInput, h('span', 'prejoin__room', { text: s.roomHint }));
    this.nameInput = h('input', 'tw-input', { id: 'joinName', type: 'text', autocomplete: 'name', maxlength: '40', placeholder: s.namePlaceholder, 'aria-label': s.nameLabel, 'aria-required': 'true' });
    this.nameInput.value = this.name;
    const nameField = h('div', 'prejoin__field', {}, h('label', '', { for: 'joinName', text: s.nameLabel }), this.nameInput);
    this.err = h('div', 'prejoin__err', { role: 'alert' });
    this.btnJoin = h('button', 'tw-btn tw-btn--primary tw-focusable', { type: 'button', id: 'btnJoinNow', text: s.join });
    this.btnInvite = h('button', 'tw-btn tw-btn--outline tw-focusable', { type: 'button', id: 'btnInvite', html: ICON.link }, h('span', '', { text: s.invite }));
    const actions = h('div', 'prejoin__actions', {}, this.btnJoin, this.btnInvite);
    const card = h('div', 'prejoin__card', {}, h('h2', 'prejoin__h', { text: s.heading }), roomField, nameField, this.err, actions);
    const body = h('div', 'prejoin__body', {}, preview, card);
    const foot = h('div', 'prejoin__foot', { text: s.foot });
    this.el = h('section', 'prejoin', { id: 'prejoin', role: 'region', 'aria-label': 'Pre-join', hidden: '' }, top, body, foot);
    this.root.appendChild(this.el);
    this._buildInvite();

    // wiring
    this.nameInput.addEventListener('input', () => { this.err.textContent = ''; const v = this.nameInput.value.trim(); this.initialsEl.textContent = initials(v); this.labelEl.textContent = v || '—'; });
    this.nameInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); this._join(); } });
    // codes are typed in any case (phones): uppercase while the prefix could still be a code (alphabet letters only, <= 5)
    this.roomInput.addEventListener('input', () => { this.err.textContent = ''; const v = this.roomInput.value; if (v.length <= 5 && [...v.toUpperCase()].every(c => ROOM_CODE_ALPHABET.includes(c))) this.roomInput.value = v.toUpperCase(); this._setRoom(this.roomInput.value, false); });
    this.roomInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); this.nameInput.focus(); } });
    this.btnJoin.addEventListener('click', () => this._join());
    this.btnInvite.addEventListener('click', () => this.openInvite());
    this.btnCam.addEventListener('click', () => this.setCamera(!this.camera));
    this.btnMic.addEventListener('click', () => this.setMic(!this.mic));
  }

  _setRoom(v, render = true) {
    const code = normalizeRoomCode(v);
    if (!code) return;
    this.room = code; this.codeEl.textContent = code; if (render) this.roomInput.value = code;
    if (this.linkInput) this.linkInput.value = this.inviteUrl;
    if (this.peopleMeta) this.peopleMeta.textContent = this.s.peopleInviteMeta(code);
    this._qrFor = null;
  }

  // ---- lifecycle ----
  /** Show the screen; resolves with {name, mic, camera, room} on Join now. Calls requestPreview() once. */
  open() {
    this.el.hidden = false; this._opened = true;
    if (this.requestPreview && !this.stream) Promise.resolve().then(() => this.requestPreview()).then(st => { if (st) this.setPreview(st); }).catch(e => { this.avatarNote.textContent = (e && e.message) || this.s.camUnavailable; });
    setTimeout(() => (this.name ? this.btnJoin : this.nameInput).focus(), 0);
    return new Promise(res => { this._resolve = res; });
  }
  /** Hide the screen (keeps the invite dialog and the chip usable in the meeting). */
  close() { this.el.hidden = true; this._opened = false; }
  get isOpen() { return this._opened; }
  destroy() { this.chip.detach(); this.el.remove(); this.dlg?.remove(); this.peopleRow?.remove(); }

  _join() {
    const name = this.nameInput.value.trim();
    if (!name) { this.err.textContent = this.s.nameRequired; this.nameInput.focus(); return; }
    const room = normalizeRoomCode(this.roomInput.value);
    if (!room || /[\s/?#]/.test(room)) { this.err.textContent = this.s.roomInvalid; this.roomInput.focus(); return; }   // codes or plain names; nothing that breaks the /room/<x> path
    this._setRoom(room);
    this.name = name; try { localStorage.setItem(NAME_KEY, name); } catch { /* private mode */ }
    const detail = { name, mic: this.mic, camera: this.camera, room: this.room, relay: this.relay, inviteUrl: this.inviteUrl };
    this.dispatchEvent(new CustomEvent('join', { detail }));
    this._resolve?.(detail); this._resolve = null;
  }

  // ---- preview / devices ----
  setPreview(stream) {
    this.stream = stream || null;
    if (stream) { try { this.video.srcObject = stream; this.video.play?.().catch(() => {}); } catch { /* ignore */ } }
    this.cameraAvailable = !!stream;
    this._renderCam();
  }
  setCameraAvailable(on, note = null) { this.cameraAvailable = !!on; if (note) this.avatarNote.textContent = note; this._renderCam(); }
  setCamera(on) { this.camera = !!on; this.btnCam.setAttribute('aria-pressed', String(this.camera)); this.camLabel.textContent = this.camera ? this.s.camOn : this.s.camOff; this._renderCam(); this.dispatchEvent(new CustomEvent('camera', { detail: { on: this.camera } })); }
  setMic(on) { this.mic = !!on; this.btnMic.setAttribute('aria-pressed', String(this.mic)); this.micLabel.textContent = this.mic ? this.s.micOn : this.s.micOff; this.dispatchEvent(new CustomEvent('mic', { detail: { on: this.mic } })); }
  _renderCam() {
    const show = this.camera && this.cameraAvailable;
    this.tile.classList.toggle('is-camoff', !show);
    this.avatarNote.hidden = this.cameraAvailable;    // camera exists but is toggled off: just the initials
  }

  // ---- invite dialog ----
  _buildInvite() {
    const s = this.s;
    this.linkInput = h('input', 'tw-input', { type: 'text', readonly: '', 'aria-label': 'Invite link', id: 'inviteLink' }); this.linkInput.value = this.inviteUrl;
    this.btnCopy = h('button', 'tw-btn tw-btn--primary tw-focusable', { type: 'button', id: 'btnCopyLink', text: s.copy });
    this.copied = h('p', 'invite__copied', { 'aria-live': 'polite' });
    this.qrImg = h('img', '', { alt: 'QR code of the invite link', width: '176', height: '176', hidden: '' });
    this.qrText = h('div', 'invite__qrtext', { hidden: '' });
    this.qrBox = h('div', 'invite__qr', { id: 'inviteQr', 'data-qr': 'pending' }, this.qrImg, this.qrText, h('p', 'invite__hint', { text: s.qrHint }));
    const btns = h('div', 'dlg__btns', {});
    if (typeof navigator !== 'undefined' && typeof navigator.share === 'function') {
      this.btnShare = h('button', 'tw-btn tw-btn--outline tw-focusable', { type: 'button', text: s.share });
      this.btnShare.addEventListener('click', () => navigator.share({ title: s.title, text: `Join room ${this.room}`, url: this.inviteUrl }).catch(() => {}));
      btns.append(this.btnShare);
    }
    this.btnDone = h('button', 'tw-btn tw-btn--outline tw-focusable', { type: 'button', text: s.done });
    btns.append(this.btnDone);
    const codeRow = h('div', 'invite__code', {}, h('span', 'tw-caption1', { text: s.roomLabel }), this.inviteCode = h('span', 'prejoin__code', { text: this.room }));
    this.dlg = h('dialog', 'invite', { id: 'inviteDlg', 'aria-labelledby': 'invite-title' },
      h('div', 'dlg', {}, h('h2', 'dlg__title', { id: 'invite-title', text: s.inviteTitle }),
        h('div', 'dlg__body', {}, h('p', 'invite__lead', { text: s.inviteLead }), codeRow, h('div', 'invite__linkrow', {}, this.linkInput, this.btnCopy), this.copied, this.qrBox), btns));
    this.root.appendChild(this.dlg);
    this.btnCopy.addEventListener('click', () => this.copyLink());
    this.btnDone.addEventListener('click', () => this.dlg.close());
    this.linkInput.addEventListener('focus', () => this.linkInput.select());
  }
  async openInvite() {
    const url = this.inviteUrl;
    this.linkInput.value = url; this.inviteCode.textContent = this.room; this.copied.textContent = '';
    this.dispatchEvent(new CustomEvent('invite', { detail: { url } }));
    if (!this.dlg.open) { try { this.dlg.showModal(); } catch { this.dlg.setAttribute('open', ''); } }
    if (this._qrFor !== url) {
      this.qrBox.dataset.qr = 'pending';
      const data = await makeQrDataUrl(url);
      if (this.linkInput.value !== url) return;   // room changed meanwhile
      this._qrFor = url;
      if (data) { this.qrImg.src = data; this.qrImg.hidden = false; this.qrText.hidden = true; this.qrBox.dataset.qr = 'img'; }
      else { this.qrImg.hidden = true; this.qrText.textContent = `${this.s.qrFallback} ${url}`; this.qrText.hidden = false; this.qrBox.dataset.qr = 'text'; }
    }
    return url;
  }
  async copyLink() {
    const url = this.inviteUrl; let ok = false;
    try { await navigator.clipboard.writeText(url); ok = true; } catch { try { this.linkInput.focus(); this.linkInput.select(); ok = document.execCommand('copy'); } catch { ok = false; } }
    this.copied.textContent = ok ? this.s.copied : this.s.copyFailed;
    if (ok) setTimeout(() => { if (this.copied.textContent === this.s.copied) this.copied.textContent = ''; }, 2500);
    this.dispatchEvent(new CustomEvent('copy', { detail: { url, ok } }));
    return ok;
  }

  // ---- in-meeting entries ----
  /** People pane: an "Invite people" row (avatar +, meta "Room CODE · link or QR", Invite button) before `rosterEl`. */
  mountPeopleInvite(rosterEl) {
    if (!rosterEl || this.peopleRow) return this.peopleRow;
    const btn = h('button', 'tw-btn tw-btn--outline tw-focusable', { type: 'button', id: 'btnInvitePeople', text: this.s.invite });
    btn.addEventListener('click', () => this.openInvite());
    this.peopleMeta = h('span', 'roster__meta tw-caption1', { text: this.s.peopleInviteMeta(this.room) });
    this.peopleRow = h('div', 'roster__invite', {}, h('span', 'roster__avatar', { 'aria-hidden': 'true', html: ICON.plus }),
      h('span', 'roster__name', { text: this.s.peopleInvite }), this.peopleMeta, btn);
    rosterEl.parentNode.insertBefore(this.peopleRow, rosterEl);
    return this.peopleRow;
  }
  /** Move the connection chip onto the meeting top bar (before #topbarBtns when present). */
  mountChip(topbarEl) {
    if (!topbarEl) return this.chip.el;
    this.chip.el.classList.remove('prejoin__chip');
    const before = topbarEl.querySelector('#topbarBtns');
    if (before) topbarEl.insertBefore(this.chip.el, before); else topbarEl.appendChild(this.chip.el);
    return this.chip.el;
  }
}

export { makeRoomCode, parseRoomFromUrl, buildInviteUrl, resolveRelayInfo, RELAY_DEFAULT };
