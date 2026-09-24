/* Built-in teaching cases (fictional). ac/bc = dB HL at 0.5, 1, 2, 4 kHz.
 * path: 0 none, 1 retrocochlear, 2 neuropathy (ANSD); sev 0-3; cm 0 absent .. 3 large; ring 1 = ringing CM;
 * latI/latIII/latV = optional manual latency (ms) at 80 dB nHL, 17.1/s. */
window.DEFAULT_PATIENTS = [
  { name: 'Normal hearing adult (asleep/quiet)', adult: true, ageMonths: 0, noisy: false,
    ears: [{ ac: [5, 5, 5, 5], bc: [0, 0, 0, 0] }, { ac: [5, 5, 5, 5], bc: [0, 0, 0, 0] }] },
  { name: 'Normal adult - noisy, awake', adult: true, ageMonths: 0, noisy: true,
    ears: [{ ac: [10, 5, 5, 10], bc: [5, 0, 0, 5] }, { ac: [10, 5, 5, 10], bc: [5, 0, 0, 5] }] },
  { name: 'Right conductive loss (adult)', adult: true, ageMonths: 0, noisy: false,
    ears: [{ ac: [45, 45, 40, 35], bc: [5, 5, 5, 5] }, { ac: [5, 5, 5, 5], bc: [0, 0, 0, 0] }] },
  { name: 'Bilateral sloping SNHL (adult)', adult: true, ageMonths: 0, noisy: false,
    ears: [{ ac: [25, 35, 55, 70], bc: [20, 30, 50, 65] }, { ac: [25, 40, 55, 70], bc: [20, 35, 50, 65] }] },
  { name: 'Left retrocochlear (prolonged I-V)', adult: true, ageMonths: 0, noisy: false,
    ears: [{ ac: [10, 10, 10, 15], bc: [5, 5, 5, 10] }, { ac: [15, 15, 20, 30], bc: [10, 10, 15, 25], path: 1, sev: 1 }] },
  { name: 'Baby 3 mo - normal (asleep)', adult: false, ageMonths: 3, noisy: false,
    ears: [{ ac: [10, 10, 10, 10], bc: [5, 5, 5, 5] }, { ac: [10, 10, 10, 10], bc: [5, 5, 5, 5] }] },
  { name: 'Child 4 y - restless, normal', adult: false, ageMonths: 48, noisy: true,
    ears: [{ ac: [10, 5, 5, 10], bc: [5, 0, 0, 5] }, { ac: [10, 5, 5, 10], bc: [5, 0, 0, 5] }] },
  { name: 'Baby 5 mo - auditory neuropathy (CM present)', adult: false, ageMonths: 5, noisy: false,
    ears: [{ ac: [60, 55, 50, 55], bc: [55, 50, 45, 50], path: 2, sev: 3, cm: 3, ring: 1 },
           { ac: [60, 60, 55, 55], bc: [55, 55, 50, 50], path: 2, sev: 3, cm: 3, ring: 1 }] },
  // partial ANSD: hearing much better than the ABR suggests; late, broad, small wave V only at high click levels
  { name: 'Baby 4 mo - partial auditory neuropathy (mild)', adult: false, ageMonths: 4, noisy: false,
    ears: [{ ac: [25, 25, 30, 30], bc: [20, 20, 25, 25], path: 2, sev: 0, cm: 3 },
           { ac: [30, 25, 25, 30], bc: [25, 20, 20, 25], path: 2, sev: 0, cm: 3 }] },
  { name: 'Baby 6 mo - partial auditory neuropathy (moderate)', adult: false, ageMonths: 6, noisy: false,
    ears: [{ ac: [40, 40, 45, 45], bc: [35, 35, 40, 40], path: 2, sev: 1, cm: 3, ring: 1 },
           { ac: [40, 45, 45, 50], bc: [35, 40, 40, 45], path: 2, sev: 1, cm: 3, ring: 1 }] }
];
