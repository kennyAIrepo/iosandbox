/**
 * hopeOS — PushToTalk: hold-to-record speech -> transcript -> CommandAgent.
 * ═══════════════════════════════════════════════════════════════════════════
 * The existing VoiceCommander (sdk/interaction/voice.js, read 2026-09-18) records
 * FIXED 4 s chunks back-to-back (`interval: 4000`, then `setTimeout(rec, 200)`),
 * drops blobs under 4000 bytes, and transcribes each chunk, so a command waits on
 * average ~2 s (worst ~4.2 s) before it is even sent, and a phrase spoken across a
 * chunk boundary is split in two. For a demo where a person says one command and
 * expects the apple NOW, push-to-talk is faster: MediaRecorder.start() on key-down,
 * .stop() on key-up, one upload.
 *
 * MediaRecorder API (verified 2026-09-18 at
 * https://developer.mozilla.org/en-US/docs/Web/API/MediaRecorder): start(timeslice?)
 * begins recording (no timeslice -> one Blob on stop), stop() ends it and fires a
 * final `dataavailable` then `stop`, static isTypeSupported(mime), and `state` is
 * "inactive" | "recording" | "paused".
 *
 * Transport is the SAME proxy VoiceCommander uses (api/openai.js, read 2026-09-18):
 * raw audio bytes as application/octet-stream plus x-audio-type / x-model /
 * x-language headers; the server rebuilds the multipart form (file, model,
 * language), adds the OpenAI key and forwards to
 * POST https://api.openai.com/v1/audio/transcriptions, returning upstream's body
 * ({ text }). The default model name 'gpt-4o-transcribe' is taken from voice.js and
 * api/openai.js; the OpenAI reference page
 * (https://platform.openai.com/docs/api-reference/audio/createTranscription)
 * returned HTTP 403 to this session, so the model list was NOT re-verified against
 * the vendor docs — 'whisper-1' is the long-standing alternative if it 400s.
 *
 *   import { PushToTalk } from './push-to-talk.js';
 *   const ptt = new PushToTalk({ onTranscript: t => agent.command(t) });
 *   await ptt.arm();                       // getUserMedia once (mic permission)
 *   ptt.bindKey(' ');                      // hold SPACE to talk
 *   ptt.bindButton(document.getElementById('talk'));   // or a HUD button (pointer/touch)
 */
export class PushToTalk {
  constructor({ endpoint = '/api/openai', model = 'gpt-4o-transcribe', lang = 'en',
                onTranscript, onState, minBytes = 2500, maxMs = 12000 } = {}) {
    this.endpoint = endpoint;
    this.model = model;
    this.lang = lang;
    this.onTranscript = onTranscript || (() => {});
    this.onState = onState || (() => {});        // 'armed' | 'recording' | 'uploading' | 'idle' | 'denied'
    this.minBytes = minBytes;                    // below this the blob is a click, not speech
    this.maxMs = maxMs;                          // safety stop if the key sticks
    this.stream = null;
    this._rec = null;
    this._chunks = [];
    this._t0 = 0;
    this._timer = 0;
    this.mimeType = (typeof MediaRecorder !== 'undefined' && MediaRecorder.isTypeSupported('audio/webm;codecs=opus'))
      ? 'audio/webm;codecs=opus' : 'audio/webm';
  }

  /** Ask for the mic once; returns false if denied. Same constraints VoiceCommander uses. */
  async arm() {
    try {
      this.stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } });
      this.onState('armed');
      return true;
    } catch (e) {
      console.warn('[ptt] mic denied:', e);
      this.onState('denied');
      return false;
    }
  }

  /** Begin recording (key-down / pointer-down). Idempotent while recording. */
  start() {
    if (!this.stream || this._rec) return;
    this._chunks = [];
    this._rec = new MediaRecorder(this.stream, { mimeType: this.mimeType });
    this._rec.ondataavailable = e => { if (e.data.size > 0) this._chunks.push(e.data); };
    this._rec.onstop = () => this._flush();
    this._rec.start();                            // no timeslice: one blob on stop()
    this._t0 = performance.now();
    this.onState('recording');
    this._timer = setTimeout(() => this.stop(), this.maxMs);
  }

  /** End recording (key-up / pointer-up) -> upload -> onTranscript(text). */
  stop() {
    clearTimeout(this._timer);
    if (this._rec && this._rec.state === 'recording') this._rec.stop();
  }

  async _flush() {
    this._rec = null;
    const blob = new Blob(this._chunks, { type: this.mimeType });
    const heldMs = performance.now() - this._t0;
    if (blob.size < this.minBytes) { this.onState('idle'); return; }     // tap, not talk
    this.onState('uploading');
    const t1 = performance.now();
    const text = await this._transcribe(blob);
    const sttMs = performance.now() - t1;
    this.onState('idle');
    if (text && text.trim().length > 1) this.onTranscript(text.trim(), { heldMs, sttMs, bytes: blob.size });
  }

  /** Identical wire protocol to VoiceCommander._transcribe (sdk/interaction/voice.js). */
  async _transcribe(blob) {
    try {
      const r = await fetch(this.endpoint, {
        method: 'POST',
        headers: {
          'content-type': 'application/octet-stream',
          'x-audio-type': blob.type || 'audio/webm',
          'x-model': this.model,
          'x-language': this.lang,
        },
        body: blob,
      });
      if (!r.ok) return null;
      return (await r.json()).text || null;
    } catch { return null; }
  }

  /** Hold a key to talk. Ignores auto-repeat and typing in inputs. Returns an unbind fn. */
  bindKey(key = ' ') {
    const down = e => {
      if (e.key !== key || e.repeat) return;
      const tag = (e.target && e.target.tagName) || '';
      if (/INPUT|TEXTAREA/.test(tag) || (e.target && e.target.isContentEditable)) return;
      e.preventDefault(); this.start();
    };
    const up = e => { if (e.key === key) { e.preventDefault(); this.stop(); } };
    window.addEventListener('keydown', down);
    window.addEventListener('keyup', up);
    return () => { window.removeEventListener('keydown', down); window.removeEventListener('keyup', up); };
  }

  /** Hold a HUD button (mouse, pen, touch) to talk. Returns an unbind fn. */
  bindButton(el) {
    const down = e => { e.preventDefault(); el.setPointerCapture?.(e.pointerId); this.start(); };
    const up = e => { e.preventDefault(); this.stop(); };
    el.addEventListener('pointerdown', down);
    el.addEventListener('pointerup', up);
    el.addEventListener('pointercancel', up);
    return () => { el.removeEventListener('pointerdown', down); el.removeEventListener('pointerup', up); el.removeEventListener('pointercancel', up); };
  }

  dispose() {
    this.stop();
    if (this.stream) for (const t of this.stream.getTracks()) t.stop();
    this.stream = null;
  }
}

/**
 * Alternative wiring that KEEPS VoiceCommander's always-on 4 s chunking and
 * simply routes its transcript into the agent instead of its regex registry.
 * VoiceCommander._matchCommands calls this._onTranscript(lower) BEFORE the regex
 * loop, with the lowercased, trimmed text (sdk/interaction/voice.js), so:
 *
 *   import { VoiceCommander } from '/sdk/interaction/voice.js';
 *   const vc = new VoiceCommander('', { interval: 4000, onTranscript: t => agent.command(t) });
 *   // register NO regex commands — CommandAgent.parseLocal is the offline grammar now
 *   await vc.start();
 *
 * The transcript is lowercased, so participant names arrive as "maya"; the
 * executor must match names case-insensitively (MockScene does).
 *
 * Optional wake-word gate so table talk in the call does not spawn apples:
 *   onTranscript: t => { const m = t.match(/\b(?:hey |ok )?hope[,]?\s+(.+)/); if (m) agent.command(m[1]); }
 */
