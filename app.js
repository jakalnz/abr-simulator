/* ABR simulator UI: Eclipse-style recording, ipsi/contra traces, latency cursors, patient editor, share links, report. */
(function () {
  'use strict';
  const M = window.ABRModel, DT = M.DT, W0 = M.W0, W1 = M.W1, NW = M.NW;
  const $ = (id) => document.getElementById(id);
  const EAR = ['R', 'L'];
  const RATES = [7.1, 11.1, 17.1, 27.1, 33.1, 39.1, 65.1, 91.1];
  const NMAX = [500, 1000, 1500, 2000, 3000, 4000];
  const WAVES = ['I', 'II', 'III', 'IV', 'V'];
  const CATS = ['CR', 'NR', 'INC'];
  const CAT_COL = { CR: '#2e8b3a', NR: '#777', INC: '#d08a00' };
  const CAT_NAME = { CR: 'Clear response', NR: 'No response', INC: 'Inconclusive' };

  const S = {
    patient: M.newPatient(JSON.parse(JSON.stringify(window.DEFAULT_PATIENTS[0]))),
    ear: 0, level: 80, type: 0, trans: 'insert', pol: 'rare', rate: 17.1, nmax: 2000,
    reject: 40, hp: 100, lp: 3000, speed: 100, noise: 0.3, clamped: false,      // noise comes from the patient (case setting)
    chan: 'ipsi', showAB: false, order: 'I', zoom: 1,
    pages: Array.from({ length: 9 }, () => ({ traces: [], sel: null })), page: 0,
    traces: [], sel: null, acq: null, live: null, timer: null, last: 0, paused: false,
    tab: 'record', wave: null, nextId: 1, selMark: null, hover: null
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
  const POL_NAME = { rare: 'Raref.', cond: 'Cond.', alt: 'Alter.', sub: 'R − C' };
  const POL_SHORT = { rare: 'R', cond: 'C', alt: 'A', sub: 'R−C' };

  /* ---------- settings <-> UI ---------- */
  function applyProtocolDefaults() {
    // NZ UNHSEIP Appendix 4: tone bursts alternating polarity, 39.1/s, HPF 30 Hz; clicks rarefaction (separate R/C runs for CM)
    if (S.type === 0) { S.zoom = 1; S.hp = 100; S.lp = 3000; S.rate = 17.1; S.nmax = 2000; S.pol = 'rare'; S.level = Math.min(S.level || 80, 100); if (S.level < 60) S.level = 80; }
    else { S.zoom = 1.6; S.hp = 30; S.lp = 3000; S.rate = 39.1; S.nmax = 2000; S.pol = 'alt'; if (S.level > 70) S.level = 60; }
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
    $('reject').value = S.reject; $('hpf').value = S.hp; $('lpf').value = S.lp; $('speed').value = S.speed;
    document.querySelectorAll('input[name=ear]').forEach((r) => (r.checked = +r.value === S.ear));
    $('chanSel').value = S.chan; $('showAB').checked = S.showAB;
    if (S.trans === 'bone') S.clamped = false;
    $('tbClamp').classList.toggle('on', S.clamped); $('tbClamp').disabled = S.trans === 'bone'; $('clampChk').checked = S.clamped; $('clampChk').disabled = S.trans === 'bone';
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
    S.hp = +$('hpf').value; S.lp = +$('lpf').value; S.speed = +$('speed').value;
    S.ear = +document.querySelector('input[name=ear]:checked').value;
    clampLevel();
  }

  /* ---------- acquisition ---------- */
  function currentStim() {
    return { ear: S.ear, level: S.level, freq: S.type, polarity: S.pol, rate: S.rate, transducer: S.trans, clamped: S.clamped && S.trans === 'insert' };
  }
  function labelFor(stim) {
    const base = (stim.freq ? (stim.freq / 1000) + 'k ' : '') + stim.level + ' ' + EAR[stim.ear] + (stim.clamped ? ' cl' : '');
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
  /* Recording pages 1-9: each page holds its own set of curves; the app always works on S.traces / S.sel of the current page. */
  function switchPage(n) {
    if (n === S.page) return;
    if (S.acq) { toast('Stop the recording before changing page'); return; }
    S.pages[S.page].traces = S.traces; S.pages[S.page].sel = S.sel;
    S.page = n; S.traces = S.pages[n].traces; S.sel = S.pages[n].sel;
    $('ctx').hidden = true; renderList(); render();
  }
  function renderPages() {
    [...$('pageBtns').children].forEach((b, i) => {
      const traces = i === S.page ? S.traces : S.pages[i].traces;
      b.classList.toggle('on', i === S.page); b.classList.toggle('has', traces.length > 0);
      b.title = 'Page ' + (i + 1) + (traces.length ? ' (' + traces.length + ' curve' + (traces.length > 1 ? 's' : '') + ')' : ' (empty)');
    });
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
      const key = S.order === 'O' ? t.id : [t.stim.freq, t.stim.level, t.stim.transducer, t.stim.rate, t.stim.polarity, !!t.stim.clamped].join('|');
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
             base: (i) => T_MARGIN + (i + 0.62) * slot };     // baseline below the slot centre: waves I-V rise further than the trough falls
  }
  function draw(cv, ear, forReport) {
    const dpr = forReport ? 2 : window.devicePixelRatio || 1;     // report canvases at 2x so the printout stays sharp
    const w = cv.clientWidth, h = cv.clientHeight;
    if (cv.width !== Math.round(w * dpr) || cv.height !== Math.round(h * dpr)) { cv.width = Math.round(w * dpr); cv.height = Math.round(h * dpr); }
    const ctx = cv.getContext('2d'); ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    const lay = layout(cv, ear, forReport); lay.ys = []; lay.tagY = []; lay.markBoxes = []; lay.catBoxes = []; cv._lay = lay;
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
      const t = it.tr, d = t.ch[it.chan];
      // manual offsets (report ignores them) are limited so the baseline and its tag stay inside the plot and can be grabbed again
      let base = lay.base(it.slot) + (forReport ? 0 : (t.dy && t.dy[it.chan]) || 0);
      const bmin = T_MARGIN + 10, bmax = h - B_MARGIN - 10;
      if (base < bmin || base > bmax) { base = Math.max(bmin, Math.min(bmax, base)); if (!forReport && t.dy) t.dy[it.chan] = base - lay.base(it.slot); }
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
        const idx = Math.max(0, Math.min(d.avg.length - 1, Math.round((tm - W0) / DT))), yy = ys(d.avg[idx]);
        const isSel = !forReport && S.selMark && S.selMark.tr === t && S.selMark.wave === k;
        ctx.strokeStyle = isSel ? '#d00' : '#000'; ctx.lineWidth = isSel ? 2 : 1;
        ctx.beginPath(); ctx.moveTo(x(tm), yy - 4); ctx.lineTo(x(tm), yy - 13); ctx.stroke();
        if (isSel) { ctx.fillStyle = '#d00'; ctx.beginPath(); ctx.moveTo(x(tm), yy - 2); ctx.lineTo(x(tm) - 3.5, yy - 8); ctx.lineTo(x(tm) + 3.5, yy - 8); ctx.fill(); }
        ctx.fillStyle = isSel ? '#d00' : '#000'; ctx.textAlign = 'center'; ctx.font = (isSel ? 'bold ' : '') + '12px Segoe UI'; ctx.fillText(k, x(tm), yy - 16);
        ctx.lineWidth = 1; ctx.font = '11px Segoe UI';
        lay.markBoxes.push({ i, tr: t, wave: k, x: x(tm), y0: yy - 30, y1: yy });
      }
      // response category label (CR / NR / INC)
      if (t.cat && !isC) {
        const bw = t.cat === 'INC' ? 34 : 26, bx = w - R_MARGIN - bw - 4, by = tagY - 27;
        ctx.fillStyle = CAT_COL[t.cat]; ctx.fillRect(bx, by, bw, 15);
        ctx.fillStyle = '#fff'; ctx.font = 'bold 10px Segoe UI'; ctx.textAlign = 'center'; ctx.fillText(t.cat, bx + bw / 2, by + 11);
        ctx.font = '11px Segoe UI'; ctx.textAlign = 'left';
        lay.catBoxes.push({ i, tr: t, x0: bx, x1: bx + bw, y0: by, y1: by + 15 });
      }
    });
    ctx.textAlign = 'left';
    if (!items.length) { ctx.fillStyle = '#888'; ctx.fillText('No curves recorded for this ear', L_MARGIN + 10, T_MARGIN + 24); }
  }
  function render() {
    draw($('cv0'), 0); draw($('cv1'), 1); renderPages();
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
    renderLat(); renderLabelUI();
  }
  function drawEEG() {                   // raw EEG monitor: light background to match the panels, traces in the ear colours
    const c = $('eeg'), g = c.getContext('2d'); g.fillStyle = '#fff'; g.fillRect(0, 0, c.width, c.height);
    g.strokeStyle = '#e4e4e4'; g.lineWidth = 1; g.beginPath();
    for (let x = 20; x < c.width; x += 20) { g.moveTo(x + 0.5, 0); g.lineTo(x + 0.5, c.height); }
    [12, 32].forEach((y) => { g.moveTo(0, y + 0.5); g.lineTo(c.width, y + 0.5); });
    g.stroke();
    const amp = (S.patient.noisy ? 11 : 3) * (S.acq ? 1 : 0.6);
    ['#8b1414', '#1a1a9c'].forEach((col, k) => {
      g.strokeStyle = col; g.beginPath(); let y = 0;
      for (let i = 0; i < c.width; i += 2) { y = 0.8 * y + 0.6 * (Math.random() - 0.5) * 2; const py = 12 + k * 20 + y * amp * 0.9; i ? g.lineTo(i, py) : g.moveTo(i, py); }
      g.stroke();
    });
    g.fillStyle = '#555'; g.font = '9px Segoe UI'; g.fillText('R', 2, 10); g.fillText('L', 2, 30); g.fillText('±40µV', 180, 40);
  }

  /* ---------- traces, latency ---------- */
  function renderList() {
    $('traceList').innerHTML = '';
    S.traces.forEach((t) => {
      const d = document.createElement('div'); d.className = 'tr ' + EAR[t.ear] + (S.sel === t ? ' sel' : '');
      d.innerHTML = `<input type="checkbox" ${t.hidden ? '' : 'checked'}><span class="tag">${t.label}</span><span>${typeLabel(t.stim.freq)} ${t.stim.rate}/s ${POL_SHORT[t.stim.polarity]}${t.stim.clamped ? ' clamped' : ''} ${t.n}</span>`;
      d.querySelector('input').onchange = (e) => { t.hidden = !e.target.checked; render(); };
      d.onclick = (e) => { if (e.target.tagName !== 'INPUT') { S.sel = t; renderList(); render(); } };
      $('traceList').appendChild(d);
    });
  }
  /* one latency table for the pop-out and the report */
  const f2 = (v) => (v == null ? '' : v.toFixed(2)), dif = (a, b) => (a != null && b != null ? (b - a).toFixed(2) : '');
  const markedRows = () => S.traces.filter((t) => Object.keys(t.marks).length || t.cat);
  function latTableHTML(rows) {
    if (!rows.length) return '<div class="hint">No labelled curves yet: select a curve, arm a wave on the toolbar (I-V or keys 1-5) and click the curve.</div>';
    let h = '<table class="lat"><tr><th>Curve</th><th>Ear</th><th>Stimulus</th><th>dB nHL</th><th>Rate</th>' + WAVES.map((w) => `<th>${w}</th>`).join('') + '<th>I-III</th><th>III-V</th><th>I-V</th><th>Category</th></tr>';
    for (const t of rows) {
      const m = t.marks;
      h += `<tr><td><b>${t.label}</b></td><td>${EAR[t.ear]}</td><td>${typeLabel(t.stim.freq)}${t.stim.transducer === 'bone' ? ' BC' : ''}</td><td>${t.stim.level}</td><td>${t.stim.rate}</td>${WAVES.map((w) => `<td>${f2(m[w])}</td>`).join('')}<td>${dif(m.I, m.III)}</td><td>${dif(m.III, m.V)}</td><td>${dif(m.I, m.V)}</td><td>${t.cat ? `<b style="color:${CAT_COL[t.cat]}">${t.cat}</b>` : ''}</td></tr>`;
    }
    return h + '</table>';
  }
  function renderLat() {                          // Latency tab: the selected curve only
    const t = S.sel;
    if (!t) { $('latSel').innerHTML = '<div class="hint">Select a curve to see its latencies.</div>'; return; }
    const m = t.marks;
    $('latSel').innerHTML = `<div style="margin-bottom:3px"><b>${t.label}</b> &mdash; ${typeLabel(t.stim.freq)} ${t.stim.level} dB nHL ${t.stim.transducer === 'bone' ? 'BC' : 'AC'} ${t.ear ? 'left' : 'right'}${t.cat ? ` &nbsp;<b style="color:${CAT_COL[t.cat]}">${t.cat}</b>` : ''}</div>` +
      '<table><tr><th>Wave</th>' + WAVES.map((w) => `<th>${w}</th>`).join('') + '</tr><tr><th>ms</th>' + WAVES.map((w) => `<td>${f2(m[w])}</td>`).join('') + '</tr></table>' +
      `<table style="margin-top:4px"><tr><th>I-III</th><th>III-V</th><th>I-V</th></tr><tr><td>${dif(m.I, m.III)}</td><td>${dif(m.III, m.V)}</td><td>${dif(m.I, m.V)}</td></tr></table>`;
  }

  /* ---------- latency-intensity chart (Eclipse style: ms vs dB nHL, normative grey bands from M.normalLI) ---------- */
  const LI_SYM = { I: 'tri', II: 'sq', III: 'x', IV: 'o', V: 'tridn' };
  const liUsable = (t) => Object.keys(t.marks).length && !t.stim.clamped && t.stim.polarity !== 'sub';
  function liGroups() {
    const keys = new Map();
    for (const t of S.traces) {
      if (!liUsable(t)) continue;
      const k = t.stim.freq + '|' + t.stim.transducer;
      if (!keys.has(k)) keys.set(k, { freq: t.stim.freq, transducer: t.stim.transducer, label: typeLabel(t.stim.freq) + (t.stim.transducer === 'bone' ? ' bone conduction' : ' air conduction') });
    }
    return [...keys.values()].sort((a, b) => a.freq - b.freq || (a.transducer > b.transducer ? 1 : -1));
  }
  function drawSym(g, kind, x, y, r) {
    g.beginPath();
    if (kind === 'tri') { g.moveTo(x, y - r); g.lineTo(x + r, y + r * 0.8); g.lineTo(x - r, y + r * 0.8); g.closePath(); }
    else if (kind === 'tridn') { g.moveTo(x, y + r); g.lineTo(x + r, y - r * 0.8); g.lineTo(x - r, y - r * 0.8); g.closePath(); }
    else if (kind === 'sq') g.rect(x - r * 0.8, y - r * 0.8, r * 1.6, r * 1.6);
    else if (kind === 'o') g.arc(x, y, r * 0.9, 0, 2 * Math.PI);
    else { g.moveTo(x - r, y - r); g.lineTo(x + r, y + r); g.moveTo(x + r, y - r); g.lineTo(x - r, y + r); }
    g.stroke();
  }
  function drawLI(cv, grp, scale) {
    const k = scale || window.devicePixelRatio || 1, W = cv.clientWidth || 480, H = cv.clientHeight || 320;
    cv.width = Math.round(W * k); cv.height = Math.round(H * k);
    const g = cv.getContext('2d'); g.setTransform(k, 0, 0, k, 0, 0);
    g.fillStyle = '#fff'; g.fillRect(0, 0, W, H);
    const L0 = -10, L1 = 110, T1 = grp.freq ? (grp.freq <= 500 ? 20 : 16) : 12;
    const ml = 40, mr = 70, mt = 22, mb = 34;
    const x = (L) => ml + (L - L0) / (L1 - L0) * (W - ml - mr), y = (t) => H - mb - t / T1 * (H - mt - mb);
    g.font = '11px Segoe UI'; g.fillStyle = '#222'; g.textAlign = 'left'; g.fillText(grp.label, ml, 14);
    // normative bands (normal-hearing patient of the same age, +/- 2 SD)
    const nb = M.normalLI(S.patient, grp.freq, grp.transducer);
    g.fillStyle = 'rgba(0,0,0,0.13)';
    for (const w of ['I', 'III', 'V']) {
      const pts = nb.filter((r) => r[w]);
      if (pts.length < 2) continue;
      g.beginPath();
      pts.forEach((r, i) => (i ? g.lineTo(x(r.L), y(r[w][0])) : g.moveTo(x(r.L), y(r[w][0]))));
      for (let i = pts.length - 1; i >= 0; i--) g.lineTo(x(pts[i].L), y(pts[i][w][2]));
      g.closePath(); g.fill();
    }
    // grid and axes
    g.strokeStyle = '#e2e2e2'; g.lineWidth = 1; g.fillStyle = '#444'; g.textAlign = 'center';
    for (let L = -10; L <= 110; L += 10) { g.beginPath(); g.moveTo(x(L), mt); g.lineTo(x(L), H - mb); g.stroke(); g.fillText(L, x(L), H - mb + 14); }
    g.textAlign = 'right';
    for (let t = 0; t <= T1; t += (T1 > 12 ? 2 : 1)) { g.beginPath(); g.moveTo(ml, y(t)); g.lineTo(W - mr, y(t)); g.stroke(); g.fillText(t, ml - 5, y(t) + 4); }
    g.strokeStyle = '#555'; g.strokeRect(ml, mt, W - ml - mr, H - mt - mb);
    g.textAlign = 'center'; g.fillText('dB nHL', (ml + W - mr) / 2, H - 4);
    g.save(); g.translate(11, (mt + H - mb) / 2); g.rotate(-Math.PI / 2); g.fillText('ms', 0, 0); g.restore();
    // labelled latencies (right / left offset slightly so overlapping points stay visible)
    g.lineWidth = 1.4;
    for (const t of S.traces) {
      if (t.stim.freq !== grp.freq || t.stim.transducer !== grp.transducer || !liUsable(t)) continue;
      g.strokeStyle = t.ear === 0 ? '#b01818' : '#1a1a9c';
      for (const w of WAVES) if (t.marks[w] != null) drawSym(g, LI_SYM[w], x(t.stim.level + (t.ear ? 0.8 : -0.8)), y(t.marks[w]), 4.5);
    }
    // legend
    g.textAlign = 'left'; g.strokeStyle = '#222'; g.lineWidth = 1.2; g.fillStyle = '#222';
    WAVES.forEach((w, i) => { const ly = mt + 10 + i * 15; drawSym(g, LI_SYM[w], W - mr + 14, ly, 4); g.fillText(w, W - mr + 24, ly + 4); });
    g.fillStyle = '#b01818'; g.fillText('Right', W - mr + 8, mt + 95); g.fillStyle = '#1a1a9c'; g.fillText('Left', W - mr + 8, mt + 110);
    g.fillStyle = '#777'; g.font = '9px Segoe UI'; g.fillText('grey: normal', W - mr + 4, mt + 128); g.fillText('±2 SD', W - mr + 4, mt + 139);
  }
  function liChartsHTML(prefix) {
    const gs = liGroups();
    if (!gs.length) return { html: '<div class="hint">No labelled curves to plot: label wave peaks (I-V) on curves at several levels.</div>', gs };
    return { html: '<div class="li-charts">' + gs.map((g, i) => `<canvas id="${prefix}${i}"></canvas>`).join('') + '</div>', gs };
  }
  function openPop(title, html, after) {
    $('popTitle').textContent = title; $('popBody').innerHTML = html; $('mPop').hidden = false; $('popCopy').hidden = true;
    if (after) requestAnimationFrame(after);
  }
  function openLatAll() {
    const rows = markedRows();
    openPop('Latencies (ms) — page ' + (S.page + 1), latTableHTML(rows));
    $('popCopy').hidden = !rows.length;
  }
  /* tab-separated latency table (pastes into Excel as cells); includes stimulus details and interpeak intervals */
  function latTableTSV(rows) {
    const head = ['Curve', 'Ear', 'Stimulus', 'Transducer', 'dB nHL', 'Rate', 'Polarity', ...WAVES, 'I-III', 'III-V', 'I-V', 'Category'];
    const lines = [head.join('\t')];
    for (const t of rows) {
      const m = t.marks;
      lines.push([t.label, EAR[t.ear], typeLabel(t.stim.freq), t.stim.transducer === 'bone' ? 'Bone' : 'Insert', t.stim.level, t.stim.rate, POL_NAME[t.stim.polarity],
        ...WAVES.map((w) => f2(m[w])), dif(m.I, m.III), dif(m.III, m.V), dif(m.I, m.V), t.cat || ''].join('\t'));
    }
    return lines.join('\r\n');
  }
  function copyLatTable() {
    const txt = latTableTSV(markedRows());
    const done = () => toast('Latency table copied — paste into Excel');
    if (navigator.clipboard && window.isSecureContext) navigator.clipboard.writeText(txt).then(done, () => fallbackCopy(txt, done));
    else fallbackCopy(txt, done);
  }
  function fallbackCopy(txt, done) {             // file:// pages have no async clipboard: copy via a hidden textarea
    const ta = document.createElement('textarea'); ta.value = txt; ta.style.position = 'fixed'; ta.style.opacity = '0';
    document.body.appendChild(ta); ta.select();
    try { document.execCommand('copy'); done(); } catch (e) { toast('Copy failed: select the table and press Ctrl+C'); }
    ta.remove();
  }
  function openLI() {
    const { html, gs } = liChartsHTML('li');
    openPop('Latency–intensity — page ' + (S.page + 1), html, () => gs.forEach((g, i) => drawLI($('li' + i), g)));
  }
  /* ---------- labels: wave marks (I-V) and response category (CR/NR/INC) ---------- */
  const clampT = (tr, t) => Math.max(W0, Math.min(W0 + (tr.ch[0].avg.length - 1) * DT, t));
  const toSample = (tr, t) => W0 + Math.round((clampT(tr, t) - W0) / DT) * DT;
  function snapPeak(tr, t) {                       // nearest local maximum of the ipsilateral trace within +/-0.35 ms
    const arr = tr.ch[0].avg, c = Math.round((t - W0) / DT), half = Math.round(0.35 / DT);
    let best = Math.max(1, Math.min(arr.length - 2, c));
    for (let k = Math.max(1, c - half); k <= Math.min(arr.length - 2, c + half); k++) if (arr[k] > arr[best]) best = k;
    return W0 + best * DT;
  }
  function placeMark(tr, wave, t) { tr.marks[wave] = t; S.selMark = { tr, wave }; S.wave = wave; }
  function curMark() {                             // the selected label, if it still exists
    const m = S.selMark;
    if (m && S.traces.includes(m.tr) && m.tr.marks[m.wave] != null) return m;
    S.selMark = null; return null;
  }
  function setCat(tr, c) { if (!tr) { toast('Select a curve first'); return; } tr.cat = tr.cat === c ? null : c; }
  function nudge(steps) {
    let m = curMark();
    if (!m && S.sel && S.sel.marks[S.wave] != null) m = S.selMark = { tr: S.sel, wave: S.wave };
    if (!m) { toast('Click a label to select it first'); return; }
    m.tr.marks[m.wave] = toSample(m.tr, m.tr.marks[m.wave] + steps * DT);
    render();
  }
  function removeMark(m) {
    if (!m) return;
    delete m.tr.marks[m.wave];
    if (S.selMark && S.selMark.tr === m.tr && S.selMark.wave === m.wave) S.selMark = null;
  }
  function renderLabelUI() {
    [...$('waveBtns').children].forEach((b) => b.classList.toggle('on', b.dataset.w === S.wave));
    [...$('catBtns').children].forEach((b) => b.classList.toggle('on', !!S.sel && S.sel.cat === b.dataset.c));
    const m = curMark();
    $('selInfo').textContent = m ? `Selected: ${m.wave} on ${m.tr.label} at ${m.tr.marks[m.wave].toFixed(2)} ms` : 'No label selected';
  }
  function hitMark(cv, ev) {
    const r = cv.getBoundingClientRect(), mx = ev.clientX - r.left, my = ev.clientY - r.top, lay = cv._lay;
    if (!lay || !lay.markBoxes) return null;
    let best = null, bd = 1e9;
    for (const b of lay.markBoxes) { const d = Math.abs(mx - b.x); if (d <= 7 && my >= b.y0 && my <= b.y1 && d < bd) { bd = d; best = b; } }
    return best;
  }
  function hitCat(cv, ev) {
    const r = cv.getBoundingClientRect(), mx = ev.clientX - r.left, my = ev.clientY - r.top, lay = cv._lay;
    return (lay && lay.catBoxes || []).find((b) => mx >= b.x0 && mx <= b.x1 && my >= b.y0 && my <= b.y1) || null;
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
      const mb = hitMark(cv, ev);
      if (mb && !mb.tr.live) {                       // grab a wave label to slide it along the curve
        S.sel = mb.tr; S.selMark = { tr: mb.tr, wave: mb.wave }; S.wave = mb.wave;
        S.mdrag = { cv, tr: mb.tr, wave: mb.wave, moved: false, x0: ev.clientX };
        cv.style.cursor = 'ew-resize'; renderList(); render(); ev.preventDefault(); return;
      }
      const h = paneClick(cv, ear, ev);
      if (!h || !h.onTag || h.it.tr.live) return;
      const tr = h.it.tr; S.sel = tr;
      if (!tr.dy) tr.dy = [0, 0];
      S.drag = { cv, tr, ch: h.it.chan, y0: ev.clientY, dy0: tr.dy[h.it.chan], moved: false };
      cv.style.cursor = 'grabbing'; renderList(); render(); ev.preventDefault();
    });
    cv.addEventListener('mousemove', (ev) => {
      S.hover = { ear, cv, clientX: ev.clientX, clientY: ev.clientY };
      if (S.drag || S.mdrag) return;
      const h = paneClick(cv, ear, ev);
      cv.style.cursor = hitMark(cv, ev) ? 'ew-resize' : (h && h.onTag && !h.it.tr.live ? 'grab' : 'crosshair');
    });
    cv.addEventListener('mouseleave', () => { if (S.hover && S.hover.cv === cv) S.hover = null; });
    cv.addEventListener('dblclick', (ev) => {
      const h = paneClick(cv, ear, ev);
      if (h && h.onTag && h.it.tr.dy) { h.it.tr.dy[h.it.chan] = 0; render(); }
    });
  }
  window.addEventListener('mousemove', (ev) => {
    const m = S.mdrag;
    if (m) {
      if (Math.abs(ev.clientX - m.x0) > 2) m.moved = true;
      const r = m.cv.getBoundingClientRect();
      m.tr.marks[m.wave] = toSample(m.tr, m.cv._lay.tOf(ev.clientX - r.left));
      render(); return;
    }
    const d = S.drag; if (!d) return;
    const dy = ev.clientY - d.y0;
    if (Math.abs(dy) > 3) d.moved = true;
    d.tr.dy[d.ch] = Math.max(-600, Math.min(600, d.dy0 + dy));
    render();
  });
  window.addEventListener('mouseup', () => {
    const m = S.mdrag;
    if (m) { m.cv.style.cursor = 'crosshair'; S.dragMoved = m.moved; S.mdrag = null; setTimeout(() => (S.dragMoved = false), 0); return; }
    const d = S.drag; if (!d) return;
    d.cv.style.cursor = 'grab'; S.dragMoved = d.moved; S.drag = null;
    setTimeout(() => (S.dragMoved = false), 0);
  });
  function onClick(cv, ear, ev) {
    if (S.dragMoved) return;
    const mb = hitMark(cv, ev);
    if (mb && !mb.tr.live) { S.sel = mb.tr; S.selMark = { tr: mb.tr, wave: mb.wave }; S.wave = mb.wave; renderList(); render(); return; }
    const cb = hitCat(cv, ev);
    if (cb) { S.sel = cb.tr; renderList(); render(); return; }
    const h = paneClick(cv, ear, ev); if (!h) return;
    const tr = h.it.tr;
    if (tr.live) return;
    if (h.onTag) S.sel = tr;
    else if (S.wave && S.sel === tr && h.it.chan === 0) placeMark(tr, S.wave, snapPeak(tr, h.t));   // armed wave: label the selected curve (any tab)
    else S.sel = tr;
    renderList(); render();
  }
  function openCtx(ev, items) {
    const c = $('ctx'); c.innerHTML = '';
    items.forEach(([txt, fn]) => { const d = document.createElement('div'); d.textContent = txt; d.onclick = () => { c.hidden = true; fn(); renderList(); render(); }; c.appendChild(d); });
    c.style.left = ev.clientX + 'px'; c.style.top = ev.clientY + 'px'; c.hidden = false;
  }
  function onContext(cv, ear, ev) {
    ev.preventDefault();
    const mb = hitMark(cv, ev);
    if (mb && !mb.tr.live) {
      S.sel = mb.tr; S.selMark = { tr: mb.tr, wave: mb.wave }; render(); renderList();
      openCtx(ev, [[`Remove label ${mb.wave}`, () => removeMark(mb)], [`Clear all labels on ${mb.tr.label}`, () => { mb.tr.marks = {}; mb.tr.cat = null; S.selMark = null; }]]);
      return;
    }
    const cb = hitCat(cv, ev);
    if (cb) {
      S.sel = cb.tr; render(); renderList();
      openCtx(ev, [[`Remove ${cb.tr.cat} label`, () => (cb.tr.cat = null)], ...CATS.filter((c) => c !== cb.tr.cat).map((c) => [`Change to ${c} (${CAT_NAME[c].toLowerCase()})`, () => (cb.tr.cat = c)])]);
      return;
    }
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
      add(`Subtract (${prev.label} − ${tr.label}) / 2 (shows CM: rarefaction − condensation)`, () => combine(prev, tr, 'sub'));
    }
    if (tr.parts) add('Unmerge', () => unmerge(tr));
    add(tr.hidden ? 'Show' : 'Hide', () => (tr.hidden = !tr.hidden));
    add(S.chan === 'both' ? 'Ipsilateral only' : 'Show contralateral (Ipsi / Contra)', () => { S.chan = S.chan === 'both' ? 'ipsi' : 'both'; syncUI(); });
    if (Object.keys(tr.marks).length) add('Remove wave labels', () => { tr.marks = {}; if (S.selMark && S.selMark.tr === tr) S.selMark = null; });
    if (tr.cat) add(`Remove ${tr.cat} label`, () => (tr.cat = null));
    else CATS.forEach((c) => add(`Label ${c} (${CAT_NAME[c].toLowerCase()})`, () => (tr.cat = c)));
    add('Reset position', () => (tr.dy = [0, 0]));
    add('Export waveform (CSV)', () => exportCsv(tr));
    add('Delete', () => { S.traces = S.traces.filter((t) => t !== tr); S.sel = null; });
    c.style.left = ev.clientX + 'px'; c.style.top = ev.clientY + 'px'; c.hidden = false;
  }
  /* merge = sweep-weighted average (grand average); add = arithmetic sum. Sources are kept so it can be unmerged. */
  function combine(a, b, mode) {
    const na = Math.max(a.n, 1), nb = Math.max(b.n, 1), nt = na + nb;
    // merge / add: sweep-weighted average; sub: (a - b) / 2, e.g. rarefaction - condensation isolates the CM (UNHSEIP 5.36)
    const sub = mode === 'sub', wa = sub ? 0.5 : na / nt, wb = sub ? -0.5 : nb / nt;
    if (a.ch[0].avg.length !== b.ch[0].avg.length) { toast('Cannot combine click and tone-burst curves (different time windows)'); return; }
    const NWc = a.ch[0].avg.length;
    const mix = (x, y) => { const o = new Float64Array(NWc); for (let i = 0; i < NWc; i++) o[i] = wa * x[i] + wb * y[i]; return o; };
    const ch = [0, 1].map((k) => ({ avg: mix(a.ch[k].avg, b.ch[k].avg), A: mix(a.ch[k].A, b.ch[k].A), B: mix(a.ch[k].B, b.ch[k].B) }));
    const rn = !(a.rn > 0 && b.rn > 0) ? 0 : sub ? 0.5 * Math.hypot(a.rn, b.rn) : 1 / Math.sqrt(1 / (a.rn * a.rn) + 1 / (b.rn * b.rn));
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
    const rnU = Math.max(rn / 1000, 1e-4), fmp = (pw + rnU * rnU) / (rnU * rnU);
    S.mergeCount = (S.mergeCount || 0) + 1;
    const t = {
      id: S.nextId++, base: a.base, ear: a.ear, stim: sub ? Object.assign({}, a.stim, { polarity: 'sub' }) : a.stim, w1: a.w1, opts: a.opts, dy: [0, 0], marks: {}, hidden: false, live: false,
      label: a.base + ({ merge: ' M', add: ' +', sub: ' −' })[mode] + S.mergeCount, mode,
      ch, n: nt, rejected: (a.rejected * na + b.rejected * nb) / nt, rn,
      repro: saa && sbb ? Math.max(0, sab / Math.sqrt(saa * sbb)) : 0, fmp, conf: Math.min(99.9, (1 - Math.exp(-2.2 * Math.max(0, fmp - 1))) * 100)
    };
    if (mode === 'merge') {                   // merge replaces the two curves (can be unmerged)
      t.parts = [a, b];
      const at = Math.min(S.traces.indexOf(a), S.traces.indexOf(b));
      S.traces = S.traces.filter((x) => x !== a && x !== b);
      S.traces.splice(Math.max(0, at), 0, t);
      toast('Merged ' + a.label + ' + ' + b.label + ' (right-click > Unmerge to undo)');
    } else {                                  // add / subtract keep both originals visible
      S.traces.push(t);
      toast((sub ? 'Subtracted ' + a.label + ' − ' : 'Added ' + a.label + ' + ') + b.label + ' as ' + t.label + ' (originals kept)');
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
      <label>CM type<select data-p="ring" data-e="${e}"><option value="0">Brief</option><option value="1">Ringing (ANSD-type)</option></select></label>
      <label>Click morphology<select data-p="morph" data-e="${e}">${M.MORPH_NAMES.map((n, i) => `<option value="${i}">${n}</option>`).join('')}</select></label>
      <label>PAM (muscle) wave<select data-p="pam" data-e="${e}"><option value="0">Off</option><option value="1">Small</option><option value="2">Large</option></select></label>
      <label>Wave I (ms)<input type="number" step="0.05" data-p="latI" data-e="${e}" placeholder="auto"></label>
      <label>Wave III (ms)<input type="number" step="0.05" data-p="latIII" data-e="${e}" placeholder="auto"></label>
      <label>Wave V (ms)<input type="number" step="0.05" data-p="latV" data-e="${e}" placeholder="auto"></label></div>`).join('') +
      '<div class="hint">Latencies apply at 80 dB nHL, 17.1/s, rarefaction, insert phones. Leave blank for the model default (adjusted for age, pathology, thresholds). Click morphology varies waves II-V (IV/V complex); PAM adds a post-auricular muscle wave at ~10-12 ms (adults, insert phones).</div>';
  }
  function fillPatientModal() {
    const p = S.patient;
    $('pName').value = p.name; $('pAge').value = p.adult ? 'adult' : 'child'; $('pMonths').value = p.ageMonths; $('pState').value = p.noisy ? 'noisy' : 'quiet'; $('pNoise').value = String(p.noise == null ? 0.3 : p.noise);
    $('pMonths').disabled = p.adult;
    document.querySelectorAll('#pAud input').forEach((inp) => (inp.value = p.ears[+inp.dataset.e][inp.dataset.k][+inp.dataset.i]));
    document.querySelectorAll('#pPath [data-p]').forEach((el) => { const v = p.ears[+el.dataset.e][el.dataset.p]; el.value = v == null ? '' : v; });
  }
  function readPatientModal() {
    const p = M.newPatient({ name: $('pName').value.trim() || 'Patient', adult: $('pAge').value === 'adult', ageMonths: Math.max(0, Math.min(63, +$('pMonths').value || 0)), noisy: $('pState').value === 'noisy', noise: parseFloat($('pNoise').value) });
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
    S.patient = M.newPatient(JSON.parse(JSON.stringify(p))); S.noise = S.patient.noise;
    S.pages.forEach((p) => { p.traces = []; p.sel = null; }); S.traces = S.pages[S.page].traces; S.sel = null; S.live = null;
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
    const rows = S.traces.filter((t) => !t.hidden), p = S.patient;
    // graph height grows with the number of curve slots so every curve is printed
    const slots = Math.max(paneItems(0, 'x').nSlots || 1, paneItems(1, 'x').nSlots || 1);
    const gh = Math.min(1000, Math.max(380, slots * 55 + 60));
    let h = `<div class="rep-head"><div><h2>ABR report &mdash; page ${S.page + 1}</h2><div>${p.name} &mdash; ${p.adult ? 'Adult' : 'Child ' + p.ageMonths + ' mo'}</div></div><div>${new Date().toLocaleDateString()}</div></div>
      <div class="rep-graphs"><div><div class="ptitle r">Right ear</div><canvas id="rc0" style="height:${gh}px"></canvas></div><div><div class="ptitle l">Left ear</div><canvas id="rc1" style="height:${gh}px"></canvas></div></div>
      <div class="rep-sec"><h3>Recordings</h3>
      <table><tr><th>Curve</th><th>Stimulus</th><th>Transducer</th><th>Rate (/s)</th><th>Polarity</th><th>HPF / LPF (Hz)</th><th>Recorded</th><th>Rejected</th><th>Wave repro</th><th>Fmp</th><th>Response confidence</th><th>Residual noise</th></tr>`;
    for (const t of rows) {
      h += `<tr><td><b>${t.label}</b></td><td>${typeLabel(t.stim.freq)} ${t.stim.level} dB nHL</td><td>${t.stim.transducer === 'bone' ? 'Bone' : 'Insert'}${t.stim.clamped ? ' (clamped)' : ''}</td>` +
        `<td>${t.stim.rate}</td><td>${POL_NAME[t.stim.polarity]}</td><td>${t.opts ? t.opts.hp : S.hp} / ${t.opts ? t.opts.lp : S.lp}</td>` +
        `<td>${t.n}</td><td>${Math.round(t.rejected * 100)}%</td><td>${Math.round(t.repro * 100)}%</td><td>${t.fmp ? t.fmp.toFixed(1) : '--'}</td><td>${t.n ? t.conf.toFixed(1) + '%' : '--'}</td><td>${t.rn ? t.rn.toFixed(0) + ' nV' : '--'}</td></tr>`;
    }
    const li = liChartsHTML('rli');
    h += `</table></div><div class="rep-sec"><h3>Latencies (ms)</h3>${latTableHTML(markedRows())}</div>
      <div class="rep-sec"><h3>Latency&ndash;intensity</h3>${li.html}</div>`;
    $('reportBody').innerHTML = h;
    $('mReport').hidden = false;
    requestAnimationFrame(() => { draw($('rc0'), 0, 'x'); draw($('rc1'), 1, 'x'); li.gs.forEach((g, i) => drawLI($('rli' + i), g, 2)); });
  }

  /* ---------- wiring ---------- */
  function init() {
    fill($('rate'), RATES, 17.1, (v) => v.toFixed(1)); fill($('nmax'), NMAX, 2000);
    $('waveBtns').innerHTML = WAVES.map((w, i) => `<button data-w="${w}" title="Arm wave ${w} (key ${i + 1}); click again to disarm">${w}<span class="kb">${i + 1}</span></button>`).join('');
    $('waveBtns').onclick = (e) => { const b = e.target.closest('button'); if (b) { S.wave = S.wave === b.dataset.w ? null : b.dataset.w; renderLabelUI(); } };
    $('catBtns').innerHTML = CATS.map((c, i) => `<button data-c="${c}" title="${CAT_NAME[c]} (key ${i + 6})">${c}<span class="kb">${i + 6}</span></button>`).join('');
    $('catBtns').onclick = (e) => { const b = e.target.closest('button'); if (b) { setCat(S.sel, b.dataset.c); render(); } };
    $('nudge').onclick = (e) => { const b = e.target.closest('button[data-n]'); if (b) nudge(+b.dataset.n); };
    $('btnDelMark').onclick = () => { const m = curMark(); if (m) { removeMark(m); render(); } else toast('Click a label to select it first'); };
    document.addEventListener('keydown', (e) => {
      const tg = e.target && e.target.tagName;
      if (tg === 'INPUT' || tg === 'SELECT' || tg === 'TEXTAREA' || e.ctrlKey || e.metaKey || e.altKey) return;
      if (!$('mPop').hidden && e.key === 'Escape') { $('mPop').hidden = true; return; }
      if (!$('mPatient').hidden || !$('mReport').hidden || !$('mPop').hidden) return;
      const k = e.key;
      if (k >= '1' && k <= '5') {                     // 1-5: arm wave I-V; with the pointer over a curve, place it there
        S.wave = WAVES[+k - 1];
        const hv = S.hover, h = hv && !S.acq ? paneClick(hv.cv, hv.ear, hv) : null;
        if (h && !h.onTag && !h.it.tr.live && h.it.chan === 0) { S.sel = h.it.tr; placeMark(h.it.tr, S.wave, snapPeak(h.it.tr, h.t)); renderList(); }
        render(); e.preventDefault();
      } else if (k === '6' || k === '7' || k === '8') { setCat(S.sel, CATS[+k - 6]); render(); e.preventDefault(); }
      else if (k === 'ArrowLeft' || k === 'ArrowRight') { if (curMark() || (S.sel && S.sel.marks[S.wave] != null)) { nudge((k === 'ArrowLeft' ? -1 : 1) * (e.shiftKey ? 5 : 1)); e.preventDefault(); } }
      else if (k === 'Escape') { S.wave = null; render(); }
      else if (k === 'Delete' || k === 'Backspace') { const m = curMark(); if (m) { removeMark(m); render(); e.preventDefault(); } }
    });
    document.querySelectorAll('.tab').forEach((b) => (b.onclick = () => {
      S.tab = b.dataset.tab;
      document.querySelectorAll('.tab').forEach((x) => x.classList.toggle('on', x === b));
      document.querySelectorAll('.tabpane').forEach((p) => (p.hidden = p.id !== 'tab-' + S.tab));
    }));
    $('protocol').onchange = () => { S.type = +$('protocol').value; applyProtocolDefaults(); syncUI(); };
    $('stType').onchange = () => { S.type = +$('stType').value; applyProtocolDefaults(); syncUI(); };
    ['level', 'trans', 'pol', 'rate', 'nmax', 'reject', 'hpf', 'lpf', 'speed'].forEach((id) => ($(id).onchange = () => { readUI(); syncUI(); }));
    document.querySelectorAll('input[name=ear]').forEach((r) => (r.onchange = () => { readUI(); }));
    $('lvlUp').onclick = () => { S.level += 5; clampLevel(); syncUI(); };
    $('lvlDn').onclick = () => { S.level -= 5; clampLevel(); syncUI(); };
    $('btnStart').onclick = () => (S.acq ? stop() : start());
    $('btnPause').onclick = () => { S.paused = !S.paused; setButtons(); };
    $('chanSel').onchange = () => { S.chan = $('chanSel').value; syncUI(); render(); };
    $('showAB').onchange = () => { S.showAB = $('showAB').checked; syncUI(); render(); };
    $('tbAB').onclick = () => { S.showAB = !S.showAB; syncUI(); render(); };
    $('tbC').onclick = () => { S.chan = S.chan === 'both' ? 'ipsi' : 'both'; syncUI(); render(); };
    const setClamp = (on) => {
      if (on && S.trans === 'bone') { toast('The clamp test applies to insert phones: switch the transducer to Insert'); on = false; }
      S.clamped = on; syncUI();
      if (on) toast('Insert tube clamped: no sound reaches the ear, only stimulus artefact is recorded');
    };
    $('tbClamp').onclick = () => setClamp(!S.clamped);
    $('clampChk').onchange = () => setClamp($('clampChk').checked);
    document.querySelectorAll('.ord').forEach((b) => (b.onclick = () => {
      S.order = b.dataset.ord; S.traces.forEach((t) => (t.dy = [0, 0]));   // re-arranging clears manual positions
      syncUI(); render();
    }));
    $('zoomUp').onclick = () => { S.zoom *= 1.25; render(); }; $('zoomDn').onclick = () => { S.zoom /= 1.25; render(); };
    $('btnDel').onclick = () => { if (S.sel) { S.traces = S.traces.filter((t) => t !== S.sel); S.sel = null; renderList(); render(); } };
    $('btnClear').onclick = () => { S.traces = []; S.sel = null; renderList(); render(); };
    $('btnClrMarks').onclick = () => { if (S.sel) { S.sel.marks = {}; S.sel.cat = null; S.selMark = null; render(); } };
    $('btnUnmerge').onclick = () => { if (S.sel && S.sel.parts) { unmerge(S.sel); renderList(); render(); } else toast('Select a merged curve first'); };
    for (let i = 0; i < 9; i++) { const b = document.createElement('button'); b.textContent = i + 1; b.onclick = () => switchPage(i); $('pageBtns').appendChild(b); }
    $('btnResetPos').onclick = () => { S.traces.forEach((t) => (t.dy = [0, 0])); render(); };
    [0, 1].forEach((e) => { bindDrag($('cv' + e), e); });
    [0, 1].forEach((e) => { const cv = $('cv' + e); cv.onclick = (ev) => onClick(cv, e, ev); cv.oncontextmenu = (ev) => onContext(cv, e, ev); });
    document.addEventListener('click', () => ($('ctx').hidden = true));
    $('btnLatAll').onclick = openLatAll; $('btnLI').onclick = openLI; $('popClose').onclick = () => ($('mPop').hidden = true); $('popCopy').onclick = copyLatTable;
    $('btnReport').onclick = openReport; $('rClose').onclick = () => ($('mReport').hidden = true); $('rPrint').onclick = () => window.print();
    window.addEventListener('resize', render);
    bindPatient();
    // shared case link
    const m = /case=([^&]+)/.exec(location.hash);
    if (m) { try { S.patient = M.newPatient(window.ABRCodec.decode(m[1])); S.noise = S.patient.noise; } catch (err) { toast('Could not read shared case: ' + err.message); } }
    syncUI(); setButtons(); renderList(); render();
    setInterval(drawEEG, 120);
    window.ABRApp = S;   // exposed for debugging
  }
  init();
})();
