/* ABR simulator UI: Eclipse-style recording, ipsi/contra traces, latency cursors, patient editor, share links, report. */
(function () {
  'use strict';
  const M = window.ABRModel, DT = M.DT, W0 = M.W0, W1 = M.W1, NW = M.NW;
  const $ = (id) => document.getElementById(id);
  const EAR = ['R', 'L'];
  const RATES = [7.1, 11.1, 17.1, 27.1, 33.1, 39.1, 65.1, 91.1];
  const NMAX = [500, 1000, 1500, 2000, 3000, 4000];
  const WAVES = ['I', 'II', 'III', 'IV', 'V'];

  const S = {
    patient: M.newPatient(JSON.parse(JSON.stringify(window.DEFAULT_PATIENTS[0]))),
    ear: 0, level: 80, type: 0, trans: 'insert', pol: 'rare', rate: 17.1, nmax: 2000,
    reject: 40, hp: 100, lp: 3000, speed: 100, noise: 0.8,
    chan: 'ipsi', showAB: false, order: 'I', zoom: 1,
    traces: [], sel: null, acq: null, live: null, timer: null, last: 0, paused: false,
    tab: 'record', wave: 'V', nextId: 1
  };

  /* ---------- helpers ---------- */
  function toast(msg) {
    const t = $('toast'); t.textContent = msg; t.hidden = false;
    clearTimeout(toast._t); toast._t = setTimeout(() => (t.hidden = true), 2600);
  }
  function maxLevel() {
    const m = M.MAX_LEVEL[S.trans];
    if (!S.type) return m.click;
    return Array.isArray(m.tone) ? m.tone[M.FREQS.indexOf(S.type)] : m.tone;
  }
  function typeLabel(t) { return t ? 'TB ' + t / 1000 + 'k' : 'Click'; }
  function fill(sel, vals, cur, fmt) {
    sel.innerHTML = vals.map((v) => `<option value="${v}"${v === cur ? ' selected' : ''}>${fmt ? fmt(v) : v}</option>`).join('');
  }
  const fmtMs = (v) => (v == null ? '' : v.toFixed(2));

  /* ---------- settings <-> UI ---------- */
  function applyProtocolDefaults() {
    if (S.type === 0) { S.zoom = 1; S.noise = 0.8; S.hp = 100; S.lp = 3000; S.rate = 17.1; S.nmax = 2000; S.level = Math.min(S.level || 80, 100); if (S.level < 60) S.level = 80; }
    else { S.zoom = 1.6; S.noise = 0.5; S.hp = 30; S.lp = 3000; S.rate = 39.1; S.nmax = 2000; if (S.level > 70) S.level = 60; }
    clampLevel();
  }
  function clampLevel() {
    const m = maxLevel();
    if (S.level > m) { S.level = m; toast(`Maximum ${m} dB nHL for this stimulus/transducer`); }
    if (S.level < 0) S.level = 0;
  }
  function syncUI() {
    $('protocol').value = $('stType').value = String(S.type);
    $('level').value = S.level; $('trans').value = S.trans; $('pol').value = S.pol;
    fill($('rate'), RATES, S.rate, (v) => v.toFixed(1)); fill($('nmax'), NMAX, S.nmax);
    $('noise').value = String(S.noise); $('reject').value = S.reject; $('hpf').value = S.hp; $('lpf').value = S.lp; $('speed').value = S.speed;
    document.querySelectorAll('input[name=ear]').forEach((r) => (r.checked = +r.value === S.ear));
    $('chanSel').value = S.chan; $('showAB').checked = S.showAB;
    $('tbAB').classList.toggle('on', S.showAB); $('tbC').classList.toggle('on', S.chan === 'both');
    document.querySelectorAll('.ord').forEach((b) => b.classList.toggle('on', b.dataset.ord === S.order));
    const m = maxLevel();
    const g = $('lvlGrid'); g.innerHTML = '';
    for (let l = 0; l <= 100; l += 10) {
      const b = document.createElement('button'); b.textContent = l;
      b.className = l === S.level ? 'on' : ''; b.disabled = l > m;
      b.onclick = () => { S.level = l; syncUI(); };
      g.appendChild(b);
    }
    $('lvlHint').textContent = `Max ${m} dB nHL (${S.trans === 'bone' ? 'bone conductor' : 'insert phone'}). Use +/- for 5 dB steps.`;
    const p = S.patient;
    $('caseName').textContent = p.name ? '— ' + p.name + ' (' + (p.adult ? 'adult' : 'child ' + p.ageMonths + ' mo') + ', ' + (p.noisy ? 'awake/noisy' : 'quiet/asleep') + ')' : '';
  }
  function readUI() {
    S.type = +$('stType').value; S.level = +$('level').value || 0; S.trans = $('trans').value; S.pol = $('pol').value;
    S.rate = +$('rate').value; S.nmax = +$('nmax').value; S.reject = +$('reject').value;
    S.noise = +$('noise').value || 1; S.hp = +$('hpf').value; S.lp = +$('lpf').value; S.speed = +$('speed').value;
    S.ear = +document.querySelector('input[name=ear]:checked').value;
    clampLevel();
  }

  /* ---------- acquisition ---------- */
  function currentStim() {
    return { ear: S.ear, level: S.level, freq: S.type, polarity: S.pol, rate: S.rate, transducer: S.trans };
  }
  function labelFor(stim) {
    const base = (stim.freq ? (stim.freq / 1000) + 'k ' : '') + stim.level + ' ' + EAR[stim.ear];
    const n = S.traces.filter((t) => t.base === base && t.ear === stim.ear).length;
    return { base, label: n ? base + n : base };
  }
  function start() {
    if (S.acq) return;
    readUI();
    const stim = currentStim();
    S.acq = new M.Acquisition(S.patient, stim, { nMax: S.nmax, reject: S.reject, hp: S.hp, lp: S.lp, noise: S.noise });
    const { base, label } = labelFor(stim);
    S.live = { id: S.nextId++, base, label, ear: stim.ear, stim, dy: [0, 0], opts: { hp: S.hp, lp: S.lp }, live: true, marks: {}, hidden: false, ...blank(stim) };
    S.paused = false; S.last = performance.now();
    S.timer = setInterval(tick, 60);
    setButtons(); render();
  }
  const blank = (stim) => { const nw = M.nwFor(stim); const z = () => ({ avg: new Float64Array(nw), A: new Float64Array(nw), B: new Float64Array(nw) }); return { w1: W0 + (nw - 1) * DT, ch: [z(), z()], n: 0, rejected: 0, rn: 0, repro: 0, fmp: 0, conf: 0 }; };
  const blankOld = () => ({ n: 0, rejected: 0, rn: 0, repro: 0, fmp: 0, conf: 0 });
  function tick() {
    const now = performance.now(), dt = Math.min(0.25, (now - S.last) / 1000); S.last = now;
    if (S.paused || !S.acq) return;
    S.acq.step(Math.max(1, Math.round(S.acq.stim.rate * S.speed * dt)));
    Object.assign(S.live, S.acq.snapshot());
    render();
    if (S.acq.done) stop();
  }
  function stop() {
    clearInterval(S.timer); S.timer = null;
    if (S.acq && S.live && S.acq.n > 0) {
      Object.assign(S.live, S.acq.snapshot(), { live: false });
      S.traces.push(S.live); S.sel = S.live;
    }
    S.acq = null; S.live = null; S.paused = false;
    setButtons(); render(); renderList();
  }
  function setButtons() {
    const b = $('btnStart');
    b.textContent = S.acq ? 'Stop' : 'Start'; b.className = 'big ' + (S.acq ? 'stop' : 'go');
    $('btnPause').textContent = S.paused ? 'Resume' : 'Pause'; $('btnPause').disabled = !S.acq;
  }

  /* ---------- rendering ---------- */
  // curve arrangement: O = testing order, F = frequency (click first, then 0.5-4 kHz), I = intensity (highest first)
  const ORDERS = {
    O: (a, b) => a.id - b.id,
    F: (a, b) => a.stim.freq - b.stim.freq || b.stim.level - a.stim.level || a.id - b.id,
    I: (a, b) => b.stim.level - a.stim.level || a.stim.freq - b.stim.freq || a.id - b.id
  };
  const PALETTE = [null, '#7b2d8e', '#d2691e', '#1e8a5a', '#a0a000'];   // colours for overlaid replicates (null = ear colour)
  function paneItems(ear, forReport) {
    const list = S.traces.filter((t) => t.ear === ear && !t.hidden);
    if (S.live && S.live.ear === ear) list.push(S.live);
    list.sort(ORDERS[S.order]);
    // O: every curve on its own baseline. F / I: curves with the same details (frequency, level, transducer, rate,
    // polarity) are overlaid on one baseline, as Eclipse overlays replicates.
    const groups = [], byKey = new Map();
    for (const t of list) {
      const key = S.order === 'O' ? t.id : [t.stim.freq, t.stim.level, t.stim.transducer, t.stim.rate, t.stim.polarity].join('|');
      let g = byKey.get(key); if (!g) { g = []; byKey.set(key, g); groups.push(g); }
      g.push(t);
    }
    const showC = S.chan === 'both' || forReport === 'both';
    const items = []; let slot = 0;
    for (const g of groups) {
      g.forEach((t, gi) => items.push({ tr: t, chan: 0, label: t.label, slot, gi, n: g.length }));
      slot++;
      if (showC) { g.forEach((t, gi) => items.push({ tr: t, chan: 1, label: t.label + ' c', slot, gi, n: g.length })); slot++; }
    }
    items.nSlots = slot;
    return items;
  }
  const L_MARGIN = 92, R_MARGIN = 14, T_MARGIN = 26, B_MARGIN = 34;
  function layout(cv, ear, forReport) {
    const W = cv.clientWidth, H = cv.clientHeight;
    const items = paneItems(ear, forReport);
    const plotH = H - T_MARGIN - B_MARGIN;
    const w1 = items.reduce((m, it) => Math.max(m, it.tr.w1 || W1), W1);
    const slot = Math.min(120, plotH / Math.max(items.nSlots || 1, 1));
    return { W, H, items, slot, plotH, w1, px200: S.zoom * Math.min(40, Math.max(12, slot * 0.3)),
             x: (t) => L_MARGIN + (t - W0) / (w1 - W0) * (W - L_MARGIN - R_MARGIN),
             tOf: (x) => W0 + (x - L_MARGIN) / (W - L_MARGIN - R_MARGIN) * (w1 - W0),
             base: (i) => T_MARGIN + (i + 0.5) * slot };
  }
  function draw(cv, ear, forReport) {
    const dpr = window.devicePixelRatio || 1;
    const w = cv.clientWidth, h = cv.clientHeight;
    if (cv.width !== Math.round(w * dpr) || cv.height !== Math.round(h * dpr)) { cv.width = Math.round(w * dpr); cv.height = Math.round(h * dpr); }
    const ctx = cv.getContext('2d'); ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    const lay = layout(cv, ear, forReport); lay.ys = []; lay.tagY = []; cv._lay = lay;
    const { x, items, slot, px200 } = lay;
    // grid
    ctx.strokeStyle = '#d3d3d3'; ctx.setLineDash([2, 3]); ctx.lineWidth = 1; ctx.fillStyle = '#444'; ctx.font = '11px Segoe UI'; ctx.textAlign = 'center';
    for (let t = -1; t <= lay.w1; t += (lay.w1 > 14 ? 2 : 1)) {
      ctx.beginPath(); ctx.moveTo(x(t), T_MARGIN); ctx.lineTo(x(t), h - B_MARGIN); ctx.stroke();
      ctx.fillText(t, x(t), h - B_MARGIN + 14);
    }
    ctx.setLineDash([]); ctx.textAlign = 'left'; ctx.fillText('ms', w - R_MARGIN - 14, h - 6);
    ctx.strokeStyle = '#555'; ctx.strokeRect(L_MARGIN, T_MARGIN, w - L_MARGIN - R_MARGIN, h - T_MARGIN - B_MARGIN);
    // scale bar
    ctx.strokeStyle = '#000'; ctx.beginPath(); ctx.moveTo(L_MARGIN - 8, T_MARGIN + 6); ctx.lineTo(L_MARGIN - 8, T_MARGIN + 6 + px200); ctx.stroke();
    ctx.fillStyle = '#000'; ctx.fillText('+200 nV', 6, T_MARGIN + 12);
    const col = ear === 0 ? '#8b1414' : '#1a1a9c';
    // the selected curve is drawn last (on top of any overlaid replicates)
    const drawOrder = items.map((_, i) => i).sort((a, b) => (items[a].tr === S.sel && !forReport) - (items[b].tr === S.sel && !forReport));
    drawOrder.forEach((i) => {
      const it = items[i];
      const t = it.tr, d = t.ch[it.chan], base = lay.base(it.slot) + ((t.dy && t.dy[it.chan]) || 0);
      const tagY = base + (it.gi - (it.n - 1) / 2) * 15, ecol = PALETTE[it.gi % PALETTE.length] || col;   // overlaid replicates get their own colour and tag
      lay.ys[i] = base; lay.tagY[i] = tagY;
      const sel = S.sel === t && !forReport, isC = it.chan === 1;
      const ys = (v) => base - v * 1000 / 200 * px200;
      const line = (arr, color, lw, dash, alpha) => {
        ctx.save(); ctx.globalAlpha = alpha == null ? 1 : alpha; ctx.beginPath(); ctx.rect(L_MARGIN, T_MARGIN, w - L_MARGIN - R_MARGIN, h - T_MARGIN - B_MARGIN); ctx.clip();
        ctx.strokeStyle = color; ctx.lineWidth = lw; ctx.setLineDash(dash || []);
        ctx.beginPath();
        for (let k = 0; k < arr.length; k++) { const px = x(W0 + k * DT), py = ys(arr[k]); k ? ctx.lineTo(px, py) : ctx.moveTo(px, py); }
        ctx.stroke(); ctx.restore();
      };
      if (S.showAB && t.n > 0) { line(d.A, '#1f9d9d', 1); line(d.B, '#2b8a2b', 1); }
      line(d.avg, ecol, sel ? 2.4 : 1.5, isC ? [5, 3] : null, isC ? 0.55 : 1);
      // label tag
      ctx.fillStyle = sel ? ecol : (isC ? '#999' : '#fff'); ctx.strokeStyle = isC ? '#999' : ecol; ctx.lineWidth = 1;
      ctx.fillRect(4, tagY - 8, L_MARGIN - 20, 16); ctx.strokeRect(4, tagY - 8, L_MARGIN - 20, 16);
      ctx.fillStyle = sel || isC ? '#fff' : ecol; ctx.font = '11px Segoe UI'; ctx.textAlign = 'left';
      ctx.fillText(it.label + (t.live ? '*' : ''), 8, tagY + 4);
      if (S.showAB && t.n > 0 && !t.live) { ctx.fillStyle = '#2b8a2b'; ctx.fillText('A/B', w - R_MARGIN - 26, tagY - 4); }
      // wave marks
      if (!isC) for (const k of WAVES) {
        const tm = t.marks && t.marks[k]; if (tm == null) continue;
        const idx = Math.round((tm - W0) / DT), yy = ys(d.avg[idx]);
        ctx.strokeStyle = '#000'; ctx.beginPath(); ctx.moveTo(x(tm), yy - 4); ctx.lineTo(x(tm), yy - 13); ctx.stroke();
        ctx.fillStyle = '#000'; ctx.textAlign = 'center'; ctx.fillText(k, x(tm), yy - 16);
      }
    });
    ctx.textAlign = 'left';
    if (!items.length) { ctx.fillStyle = '#888'; ctx.fillText('No curves recorded for this ear', L_MARGIN + 10, T_MARGIN + 24); }
  }
  function render() {
    draw($('cv0'), 0); draw($('cv1'), 1);
    const t = S.live || S.sel;
    $('confV').textContent = t && t.n ? t.conf.toFixed(1) + '%' : '--';
    $('confV').className = t && t.conf >= 99 ? 'ok' : '';
    $('fmpV').textContent = t && t.n ? t.fmp.toFixed(1) : '--';
    $('recV').textContent = $('stRec').textContent = t ? t.n : 0;
    $('rnV').textContent = t && t.n ? t.rn.toFixed(0) + ' nV' : '--';
    $('stRej').textContent = t ? Math.round(t.rejected * 100) + '%' : '0%';
    const rp = t ? Math.round(t.repro * 100) : 0;
    $('stRep').textContent = rp + '%'; $('repBar').style.width = rp + '%';
    $('progFill').style.width = (t ? Math.min(100, t.n / 40) : 0) + '%';     // 0-4000 sweeps
    renderLat();
  }
  function drawEEG() {
    const c = $('eeg'), g = c.getContext('2d'); g.fillStyle = '#111'; g.fillRect(0, 0, c.width, c.height);
    const amp = (S.patient.noisy ? 11 : 3) * (S.acq ? 1 : 0.6);
    ['#f55', '#59f'].forEach((col, k) => {
      g.strokeStyle = col; g.beginPath(); let y = 0;
      for (let i = 0; i < c.width; i += 2) { y = 0.8 * y + 0.6 * (Math.random() - 0.5) * 2; const py = 12 + k * 20 + y * amp * 0.9; i ? g.lineTo(i, py) : g.moveTo(i, py); }
      g.stroke();
    });
    g.fillStyle = '#aaa'; g.font = '9px Segoe UI'; g.fillText('R', 2, 10); g.fillText('L', 2, 30); g.fillText('±40µV', 180, 40);
  }

  /* ---------- traces, latency ---------- */
  function renderList() {
    $('traceList').innerHTML = '';
    S.traces.forEach((t) => {
      const d = document.createElement('div'); d.className = 'tr ' + EAR[t.ear] + (S.sel === t ? ' sel' : '');
      d.innerHTML = `<input type="checkbox" ${t.hidden ? '' : 'checked'}><span class="tag">${t.label}</span><span>${typeLabel(t.stim.freq)} ${t.stim.rate}/s ${t.stim.polarity === 'rare' ? 'R' : t.stim.polarity === 'cond' ? 'C' : 'A'} ${t.n}</span>`;
      d.querySelector('input').onchange = (e) => { t.hidden = !e.target.checked; render(); };
      d.onclick = (e) => { if (e.target.tagName !== 'INPUT') { S.sel = t; renderList(); render(); } };
      $('traceList').appendChild(d);
    });
  }
  function renderLat() {
    const rows = S.traces.filter((t) => Object.keys(t.marks).length);
    if (!rows.length) { $('lat').innerHTML = '<span class="hint">Latencies (ms): choose the Latency tab, select a curve and click on waves I, III and V.</span>'; return; }
    const f = (v) => (v == null ? '' : v.toFixed(2)), dif = (a, b) => (a != null && b != null ? (b - a).toFixed(2) : '');
    let h = '<table><tr><th>Curve</th><th>Type</th><th>Rate</th>' + WAVES.map((w) => `<th>${w}</th>`).join('') + '<th>I-III</th><th>III-V</th><th>I-V</th></tr>';
    for (const t of rows) {
      const m = t.marks;
      h += `<tr><td><b>${t.label}</b></td><td>${typeLabel(t.stim.freq)}</td><td>${t.stim.rate}</td>${WAVES.map((w) => `<td>${f(m[w])}</td>`).join('')}<td>${dif(m.I, m.III)}</td><td>${dif(m.III, m.V)}</td><td>${dif(m.I, m.V)}</td></tr>`;
    }
    $('lat').innerHTML = h + '</table>';
  }
  function paneClick(cv, ear, ev) {
    const r = cv.getBoundingClientRect(), mx = ev.clientX - r.left, my = ev.clientY - r.top, lay = cv._lay;
    if (!lay || !lay.items.length) return null;
    const onTag = mx < L_MARGIN - 12;
    const pos = onTag ? lay.tagY : lay.ys;
    let bd = Infinity;
    pos.forEach((y) => { const d = Math.abs(my - y); if (d < bd) bd = d; });
    if (bd > (onTag ? 9 : Math.max(lay.slot * 0.8, 24))) return null;
    let bi = -1;
    pos.forEach((y, i) => { if (Math.abs(my - y) <= bd + 0.5 && (bi < 0 || lay.items[i].tr === S.sel)) bi = i; });
    return { it: lay.items[bi], t: lay.tOf(mx), i: bi, lay, onTag, mx, my };
  }
  function bindDrag(cv, ear) {
    cv.addEventListener('mousedown', (ev) => {
      if (ev.button !== 0) return;
      const h = paneClick(cv, ear, ev);
      if (!h || !h.onTag || h.it.tr.live) return;
      const tr = h.it.tr; S.sel = tr;
      if (!tr.dy) tr.dy = [0, 0];
      S.drag = { cv, tr, ch: h.it.chan, y0: ev.clientY, dy0: tr.dy[h.it.chan], moved: false };
      cv.style.cursor = 'grabbing'; renderList(); render(); ev.preventDefault();
    });
    cv.addEventListener('mousemove', (ev) => {
      if (S.drag) return;
      const h = paneClick(cv, ear, ev);
      cv.style.cursor = h && h.onTag && !h.it.tr.live ? 'grab' : 'crosshair';
    });
    cv.addEventListener('dblclick', (ev) => {
      const h = paneClick(cv, ear, ev);
      if (h && h.onTag && h.it.tr.dy) { h.it.tr.dy[h.it.chan] = 0; render(); }
    });
  }
  window.addEventListener('mousemove', (ev) => {
    const d = S.drag; if (!d) return;
    const dy = ev.clientY - d.y0;
    if (Math.abs(dy) > 3) d.moved = true;
    d.tr.dy[d.ch] = Math.max(-600, Math.min(600, d.dy0 + dy));
    render();
  });
  window.addEventListener('mouseup', () => {
    const d = S.drag; if (!d) return;
    d.cv.style.cursor = 'grab'; S.dragMoved = d.moved; S.drag = null;
    setTimeout(() => (S.dragMoved = false), 0);
  });
  function onClick(cv, ear, ev) {
    if (S.dragMoved) return;
    const h = paneClick(cv, ear, ev); if (!h) return;
    const tr = h.it.tr;
    if (tr.live) return;
    if (h.onTag) S.sel = tr;
    else if (S.tab === 'latency' && S.sel === tr && h.it.chan === 0) {
      const arr = tr.ch[0].avg, c = Math.round((h.t - W0) / DT), half = Math.round(0.35 / DT);
      let best = c;
      for (let k = Math.max(1, c - half); k <= Math.min(arr.length - 2, c + half); k++) if (arr[k] > arr[best]) best = k;
      tr.marks[S.wave] = W0 + best * DT;
    } else S.sel = tr;
    renderList(); render();
  }
  function onContext(cv, ear, ev) {
    ev.preventDefault();
    const h = paneClick(cv, ear, ev); if (!h || h.it.tr.live) return;
    const tr = h.it.tr, prev = S.sel;
    const pair = prev && prev !== tr && prev.ear === tr.ear && !prev.live;   // combine 'prev' (selected) with 'tr'
    if (!pair) S.sel = tr;
    render(); renderList();
    const c = $('ctx'); c.innerHTML = '';
    const add = (txt, fn) => { const d = document.createElement('div'); d.textContent = txt; d.onclick = () => { c.hidden = true; fn(); renderList(); render(); }; c.appendChild(d); };
    if (pair) {
      add(`Merge ${prev.label} + ${tr.label} (replace originals)`, () => combine(prev, tr, 'merge'));
      add(`Add ${prev.label} + ${tr.label} (weighted average, keep originals)`, () => combine(prev, tr, 'add'));
    }
    if (tr.parts) add('Unmerge', () => unmerge(tr));
    add(tr.hidden ? 'Show' : 'Hide', () => (tr.hidden = !tr.hidden));
    add(S.chan === 'both' ? 'Ipsilateral only' : 'Show contralateral (Ipsi / Contra)', () => { S.chan = S.chan === 'both' ? 'ipsi' : 'both'; syncUI(); });
    add('Clear marks', () => (tr.marks = {}));
    add('Reset position', () => (tr.dy = [0, 0]));
    add('Export waveform (CSV)', () => exportCsv(tr));
    add('Delete', () => { S.traces = S.traces.filter((t) => t !== tr); S.sel = null; });
    c.style.left = ev.clientX + 'px'; c.style.top = ev.clientY + 'px'; c.hidden = false;
  }
  /* merge = sweep-weighted average (grand average); add = arithmetic sum. Sources are kept so it can be unmerged. */
  function combine(a, b, mode) {
    const na = Math.max(a.n, 1), nb = Math.max(b.n, 1), nt = na + nb;
    const wa = na / nt, wb = nb / nt;          // both modes: sweep-weighted average
    if (a.ch[0].avg.length !== b.ch[0].avg.length) { toast('Cannot combine click and tone-burst curves (different time windows)'); return; }
    const NWc = a.ch[0].avg.length;
    const mix = (x, y) => { const o = new Float64Array(NWc); for (let i = 0; i < NWc; i++) o[i] = wa * x[i] + wb * y[i]; return o; };
    const ch = [0, 1].map((k) => ({ avg: mix(a.ch[k].avg, b.ch[k].avg), A: mix(a.ch[k].A, b.ch[k].A), B: mix(a.ch[k].B, b.ch[k].B) }));
    const rn = 1 / Math.sqrt(1 / (a.rn * a.rn) + 1 / (b.rn * b.rn));
    // reproducibility of the new A/B split (1-10 ms) and an Fmp-like statistic from the combined average
    let ta = 1, tb = 10;
    if (NWc > M.NW) {                     // tone burst: statistics around the wave V-V' peak of the combined average
      let bi = Math.round((5 - W0) / DT); const av = ch[0].avg;
      for (let i = bi; i < NWc; i++) if (av[i] > av[bi]) bi = i;
      const tpk = W0 + bi * DT; ta = Math.max(2, tpk - 2); tb = Math.min(W0 + (NWc - 1) * DT - 2, tpk + 8);
    }
    const i0 = Math.round((ta - W0) / DT), i1 = Math.round((tb - W0) / DT), i2 = Math.min(NWc - 1, Math.round((tb + 2 - W0) / DT));
    let ma = 0, mb = 0; const m = i1 - i0;
    for (let i = i0; i < i1; i++) { ma += ch[0].A[i]; mb += ch[0].B[i]; }
    ma /= m; mb /= m;
    let sab = 0, saa = 0, sbb = 0;
    for (let i = i0; i < i1; i++) { const x = ch[0].A[i] - ma, y = ch[0].B[i] - mb; sab += x * y; saa += x * x; sbb += y * y; }
    let pw = 0; for (let i = i0; i < i2; i++) pw += ch[0].avg[i] * ch[0].avg[i]; pw /= (i2 - i0);
    const rnU = rn / 1000, fmp = (pw + rnU * rnU) / (rnU * rnU);
    S.mergeCount = (S.mergeCount || 0) + 1;
    const t = {
      id: S.nextId++, base: a.base, ear: a.ear, stim: a.stim, w1: a.w1, opts: a.opts, dy: [0, 0], marks: {}, hidden: false, live: false,
      label: a.base + (mode === 'merge' ? ' M' : ' +') + S.mergeCount, mode,
      ch, n: nt, rejected: (a.rejected * na + b.rejected * nb) / nt, rn,
      repro: saa && sbb ? Math.max(0, sab / Math.sqrt(saa * sbb)) : 0, fmp, conf: Math.min(99.9, (1 - Math.exp(-2.2 * Math.max(0, fmp - 1))) * 100)
    };
    if (mode === 'merge') {                   // merge replaces the two curves (can be unmerged)
      t.parts = [a, b];
      const at = Math.min(S.traces.indexOf(a), S.traces.indexOf(b));
      S.traces = S.traces.filter((x) => x !== a && x !== b);
      S.traces.splice(Math.max(0, at), 0, t);
      toast('Merged ' + a.label + ' + ' + b.label + ' (right-click > Unmerge to undo)');
    } else {                                  // add keeps both originals visible
      S.traces.push(t);
      toast('Added ' + a.label + ' + ' + b.label + ' as ' + t.label + ' (originals kept)');
    }
    S.sel = t;
  }
  function unmerge(t) {
    if (!t.parts) return;
    const at = S.traces.indexOf(t);
    S.traces.splice(at, 1, ...t.parts);
    S.sel = t.parts[0];
    toast('Unmerged ' + t.label);
  }
  function exportCsv(tr) {
    let s = 'ms,ipsi_nV,contra_nV\n';
    for (let k = 0; k < tr.ch[0].avg.length; k++) s += (W0 + k * DT).toFixed(2) + ',' + (tr.ch[0].avg[k] * 1000).toFixed(1) + ',' + (tr.ch[1].avg[k] * 1000).toFixed(1) + '\n';
    const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([s], { type: 'text/csv' })); a.download = tr.label.replace(/\W+/g, '_') + '.csv'; a.click();
  }

  /* ---------- patient editor ---------- */
  const PATHS = ['None', 'Retrocochlear', 'Neuropathy (ANSD)'];
  const SEVS = ['Mild', 'Moderate', 'Severe', 'Marked / absent'];
  const CMS = ['Absent', 'Small', 'Moderate', 'Large'];
  function buildPatientModal() {
    const sel = $('pPreset');
    sel.innerHTML = '<option value="">— choose —</option>' + window.DEFAULT_PATIENTS.map((p, i) => `<option value="${i}">${p.name}</option>`).join('');
    const tb = $('pAud').querySelector('tbody'); tb.innerHTML = '';
    [['Right AC', 0, 'ac'], ['Right BC', 0, 'bc'], ['Left AC', 1, 'ac'], ['Left BC', 1, 'bc']].forEach(([lbl, e, k]) => {
      const tr = document.createElement('tr'); tr.innerHTML = `<th>${lbl}</th>` + [0, 1, 2, 3].map((i) => `<td><input type="number" step="5" min="-10" max="${k === 'bc' ? 70 : 120}" data-e="${e}" data-k="${k}" data-i="${i}"></td>`).join('');
      tb.appendChild(tr);
    });
    $('pPath').innerHTML = [0, 1].map((e) => `<div class="earblk"><h4>${e ? 'Left' : 'Right'} ear</h4>
      <label>Pathology<select data-p="path" data-e="${e}">${PATHS.map((n, i) => `<option value="${i}">${n}</option>`).join('')}</select></label>
      <label>Severity<select data-p="sev" data-e="${e}">${SEVS.map((n, i) => `<option value="${i}">${n}</option>`).join('')}</select></label>
      <label>Cochlear microphonic<select data-p="cm" data-e="${e}">${CMS.map((n, i) => `<option value="${i}">${n}</option>`).join('')}</select></label>
      <label>Wave I (ms)<input type="number" step="0.05" data-p="latI" data-e="${e}" placeholder="auto"></label>
      <label>Wave III (ms)<input type="number" step="0.05" data-p="latIII" data-e="${e}" placeholder="auto"></label>
      <label>Wave V (ms)<input type="number" step="0.05" data-p="latV" data-e="${e}" placeholder="auto"></label></div>`).join('') +
      '<div class="hint">Latencies apply at 80 dB nHL, 17.1/s, rarefaction, insert phones. Leave blank for the model default (adjusted for age, pathology, thresholds).</div>';
  }
  function fillPatientModal() {
    const p = S.patient;
    $('pName').value = p.name; $('pAge').value = p.adult ? 'adult' : 'child'; $('pMonths').value = p.ageMonths; $('pState').value = p.noisy ? 'noisy' : 'quiet';
    $('pMonths').disabled = p.adult;
    document.querySelectorAll('#pAud input').forEach((inp) => (inp.value = p.ears[+inp.dataset.e][inp.dataset.k][+inp.dataset.i]));
    document.querySelectorAll('#pPath [data-p]').forEach((el) => { const v = p.ears[+el.dataset.e][el.dataset.p]; el.value = v == null ? '' : v; });
  }
  function readPatientModal() {
    const p = M.newPatient({ name: $('pName').value.trim() || 'Patient', adult: $('pAge').value === 'adult', ageMonths: Math.max(0, Math.min(63, +$('pMonths').value || 0)), noisy: $('pState').value === 'noisy' });
    document.querySelectorAll('#pAud input').forEach((inp) => { p.ears[+inp.dataset.e][inp.dataset.k][+inp.dataset.i] = Math.round((+inp.value || 0) / 5) * 5; });
    document.querySelectorAll('#pPath [data-p]').forEach((el) => {
      const k = el.dataset.p, e = p.ears[+el.dataset.e];
      e[k] = ['latI', 'latIII', 'latV'].includes(k) ? (el.value === '' ? null : Math.round(+el.value * 20) / 20) : +el.value;
    });
    return p;
  }
  function shareUrl(p) {
    return location.href.split('#')[0] + '#case=' + window.ABRCodec.encode(p);
  }
  function copyLink(p) {
    const url = shareUrl(p);
    (navigator.clipboard ? navigator.clipboard.writeText(url) : Promise.reject()).then(() => toast(url.length > 255 ? 'Link copied (over 255 chars, may not survive Word hyperlinks)' : 'Share link copied'), () => { prompt('Copy this link', url); });
  }
  function setPatient(p) {
    if (S.acq) stop();
    S.patient = M.newPatient(JSON.parse(JSON.stringify(p)));
    S.traces = []; S.sel = null; S.live = null;
    syncUI(); renderList(); render();
  }
  const ADMIN_PW = '1234';
  function applyLock() {
    const un = !!S.unlocked;
    $('mPatient').classList.toggle('locked', !un);
    document.querySelectorAll('#mPatient input, #mPatient select').forEach((el) => { if (el.id !== 'pPw') el.disabled = !un; });
    if (un) $('pMonths').disabled = $('pAge').value === 'adult';
    $('pHint').textContent = un ? 'Instructor mode: edit the case, then Apply. Copy share link distributes the case to students.' : 'Case information (read-only). Instructor password required to edit the case or create links.';
  }
  function tryUnlock() {
    if ($('pPw').value === ADMIN_PW) {
      S.unlocked = true; try { sessionStorage.setItem('abrAdmin', '1'); } catch (e) { /* ignore */ }
      $('pPw').value = ''; $('pLockMsg').textContent = ''; applyLock(); return true;
    }
    $('pLockMsg').textContent = 'Incorrect password'; return false;
  }
  function lockAgain() { S.unlocked = false; try { sessionStorage.removeItem('abrAdmin'); } catch (e) { /* ignore */ } applyLock(); }
  function bindPatient() {
    try { S.unlocked = sessionStorage.getItem('abrAdmin') === '1'; } catch (e) { S.unlocked = false; }
    buildPatientModal();
    $('pUnlock').onclick = tryUnlock; $('pRelock').onclick = lockAgain;
    $('pPw').onkeydown = (e) => { if (e.key === 'Enter') tryUnlock(); };
    $('btnPatient').onclick = () => { fillPatientModal(); applyLock(); $('mPatient').hidden = false; };
    $('pClose').onclick = () => ($('mPatient').hidden = true);
    $('pAge').onchange = () => ($('pMonths').disabled = $('pAge').value === 'adult');
    $('pPreset').onchange = () => { const i = $('pPreset').value; if (i !== '') { S.patient = M.newPatient(JSON.parse(JSON.stringify(window.DEFAULT_PATIENTS[+i]))); fillPatientModal(); } };
    $('pApply').onclick = () => { if (!S.unlocked) return; setPatient(readPatientModal()); $('mPatient').hidden = true; toast('Patient applied; recordings cleared'); };
    $('pCopy').onclick = () => { if (S.unlocked) copyLink(readPatientModal()); };
    $('btnShare').onclick = () => { if (S.unlocked) copyLink(S.patient); else { fillPatientModal(); applyLock(); $('mPatient').hidden = false; toast('Instructor password required to create share links'); } };
  }

  /* ---------- report ---------- */
  function openReport() {
    const rows = S.traces.filter((t) => !t.hidden);
    let h = `<div class="rep-head"><div><h2>ABR report</h2><div>${S.patient.name} &mdash; ${S.patient.adult ? 'Adult' : 'Child ' + S.patient.ageMonths + ' mo'}</div></div><div>${new Date().toLocaleDateString()}</div></div>
      <div class="rep-graphs"><canvas id="rc0"></canvas><canvas id="rc1"></canvas></div><h3>Recordings</h3>
      <table><tr><th>Curve</th><th>Stimulus</th><th>Transducer</th><th>Recorded / rejected</th><th>Wave repro</th><th>Rate</th><th>Polarity</th><th>HPF / LPF</th><th>RN</th></tr>`;
    for (const t of rows) h += `<tr><td>${t.label}</td><td>${typeLabel(t.stim.freq)} ${t.stim.level} dB nHL</td><td>${t.stim.transducer === 'bone' ? 'Bone' : 'Insert'}</td><td>${t.n} / ${Math.round(t.rejected * 100)}%</td><td>${Math.round(t.repro * 100)}%</td><td>${t.stim.rate}</td><td>${{ rare: 'Raref.', cond: 'Cond.', alt: 'Alter.' }[t.stim.polarity]}</td><td>${t.opts ? t.opts.hp : S.hp} / ${t.opts ? t.opts.lp : S.lp}</td><td>${t.rn.toFixed(0)} nV</td></tr>`;
    h += '</table><h3>Latencies (ms)</h3><div id="repLat"></div>';
    $('reportBody').innerHTML = h;
    $('repLat').innerHTML = $('lat').innerHTML;
    $('mReport').hidden = false;
    requestAnimationFrame(() => { draw($('rc0'), 0, 'x'); draw($('rc1'), 1, 'x'); });
  }

  /* ---------- wiring ---------- */
  function init() {
    fill($('rate'), RATES, 17.1, (v) => v.toFixed(1)); fill($('nmax'), NMAX, 2000);
    $('waveBtns').innerHTML = WAVES.map((w) => `<button data-w="${w}" class="${w === S.wave ? 'on' : ''}">${w}</button>`).join('');
    $('waveBtns').onclick = (e) => { if (e.target.dataset.w) { S.wave = e.target.dataset.w; [...$('waveBtns').children].forEach((b) => b.classList.toggle('on', b.dataset.w === S.wave)); } };
    document.querySelectorAll('.tab').forEach((b) => (b.onclick = () => {
      S.tab = b.dataset.tab;
      document.querySelectorAll('.tab').forEach((x) => x.classList.toggle('on', x === b));
      document.querySelectorAll('.tabpane').forEach((p) => (p.hidden = p.id !== 'tab-' + S.tab));
    }));
    $('protocol').onchange = () => { S.type = +$('protocol').value; applyProtocolDefaults(); syncUI(); };
    $('stType').onchange = () => { S.type = +$('stType').value; applyProtocolDefaults(); syncUI(); };
    ['level', 'trans', 'pol', 'rate', 'nmax', 'reject', 'hpf', 'lpf', 'speed', 'noise'].forEach((id) => ($(id).onchange = () => { readUI(); syncUI(); }));
    document.querySelectorAll('input[name=ear]').forEach((r) => (r.onchange = () => { readUI(); }));
    $('lvlUp').onclick = () => { S.level += 5; clampLevel(); syncUI(); };
    $('lvlDn').onclick = () => { S.level -= 5; clampLevel(); syncUI(); };
    $('btnStart').onclick = () => (S.acq ? stop() : start());
    $('btnPause').onclick = () => { S.paused = !S.paused; setButtons(); };
    $('chanSel').onchange = () => { S.chan = $('chanSel').value; syncUI(); render(); };
    $('showAB').onchange = () => { S.showAB = $('showAB').checked; syncUI(); render(); };
    $('tbAB').onclick = () => { S.showAB = !S.showAB; syncUI(); render(); };
    $('tbC').onclick = () => { S.chan = S.chan === 'both' ? 'ipsi' : 'both'; syncUI(); render(); };
    document.querySelectorAll('.ord').forEach((b) => (b.onclick = () => {
      S.order = b.dataset.ord; S.traces.forEach((t) => (t.dy = [0, 0]));   // re-arranging clears manual positions
      syncUI(); render();
    }));
    $('zoomUp').onclick = () => { S.zoom *= 1.25; render(); }; $('zoomDn').onclick = () => { S.zoom /= 1.25; render(); };
    $('btnDel').onclick = () => { if (S.sel) { S.traces = S.traces.filter((t) => t !== S.sel); S.sel = null; renderList(); render(); } };
    $('btnClear').onclick = () => { S.traces = []; S.sel = null; renderList(); render(); };
    $('btnClrMarks').onclick = () => { if (S.sel) { S.sel.marks = {}; render(); } };
    $('btnUnmerge').onclick = () => { if (S.sel && S.sel.parts) { unmerge(S.sel); renderList(); render(); } else toast('Select a merged curve first'); };
    $('btnResetPos').onclick = () => { S.traces.forEach((t) => (t.dy = [0, 0])); render(); };
    [0, 1].forEach((e) => { bindDrag($('cv' + e), e); });
    [0, 1].forEach((e) => { const cv = $('cv' + e); cv.onclick = (ev) => onClick(cv, e, ev); cv.oncontextmenu = (ev) => onContext(cv, e, ev); });
    document.addEventListener('click', () => ($('ctx').hidden = true));
    $('btnReport').onclick = openReport; $('rClose').onclick = () => ($('mReport').hidden = true); $('rPrint').onclick = () => window.print();
    window.addEventListener('resize', render);
    bindPatient();
    // shared case link
    const m = /case=([^&]+)/.exec(location.hash);
    if (m) { try { S.patient = M.newPatient(window.ABRCodec.decode(m[1])); } catch (err) { toast('Could not read shared case: ' + err.message); } }
    syncUI(); setButtons(); renderList(); render();
    setInterval(drawEEG, 120);
    window.ABRApp = S;   // exposed for debugging
  }
  init();
})();
