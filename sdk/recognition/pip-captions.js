/**
 * hopeOS SDK — Floating Caption Window (Document Picture-in-Picture)
 * ═══════════════════════════════════════════════════════════════
 * The "no-install OBS" caption sink: a real, OS-level always-on-top
 * window — separate from the tab, floats above whatever app the user is
 * actually looking at (Zoom, Teams, a video call) — not just an overlay
 * drawn inside our own page. This is what makes the tab-capture source
 * adapter (sign-recognizer.js consumers, signlab.html) genuinely useful
 * live, not just for testing: without this, a captured tab's captions
 * only ever sit on OUR copy of that tab's video, never on the real thing
 * the user is looking at.
 *
 * Chromium-only (`documentPictureInPicture`, Chrome/Edge 116+) — no
 * Firefox/Safari support as of this writing. Feature-detected; callers
 * must check `.available` before offering the control, and open() must
 * be called directly from a user-gesture handler (click), not after an
 * intervening await chain, or the browser drops the transient-activation
 * grant and the request silently rejects.
 *
 * The PiP window gets its OWN separate `document` — CaptionStrip is
 * cross-document-safe (creates elements via parent.ownerDocument), so
 * the exact same class renders here unmodified; no separate PiP-specific
 * caption widget to maintain.
 */

import { CaptionStrip } from './captions.js';

export class PipCaptions {
  constructor(opts = {}) {
    this.opts = { width: 420, height: 160, fontPx: 22, maxLines: 3, fadeMs: 6000, ...opts };
    this.available = typeof window !== 'undefined' && 'documentPictureInPicture' in window;
    this.win = null;
    this.strip = null;
    this._closeListeners = [];
  }

  get open_() { return !!(this.win && !this.win.closed); }

  /** Call directly inside a click handler — see the class doc on gesture timing. */
  async open() {
    if (!this.available) throw new Error('Document Picture-in-Picture not supported in this browser');
    if (this.open_) return this.win;
    this.win = await window.documentPictureInPicture.requestWindow({
      width: this.opts.width, height: this.opts.height
    });
    const doc = this.win.document;
    doc.title = 'Sign captions';
    doc.body.style.cssText = 'margin:0;background:#0d1117;overflow:hidden;height:100vh;';
    this.strip = new CaptionStrip(doc.body, {
      maxLines: this.opts.maxLines, fadeMs: this.opts.fadeMs, fontPx: this.opts.fontPx
    });
    // user closing the floating window via its own chrome — not us calling close()
    this.win.addEventListener('pagehide', () => {
      this.win = null; this.strip = null;
      for (const cb of this._closeListeners) cb();
    });
    return this.win;
  }

  /** Fires when the window closes for any reason (our close() or the user's). */
  onClose(cb) { this._closeListeners.push(cb); }

  /** No-op (not an error) when the window isn't open — safe to call unconditionally. */
  push(text, opts) {
    if (this.strip) this.strip.push(text, opts);
  }

  close() {
    if (this.open_) this.win.close();     // triggers the pagehide handler above
    this.win = null; this.strip = null;
  }
}
