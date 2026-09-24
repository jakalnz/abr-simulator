/* Compact, versioned, bit-packed share codec for ABR patients (#case=<base64url>).
 * Same approach as the immittance simulator's caseCodec.js: fixed-width fields + UTF-8 name at the end.
 */
(function (root) {
  'use strict';
  const VERSION = 4;                     // v2 adds the EEG-noise level (v1: 30%); v3 adds per-ear CM type, click morphology and PAM (older: 0);
                                         // v4 adds the electrode start state (0 on as found, 1 difficult skin, 2 not attached, 3 ready at 1.0 kOhm; older: 0)
  const NOISE_LEVELS = [0, 0.1, 0.2, 0.3, 0.4, 0.5, 0.65, 0.8, 1, 1.5, 2];

  class BitWriter {
    constructor() { this.bits = []; }
    write(v, n) { v = Math.max(0, Math.min((1 << n) - 1, Math.round(v))); for (let i = n - 1; i >= 0; i--) this.bits.push((v >> i) & 1); }
    bytes() {
      const out = new Uint8Array(Math.ceil(this.bits.length / 8));
      this.bits.forEach((b, i) => { if (b) out[i >> 3] |= 0x80 >> (i & 7); });
      return out;
    }
  }
  class BitReader {
    constructor(bytes) { this.b = bytes; this.pos = 0; }
    read(n) { let v = 0; for (let i = 0; i < n; i++, this.pos++) v = (v << 1) | ((this.b[this.pos >> 3] >> (7 - (this.pos & 7))) & 1); return v; }
  }
  const b64 = (u8) => btoa(String.fromCharCode(...u8)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  const unb64 = (s) => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0));

  function encode(p) {
    const w = new BitWriter();
    w.write(VERSION, 4);
    w.write(p.adult ? 1 : 0, 1);
    w.write(p.ageMonths, 6);
    w.write(p.noisy ? 1 : 0, 1);
    w.write(Math.max(0, NOISE_LEVELS.indexOf(p.noise == null ? 0.3 : p.noise)), 4);
    for (const e of p.ears) {
      for (const v of e.ac) w.write(v / 5 + 1, 5);          // -5..150 dB HL in 5 dB steps
      for (const v of e.bc) w.write(v / 5 + 1, 5);
      w.write(e.path, 2); w.write(e.sev, 2); w.write(e.cm, 2);
      for (const l of [e.latI, e.latIII, e.latV]) { w.write(l == null ? 0 : 1, 1); w.write((l || 0) * 20, 8); }
      w.write(e.ring || 0, 1); w.write(e.morph || 0, 3); w.write(e.pam || 0, 2);
    }
    w.write(p.electrodes || 0, 2);
    const name = new TextEncoder().encode((p.name || '').slice(0, 60));
    const head = w.bytes();
    const out = new Uint8Array(head.length + 1 + name.length);
    out.set(head); out[head.length] = name.length; out.set(name, head.length + 1);
    return b64(out);
  }

  function decode(str) {
    const bytes = unb64(str);
    const r = new BitReader(bytes);
    const ver = r.read(4);
    if (ver < 1 || ver > 4) throw new Error('Unsupported case version');
    const p = { adult: !!r.read(1), ageMonths: r.read(6), noisy: !!r.read(1), noise: 0.3, ears: [] };
    if (ver >= 2) { const ni = r.read(4); p.noise = NOISE_LEVELS[ni] == null ? 0.3 : NOISE_LEVELS[ni]; }
    for (let i = 0; i < 2; i++) {
      const e = { ac: [], bc: [] };
      for (let k = 0; k < 4; k++) e.ac.push((r.read(5) - 1) * 5);
      for (let k = 0; k < 4; k++) e.bc.push((r.read(5) - 1) * 5);
      e.path = r.read(2); e.sev = r.read(2); e.cm = r.read(2);
      for (const key of ['latI', 'latIII', 'latV']) { const has = r.read(1), v = r.read(8); e[key] = has ? v / 20 : null; }
      if (ver >= 3) { e.ring = r.read(1); e.morph = r.read(3); e.pam = r.read(2); } else { e.ring = 0; e.morph = 0; e.pam = 0; }
      p.ears.push(e);
    }
    p.electrodes = ver >= 4 ? r.read(2) : 0;
    const headBytes = Math.ceil(r.pos / 8);
    const len = bytes[headBytes];
    p.name = new TextDecoder().decode(bytes.slice(headBytes + 1, headBytes + 1 + len));
    return p;
  }

  root.ABRCodec = { encode, decode };
  if (typeof module !== 'undefined') module.exports = root.ABRCodec;
})(typeof window !== 'undefined' ? window : globalThis);
