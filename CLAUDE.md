# ABR Simulator — notes for Claude

Teaching simulator of ABR recording in the style of the Interacoustics Eclipse. Static vanilla HTML/CSS/JS,
no build step, no dependencies (same approach as the other `jakalnz` simulators: dpoae, immittance, pta).

## Run / test
- Serve statically: `npx http-server -p 8232 -c-1` (see `.claude/launch.json`), open http://localhost:8232.
- `js/model.js` and `js/codec.js` also load in Node (`module.exports`), which is the fastest way to check the
  physiology: `require('./js/model.js')`, then `M.simulate(patient, stim, opts)` or `new M.Acquisition(...)`.
  `js/defaultPatients.js` expects a `window` global (`global.window = global`).
- Chrome pauses timers in background tabs, so browser tests of the recording loop only advance while the tab is
  visible. Keep browser test scripts short and poll in separate calls.

## Layout
| File | Role |
|---|---|
| `index.html`, `style.css` | Eclipse-style UI: Record / Edit / Latency tabs, Right/Left canvases, patient + report modals |
| `app.js` | UI state (`window.ABRApp`), acquisition loop, canvas renderer, curve drag/merge, latency cursors, patient editor, share link, report |
| `js/model.js` | Physiology model + averager (`window.ABRModel`) |
| `js/codec.js` | Versioned bit-packed `#case=` share codec (`window.ABRCodec`) |
| `js/defaultPatients.js` | Fictional built-in cases (`window.DEFAULT_PATIENTS`) |

## Model (js/model.js)
Channel-based auditory-nerve population model, not a full biophysical cochlea: 9 CF channels, each with an
excitation (dB above the ABR threshold at that place), amplitude growth, level-latency and synchrony; wave I–V
generators (Gaussian + trough) summed over channels; two recording channels (ipsi/contra morphology) built from
both cochleae; CM and stimulus artefact added; zero-phase HPF/LPF; then the averager adds EEG noise per block
(Bayesian weighting, A/B splits). The whole thing sits behind `simulate()` / `Acquisition` so the backend can be
swapped without touching the UI.

Conventions: ears are 0 = Right, 1 = Left; time in ms; amplitude in µV; `stim = {ear, level, freq (0 = click),
polarity 'rare'|'cond'|'alt', rate, transducer 'insert'|'bone'}`.

Literature anchors (do not change casually — each constant is fitted to a source):
- Click wave I/III/V at 80 dB nHL, 17.1/s: Kelly 1996 adult norms (1.66 / 3.82 / 5.75 ms), set by `calibrate()`.
  Rate effect on V (+0.35 ms at 65.1/s) also from Kelly.
- Click level-latency (`TAU_D`, `WV[k].D`): Gorga 1989 adult fit `4.89 + 5.31·exp(-0.0264·L)`.
- **Children are deliberately NOT fitted to Kelly.** `CHILD_BASE` puts them on the Gorga 1989 (Boys Town) data
  themselves, because Kelly's latencies are later (more conservative peak picking). Maturation:
  `4.46·exp(-0.0318·a)` (a = conceptional weeks; `ageMonths` = months after term; preterm not modelled).
- Tone-burst wave V latency: Neely et al. 1988 `5.0 + 12.9·5^(-SPL/100)·f^(-0.413)` (`toneLatency()`), shortened for
  the 2 and 4 kHz rise-time difference (clinical 2-1-2 vs their bursts). Interpeak intervals stay at click values.
- Tone-burst AC thresholds: Stapells, Gravel & Martin 1995 (`thrTone()`: `max(HL + diff, normal floor)`).
- Bone conduction: Stapells & Ruben 1989 (infant BC tones: latency/amplitude vs level, ipsi/contra asymmetry);
  interaural attenuation falls with age (`boneIA()`: ~19 dB at 6 months, ~6 dB adult); normal BC thresholds
  `ABR_CORR_BC`. BCEHP protocol (Nov 2022) gives max levels (`MAX_LEVEL`) and the ANSD criteria.
- Tone-burst wave shape and amplitude: the V-V' complex is broad at low frequencies (width `senv = 0.5/f`, trough delay/width
  scaled by `1 + 3*senv`), so 500 Hz is slow and smooth, 2-4 kHz compact. A tone burst is one response: its size
  (`TAU_TONE`, `TONE_W`) and wave V latency follow the best-excited place (`Emax`), shared over the excited CF channels
  with their relative travelling-wave delays (per-channel timing made V non-monotonic above 70 dB). Amplitudes
  (`TONE_GAIN`, `TONE_FREQ_GAIN`, `TONE_ONSET`, `BONE_LF_GAIN`) are matched to clinical infant tone-burst printouts
  (normal ears, 30-3000 Hz, alternating): infant V-V' ~80/140/185 nV at 2 kHz 25/45/65 dB nHL, ~100/160/210 nV at
  500 Hz 35/45/55, ~130 nV at 4 kHz 45, BC 2 kHz 45 dB ~190 nV (Stapells & Ruben 1989: 0.18-0.25 uV). With RN ~17 nV
  (30% noise, 2000 sweeps) detection still matches Stapells 1995 (2 kHz visual threshold ~15 dB nHL, mean confidence
  ~99% at 30 dB). 500 Hz is now slightly larger than 2 kHz well above threshold (158 vs 139 nV at 45 dB nHL, as in the
  printouts) but still less detectable near threshold (mean confidence at 25 dB: 500 Hz ~57%, 2 kHz ~95%). Re-run a
  detection sweep if any of these change. Uncancelled BC 500 Hz artefact at 50 dB nHL drives Fmp/confidence to ~100%
  even with no cochlear response (BCEHP 2022 warns RN/SNR are unreliable with artefact).
- CM (`CM_GAIN`, `cmGrowth`): linear to 70 dB, compressive above (0.5 dB/dB); Large ~0.35-0.4 uV at 90 dB after
  filtering, as in clinical ANSD click printouts. `ear.ring` gives a ringing CM (~1.5 kHz, tau 1.3 ms, visible to
  ~4 ms). The stimulus artefact is electrical (t = 0, no tube delay), so `stim.clamped` (no sound to either cochlea)
  keeps it while CM and neural responses vanish (UNHSEIP 5.36 clamp test); condensation artefact is 0.75x rarefaction
  so alternating leaves a residual (BCEHP 2022).
- ANSD (`path` 2, `ANSD[sev]`): the neural response has its own onset `T` (dB nHL, +`ANSD_TONE_T` for tones) independent of
  the audiogram; excitation is clamped to `level - gap - T`, so V is small, late and broad near onset (no separate delay term).
  Waves I/II mostly absent (`ANSD_WAVE`; clear I + late V would read as retrocochlear), condensation smaller/later so alt
  partly cancels, extra rate adaptation. V-V' is measured as the larger of RC and CC (BCEHP 2022 5.6). Measured on the two
  partial-ANSD presets (90 dB nHL click, 30% noise, 2000 sweeps): Mild CM 421 nV, RC V 7.25 ms / ~198 nV (Table 5.10.1
  Probable; Fig 5.7.1 late V), confidence 100 / 100 / ~80 / ~4% at 90 / 80 / 70 / 60 dB, 2 kHz at 80 dB ~20% (small, V > 10 ms:
  5.2 entry criterion); Moderate CM 597 nV, RC V 7.75 ms / ~91 nV (Definite), confidence ~90% at 90 dB, ~25% at 80, 2 kHz NR.
  Severe gives only a trace at 100 dB; Marked none. Alternating A/B repro is ~0 with a large CM (A = RC, B = CC), so use
  confidence/Fmp for ANSD. Re-run this check if `ANSD` changes.
- Contralateral masking (`stim.mask`, dB SPL BBN via insert to the non-test ear, max 85): raises that cochlea's threshold
  to `em = mask - MASK_K - gap` (gap = masked ear's AC-BC gap); the test cochlea gets `mask - INTERAURAL_ATT_INSERT - K`
  (over-masking). `MASK_K` is fitted so the BCEHP 2022 tables mask the cross-over with ~10 dB to spare: AC from the 4.11
  table (Stapells 1984, 30 dB IA assumed), BC from the 4.10 infant table (Lau & Small 2020, >= 10 dB IA). The two tables
  imply very different effective levels; each transducer follows its own. The UI defaults to 65 dB SPL and deliberately
  does not show a recommended level (students choose it). CM is not masked.
- Electrodes (`opts.imp` = {Cz, M1, M2, Gnd} kOhm; M2 = right mastoid): impedance does not change the ABR (BCEHP 2022
  3.5). Per channel (Cz - mastoid of that ear): EEG sd x(1 + 0.1 per kOhm difference) (CMRR, so noisy cases suffer
  more), plus 50 Hz (+150 Hz) mains hum `IMP_HUM` per kOhm difference (+0.15 x ground above 3 kOhm), passed through the
  filter gain (`humGain`: HPF 30 Hz lets far more through than 100 Hz); hum near the reject limit adds rejections from
  ~6 kOhm; high mean impedance enlarges movement bursts. Calibration (quiet infant, 30% noise, 2000 sweeps, click):
  ideal ~16 nV (vs 15 without), difference 2 kOhm ~19, 5 kOhm ~26, 10 kOhm ~40 nV + 20% rejects; 2 kHz tone bursts ~2x
  worse. Start state is a case setting (`patient.electrodes`: 0 as found, 1 difficult skin, 2 not attached, 3 ready: all 1.0 kOhm, used by the default
  demo patient).
- Click morphology (`MORPH`, per ear `morph` 0-4) scales/shifts waves II-V; `calibrate()` runs on Standard (0).
  PAM (`ear.pam`) is a myogenic 9-12 ms hump (adult, AC). `normalLI()` gives model-derived normal L-I bands
  (+/- 2 SD, V SD from Gorga 1989 Table 2).
- Wave I level-latency: `WV.I.D` = 3.5 (II 3.6) fitted to Kelly 1996 (NZAS guideline, insert, rarefaction, 17.1/s):
  I 1.82 / 1.66 / 1.59, III 3.92 / 3.82 / 3.69, V 5.87 / 5.75 / 5.65 ms at 70 / 80 / 90 dB nHL, I-V ~4.05 at all three.
  Model: I 1.80 / 1.65 / 1.55, I-V 4.10 at 70-90 dB; clean I 2.00 / 2.65 / 3.45 ms at 60 / 40 / 20 dB. Wave I is <= 45 nV at <= 30 dB, i.e. near a typical residual
  noise, so it is not reliably identifiable there and picks wander. The apparent jumps at >= 90 dB came from an uncapped CM swamping
  wave I (fixed by `cmGrowth`).
- Reference printouts in `ABR Images/` are cited only generically ("clinical printouts"); never name them.
- Click and tone-burst thresholds use different code paths; click thresholds (`ABR_CORR_AC`, `ABR_BASE`) were
  tuned together with the click level series — re-check both if you change one.

Display windows: click −1…13 ms, tone burst −1…25 ms (`nwFor()`); trace arrays have different lengths, so any
per-sample code must use `arr.length`, not a global `NW`. Reproducibility / Fmp use 1–10 ms for clicks and a ~4–10 ms (3.5 + 3000/f)
window around the modelled wave V for tone bursts (Fmp is evaluated near wave V).

## Patients and share links
`patient = {name, adult, ageMonths, noisy, noise, electrodes, ears:[{ac[4], bc[4], path 0|1|2, sev 0-3, cm 0-3, ring 0|1, morph 0-4, pam 0-2, latI, latIII, latV}]}`
(thresholds dB HL at 0.5/1/2/4 kHz; `path` 1 = retrocochlear, 2 = neuropathy/ANSD; latencies are optional manual
overrides at 80 dB nHL, 17.1/s; `noise` = EEG-noise multiplier, default 0.3, one of `NOISE_LEVELS` in `codec.js`, edited in the
Patient / case dialog (instructor only) and carried in the share link). The codec packs this into ~65–90 chars (Word
hyperlinks break above 255). Bump `VERSION` in `codec.js` if the packed layout changes and keep decoding old versions
(v1 links, which have no noise field, still decode and get 30%; v3 adds ring/morph/pam, older links get 0; v4 adds the
electrode start state, older links get 0 = on as found).

The instructor gate (password `1234`, `ADMIN_PW` in `app.js`) hides case answers and editing from students. It is
client-side only — anyone can read the source — so treat it as a classroom convenience, not security.

## Do NOT commit
- `ABR Images/` (printed click ABRs contain **real patient names**) and `Protocols and Norms/` (copyrighted papers
  and protocols). Both are in `.gitignore`; keep it that way. Use them only for calibration; never copy names, IDs
  or trace images into the repo or the default cases (which are fictional).
- Do not copy code from the Verhulst et al. 2018 model (UGent Academic License) into this project.

## Style
Match the existing code: plain ES2015+, no frameworks, terse comments that state the *source* of a constant.
`app.js` mutates the shared `S` state object and calls `render()`; new UI should follow that pattern.
