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
  condensation or alternating polarity (buffer A = rarefaction, B = condensation; tone bursts default to alternating,
  as in the NZ UNHSEIP protocol); rate, level, averages, reject level, filters and an adjustable EEG-noise level.
  **Clamp insert** runs a no-sound (clamped tube) recording: only the stimulus artefact remains, so a CM disappears.
- **Recording:** live averaging with A/B splits, response confidence, Fmp, residual noise and wave reproducibility.
  Ipsilateral and contralateral channels are recorded together.
- **Labelling:** arm a wave label I–V on the toolbar (keys **1–5**), then click the selected curve (it snaps to the
  nearest peak); click the armed wave again or press Esc to disarm. Categorise a curve as CR / NR / INC (clear
  response / no response / inconclusive; toolbar or keys **6–8**).
  Drag a label to move it, or select it and nudge it with the ◄ ► buttons or arrow keys (Shift = bigger steps);
  Delete or a right-click removes a label.
- **Analysis:** the Latency tab shows the selected curve's latencies and intervals, with pop-outs for the table of
  all curves and latency–intensity charts (grey normative bands); drag curves up and down by their tags; merge curves
  (weighted average, can be unmerged), add them (keeps the originals) or subtract rarefaction − condensation to show
  the CM; export a waveform as CSV; print a report (all curves, recording statistics, latencies, L–I charts).
- **Patients:** adult or child (age in months), quiet asleep or noisy awake, 4-point air- and bone-conduction
  thresholds for each ear, retrocochlear pathology, auditory neuropathy with cochlear microphonic (brief or ringing),
  click morphology variants (II, IV/V complex, large III), an optional post-auricular muscle wave, and optional
  manual latencies for waves I, III and V.

## Sharing a case
Instructors: **Patient / case…** → enter the instructor password → edit the case → **Copy share link**.
The whole patient is encoded in the link (`…index.html#case=…`, well under 255 characters), so nothing is stored on
a server. Students opening the link get the case read-only: the hearing thresholds and the pathology, CM and
latency answers stay folded away until the instructor password is entered. Students can still pick one of the
built-in preset cases and Apply it without the password.

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

Tone-burst amplitudes are matched to clinical infant tone-burst recordings (e.g. 2 kHz V–V′ about 80 / 140 / 200 nV
at 25 / 45 / 65 dB nHL) while keeping detection close to Stapells et al. (about 100% at 30 dB nHL); the papers do not
give amplitude tables. It is a teaching tool, not a diagnostic one — do not use it to
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
