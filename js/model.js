/* ABR physiology model: channel-based auditory-nerve population model + brainstem wave generators.
 *
 *   stimulus -> per-place (CF) excitation (from patient thresholds, transducer, cross-hearing)
 *            -> nerve firing amplitude/latency/synchrony per CF channel
 *            -> wave I/II/III/IV/V generators (biphasic unitary responses) summed over CF channels
 *            -> recording channels (electrode at each ear: ipsilateral / contralateral morphology)
 *            -> + CM / stimulus artifact -> filters -> + EEG noise (averaging model)
 *
 * Everything the UI needs goes through: ABRModel.simulate(), ABRModel.Acquisition.
 * Ears: index 0 = Right, 1 = Left. Amplitudes in microvolts, times in ms.
 */
(function (root) {
  'use strict';

  const FS = 20000;                    // Hz
  const DT = 1000 / FS;                // ms
  const TS0 = -8, TS1 = 40;            // internal window (ms) so filters have run-in
  const W0 = -1, W1 = 13;              // displayed window (ms)
  const NS = Math.round((TS1 - TS0) * FS / 1000) + 1;
  const I0 = Math.round((W0 - TS0) * FS / 1000);
  const NW = Math.round((W1 - W0) * FS / 1000) + 1;                 // click window
  const W1_TONE = 25;                                              // tone-burst ABR analysis window (ms)
  const nwFor = (stim) => Math.round(((stim.freq ? W1_TONE : W1) - W0) * FS / 1000) + 1;

  const FREQS = [500, 1000, 2000, 4000];
  const ABR_CORR_AC = [10, 10, 5, 0];  // dB nHL -> dB eHL (UNHSEIP/BCEHP protocol)
  const ABR_CORR_BC = [-12, -8, -4, -4];   // BC normal ABR threshold ~3/7/11/11 dB nHL (Stapells & Ruben 1989: infant 500 Hz detectable ~0-10, 2 kHz ~10-20 dB nHL)
  const ABR_BASE = 15;                 // normal ABR threshold (nHL) sits ~15 dB above 0 dB HL
  const CH_CF = [500, 700, 1000, 1400, 2000, 2800, 4000, 5600, 8000];
  const CH_W  = [0.15, 0.35, 0.6, 0.85, 1, 1, 1, 0.7, 0.4];
  const CLICK_W = [0, 0.25, 0.35, 0.4];       // click threshold weighting of 0.5/1/2/4 kHz
  const INTERAURAL_ATT_BONE = 6;             // dB, effective cross-hearing loss for bone conduction (ipsilateral channel dominates)
  const INTERAURAL_ATT_INSERT = 65;           // dB, insert earphones (NZAS guideline)
  const MAX_LEVEL = {
    insert: { click: 100, tone: 100 },
    bone:   { click: 50,  tone: [50, 55, 60, 60] }
  };

  const WAVES = ['I', 'II', 'III', 'IV', 'V'];
  // amplitude (uV at saturation), compression exponent, level-latency growth (ms), width (ms),
  // trough (rel. depth, delay ms, width ms), contralateral gain & delay
  // wave I level-latency (D) fitted to Kelly 1996 insert norms: I 1.82 / 1.66 / 1.59 ms at 70 / 80 / 90 dB nHL with I-V
  // constant (4.06 / 4.04 / 4.06); D 2.5 had I-V shrinking 4.20 -> 4.05 over the same range. II moves with I.
  const WV = {
    I:   { A: 0.45, p: 1.35, D: 3.5, su: 0.18, tr: [0.25, 0.50, 0.35], cg: 0.05, cd: 0.0 },
    II:  { A: 0.09, p: 1.2,  D: 3.6, su: 0.20, tr: [0.2, 0.5, 0.4],    cg: 0.30, cd: 0.1 },
    III: { A: 0.42, p: 1.0,  D: 3.4, su: 0.26, tr: [0.3, 0.6, 0.45],  cg: 0.55, cd: 0.15 },
    IV:  { A: 0.14, p: 0.85, D: 3.9, su: 0.28, tr: [0.1, 0.6, 0.5],    cg: 1.0,  cd: 0.1 },
    V:   { A: 0.85, p: 0.7,  D: 4.2, su: 0.30, tr: [0.9, 0.9, 0.55], cg: 0.65, cd: 0.3 }
  };
  /* Click morphology variants (per ear, a case setting). Multipliers on each wave's amplitude (a) and width (w), plus a
   * latency shift (dt, ms). Shapes follow the range seen in clinical adult click printouts (80 dB nHL, 100-3000 Hz):
   * a small II and a IV shoulder on V (standard); IV and V as separate peaks; a broad fused IV/V complex; IV larger with V
   * as a shoulder on its down-slope; III larger than V. calibrate() runs on Standard, so I/III/V sit on TARGET there. */
  const MORPH = [
    { II: { a: 2.4, w: 0.8 }, IV: { a: 3.4, dt: -0.15, w: 0.7 } },                                    // 0 Standard
    { II: { a: 3.2, w: 0.7 }, IV: { a: 3.4, dt: -0.3, w: 0.6 }, V: { w: 0.8 } },                         // 1 Separate IV and V
    { II: { a: 1.5 }, IV: { a: 5.5, dt: 0.12, w: 0.75 }, V: { a: 0.72, dt: 0.05, w: 0.8 } },         // 2 Fused IV/V complex
    { II: { a: 2 }, IV: { a: 6, dt: -0.1, w: 0.8 }, V: { a: 0.5, dt: 0.15, w: 0.85 } },                  // 3 IV dominant, V shoulder
    { II: { a: 2 }, III: { a: 1.8, w: 0.9 }, IV: { a: 1.5 }, V: { a: 0.55 } }                            // 4 Large III, small V
  ];
  const MORPH_NAMES = ['Standard', 'Separate IV and V', 'Fused IV/V complex', 'IV dominant (V shoulder)', 'Large III, small V'];
  const TARGET = { I: 1.66, III: 3.82, V: 5.75 };       // Kelly (1996) adult, 80 dB nHL, 17.1/s, insert
  const OFFSET = { I: 0, II: 0, III: 0, IV: 0, V: 0 };  // set by calibrate()
  const TAU_A = 25, TAU_D = 38;
  // tone-burst response size: V-V' grows ~1 : 1.75 : 2.5 from 25 to 65 dB nHL at 2 kHz in clinical infant printouts
  const TAU_TONE = 80, TONE_W = 0.83;
  const RETRO_S = [0.35, 0.65, 1.0, 1.6];
  const ANSD_D = [0.4, 0.7, 0.9, 1.0];
  // CM source gain (uV) at 90 dB nHL (insert click) for Absent/Small/Moderate/Large; after the 100-3000 Hz filter Large gives
  // ~0.35-0.4 uV peaks, as in clinical ANSD click printouts (90 dB nHL). Growth is linear up to 70 dB and compressive (0.5 dB/dB) above, so the CM
  // saturates at 90-100 dB instead of rising 10x and swamping wave I.
  const CM_GAIN = [0, 0.12, 0.32, 0.8];
  const cmGrowth = (L) => Math.pow(10, (L >= 70 ? 0.5 * (L - 90) : -10 + (L - 70)) / 20);
  // x0.45 overall to match clinical infant tone-burst printouts (normal ears, 30-3000 Hz, alternating, ~2000-4000 sweeps):
  // V-V' ~80 / 140 / 200 nV at 2 kHz 25 / 45 / 65 dB nHL, ~130 nV at 4 kHz 45 dB, BC 2 kHz 45 dB ~200 nV
  const TONE_GAIN = { I: 0.09, II: 0.09, III: 0.135, IV: 0.2, V: 0.36 };

  // frequency-dependent tone-burst amplitude: low-frequency tone V-V' complexes are larger and grow more linearly with level
  // (Stapells & Ruben 1989 Fig 3: 500 Hz 0.11 -> 0.46 uV over 0-40 dB nHL; 2 kHz 0.18 -> 0.25 uV, saturating above 30 dB)
  // Clinical infant printouts: 500 Hz V-V' ~100 / 150 / 200 nV at 35 / 45 / 55 dB nHL (relatively larger than 2 kHz than before)
  const TONE_FREQ_GAIN = [3.4, 1.8, 1.2, 1.0];
  // BC tone-burst gain: low-frequency BC tones excite a wider cochlear area (Stapells & Ruben 1989 discussion); 2-4 kHz raised so
  // infant BC 2 kHz at 45 dB nHL gives ~0.2 uV ipsi (Stapells & Ruben 1989: 0.18-0.25 uV; clinical infant BC printouts)
  const BONE_LF_GAIN = [1.2, 1.3, 1.5, 1.5];
  // dB-equivalent onset offset for tone-burst amplitude growth: 500 Hz grows steeply with level (0.11 -> 0.46 uV over 0-40 dB nHL),
  // 2 kHz is nearly saturated at threshold (0.18 -> 0.25 uV; Stapells & Ruben 1989 Fig 3)
  const TONE_ONSET = [4, 8, 10, 10];
  const clamp = (x, a, b) => Math.max(a, Math.min(b, x));

  /* ---------- patient ---------- */
  function newEar(o) {
    return Object.assign({ ac: [5, 5, 5, 5], bc: [0, 0, 0, 0], path: 0, sev: 0, cm: 1, ring: 0, morph: 0, pam: 0,
                           latI: null, latIII: null, latV: null }, o || {});
  }
  function newPatient(o) {
    const p = Object.assign({ name: 'New patient', adult: true, ageMonths: 4, noisy: false, noise: 0.3 }, o || {});   // noise = EEG noise multiplier (case setting)
    p.ears = [newEar(o && o.ears && o.ears[0]), newEar(o && o.ears && o.ears[1])];
    return p;
  }

  function interp(arr, f) {                  // arr at FREQS, log-frequency interpolation, flat extrapolation
    if (f <= FREQS[0]) return arr[0];
    if (f >= FREQS[3]) return arr[3];
    for (let i = 0; i < 3; i++) {
      if (f <= FREQS[i + 1]) {
        const x = Math.log(f / FREQS[i]) / Math.log(FREQS[i + 1] / FREQS[i]);
        return arr[i] + x * (arr[i + 1] - arr[i]);
      }
    }
    return arr[3];
  }
  /* Air-conduction tone-burst ABR threshold (dB nHL) from the behavioural audiogram (dB HL).
   * Stapells, Gravel & Martin 1995 (infants/children, tones in notched noise, 2-1-2 cycles, 39.1/s):
   *   ABR (nHL) - behavioural (HL), all ears: +8.6 (0.5 kHz), -0.4 (2 kHz), -4.3 (4 kHz); 1 kHz interpolated.
   *   Normal ears: ABR threshold 23.6 / 12.9 / 12.6 dB nHL at 0.5 / 2 / 4 kHz (behavioural ~14-16 dB HL).
   * ABR thresholds cannot fall below the normal floor (Gorga et al. 2006: minimum response level ~20 dB nHL and
   * ABR overestimates thresholds in normal hearing, underestimates in loss), hence max(HL + diff, normal). */
  const TONE_DIFF = [8.6, 4.1, -0.4, -4.3], TONE_NORMAL = [23.6, 18.2, 12.9, 12.6];
  const thrTone = (hl, f) => Math.max(interp(hl, f) + interp(TONE_DIFF, f), interp(TONE_NORMAL, f));
  const thrNHL = (hl, corr, f) => interp(hl, f) + interp(corr, f) + ABR_BASE;
  const clickHL = (hl) => hl.reduce((s, v, i) => s + v * CLICK_W[i], 0);
  const clickThr = (hl, corr) => clickHL(hl) + corr.reduce((s, v, i) => s + v * CLICK_W[i], 0) + ABR_BASE;

  const tw = (cf) => 0.1 + 1.2 * Math.pow(cf / 1000, -0.6);            // travelling-wave delay (ms)
  const envDelay = (f) => (f ? 0.9 * 1000 / f : 0);                    // tone-burst envelope delay
  const envJit = (f) => (f ? 0.4 * Math.pow(1000 / f, 0.8) : 0);       // tone-burst timing spread

  /* Tone-burst wave V latency (Neely et al. 1988, JASA 83:652, Eq. 1; normal adults, 20-100 dB SPL):
   *   L = 5.0 + 12.9 * 5^(-SPL/100) * f_kHz^(-0.413)  ms
   * Their stimuli had 4/2/2/1 ms rise times at 0.5/1/2/4 kHz; clinical 2-1-2 bursts have 4/2/1/0.5 ms, so the
   * 2 and 4 kHz latencies are shortened by half the rise-time difference. The level is converted to an
   * equivalent normal-hearing SPL as (normal ABR threshold in SPL) + sensation level, so hearing loss and
   * recruitment move the latency along the same function. Interpeak intervals stay at the click values
   * (constant central conduction time, as assumed by Gorga et al. 1988). */
  const THR_SPL = [40, 34, 28, 30];                       // approx. normal adult ABR tone thresholds (dB SPL; Gorga 1988 Table 2)
  const RISE_NEELY = { 500: 4, 1000: 2, 2000: 2, 4000: 1 }, RISE_CLIN = { 500: 4, 1000: 2, 2000: 1, 4000: 0.5 };
  const IPL = { I: TARGET.V - TARGET.I, II: TARGET.V - TARGET.I - 1.05, III: TARGET.V - TARGET.III, IV: 0.55, V: 0 };
  function toneLatency(f, sl, k) {
    const spl = clamp(interp(THR_SPL, f) + Math.max(sl, 0), 20, 100);
    const v = 5.0 + 12.9 * Math.pow(5, -spl / 100) * Math.pow(f / 1000, -0.413);
    const corr = 0.5 * ((RISE_NEELY[f] || 0) - (RISE_CLIN[f] || 0));
    return v - corr - IPL[k];
  }

  /* Maturation (Gorga, Kaminski, Beauchaine, Jesteadt & Neely 1989, JSHR 32:281; 535 children 3 mo-3 y + term infants):
   *   wave V latency = 4.89 + 4.46 exp(-0.0318 a) + 5.31 exp(-0.0264 L)   (a = conceptional age in weeks, L = dB HLn)
   * The level term alone is the adult curve, so the age term is the extra wave V delay. Wave I latency does not change
   * from 3 months, so almost all of the delay is in the I-V interval; the published I-III / III-V intervals (Table 4)
   * shrink in roughly a 65:35 ratio. ageMonths = 0 is a term baby (40 weeks CA). */
  /* Children are NOT fitted to the Kelly adult latencies: Kelly's picks are later (conservative peak-selection criterion).
   * Instead the child curves sit on the Gorga 1989 data themselves. At 33-36 months their means at 80 dB HLn are
   * I 1.56, III 3.73, V 5.66 ms (adult V 5.53 + ~0.1 ms), i.e. 0.07-0.12 ms earlier than the Kelly-based adult
   * anchor used above; CHILD_BASE moves the child family onto that reference. */
  const CHILD_BASE = { I: -0.07, II: -0.08, III: -0.09, IV: -0.10, V: -0.12 };
  function ageShift(p, k) {
    if (p.adult) return 0;
    const wk = p.ageMonths * 4.345, a = 40 + wk;
    const dV = 4.46 * Math.exp(-0.0318 * a);
    const wI = 0.08 * Math.exp(-wk / 10);
    const ipl = Math.max(0, dV - wI);
    return CHILD_BASE[k] + { I: wI, II: wI + 0.3 * ipl, III: wI + 0.65 * ipl, IV: wI + 0.85 * ipl, V: dV }[k];
  }
  function rateFactor(rate) {
    const f = Math.log(rate / 17.1) / Math.log(65.1 / 17.1);
    return clamp(f, -0.7, 1.5);
  }
  function pathShift(ear, k) {
    if (ear.path !== 1) return 0;
    const s = RETRO_S[ear.sev];
    return { I: 0, II: 0.2 * s, III: 1.0 * s, IV: 1.4 * s, V: 1.8 * s }[k];
  }

  /* nominal (80 dB nHL, 17.1/s, rarefaction, insert) latency of a wave for this ear, before manual override */
  function nominalLatency(p, e, k) {
    const ear = p.ears[e];
    let m = 0, sw = 0;
    for (let c = 0; c < CH_CF.length; c++) { m += CH_W[c] * tw(CH_CF[c]); sw += CH_W[c]; }
    return OFFSET[k] + m / sw + WV[k].D * Math.exp(-65 / TAU_D) + ageShift(p, k) + pathShift(ear, k);
  }
  function overrideShift(p, e, k) {
    const t = { I: p.ears[e].latI, III: p.ears[e].latIII, V: p.ears[e].latV }[k];
    if (t == null) {
      // keep II / IV in step with the neighbouring waves they sit between
      if (k === 'II') return overrideShift(p, e, 'I') * 0.6 + overrideShift(p, e, 'III') * 0.4;
      if (k === 'IV') return overrideShift(p, e, 'III') * 0.4 + overrideShift(p, e, 'V') * 0.6;
      return 0;
    }
    return t - nominalLatency(p, e, k);
  }

  /* ---------- cochlear input for each ear ----------
   * returns per cochlea c: level at the cochlea (dB nHL), threshold function of CF, conductive gap */
  /* Bone-conduction interaural attenuation falls with maturation (Yang et al. 1987, cited by Stapells & Ruben 1989):
   * ~25-35 dB in neonates, 15-25 dB at 1 year, 0-10 dB in adults. Stapells & Ruben (2 wk-2 y, mean 6 mo) found the
   * ipsilateral channel clearly larger/earlier for BC tones up to 30 dB nHL and near equal at 40 dB nHL. */
  function boneIA(p) { return p.adult ? INTERAURAL_ATT_BONE : 5 + 27 * Math.exp(-p.ageMonths / 9); }
  function cochleaInputs(p, stim) {
    const out = [];
    for (let c = 0; c < 2; c++) {
      const ear = p.ears[c];
      const bone = stim.transducer === 'bone';
      let level = stim.level;
      if (c !== stim.ear) level -= bone ? boneIA(p) : INTERAURAL_ATT_INSERT;
      const hl = bone ? ear.bc : ear.ac;
      const corr = bone ? ABR_CORR_BC : ABR_CORR_AC;
      const gap = Math.max(0, clickHL(ear.ac) - clickHL(ear.bc));
      out.push({ level, hl, corr, gap, bone });
    }
    return out;
  }

  /* CF-channel excitation (dB above the ABR threshold at that place) */
  function excitation(inp, stim, ci, ear) {
    const cf = CH_CF[ci];
    const thr = (stim.freq && !inp.bone) ? thrTone(inp.hl, cf) : thrNHL(inp.hl, inp.corr, cf);
    let att = 0;
    if (stim.freq) {                       // tone-burst: excitation spreads from the stimulus place
      const oct = Math.log2(cf / stim.freq);
      att = oct >= 0 ? 55 * oct : -32 * oct;      // above-CF fibres steep, below-CF (upward spread) shallow
    }
    return inp.level - att - thr + (stim.freq ? 0 : 6);   // click: broadband temporal summation
  }

  function toneFreqGain(f) { return interp(TONE_FREQ_GAIN, f); }
  function gauss(t, mu, s) { const z = (t - mu) / s; return Math.exp(-0.5 * z * z); }

  /* ---------- clean (noise-free, filter-free) response on the internal grid ---------- */
  function neuralResponse(p, stim, c, target /* recording channel ear */) {
    const ear = p.ears[c];
    const inp = cochleaInputs(p, stim)[c];
    const ipsi = c === target;
    const f = stim.freq || 0;
    const rf = rateFactor(stim.rate);
    const cond = stim.polarity === 'cond';
    const sig = new Float64Array(NS);
    const bone = stim.transducer === 'bone';
    const tubeShift = bone && !f ? -0.35 : 0;                        // no tubing delay for the bone conductor
    const wavesMeta = {};

    const retroS = ear.path === 1 ? RETRO_S[ear.sev] : 0;
    const ansdD = ear.path === 2 ? ANSD_D[ear.sev] : 0;

    const morph = f ? {} : (MORPH[ear.morph] || MORPH[0]);
    /* Tone bursts are treated as one response: its size and wave V latency follow the best-excited place (Emax; the tone
     * place in a normal ear, Neely et al. 1988 latency as a function of level), and the amplitude is shared out over the
     * excited CF channels, each keeping its travelling-wave delay relative to the tone place. Summing independent
     * channels made the V-V' grow too steeply with level (more channels joining) and V drift later again above ~70 dB. */
    const Eex = CH_CF.map((cf, ci) => { const E = excitation(inp, stim, ci, ear); return E > 0 ? E * (1 + 0.6 * clamp(interp(ear.bc, cf) / 60, 0, 1)) : 0; });
    const Emax = Math.max(...Eex);
    const wTone = Eex.map((E) => (E > 0 ? Math.exp(-(Emax - E) / 12) : 0));
    const wSum = wTone.reduce((x, y) => x + y, 0) || 1;
    for (let ci = 0; ci < CH_CF.length; ci++) {
      const E = excitation(inp, stim, ci, ear);
      if (E <= 0) continue;
      const bcHL = interp(bone ? ear.bc : ear.bc, CH_CF[ci]);
      const rec = 0.6 * clamp(bcHL / 60, 0, 1);             // recruitment (sensorineural part only)
      const Ee = E * (1 + rec);
      // tone bursts: slower saturation (TAU_TONE) and an onset offset so a detectable (~2x residual noise) response exists at threshold
      const a = f ? 1 - Math.exp(-(Emax + interp(TONE_ONSET, f)) / TAU_TONE) : 1 - Math.exp(-Ee / TAU_A);
      const w = f ? TONE_W * wTone[ci] / wSum : CH_W[ci] / 5.2;
      const jit = (0.05 + 0.25 * Math.exp(-Ee / 25)) * (1 + 6 * ansdD);
      for (const k of WAVES) {
        const W = WV[k];
        let amp = W.A * w * Math.pow(a, f ? 1 : W.p);   // tone bursts: near-linear growth with level
        if (f) amp *= TONE_GAIN[k] * toneFreqGain(f) * (bone ? interp(BONE_LF_GAIN, f) : 1);
        if (!ipsi) amp *= W.cg;
        amp *= adultAmp(p, k);
        // rate: I/III/II adapt more than V
        const rateAmp = { I: 0.30, II: 0.30, III: 0.25, IV: 0.15, V: 0.10 }[k] * (1 + 1.5 * retroS);
        amp *= 1 - rateAmp * (rf > 0 ? rf : rf * 0.4);
        if (cond && (k === 'I' || k === 'II')) amp *= 0.92;
        // pathology
        if (retroS) {
          if (k === 'III') amp *= clamp(1 - 0.3 * retroS, 0, 1);
          if (k === 'IV' || k === 'V') amp *= clamp(1 - 0.4 * retroS, 0.1, 1);
          if (retroS > 1.2 && k !== 'I' && k !== 'II') amp *= 0.15;
        }
        if (ansdD) amp *= Math.pow(1 - ansdD, 1.5);
        const mo = morph[k] || {};
        if (mo.a) amp *= mo.a;
        // timing
        let mu = (f ? toneLatency(f, Emax, k) + (tw(CH_CF[ci]) - tw(f)) : OFFSET[k] + tw(CH_CF[ci]) + W.D * Math.exp(-Ee / TAU_D))
               + ageShift(p, k) + pathShift(ear, k) + overrideShift(p, c, k) + tubeShift
               + (ipsi ? 0 : W.cd)
               + rf * { I: 0.10, II: 0.13, III: 0.20, IV: 0.28, V: 0.35 }[k] * (1 + 1.5 * retroS)
               + (cond ? 0.06 : 0) + (mo.dt || 0);
        // Tone bursts: the response is spread in time by the burst itself, so the V-V' complex is broad and slow at low
        // frequencies (~1 ms sigma at 0.5 kHz, ~0.25 ms at 2 kHz) and the trough after V is later and wider.
        const senv = f ? 0.5 * 1000 / f : 0;
        const su0 = W.su * (mo.w || 1);
        const su = Math.sqrt(su0 * su0 + jit * jit + senv * senv);
        const h = amp * (f ? Math.sqrt(su0 / su) : su0 / su);
        const kf = f ? 1 + 3 * senv : 1;
        const trb = W.tr[0] * (f ? 0.7 : 1), trd = W.tr[1] * kf, trs = W.tr[2] * kf;
        const lo = Math.max(0, Math.floor((mu - 4 * su - TS0) / DT));
        const hi = Math.min(NS - 1, Math.ceil((mu + trd + 4 * trs - TS0) / DT));
        for (let i = lo; i <= hi; i++) {
          const t = TS0 + i * DT;
          sig[i] += h * (gauss(t, mu, su) - trb * gauss(t, mu + trd, trs));
        }
      }
    }
    // slow late activity after wave V (VI/VII / SN10 tail)
    return sig;
  }
  function adultAmp(p, k) {
    if (p.adult) return 1;
    return { I: 1.25, II: 1.1, III: 1.05, IV: 1, V: 1 }[k];
  }

  function tubeDelay(stim) { return stim.transducer === 'bone' ? 0.15 : 0.95; }

  function cmResponse(p, stim, c, ipsi) {
    const ear = p.ears[c];
    const sig = new Float64Array(NS);
    if (stim.polarity === 'alt' || stim.clamped) return sig;
    const inp = cochleaInputs(p, stim)[c];
    const gain = CM_GAIN[ear.cm];
    if (!gain) return sig;
    const ohc = ear.path === 2 ? 1 : clamp(1 - clickHL(ear.bc) / 60, 0, 1);
    const eff = inp.level - (stim.transducer === 'bone' ? 0 : inp.gap);
    const amp = gain * ohc * cmGrowth(eff) * (ipsi ? 1 : 0.1);
    if (amp < 1e-4) return sig;
    const sign = stim.polarity === 'rare' ? 1 : -1;
    const t0 = tubeDelay(stim) - 0.05;
    const f = stim.freq;
    // ringing CM (often seen in ANSD): lower frequency and a long decay, ringing on for ~4-5 ms
    // (clinical ANSD click printouts: period ~0.65 ms, still visible at ~4 ms, inverting between polarities)
    const ring = ear.ring && !f;
    const fr = ring ? 1.5 : 2.4, tau = ring ? 1.3 : 0.28;
    for (let i = 0; i < NS; i++) {
      const t = TS0 + i * DT - t0;
      if (t < 0) continue;
      if (!f) sig[i] += sign * amp * Math.sin(2 * Math.PI * fr * t) * Math.exp(-t / tau) * (ring ? 1 - Math.exp(-t / 0.25) : 1);
      else {
        const T = 1000 / f, dur = 5 * T;                    // 2-1-2 cycle tone-burst
        if (t > dur) continue;
        sig[i] += sign * amp * 0.5 * burstEnv(t, T) * Math.sin(2 * Math.PI * f / 1000 * t);
      }
    }
    return sig;
  }
  function burstEnv(t, T) {                       // 2-1-2 cycle envelope
    return t < 2 * T ? Math.sin(Math.PI / 2 * t / (2 * T)) ** 2
         : t < 3 * T ? 1 : Math.cos(Math.PI / 2 * (t - 3 * T) / (2 * T)) ** 2;
  }
  /* Electrical stimulus artefact from the transducer: present at t = 0 (no tube delay), so it survives a clamped insert
   * tube while the CM (which is acoustic and arrives after the ~0.9 ms tube delay) disappears (UNHSEIP 5.36 clamp test).
   * It inverts with polarity; condensation is slightly weaker than rarefaction, so alternating polarity leaves a residual
   * (BCEHP 2022: transducer asymmetry, worst for BC 0.5 kHz and AC 90-100 dB nHL). Tone bursts follow the burst waveform. */
  function artifact(stim, ipsi) {
    const sig = new Float64Array(NS);
    if (stim.polarity === 'alt') return sig;
    const bone = stim.transducer === 'bone', f = stim.freq;
    const amp = (bone ? 0.30 : 0.15) * Math.pow(10, (stim.level - (bone ? 40 : 80)) / 20) * (ipsi ? 1 : 0.6)
              * (stim.polarity === 'cond' ? -0.75 : 1);
    if (Math.abs(amp) < 1e-4) return sig;
    for (let i = 0; i < NS; i++) {
      const t = TS0 + i * DT - (bone ? 0 : 0.05);
      if (t < 0) continue;
      if (!f) sig[i] += amp * Math.sin(2 * Math.PI * 3.5 * t) * Math.exp(-t / 0.12);
      else {
        const T = 1000 / f;
        if (t > 5 * T + 1) continue;
        const tail = t > 5 * T ? Math.exp(-(t - 5 * T) / 0.2) : 1;    // brief transducer ring-down after the burst
        sig[i] += amp * 0.8 * burstEnv(Math.min(t, 5 * T), T) * tail * Math.sin(2 * Math.PI * f / 1000 * t);
      }
    }
    return sig;
  }

  /* Post-auricular muscle (PAM) reflex: a large slow wave at ~9-12 ms picked up by the mastoid electrode, seen in some adult
   * click printouts (80 dB nHL, 100-3000 Hz) as a hump of 0.2-0.6 uV peaking ~10-11 ms with a sharp negativity after it.
   * Myogenic, so it does not invert with polarity, grows with level above ~40 dB SL and with muscle tension (noisy state).
   * Recorded mainly by the channel whose ear has it (ear.pam 0 off, 1 small, 2 large); adults only; AC only. */
  const PAM_GAIN = [0, 0.22, 0.5];
  function pamResponse(p, stim, e) {
    const sig = new Float64Array(NS);
    const g = PAM_GAIN[p.ears[e].pam] || 0;
    if (!g || !p.adult || stim.transducer === 'bone' || stim.clamped) return sig;
    const sl = stim.level - clickThr(p.ears[stim.ear].ac, ABR_CORR_AC);
    const amp = g * clamp((sl - 30) / 40, 0, 1) * (p.noisy ? 1.5 : 1) * (e === stim.ear ? 1 : 0.6);
    if (amp < 1e-4) return sig;
    const t1 = 10.2 + (stim.freq ? 0.5 * 1000 / stim.freq : 0) + 0.02 * Math.max(0, 80 - stim.level);
    for (let i = 0; i < NS; i++) { const t = TS0 + i * DT; sig[i] += amp * (gauss(t, t1, 0.75) - 0.7 * gauss(t, t1 + 2.4, 0.6)); }
    return sig;
  }

  /* ---------- filters (zero-phase) ---------- */
  function hp1(x, fc) {
    const rc = 1 / (2 * Math.PI * fc), dt = 1 / FS, a = rc / (rc + dt);
    const y = new Float64Array(x.length);
    y[0] = 0;
    for (let i = 1; i < x.length; i++) y[i] = a * (y[i - 1] + x[i] - x[i - 1]);
    return y;
  }
  function lp2(x, fc) {
    const w0 = 2 * Math.PI * fc / FS, cw = Math.cos(w0), al = Math.sin(w0) / Math.SQRT2;
    const a0 = 1 + al, b0 = (1 - cw) / 2 / a0, b1 = (1 - cw) / a0, b2 = b0;
    const a1 = -2 * cw / a0, a2 = (1 - al) / a0;
    const y = new Float64Array(x.length);
    let x1 = 0, x2 = 0, y1 = 0, y2 = 0;
    for (let i = 0; i < x.length; i++) {
      const v = b0 * x[i] + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2;
      x2 = x1; x1 = x[i]; y2 = y1; y1 = v; y[i] = v;
    }
    return y;
  }
  const rev = (x) => Float64Array.from(x).reverse();
  function filt(x, hp, lp) {
    let y = x;
    if (hp) { y = hp1(y, hp); y = rev(hp1(rev(y), hp)); }
    if (lp) { y = lp2(y, lp); y = rev(lp2(rev(y), lp)); }
    return y;
  }
  const crop = (x, nw) => x.slice(I0, I0 + (nw || NW));

  /* ---------- top-level clean simulation ----------
   * stim: {ear, level, freq (0=click), polarity:'rare'|'cond'|'alt', rate, transducer:'insert'|'bone'}
   * returns {ipsi, contra, hpF, lpF} noise-free, filtered, cropped signals (uV) */
  function simulate(p, stim, opts) {
    opts = opts || {};
    const hp = opts.hp == null ? 100 : opts.hp, lp = opts.lp == null ? 3000 : opts.lp;
    const chan = [0, 1].map((e) => {
      const s = new Float64Array(NS);
      for (let c = 0; c < 2 && !stim.clamped; c++) {     // clamped insert tube: no sound reaches either cochlea
        const n = neuralResponse(p, stim, c, e);
        for (let i = 0; i < NS; i++) s[i] += n[i];
        const cm = cmResponse(p, stim, c, c === e);
        for (let i = 0; i < NS; i++) s[i] += cm[i];
      }
      const art = artifact(stim, e === stim.ear), pam = pamResponse(p, stim, e);
      for (let i = 0; i < NS; i++) s[i] += art[i] + pam[i];
      return crop(filt(s, hp, lp), nwFor(stim));
    });
    return { ipsi: chan[stim.ear], contra: chan[1 - stim.ear] };
  }

  /* ---------- noise ---------- */
  function randn() {
    let u = 0, v = 0;
    while (u === 0) u = Math.random();
    v = Math.random();
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
  }
  function rawNoise(n) {                 // EEG-like: white shaped by a 1-pole low-pass at ~350 Hz
    const x = new Float64Array(n), a = Math.exp(-2 * Math.PI * 350 / FS);
    let y = 0;
    for (let i = 0; i < n; i++) { y = a * y + (1 - a) * randn(); x[i] = y; }
    return x;
  }
  const noiseNormCache = {};
  function noiseScale(hp, lp) {          // std of filtered noise relative to the default 100-3000 Hz filter
    const key = hp + '|' + lp;
    if (noiseNormCache[key] == null) {
      const std = (h, l) => { const y = filt(rawNoise(40000), h, l); let s = 0; for (const v of y) s += v * v; return Math.sqrt(s / y.length); };
      noiseNormCache[key] = std(hp, lp) / std(100, 3000);
    }
    return noiseNormCache[key];
  }
  function noiseBlock(hp, lp, sd, nw) {  // one noise realisation in the displayed window, std ~ sd
    const y = crop(filt(rawNoise(NS), hp, lp), nw);
    const k = sd * noiseScale(hp, lp) / DEFAULT_STD;
    for (let i = 0; i < y.length; i++) y[i] *= k;
    return y;
  }
  const DEFAULT_STD = (() => { let s = 0; const y = crop(filt(rawNoise(NS + 40000), 100, 3000)); for (const v of y) s += v * v; return Math.sqrt(s / y.length); })();

  /* single-sweep EEG sd (uV) at the default filters */
  function sweepNoise(p) {
    if (!p.noisy) return p.adult ? 2.1 : 2.0;
    return p.adult ? 7 : 11;
  }
  function rejectProb(p, reject) {
    const base = p.noisy ? 0.12 : 0.005;
    return clamp(base * Math.pow(40 / reject, 1.5), 0, 0.85);
  }

  /* ---------- acquisition (running average with A/B splits, Bayesian block weighting) ---------- */
  const BLOCK = 25;
  class Acquisition {
    constructor(patient, stim, opts) {
      this.p = patient; this.stim = stim; this.nw = nwFor(stim); this.w1 = W0 + (this.nw - 1) * DT;
      this.opts = Object.assign({ nMax: 2000, reject: 40, hp: 100, lp: 3000, noise: 1 }, opts || {});
      if (stim.polarity === 'alt') {
        // Eclipse-style alternating: buffer A = rarefaction sweeps, buffer B = condensation sweeps.
        // The displayed average is their mean, so the CM cancels while staying visible in A vs B.
        const ra = simulate(patient, Object.assign({}, stim, { polarity: 'rare' }), this.opts);
        const cb = simulate(patient, Object.assign({}, stim, { polarity: 'cond' }), this.opts);
        this.sigA = ra; this.sigB = cb;
        const mean = (x, y) => x.map((v, i) => (v + y[i]) / 2);
        this.clean = { ipsi: mean(ra.ipsi, cb.ipsi), contra: mean(ra.contra, cb.contra) };
      } else {
        this.clean = simulate(patient, stim, this.opts);
        this.sigA = this.sigB = this.clean;
      }
      this.sd1 = sweepNoise(patient) * this.opts.noise;      // opts.noise = user EEG-noise multiplier
      this.n = 0; this.rejected = 0; this.total = 0; this.wsum = [0, 0];
      this.acc = [0, 1].map(() => [new Float64Array(this.nw), new Float64Array(this.nw)]);   // [channel][half] weighted noise sums
      this.blk = 0;
      this.pRej = rejectProb(patient, this.opts.reject);
    }
    get done() { return this.n >= this.opts.nMax; }
    step(nSweeps) {
      while (nSweeps > 0 && !this.done) {
        const b = Math.min(BLOCK, nSweeps);
        nSweeps -= b; this.total += b;
        let acc = 0;
        for (let i = 0; i < b; i++) if (Math.random() >= this.pRej) acc++;
        this.rejected += b - acc;
        acc = Math.min(acc, this.opts.nMax - this.n);
        if (!acc) continue;
        const half = this.blk++ & 1;
        let m = 1 + 0.15 * Math.abs(randn());
        if (this.p.noisy && Math.random() < 0.12) m *= 1.8 + 2.2 * Math.random();   // myogenic burst
        const wt = acc / (m * m);                 // Bayesian: noisier blocks count for less
        for (let ch = 0; ch < 2; ch++) {
          const nb = noiseBlock(this.opts.hp, this.opts.lp, this.sd1 * m / Math.sqrt(acc), this.nw);
          const a = this.acc[ch][half];
          for (let i = 0; i < this.nw; i++) a[i] += nb[i] * wt;
        }
        this.wsum[half] += wt;
        this.n += acc;
      }
    }
    /* residual noise (nV) of the combined average */
    get rn() {
      const w = this.wsum[0] + this.wsum[1];
      return w ? this.sd1 * noiseScale(this.opts.hp, this.opts.lp) * 1000 / Math.sqrt(w) : 0;
    }
    snapshot() {
      const out = { w1: this.w1, n: this.n, rejected: this.total ? this.rejected / this.total : 0, rn: this.rn, ch: [] };
      for (let ch = 0; ch < 2; ch++) {
        const key = ch === 0 ? 'ipsi' : 'contra';
        const sA = this.sigA[key], sB = this.sigB[key], sig = this.clean[key];
        const avg = new Float64Array(this.nw), A = new Float64Array(this.nw), B = new Float64Array(this.nw);
        const wA = this.wsum[0], wB = this.wsum[1], w = wA + wB;
        for (let i = 0; i < this.nw; i++) {
          A[i] = wA ? sA[i] + this.acc[ch][0][i] / wA : 0;
          B[i] = wB ? sB[i] + this.acc[ch][1][i] / wB : 0;
          avg[i] = w ? sig[i] + (this.acc[ch][0][i] + this.acc[ch][1][i]) / w : 0;
        }
        out.ch.push({ avg, A, B });
      }
      const s = out.ch[0];
      // wave reproducibility: A/B correlation over 1-10 ms
      // response window: clicks 1-10 ms; tone bursts 2-22 ms (wave V arrives 7-15 ms)
      // (like Fmp, which is evaluated around the expected wave V, tone-burst statistics look at the V-V' region:
      //  a window of ~3-6 ms around the modelled wave V peak; if there is no modelled response, at ~9 ms)
      let ta = 1, tb = 10;
      if (this.stim.freq) {
        const c = this.clean.ipsi; let bi = -1, bm = 0.02;
        for (let i = Math.round((5 - W0) / DT); i < c.length; i++) if (c[i] > bm) { bm = c[i]; bi = i; }
        const tpk = bi < 0 ? 9 : W0 + bi * DT;
        const len = 3.5 + 3000 / this.stim.freq;           // V-V' complex is broad at low frequencies (~9.5 ms at 0.5 kHz, ~4.3 ms at 4 kHz)
        ta = Math.max(2, tpk - 0.3 * len); tb = Math.min(this.w1 - 2, tpk + 0.7 * len);
      }
      const a0 = Math.round((ta - W0) / DT), a1 = Math.round((tb - W0) / DT);
      let ma = 0, mb = 0; const m = a1 - a0;
      for (let i = a0; i < a1; i++) { ma += s.A[i]; mb += s.B[i]; }
      ma /= m; mb /= m;
      let sab = 0, saa = 0, sbb = 0;
      for (let i = a0; i < a1; i++) { const x = s.A[i] - ma, y = s.B[i] - mb; sab += x * y; saa += x * x; sbb += y * y; }
      out.repro = saa && sbb ? clamp(sab / Math.sqrt(saa * sbb), 0, 1) : 0;
      // Fmp-like statistic: response variance in the 1-12 ms window relative to residual noise
      const rnU = out.rn / 1000;
      let pw = 0; const b1 = Math.round((tb + 2 - W0) / DT);
      for (let i = a0; i < b1; i++) pw += this.clean.ipsi[i] * this.clean.ipsi[i];
      pw /= (b1 - a0);
      const rnE = Math.max(rnU, 1e-4);            // noise-free (0%) recordings: Fmp saturates instead of dividing by zero
      out.fmp = this.n > 0 ? (pw + rnE * rnE) / (rnE * rnE) * (0.9 + 0.2 * Math.random()) : 0;
      out.conf = clamp(1 - Math.exp(-2.2 * Math.max(0, out.fmp - 1)), 0, 0.999) * 100;
      return out;
    }
  }

  /* ---------- calibration: make the normal adult 80 dB nHL click hit the published latencies ---------- */
  function peakNear(sig, t, half) {
    const i0 = Math.round((t - half - W0) / DT), i1 = Math.round((t + half - W0) / DT);
    let bi = i0;
    for (let i = i0; i <= i1; i++) if (sig[i] > sig[bi]) bi = i;
    return W0 + bi * DT;
  }
  function calibrate() {
    // analytic first pass: place the amplitude-centroid of each wave on the published latency
    let m = 0, sw = 0;
    for (let c = 0; c < CH_CF.length; c++) { m += CH_W[c] * tw(CH_CF[c]); sw += CH_W[c]; }
    for (const k of WAVES) OFFSET[k] = (TARGET[k] || 0) - m / sw - WV[k].D * Math.exp(-65 / TAU_D);
    OFFSET.II = TARGET.I + 0.95 - m / sw - WV.II.D * Math.exp(-65 / TAU_D);
    OFFSET.IV = TARGET.V - 0.55 - m / sw - WV.IV.D * Math.exp(-65 / TAU_D);
    // numeric refinement of the visible peaks I / III / V (small, bounded corrections)
    const p = newPatient({ ears: [{ ac: [0, 0, 0, 0], bc: [0, 0, 0, 0] }, { ac: [0, 0, 0, 0], bc: [0, 0, 0, 0] }] });
    const stim = { ear: 0, level: 80, freq: 0, polarity: 'rare', rate: 17.1, transducer: 'insert' };
    for (let it = 0; it < 4; it++) {
      const s = simulate(p, stim, { hp: 100, lp: 3000 }).ipsi;
      for (const k of ['I', 'III', 'V']) {
        const pk = peakNear(s, TARGET[k], 0.4);
        const d = clamp(TARGET[k] - pk, -0.3, 0.3);
        OFFSET[k] += d;
        if (k === 'I') OFFSET.II += d; if (k === 'V') OFFSET.IV += d;
      }
    }
  }
  calibrate();

  /* Normative latency-intensity bands for the L-I chart, from the model itself so bands and simulated normals agree:
   * a normal-hearing copy of the patient (same age) is simulated (clean, alternating) at 0-100 dB nHL and the I / III / V
   * peaks are tracked from the highest level down (tone bursts: V only). Width +/- 2 SD, wave V SD from Gorga et al. 1989
   * Table 2 (children 3-36 mo: ~0.56 / 0.37 / 0.30 / 0.26 ms at 20 / 40 / 60 / 80 dB HLn), fitted as 0.24 + 0.6 exp(-0.035 L);
   * waves I and III are given 0.6x and 0.8x that SD (approximate; Gorga reports V only). */
  const liCache = {};
  const liSD = (L) => 0.24 + 0.6 * Math.exp(-0.035 * L);
  function normalLI(p, freq, transducer) {
    const key = [p.adult, p.ageMonths, freq, transducer].join('|');
    if (liCache[key]) return liCache[key];
    const n = newPatient({ adult: p.adult, ageMonths: p.ageMonths, ears: [{ ac: [0, 0, 0, 0], bc: [0, 0, 0, 0], cm: 0 }, { ac: [0, 0, 0, 0], bc: [0, 0, 0, 0], cm: 0 }] });
    const maxL = transducer === 'bone' ? 60 : 100, out = [], prev = {};
    const waves = freq ? ['V'] : ['I', 'III', 'V'];
    for (let L = maxL; L >= 0; L -= 5) {
      const sim = (pol) => simulate(n, { ear: 0, level: L, freq, polarity: pol, rate: freq ? 39.1 : 17.1, transducer }, { hp: freq ? 30 : 100, lp: 3000 }).ipsi;
      const a = sim('rare'), b = sim('cond'), x = a.map((v, i) => (v + b[i]) / 2);
      const row = { L };
      for (const k of waves) {
        // first (highest) level: wide windows that cover adults and infants; then follow each peak down in level
        const first = { I: [1.0, 2.4], III: [3.0, 5.0], V: freq ? [4.5, 18] : [4.9, 7.6] }[k];
        const lo = prev[k] != null ? prev[k] - 0.1 : first[0];
        const hi = freq ? 20 : prev[k] != null ? prev[k] + 0.8 : first[1];      // tone bursts: V is the largest peak
        let bi = -1, bm = 0.025;              // needs a clean peak of at least 25 nV
        for (let i = Math.round((lo - W0) / DT); i <= Math.round((hi - W0) / DT) && i < x.length; i++) if (x[i] > bm && x[i] >= x[i - 1] && x[i] >= x[i + 1]) { bm = x[i]; bi = i; }
        if (bi < 0) { prev[k] = null; if (!freq && k === 'V') break; continue; }
        const t = W0 + bi * DT; prev[k] = t;
        row[k] = [t - 2 * liSD(L) * { I: 0.6, III: 0.8, V: 1 }[k], t, t + 2 * liSD(L) * { I: 0.6, III: 0.8, V: 1 }[k]];
      }
      if (!waves.some((k) => row[k])) break;
      out.push(row);
    }
    return (liCache[key] = out.reverse());
  }

  root.ABRModel = {
    FS, DT, W0, W1, NW, W1_TONE, nwFor, FREQS, CH_CF, WAVES, MAX_LEVEL, TARGET, INTERAURAL_ATT_INSERT,
    MORPH_NAMES, newPatient, newEar, simulate, Acquisition, thrNHL, clickThr, clickHL, ABR_CORR_AC, ABR_CORR_BC, ABR_BASE,
    nominalLatency, toneLatency, OFFSET, normalLI
  };
  if (typeof module !== 'undefined') module.exports = root.ABRModel;
})(typeof window !== 'undefined' ? window : globalThis);
