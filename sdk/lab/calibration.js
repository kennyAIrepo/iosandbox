/**
 * hopeOS lab — CalStore (contract stage 2: MID, data half)
 * ═══════════════════════════════════════════════════════════════
 * Per-user calibration: the numbers that make "your wide-open" and
 * "anyone else's wide-open" the same normalized 1.0 before the value
 * crosses into puppet space. Two-step ritual (neutral hold → range
 * burst), persisted in localStorage under one key so every lab page
 * (riglab / taplab / pipeline) shares the same calibration.
 */

const KEY = 'riglab.cal.v1';

export const DEFAULT_CAL = {
  'mouth.open': { neutral: 0.05, max: 0.7 },
  'tongue.out': { neutral: 0.0, max: 0.55 },
  'eye.L': { open: 0.30, closed: 0.08 },
  'eye.R': { open: 0.30, closed: 0.08 }
};

export class CalStore {
  constructor() {
    this.cal = JSON.parse(localStorage.getItem(KEY) || 'null')
            || JSON.parse(JSON.stringify(DEFAULT_CAL));
    this.capture = null;      // {kind, until, acc[]}
    this.message = '';
  }

  get stored() { return !!localStorage.getItem(KEY); }
  get armed() { return this.capture?.kind || null; }

  start(kind, ms) {
    this.capture = { kind, until: performance.now() + ms, acc: [] };
    this.message = kind === 'neutral'
      ? 'hold still, face relaxed, mouth closed…'
      : 'open WIDE, blink hard, tongue OUT…';
  }

  /** Feed raw measures each face frame; resolves the ritual when time is up. */
  feed(raw) {
    const c = this.capture;
    if (!c) return false;
    c.acc.push({ mar: raw['mouth.open'], eL: raw['eye.blink.L'], eR: raw['eye.blink.R'],
                 t: raw['tongue.out'] || 0 });
    if (performance.now() < c.until) return false;

    const a = c.acc, n = a.length || 1;
    if (c.kind === 'neutral') {
      this.cal['mouth.open'].neutral = a.reduce((s, x) => s + x.mar, 0) / n;
      this.cal['eye.L'].open = a.reduce((s, x) => s + x.eL, 0) / n;
      this.cal['eye.R'].open = a.reduce((s, x) => s + x.eR, 0) / n;
      this.message = `neutral set: MAR ${this.cal['mouth.open'].neutral.toFixed(3)}, ` +
        `EAR ${this.cal['eye.L'].open.toFixed(2)}/${this.cal['eye.R'].open.toFixed(2)}`;
    } else {
      this.cal['mouth.open'].max = Math.max(...a.map(x => x.mar));
      this.cal['tongue.out'].max = Math.max(this.cal['tongue.out'].max, ...a.map(x => x.t));
      this.cal['eye.L'].closed = Math.min(...a.map(x => x.eL));
      this.cal['eye.R'].closed = Math.min(...a.map(x => x.eR));
      this.message = `range set: MAR max ${this.cal['mouth.open'].max.toFixed(2)}, ` +
        `tongue ${this.cal['tongue.out'].max.toFixed(2)}, ` +
        `EAR closed ${this.cal['eye.L'].closed.toFixed(2)}/${this.cal['eye.R'].closed.toFixed(2)}`;
    }
    localStorage.setItem(KEY, JSON.stringify(this.cal));
    this.capture = null;
    return true;                 // ritual completed this frame
  }

  /** The stage-1→3 handshake artifact: contract id + user cal + puppet alignment. */
  exportHandshake(contractId, alignment) {
    return {
      contract_id: contractId || null,
      captured: new Date().toISOString(),
      human_cal: this.cal,
      puppet_alignment: alignment || null
    };
  }

  download(contractId, alignment) {
    const blob = new Blob([JSON.stringify(this.exportHandshake(contractId, alignment), null, 1)],
                          { type: 'application/json' });
    const a = Object.assign(document.createElement('a'),
      { href: URL.createObjectURL(blob), download: 'face-handshake.json' });
    a.click();
  }
}
