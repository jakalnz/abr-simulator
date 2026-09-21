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
  scaled by `1 + 3*senv`), so 500 Hz is slow and smooth, 2-4 kHz compact. Amplitudes (`TONE_GAIN`, `TONE_FREQ_GAIN`,
  `TONE_ONSET` (per frequency), `BONE_LF_GAIN`) are tuned by hand against Stapells & Ruben 1989 Fig 3 (infant BC V-V'
  amplitude: 500 Hz 0.21-0.46 uV, 2 kHz 0.18-0.25 uV) and so that detectability of a normal ear matches Stapells 1995
  (~100% at 30 dB nHL, 2 kHz threshold ~13 dB nHL). No amplitude table exists in those papers; 500 Hz is deliberately
  no clearer than 2 kHz for AC at the same nHL.
- Click and tone-burst thresholds use different code paths; click thresholds (`ABR_CORR_AC`, `ABR_BASE`) were
  tuned together with the click level series — re-check both if you change one.

Display windows: click −1…13 ms, tone burst −1…25 ms (`nwFor()`); trace arrays have different lengths, so any
per-sample code must use `arr.length`, not a global `NW`. Reproducibility / Fmp use 1–10 ms for clicks and a ~4–10 ms (3.5 + 3000/f)
window around the modelled wave V for tone bursts (Fmp is evaluated near wave V).

## Patients and share links
`patient = {name, adult, ageMonths, noisy, noise, ears:[{ac[4], bc[4], path 0|1|2, sev 0-3, cm 0-3, latI, latIII, latV}]}`
(thresholds dB HL at 0.5/1/2/4 kHz; `path` 1 = retrocochlear, 2 = neuropathy/ANSD; latencies are optional manual
overrides at 80 dB nHL, 17.1/s; `noise` = EEG-noise multiplier, default 0.2, one of `NOISE_LEVELS` in `codec.js`, edited in the
Patient / case dialog (instructor only) and carried in the share link). The codec packs this into ~65–90 chars (Word
hyperlinks break above 255). Bump `VERSION` in `codec.js` if the packed layout changes and keep decoding old versions
(v1 links, which have no noise field, still decode and get 20%).

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
