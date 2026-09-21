# ABR Simulator

A browser-based teaching simulator of auditory brainstem response (ABR) recording, laid out like the
Interacoustics Eclipse. Students pick a stimulus, record ipsilateral and contralateral traces from a simulated
patient, mark waves I–V and interpret the result; instructors build cases and share them as a link.

No installation and no server-side code: it is plain HTML/CSS/JavaScript.

## Running it
Open `index.html`, or serve the folder (for example `npx http-server -p 8232 -c-1`) and browse to
http://localhost:8232. It can be hosted on GitHub Pages as-is.

## What you can do
- **Stimuli:** click, or 0.5 / 1 / 2 / 4 kHz tone bursts; insert phones or a bone conductor; rarefaction,
  condensation or alternating polarity (buffer A = rarefaction, B = condensation); rate, level, averages, reject
  level, filters and an adjustable EEG-noise level.
- **Recording:** live averaging with A/B splits, response confidence, Fmp, residual noise and wave reproducibility.
  Ipsilateral and contralateral channels are recorded together.
- **Analysis:** mark waves I–V on any curve (Latency tab) and read latencies and interpeak intervals; drag curves
  up and down by their tags; merge curves (weighted average, can be unmerged) or add them (keeps the originals);
  export a waveform as CSV; print a report.
- **Patients:** adult or child (age in months), quiet asleep or noisy awake, 4-point air- and bone-conduction
  thresholds for each ear, retrocochlear pathology, auditory neuropathy with cochlear microphonic, and optional
  manual latencies for waves I, III and V.

## Sharing a case
Instructors: **Patient / case…** → enter the instructor password → edit the case → **Copy share link**.
The whole patient is encoded in the link (`…index.html#case=…`, well under 255 characters), so nothing is stored on
a server. Students opening the link get the case read-only (their view shows the audiogram but not the pathology,
CM or latency answers).

The instructor password is set in `app.js` (`ADMIN_PW`, default `1234`). It is client-side only and is a classroom
convenience, not security.

## How realistic is it?
Recordings come from a channel-based auditory-nerve population model with wave I–V generators, calibrated to
published data rather than invented values:

| Behaviour | Source |
|---|---|
| Adult click latencies and rate effect | Kelly (1996) norms, as used in the NZAS ABR guideline |
| Click level–latency and infant/child maturation | Gorga et al. (1989), *J Speech Hear Res* 32:281 |
| Tone-burst wave V latency vs frequency and level | Neely et al. (1988), *JASA* 83:652; Gorga et al. (1988), *J Speech Hear Res* 31:87 |
| Tone-burst thresholds vs behavioural audiogram | Stapells, Gravel & Martin (1995), *Ear Hear* 16:361; Gorga et al. (2006), *Ear Hear* 27:60 |
| Bone-conducted tones, ipsi/contra asymmetry | Stapells & Ruben (1989), *Ann Otol Rhinol Laryngol* 98:941 |
| Levels, transducer limits, ANSD/CM criteria | BC Early Hearing Program ABR Protocol (2022) |

Tone-burst amplitudes are tuned so a normal ear is detected about as often as in Stapells et al. (about 100% at
30 dB nHL); the papers do not give amplitude tables. It is a teaching tool, not a diagnostic one — do not use it to
make clinical decisions.

## Project layout
```
index.html  style.css  app.js     UI, acquisition loop, rendering, curve tools, patient editor, report
js/model.js                        physiology model + averager (also loads in Node for testing)
js/codec.js                        versioned share-link codec
js/defaultPatients.js              built-in fictional cases
CLAUDE.md                          developer notes (model conventions, calibration sources)
```

## Privacy and licensing
The reference material used for calibration (printed patient ABRs, journal papers, national protocols) is **not**
in this repository. All built-in patients are fictional. No code from third-party ABR models is included.
