(function () {
'use strict';
// ---------- helpers ----------
const $ = (s, r) => (r || document).querySelector(s);
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const h = (tag, attrs, ...kids) => {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (k === 'class') e.className = v;
    else if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
    else if (v !== false && v != null) e.setAttribute(k, v === true ? '' : v);
  }
  for (const c of kids.flat()) if (c != null && c !== false) e.append(c.nodeType ? c : document.createTextNode(c));
  return e;
};
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const pct = (x) => x == null ? '-' : Math.round(x * 100) + '%';
const num = (x, d) => x == null ? '-' : Number(x).toFixed(d || 0);
const sgn = (x) => (x > 0 ? '+' : x < 0 ? '−' : '') + Math.abs(x);
const mean = (a) => a.length ? a.reduce((s, x) => s + x, 0) / a.length : null;
const api = async (p, o) => {
  const init = o && o.body !== undefined ? { method: o.method || 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(o.body) } : (o || {});
  const r = await fetch(p, init), t = await r.text();
  let j; try { j = JSON.parse(t); } catch (e) { j = t; }
  if (!r.ok) throw new Error((j && j.error) || r.statusText);
  return j;
};
const personaColor = (p) => ({ random: 'var(--c-random)', novice: 'var(--c-novice)', smart: 'var(--c-smart)', optimizer: 'var(--c-optimizer)', oracle: 'var(--c-oracle)' }[p] || 'var(--c-other)');
const band = (d) => d < 20 ? 'Very easy' : d < 35 ? 'Easy' : d < 50 ? 'Moderate' : d < 65 ? 'Challenging' : d < 80 ? 'Hard' : 'Brutal';
const FLAG_SEV = { BROKEN: 'bad', TOO_HARD: 'bad', TOO_EASY: 'bad', WALL: 'bad', SPIKE: 'bad', '?HARD': 'warn', '?EASY': 'warn', DIP: 'warn', SLOW: 'warn', DEATHY: 'warn', INCOME_LOW: 'warn', INCOME_HIGH: 'warn', RANDOM_WINS: 'warn', NO_SKILL: 'warn', COINFLIP: 'warn' };
const flagEl = (f) => h('span', { class: 'flag ' + (FLAG_SEV[f] || 'info') }, f);

// ---------- state ----------
const A = { st: null, tab: 'detect', det: null, selStage: null, T: null, Tdirty: false, calib: null, calibRunId: null, logRunId: null, logData: null, logTab: 'console', form: null, cform: { rounds: 6, runs: 60, k: 0.8, useCand: false }, lines: [], es: null, jobWas: null };
const TABS = [['detect', 'Detect'], ['target', 'Target'], ['calibrate', 'Calibrate'], ['logs', 'Runs & logs']];

// ---------- scores (all derived from one detection report) ----------
function scores(rep) {
  const tp = rep.targetPersona, ids = Object.keys(rep.stages), out = [];
  ids.forEach((id, i) => {
    const st = rep.stages[id], me = st[tp], rnd = st.random;
    if (!me) { out.push({ id, idx: i, empty: true, flags: st.flags || [] }); return; }
    const win = me.win, tries = me.tries ?? me.attempts ?? 1, stall = me.stall || 0;
    out.push({
      id, idx: i, win, lo: me.lo, hi: me.hi, n: me.n, tries, stall, flags: (st.flags || []).filter((f) => f !== 'LOW_N'), lowN: (st.flags || []).includes('LOW_N'),
      difficulty: 100 * (1 - win),
      frustration: clamp(100 * (0.6 * stall + 0.4 * Math.min(1, (tries - 1) / 4)), 0, 100),
      boredom: clamp(100 * (0.7 * clamp((win - 0.85) / 0.15, 0, 1) + 0.3 * (rnd ? rnd.win : 0)), 0, 100),
      skill: rnd ? 100 * (win - rnd.win) : null,
      conf: 100 * (me.hi - me.lo) / 2,
      targetWin: st.target && st.target.win != null ? st.target.win : null,
      reach: me.reach ?? null,
    });
  });
  // spikes: much harder than the median of the 3 stages before
  const dv = out.map((s) => s.difficulty);
  out.forEach((s, i) => { if (i < 3 || s.empty) { s.spike = 0; return; } const prev = dv.slice(i - 3, i).filter((x) => x != null).sort((a, b) => a - b); s.spike = prev.length ? s.difficulty - prev[Math.floor(prev.length / 2)] : 0; });
  return out;
}
function summary(rep, sc) {
  const ok = sc.filter((s) => !s.empty), d = ok.map((s) => s.difficulty), third = Math.max(1, Math.floor(ok.length / 3));
  const camp = ok.some((s) => s.stall > 0 || s.tries > 1.05);
  return {
    avg: mean(d), trend: ok.length > 5 ? mean(ok.slice(-third).map((s) => s.difficulty)) - mean(ok.slice(0, third).map((s) => s.difficulty)) : null,
    spikes: ok.filter((s) => s.spike > 20).length, frustrated: ok.filter((s) => s.frustration >= 45).length, bored: ok.filter((s) => s.boredom >= 60).length,
    skill: mean(ok.filter((s) => s.skill != null).map((s) => s.skill)), conf: mean(ok.map((s) => s.conf)), tp: rep.targetPersona, camp,
    hardest: [...ok].sort((a, b) => b.difficulty - a.difficulty).slice(0, 3), easiest: [...ok].sort((a, b) => a.difficulty - b.difficulty).slice(0, 3),
  };
}

// ---------- a small chart used by Detect, Target and Calibrate ----------
function Chart(box, cfg) {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg'), tip = h('div', { class: 'tip', hidden: true });
  svg.setAttribute('role', 'img'); svg.setAttribute('aria-label', cfg.label || 'chart');
  box.append(svg, tip);
  let W = 760, H = 300, hover = null, dragging = null;
  const L = 46, R = cfg.rightPad ?? 70, T = 12, B = 30;
  const geom = () => { W = Math.max(300, (box.clientWidth || 760) - 16); H = Math.round(clamp(W * 0.4, 230, 330)); };
  const pw = () => W - L - R, ph = () => H - T - B;
  const xs = (i) => L + (cfg.ids.length > 1 ? pw() * i / (cfg.ids.length - 1) : pw() / 2);
  const ys = (v) => T + ph() * (1 - clamp(v / cfg.yMax, 0, 1));
  const idxAt = (cx) => { const r = svg.getBoundingClientRect(), x = (cx - r.left) / r.width * W; return clamp(Math.round((x - L) / (pw() / Math.max(1, cfg.ids.length - 1))), 0, cfg.ids.length - 1); };
  const yAt = (cy) => { const r = svg.getBoundingClientRect(), y = (cy - r.top) / r.height * H; return clamp((1 - (y - T) / ph()) * cfg.yMax, 0, cfg.yMax); };
  function draw() {
    geom();
    const n = cfg.ids.length, series = cfg.series();
    let g = '';
    for (let t = 0; t <= 4; t++) { const v = cfg.yMax * t / 4; g += `<line x1="${L}" x2="${W - R}" y1="${ys(v)}" y2="${ys(v)}" stroke="var(--line)"/><text x="${L - 7}" y="${ys(v) + 4}" text-anchor="end" class="ax">${esc(cfg.yFmt(v))}</text>`; }
    const step = Math.max(1, Math.ceil(n / Math.max(4, Math.floor(pw() / 30))));
    cfg.ids.forEach((id, i) => { if (cfg.bosses && cfg.bosses().has(String(id))) g += `<path d="M${xs(i)},${T + ph() + 3} l4,5 l-8,0 z" fill="var(--mut)"/>`; if (i % step === 0 || i === n - 1) g += `<text x="${xs(i)}" y="${H - 8}" text-anchor="middle" class="ax">${esc(id)}</text>`; });
    const bd = cfg.band && cfg.band();
    if (bd) { const up = [], dn = []; bd.forEach((b, i) => { if (b) { up.push(`${xs(i).toFixed(1)},${ys(b[1]).toFixed(1)}`); dn.unshift(`${xs(i).toFixed(1)},${ys(b[0]).toFixed(1)}`); } }); if (up.length) g += `<polygon points="${up.concat(dn).join(' ')}" fill="var(--band)"/>`; }
    const sel = cfg.sel && cfg.sel();
    if (sel != null && sel >= 0) g += `<line x1="${xs(sel)}" x2="${xs(sel)}" y1="${T}" y2="${T + ph()}" stroke="var(--accent)" stroke-width="2" opacity=".5"/>`;
    const path = (vals) => { let d = '', pen = false; vals.forEach((v, i) => { if (v == null) { pen = false; return; } d += `${pen ? 'L' : 'M'}${xs(i).toFixed(1)},${ys(v).toFixed(1)}`; pen = true; }); return d; };
    const ends = [];
    series.forEach((s) => {
      if (s.whisk) s.whisk.forEach((w, i) => { if (w) g += `<line x1="${xs(i)}" x2="${xs(i)}" y1="${ys(w[0])}" y2="${ys(w[1])}" stroke="${s.color}" stroke-width="2" opacity=".25"/>`; });
      g += `<path d="${path(s.vals)}" fill="none" stroke="${s.color}" stroke-width="${s.w || 2}" ${s.dash ? `stroke-dasharray="${s.dash}"` : ''} stroke-linejoin="round" opacity="${s.opacity ?? 1}"/>`;
      if (s.dots) s.vals.forEach((v, i) => { if (v != null) g += `<circle cx="${xs(i)}" cy="${ys(v)}" r="${s.dots}" fill="${s.color}"/>`; });
      let li = -1; s.vals.forEach((v, i) => { if (v != null) li = i; });
      if (s.label && li >= 0) ends.push({ x: xs(li), y: ys(s.vals[li]), t: s.label, c: s.color, b: s.bold });
    });
    (cfg.marks ? cfg.marks() : []).forEach((m) => { g += m.kind === 'ring' ? `<circle cx="${xs(m.i)}" cy="${ys(m.y)}" r="6" fill="none" stroke="var(--bad)" stroke-width="2"/>` : `<path d="M${xs(m.i)},${ys(m.y) - 7} l6,7 l-6,7 l-6,-7 z" fill="var(--accent)" stroke="var(--panel)" stroke-width="1.5"/>`; });
    if (hover != null) { g += `<line x1="${xs(hover)}" x2="${xs(hover)}" y1="${T}" y2="${T + ph()}" stroke="var(--mut)" stroke-dasharray="3 3"/>`; series.forEach((s) => { const v = s.vals[hover]; if (v != null) g += `<circle cx="${xs(hover)}" cy="${ys(v)}" r="4" fill="${s.color}"/>`; }); }
    ends.forEach((e) => { e.y = Math.min(e.y, T + ph() - 10); }); ends.sort((a, b) => a.y - b.y);
    for (let i = 1; i < ends.length; i++) if (ends[i].y - ends[i - 1].y < 13) ends[i].y = ends[i - 1].y + 13;
    ends.forEach((e) => { g += `<text x="${e.x + 8}" y="${e.y + 4}" font-size="11.5" fill="${e.c}" ${e.b ? 'font-weight="700"' : ''}>${esc(e.t)}</text>`; });
    svg.setAttribute('viewBox', `0 0 ${W} ${H}`); svg.setAttribute('height', H);
    svg.innerHTML = g;
  }
  const showTip = (i, px) => {
    if (!cfg.tip) return;
    const t = cfg.tip(i); if (!t) { tip.hidden = true; return; }
    tip.innerHTML = `<b>${esc(t.title)}</b>` + t.rows.map((r) => `<div><span>${r.c ? `<i style="background:${r.c}"></i>` : ''}${esc(r.k)}</span><span>${esc(r.v)}</span></div>`).join('');
    tip.hidden = false; const w = tip.offsetWidth; let left = px + 14; if (left + w > box.clientWidth - 6) left = px - w - 14; tip.style.left = Math.max(6, left) + 'px';
  };
  svg.addEventListener('pointermove', (e) => {
    if (dragging != null) { cfg.drag.onDrag(dragging, yAt(e.clientY)); draw(); return; }
    const i = idxAt(e.clientX); if (i !== hover) { hover = i; draw(); } showTip(i, e.clientX - box.getBoundingClientRect().left);
  });
  svg.addEventListener('pointerleave', () => { if (dragging != null) return; hover = null; tip.hidden = true; draw(); });
  svg.addEventListener('pointerdown', (e) => {
    const i = idxAt(e.clientX);
    if (cfg.drag) { const v = cfg.drag.valueAt(i); const r = svg.getBoundingClientRect(); const py = r.top + ys(v) / H * r.height; if (v != null && Math.abs(e.clientY - py) < 16) { dragging = i; svg.setPointerCapture(e.pointerId); cfg.onSelect && cfg.onSelect(i); return; } }
    cfg.onSelect && cfg.onSelect(i);
  });
  const end = (e) => { if (dragging == null) return; const i = dragging; dragging = null; try { svg.releasePointerCapture(e.pointerId); } catch (x) { /* ignore */ } cfg.drag.onDrop && cfg.drag.onDrop(i); draw(); };
  svg.addEventListener('pointerup', end); svg.addEventListener('pointercancel', end);
  svg.setAttribute('tabindex', '0');
  svg.addEventListener('keydown', (e) => { if (!cfg.onSelect) return; const s = cfg.sel ? cfg.sel() : -1; if (e.key === 'ArrowRight') { cfg.onSelect(Math.min(cfg.ids.length - 1, (s < 0 ? -1 : s) + 1)); e.preventDefault(); } if (e.key === 'ArrowLeft') { cfg.onSelect(Math.max(0, (s < 0 ? cfg.ids.length : s) - 1)); e.preventDefault(); } });
  let rz; const onResize = () => { clearTimeout(rz); rz = setTimeout(() => { if (document.body.contains(box)) draw(); }, 80); };
  window.addEventListener('resize', onResize);
  return { draw };
}

// ---------- shell: tabs, job pill, console drawer ----------
function renderTabs() {
  const nav = $('#tabs'); nav.textContent = '';
  TABS.forEach(([k, label], i) => nav.append(h('button', { role: 'tab', 'aria-selected': String(A.tab === k), onclick: () => go(k) }, h('span', { class: 'n' }, String(i + 1)), label)));
}
function renderPill() {
  const pill = $('#pill'), j = A.st && A.st.job;
  if (!j || j.status !== 'running') { pill.hidden = true; return; }
  pill.hidden = false; pill.textContent = '';
  pill.append(h('span', { class: 'spin' }), `${j.kind === 'detect' ? 'Detection' : 'Calibration'} running`, h('button', { class: 'ghost', type: 'button', onclick: () => toggleConsole(true) }, 'Console'), h('button', { class: 'ghost danger', type: 'button', onclick: () => api('/api/jobs/' + j.id + '/stop', { body: {} }) }, 'Stop'));
}
function toggleConsole(show) { const d = $('#drawer'); d.hidden = show === undefined ? !d.hidden : !show; if (!d.hidden) { const c = $('#console'); c.textContent = A.lines.join('\n'); c.scrollTop = c.scrollHeight; } }
function watchJob(id) {
  if (A.es) A.es.close();
  A.lines = []; $('#console').textContent = ''; $('#dtitle').textContent = 'Console: ' + id;
  const es = A.es = new EventSource('/api/jobs/' + id + '/stream');
  es.onmessage = (e) => { const l = JSON.parse(e.data); A.lines.push(l); const c = $('#console'); c.append(l + '\n'); c.scrollTop = c.scrollHeight; };
  es.addEventListener('done', () => { es.close(); });
}
function go(tab) { A.tab = tab; history.replaceState(null, '', '#' + tab); render(); }

// ---------- data ----------
async function refresh() {
  A.st = await api('/api/state');
  $('#proj').textContent = A.st.project + ' · ' + A.st.adapter;
  if (!A.form) { const c = A.st.config; A.form = { personas: new Set(c.personas), runs: c.runs, retries: c.retries, seed: c.seed, stages: '', useCand: false }; }
  renderTabs(); renderPill();
}
const latest = (kind) => (A.st.runs || []).find((r) => r.kind === kind && r.status === 'done');
async function loadDetect() {
  const r = latest('detect'); A.det = null;
  if (r) { const d = await api('/api/runs/' + r.id); if (d.report) { d.scores = scores(d.report); d.sum = summary(d.report, d.scores); A.det = d; } }
}
async function loadCalib(id) {
  const rid = id || A.calibRunId || (latest('calibrate') || {}).id;
  A.calib = null; if (!rid) return;
  A.calibRunId = rid; A.calib = await api('/api/runs/' + rid);
}

// ---------- 1 · DETECT ----------
function viewDetect(root) {
  const st = A.st, info = st.info, f = A.form, running = st.job && st.job.status === 'running';
  root.append(h('h1', null, '1 · Detect'), h('p', { class: 'lead' }, 'Run the bots through every stage once. You get an average difficulty for the whole game and a difficulty score per stage (0 = nobody can fail it, 100 = nobody can pass it), plus frustration, boredom and skill scores.'));
  if (st.infoError) { root.append(h('div', { class: 'note bad' }, h('b', null, 'Cannot start yet. '), st.infoError), h('button', { class: 'ghost', onclick: async () => { await api('/api/reload', { body: {} }); await refresh(); render(); } }, 'Reload adapter')); return; }
  const personas = ['random', 'novice', 'smart', 'optimizer'].concat(info.hasOracle ? ['oracle'] : []);
  const box = h('section', { class: 'card' });
  box.append(h('h2', null, 'Detection run'));
  const g = h('div', { class: 'grid3' });
  g.append(h('div', null, h('label', null, 'Bots to play'), h('div', { class: 'stack' }, personas.map((p) => h('label', { class: 'check' }, h('input', { type: 'checkbox', checked: f.personas.has(p), onchange: (e) => { e.target.checked ? f.personas.add(p) : f.personas.delete(p); } }), h('i', { class: 'chip', style: 'padding:0;border:0' }, h('i', { style: 'background:' + personaColor(p) })), p + (p === 'optimizer' ? ' (slow)' : p === 'oracle' ? ' (solver)' : ''))))));
  g.append(h('div', { class: 'stack' }, h('div', null, h('label', null, 'Runs per stage'), h('input', { type: 'number', min: 5, max: 1000, value: f.runs, oninput: (e) => { f.runs = +e.target.value; } })),
    info.campaign ? h('div', null, h('label', null, 'Retries per stage (a player quits after this many failures)'), h('input', { type: 'number', min: 0, max: 30, value: f.retries, oninput: (e) => { f.retries = +e.target.value; } })) : null));
  g.append(h('div', { class: 'stack' }, h('div', null, h('label', null, 'Stages (empty = all ' + info.stages.length + ')'), h('input', { type: 'text', placeholder: 'e.g. 1-20', value: f.stages, oninput: (e) => { f.stages = e.target.value; } })), h('div', null, h('label', null, 'Seed'), h('input', { type: 'number', value: f.seed, oninput: (e) => { f.seed = +e.target.value; } }))));
  box.append(g);
  if (st.config.candidate) box.append(h('label', { class: 'check', style: 'margin-top:10px' }, h('input', { type: 'checkbox', checked: f.useCand, onchange: (e) => { f.useCand = e.target.checked; } }), `Use the active calibration candidate (${Object.keys(st.config.candidate.params).length} lever values) instead of the game as it is`));
  box.append(h('div', { class: 'row', style: 'margin-top:12px' }, h('button', { class: 'primary', disabled: running, onclick: startDetect }, running ? 'A job is running…' : 'Run detection'), h('span', { class: 'hint' }, info.campaign ? 'Campaign game: one simulated player lives through all stages and keeps its gear.' : 'Every stage is played independently.')));
  root.append(box);
  if (!A.det) { root.append(h('div', { class: 'panel empty' }, 'No detection run yet. Start one above, results appear here.')); return; }
  detectResults(root, A.det);
}
async function startDetect() {
  const f = A.form;
  if (!f.personas.size) return alert('Pick at least one bot.');
  await api('/api/config', { body: { personas: [...f.personas], runs: f.runs, retries: f.retries, seed: f.seed } });
  try {
    const meta = await api('/api/jobs', { body: { kind: 'detect', personas: [...f.personas], runs: f.runs, retries: f.retries, seed: f.seed, stages: f.stages || null, useCandidate: f.useCand } });
    await afterStart(meta.id);
  } catch (e) { alert(e.message); }
}
async function afterStart(id) { await refresh(); watchJob(id); toggleConsole(true); render(); }

function detectResults(root, d) {
  const sc = d.scores, sm = d.sum, rep = d.report, ok = sc.filter((s) => !s.empty);
  const tone = (v, good, warn) => v <= good ? 'good' : v <= warn ? 'warn' : 'bad';
  const cards = h('div', { class: 'cards' });
  const stat = (t, v, s, cls) => cards.append(h('div', { class: 'stat ' + (cls || '') }, h('span', null, t), h('b', null, v), h('em', null, s)));
  stat('Average difficulty', num(sm.avg), band(sm.avg) + ' · of 100', 'info');
  if (sm.trend != null) stat('Ramp (first vs last third)', sgn(Math.round(sm.trend)) + ' pts', sm.trend < 5 ? 'almost flat' : sm.trend < 25 ? 'gentle ramp' : 'steep ramp', 'info');
  stat('Difficulty spikes', String(sm.spikes), 'much harder than the 3 stages before', tone(sm.spikes, 0, 3));
  stat(sm.camp ? 'Frustrating stages' : 'Stages needing many tries', String(sm.frustrated), 'players quit or retry a lot', tone(sm.frustrated, 0, 3));
  stat('Boring stages', String(sm.bored), 'too easy, even random bots win', tone(sm.bored, 2, 8));
  if (sm.skill != null) stat('Skill reward', num(sm.skill) + ' pts', 'smart minus random win rate', sm.skill >= 25 ? 'good' : sm.skill >= 12 ? 'warn' : 'bad');
  root.append(h('h2', { style: 'margin-top:18px' }, 'Result of ' + d.meta.id), h('p', { class: 'hint' }, `${sm.tp} is the reference bot. ${d.meta.options.runs} runs per stage, ${ok.length} stages with data. Hardest: ${sm.hardest.map((s) => s.id + ' (' + Math.round(s.difficulty) + ')').join(', ')}. Easiest: ${sm.easiest.map((s) => s.id + ' (' + Math.round(s.difficulty) + ')').join(', ')}.`), cards);
  // chart
  const hidden = new Set(); const others = Object.keys(rep.stages[Object.keys(rep.stages)[0]]).filter((k) => !['target', 'flags', sm.tp].includes(k));
  const cbox = h('div', { class: 'chartbox' }), chips = h('div', { class: 'chips' });
  const sel = () => { const i = sc.findIndex((s) => s.id === A.selStage); return i; };
  const ids = sc.map((s) => s.id);
  const chart = Chart(cbox, {
    ids, yMax: 100, yFmt: (v) => Math.round(v), label: 'Difficulty per stage',
    series: () => {
      const s = [{ vals: sc.map((x) => x.empty ? null : x.difficulty), color: personaColor(sm.tp), w: 3, label: sm.tp, bold: true, whisk: sc.map((x) => x.empty ? null : [100 * (1 - x.hi), 100 * (1 - x.lo)]) }];
      if (sc.some((x) => x.targetWin != null)) s.push({ vals: sc.map((x) => x.targetWin == null ? null : 100 * (1 - x.targetWin)), color: 'var(--target)', w: 2.2, dash: '7 5', label: 'TARGET', bold: true });
      others.filter((p) => !hidden.has(p)).forEach((p) => s.push({ vals: ids.map((id) => rep.stages[id][p] ? 100 * (1 - rep.stages[id][p].win) : null), color: personaColor(p), w: 1.5, opacity: .8, label: p }));
      return s;
    },
    marks: () => sc.filter((x) => !x.empty && x.flags.some((f) => FLAG_SEV[f] === 'bad')).map((x) => ({ i: x.idx, y: x.difficulty, kind: 'ring' })),
    sel, onSelect: (i) => { A.selStage = ids[i]; detailBox(); table(); chart.draw(); },
    tip: (i) => { const x = sc[i]; if (x.empty) return { title: 'Stage ' + x.id, rows: [{ k: 'no data', v: '' }] }; return { title: 'Stage ' + x.id, rows: [{ k: sm.tp + ' difficulty', v: Math.round(x.difficulty) + ' (' + band(x.difficulty) + ')', c: personaColor(sm.tp) }, ...(x.targetWin != null ? [{ k: 'target', v: Math.round(100 * (1 - x.targetWin)) }] : []), ...others.filter((p) => !hidden.has(p) && rep.stages[x.id][p]).map((p) => ({ k: p, v: Math.round(100 * (1 - rep.stages[x.id][p].win)), c: personaColor(p) })), { k: 'frustration / boredom', v: Math.round(x.frustration) + ' / ' + Math.round(x.boredom) }] }; },
  });
  others.forEach((p) => chips.append(h('button', { class: 'chip', type: 'button', 'aria-pressed': 'true', onclick: (e) => { hidden.has(p) ? hidden.delete(p) : hidden.add(p); e.currentTarget.setAttribute('aria-pressed', String(!hidden.has(p))); chart.draw(); } }, h('i', { style: 'background:' + personaColor(p) }), p)));
  root.append(h('h2', null, 'Difficulty per stage'), h('p', { class: 'hint' }, 'Higher = harder. Difficulty is 100 minus the first-try win rate of the reference bot. Vertical bars are the 95% confidence range. Hover a stage, click it for details.'), chips, cbox);
  chart.draw();
  const detail = h('section', { class: 'panel' }); root.append(detail);
  function detailBox() {
    detail.textContent = '';
    const x = sc.find((s) => s.id === A.selStage);
    if (!x) { detail.append(h('p', { class: 'hint' }, 'Click a stage in the chart or the table to see what its scores mean.')); return; }
    if (x.empty) { detail.append(h('h3', null, 'Stage ' + x.id), h('p', null, 'No player of the reference bot reached this stage.')); return; }
    detail.append(h('h3', null, `Stage ${x.id}: ${band(x.difficulty)} (difficulty ${Math.round(x.difficulty)})`));
    detail.append(h('p', null, `${sm.tp} clears it on the first try ${pct(x.win)} of the time (95% range ${pct(x.lo)} to ${pct(x.hi)}, ${x.n} players)${sm.camp ? `, needs ${num(x.tries, 1)} attempts on average and ${pct(x.stall)} never clear it` : `, which is about ${num(x.tries, 1)} attempts`}.`));
    const lines = [];
    if (x.frustration >= 45) lines.push('Frustration risk is high: players are likely to get stuck or quit here.');
    if (x.boredom >= 60) lines.push('Boredom risk is high: this stage is too easy to feel like progress.');
    if (x.spike > 20) lines.push(`It is ${Math.round(x.spike)} points harder than the stages right before it (a spike).`);
    if (x.skill != null) lines.push(x.skill < 10 ? 'Skill barely matters here: a random bot does almost as well.' : `Skill matters: the smart bot beats random by ${Math.round(x.skill)} points.`);
    if (x.targetWin != null) lines.push(`Target difficulty here is ${Math.round(100 * (1 - x.targetWin))}, measured ${Math.round(x.difficulty)}.`);
    detail.append(h('p', null, lines.join(' ')), h('div', null, x.flags.map(flagEl)));
    detail.append(h('div', { class: 'row', style: 'margin-top:8px' }, h('button', { class: 'ghost', onclick: () => { A.selStage = x.id; go('target'); } }, 'Edit its target'), h('button', { class: 'ghost', onclick: () => { A.logRunId = d.meta.id; A.logTab = 'attempts'; A.attFilter = { persona: sm.tp, stage: x.id, result: '' }; go('logs'); } }, 'See its attempt log')));
  }
  // table
  const cols = [['id', 'Stage', (s) => s.idx], ['difficulty', 'Difficulty', (s) => s.difficulty], ['frustration', 'Frustration', (s) => s.frustration], ['boredom', 'Boredom', (s) => s.boredom], ['skill', 'Skill', (s) => s.skill], ['conf', '± conf', (s) => s.conf], ['win', 'First-try win', (s) => s.win], ['tries', 'Tries', (s) => s.tries]];
  let sort = { k: 'id', dir: 1 };
  const tw = h('div', { class: 'tablewrap' });
  function table() {
    const rows = [...sc].sort((a, b) => { const c = cols.find((c) => c[0] === sort.k)[2], x = a.empty ? null : c(a), y = b.empty ? null : c(b); if (x == null) return 1; if (y == null) return -1; return (x - y) * sort.dir; });
    const meter = (v, color) => h('span', null, h('span', { class: 'meter' }, h('i', { style: `width:${clamp(v, 0, 100)}%;background:${color}` })), Math.round(v));
    tw.textContent = '';
    tw.append(h('table', null, h('thead', null, h('tr', null, cols.map(([k, t]) => h('th', { 'aria-sort': sort.k === k ? (sort.dir > 0 ? 'ascending' : 'descending') : 'none', onclick: () => { sort = { k, dir: sort.k === k ? -sort.dir : (k === 'id' ? 1 : -1) }; table(); } }, t)), h('th', { class: 'l' }, 'Flags'))),
      h('tbody', null, rows.map((s) => h('tr', { class: A.selStage === s.id ? 'sel' : '', onclick: () => { A.selStage = s.id; detailBox(); table(); chart.draw(); } },
        h('td', null, s.id + (s.lowN ? ' ⚠' : '')), s.empty ? h('td', { colspan: 7, class: 'l' }, 'no player reached it') : [h('td', null, meter(s.difficulty, 'var(--accent)')), h('td', null, meter(s.frustration, 'var(--bad)')), h('td', null, meter(s.boredom, 'var(--warn)')), h('td', null, s.skill == null ? '-' : Math.round(s.skill)), h('td', null, '±' + Math.round(s.conf)), h('td', null, pct(s.win)), h('td', null, num(s.tries, 1))],
        h('td', { class: 'l' }, s.flags.map(flagEl)))))));
  }
  detailBox(); table();
  root.append(h('div', { class: 'panel row' }, h('span', null, h('b', null, 'Next: '), 'this is how hard the game is now. Decide what it should be: make the whole game harder or easier, or single stages.'), h('span', { class: 'grow' }), h('button', { class: 'primary', onclick: () => go('target') }, 'Set the target \u2192')));
  root.append(h('h2', { style: 'margin-top:18px' }, 'All stages'), tw);
  root.append(h('details', { style: 'margin-top:12px' }, h('summary', null, 'How the scores are computed'), h('dl', null,
    h('dt', null, 'Difficulty'), h('dd', null, '100 × (1 − first-try win rate of the reference bot). This is the number the target editor changes.'),
    h('dt', null, 'Frustration'), h('dd', null, 'How likely players are to get stuck: 60% quit rate (players who never clear it) + 40% average retries.'),
    h('dt', null, 'Boredom'), h('dd', null, 'How trivial the stage is: 70% how far the win rate is above 85%, 30% how often a random bot wins.'),
    h('dt', null, 'Skill'), h('dd', null, 'Win rate of the reference bot minus the random bot. Low = choices do not matter.'),
    h('dt', null, '± conf'), h('dd', null, 'Half width of the 95% confidence range in points. Large = run more.'),
    h('dt', null, '⚠'), h('dd', null, 'Fewer than 20 players reached the stage, the numbers are noisy.')),
    h('p', { class: 'hint' }, 'Bots are not humans. These scores describe the bots; real playtests override them.'),
    h('a', { href: '/run/' + d.meta.id + '/report.html', target: '_blank', rel: 'noopener' }, 'Open the full report of this run')));
}

// ---------- 2 · TARGET ----------
const TPL = [['linear', 'Linear ramp'], ['slow', 'Slow start'], ['fast', 'Fast start'], ['scurve', 'S-curve'], ['waves', 'Waves per area'], ['stairs', 'Staircase'], ['flat', 'Flat'], ['smooth', 'Smooth current'], ['measured', 'Keep current']];
const TAGS = { 'much-easier': -25, easier: -12, harder: 12, 'much-harder': 25, breather: -20, boss: null };
const defaultT = () => ({ snapshot: null, template: 'linear', start: 8, end: 55, average: null, wave: 18, area: 10, bossBump: 15, tolerance: 15, persona: 'smart', tags: {}, pins: {}, bosses: [] });
function initT() {
  const t = A.st.targets, T0 = defaultT();
  if (t && t.studio) return { ...T0, ...t.studio, tags: { ...(t.studio.tags || {}) }, pins: { ...(t.studio.pins || {}) } };
  if (A.det) { T0.template = 'measured'; T0.snapshot = snapshotNow(A.st.info.stages); }
  if (t) {
    if (t.curve && !A.det) { T0.start = Math.round(100 * (1 - t.curve.start)); T0.end = Math.round(100 * (1 - t.curve.end)); T0.bossBump = Math.round(100 * (t.curve.bossDrop ?? 0.15)); }
    T0.persona = t.targetPersona || 'smart'; T0.tolerance = Math.round(100 * (t.tolerance ?? 0.12)); T0.bosses = (t.bosses || []).map(String);
  }
  return T0;
}
const snapshotNow = (ids) => { const m = measuredArr(ids); let last = m.find((x) => x != null) ?? 50; return m.map((x) => { if (x != null) last = x; return last; }); };
function measuredArr(ids) { return ids.map((id) => { const s = A.det && A.det.scores.find((x) => x.id === id); return s && !s.empty ? s.difficulty : null; }); }
function baseCurve(T, ids) {
  const n = ids.length, out = [], m = (T.snapshot && T.snapshot.length === n) ? T.snapshot : measuredArr(ids), haveM = m.some((x) => x != null);
  const fill = (a) => { let last = a.find((x) => x != null) ?? 50; return a.map((x) => { if (x != null) last = x; return last; }); };
  const mf = fill(m);
  for (let i = 0; i < n; i++) {
    const t = n > 1 ? i / (n - 1) : 0, S = +T.start, E = +T.end, area = Math.max(2, +T.area || 10);
    let v;
    switch (T.template) {
      case 'slow': v = S + (E - S) * t * t; break;
      case 'fast': v = S + (E - S) * (1 - (1 - t) * (1 - t)); break;
      case 'scurve': v = S + (E - S) * t * t * (3 - 2 * t); break;
      case 'waves': v = S + (E - S) * t + (+T.wave) * ((i % area) / (area - 1) - 0.5); break;
      case 'stairs': { const steps = Math.ceil(n / area); v = S + (E - S) * (steps > 1 ? Math.floor(i / area) / (steps - 1) : 0); break; }
      case 'flat': v = (S + E) / 2; break;
      case 'measured': v = haveM ? mf[i] : S + (E - S) * t; break;
      case 'smooth': { if (!haveM) { v = S + (E - S) * t; break; } let a = 0, c = 0; for (let k = -3; k <= 3; k++) { const j = i + k; if (j >= 0 && j < n) { a += mf[j]; c++; } } v = a / c; break; }
      default: v = S + (E - S) * t;
    }
    out.push(v);
  }
  return out;
}
function targetCurve(T, ids) {
  const base = baseCurve(T, ids), noAuto = ['measured', 'smooth'].includes(T.template);   // measured difficulty already contains the bosses
  const tagBoss = new Set(Object.entries(T.tags).filter(([, v]) => v === 'boss').map(([k]) => k));
  const autoBoss = new Set(noAuto ? [] : (T.bosses || []));
  const withMods = (shift) => base.map((v, i) => {
    const id = ids[i], tag = T.tags[id];
    let x = v + shift;
    if (autoBoss.has(id) || tagBoss.has(id)) x += +T.bossBump;
    if (tag && TAGS[tag] != null) x += TAGS[tag];
    return clamp(x, 2, 98);
  });
  let shift = 0;
  if (T.average != null) { for (let k = 0; k < 10; k++) shift += T.average - mean(withMods(shift)); }   // the average includes tags and bumps
  return withMods(shift).map((v, i) => T.pins[ids[i]] != null ? clamp(T.pins[ids[i]], 2, 98) : v);
}
const targetsJson = (T, ids) => {
  const old = A.st.targets || {}, d = targetCurve(T, ids), out = {};
  for (const [k, v] of Object.entries(old)) if (!['curve', 'stages', 'studio', 'bosses', 'targetPersona', 'tolerance', '_help', '_note'].includes(k)) out[k] = v;
  const bosses = [...new Set([...(T.bosses || []), ...Object.entries(T.tags).filter(([, v]) => v === 'boss').map(([k]) => k)])];
  return { _note: 'Written by balance-sim studio. Win rates are 1 - difficulty/100 of the Target tab; edit them there.', targetPersona: T.persona, tolerance: +(T.tolerance / 100).toFixed(3), ...out, bosses, stages: Object.fromEntries(ids.map((id, i) => [id, { firstTryWin: +(1 - d[i] / 100).toFixed(3) }])), studio: T };
};
function thumb(name, T0) {
  const ids = Array.from({ length: 30 }, (_, i) => String(i + 1)), T = { ...defaultT(), template: name, start: 10, end: 60, area: 10, wave: 18, tags: {}, pins: {}, bosses: [], average: null };
  const m = A.det ? null : null; void m;
  let v; if (name === 'smooth' || name === 'measured') { const d = A.det ? measuredArr(A.det.scores.map((s) => s.id)) : null; v = d ? d.map((x) => x ?? 50) : baseCurve({ ...T, template: 'linear' }, ids); if (name === 'smooth' && d) v = v.map((_, i) => mean(v.slice(Math.max(0, i - 3), i + 4))); const l = v.length; v = Array.from({ length: 30 }, (_, i) => v[Math.min(l - 1, Math.round(i * (l - 1) / 29))]); } else v = baseCurve(T, ids);
  const pts = v.map((y, i) => `${(i / 29 * 100).toFixed(1)},${(46 - clamp(y, 0, 100) * 0.46).toFixed(1)}`).join(' ');
  return h('div', { html: '' }, (() => { const s = document.createElementNS('http://www.w3.org/2000/svg', 'svg'); s.setAttribute('viewBox', '0 0 100 46'); s.setAttribute('preserveAspectRatio', 'none'); s.innerHTML = `<polyline points="${pts}" fill="none" stroke="var(--accent)" stroke-width="2.2" vector-effect="non-scaling-stroke"/>`; return s; })());
}
function viewTarget(root) {
  const info = A.st.info;
  root.append(h('h1', null, '2 · Target'), h('p', { class: 'lead' }, 'Decide how hard each stage SHOULD be. Pick a template curve, move the average difficulty, tag stages (this one harder, that one a breather, boss), or drag a point on the chart. The measured curve from the last detection run is drawn underneath so you see the gap.'));
  if (!info) { root.append(h('div', { class: 'note bad' }, A.st.infoError)); return; }
  if (!A.det) { root.append(h('div', { class: 'panel stack' }, h('h3', null, 'Measure the game first'), h('p', null, 'A target only makes sense next to the current difficulty. Run a detection (step 1), then come back: the editor starts from what the game does now, and you move it from there (the whole game harder or easier, single stages, or a template curve).'), h('button', { class: 'primary', onclick: () => go('detect') }, 'Go to Detect'))); return; }
  if (!A.T) A.T = initT();
  const T = A.T, ids = info.stages;
  const personas = A.det ? Object.keys(A.det.report.stages[Object.keys(A.det.report.stages)[0]]).filter((k) => !['target', 'flags'].includes(k)) : ['smart'];
  if (!personas.includes(T.persona)) T.persona = personas.includes('smart') ? 'smart' : personas[0];
  const dirty = () => { A.Tdirty = true; summaryBox(); };
  const measAvg = A.det ? A.det.sum.avg : null;
  const left = h('div', { class: 'panel stack' });
  left.append(h('h3', null, 'Template curve'));
  const tpl = h('div', { class: 'tpl' });
  const drawTpl = () => { tpl.textContent = ''; TPL.forEach(([k, label]) => tpl.append(h('button', { type: 'button', 'aria-pressed': String(T.template === k), onclick: () => { T.template = k; if (['measured', 'smooth'].includes(k) && !(T.snapshot && T.snapshot.length)) T.snapshot = snapshotNow(ids); dirty(); drawTpl(); drawForm(); chart.draw(); } }, thumb(k), label))); };
  left.append(tpl);
  const form = h('div', { class: 'stack' }); left.append(form);
  const slider = (label, key, min, max, step, fmt) => h('div', null, h('label', null, h('span', null, label + ': '), h('b', { id: 'v-' + key }, fmt ? fmt(T[key]) : T[key])), h('input', { type: 'range', min, max, step: step || 1, value: T[key], oninput: (e) => { T[key] = +e.target.value; $('#v-' + key).textContent = fmt ? fmt(T[key]) : T[key]; dirty(); chart.draw(); } }));
  function drawForm() {
    form.textContent = '';
    const noShape = ['measured', 'smooth'].includes(T.template);
    if (!noShape) form.append(slider('Difficulty at the first stage', 'start', 0, 100), slider('Difficulty at the last stage', 'end', 0, 100));
    else form.append(h('p', { class: 'hint' }, 'Starts from the difficulty measured in the last detection' + (T.template === 'smooth' ? ', with spikes smoothed out (7-stage moving average)' : ', as it is') + '. Use the average slider and the stage tags below to change it. The baseline is frozen when you save, so a newer detection does not move your target.'), h('button', { class: 'ghost', type: 'button', onclick: () => { T.snapshot = snapshotNow(ids); dirty(); chart.draw(); drawForm(); } }, 'Re-measure baseline from the latest detection'));
    if (T.template === 'waves' || T.template === 'stairs') form.append(slider('Stages per area', 'area', 3, 25), T.template === 'waves' ? slider('Wave height (points per area)', 'wave', 0, 50) : null);
    form.append(h('div', null, h('label', { class: 'check' }, h('input', { type: 'checkbox', checked: T.average != null, onchange: (e) => { T.average = e.target.checked ? Math.round(mean(targetCurve({ ...T, average: null }, ids))) : null; dirty(); drawForm(); chart.draw(); } }), 'Fix the average difficulty of the whole game'),
      T.average != null ? h('div', { style: 'margin-top:6px' }, slider('Average difficulty', 'average', 5, 95, 1, (v) => `${v} (${band(v)})`), h('div', { class: 'row' }, [-10, -5, 5, 10].map((dv) => h('button', { class: 'ghost', type: 'button', onclick: () => { T.average = clamp(T.average + dv, 5, 95); dirty(); drawForm(); chart.draw(); } }, (dv > 0 ? '+' : '\u2212') + Math.abs(dv) + (dv > 0 ? ' harder' : ' easier')))), measAvg != null ? h('p', { class: 'hint' }, `Measured now: ${Math.round(measAvg)}. The shape stays, the whole curve moves up or down.`) : null) : null));
    form.append(slider('Boss bump (extra difficulty on bosses)', 'bossBump', 0, 40), slider('Tolerance (± points that still count as on target)', 'tolerance', 3, 30));
    form.append(h('div', null, h('label', null, 'Reference bot (the "average player")'), h('select', { onchange: (e) => { T.persona = e.target.value; dirty(); } }, personas.map((p) => h('option', { value: p, selected: p === T.persona }, p)))));
  }
  const right = h('div', null);
  const cbox = h('div', { class: 'chartbox' });
  const selIdx = () => ids.indexOf(String(A.selStage));
  const chart = Chart(cbox, {
    ids, yMax: 100, yFmt: (v) => Math.round(v), label: 'Target and measured difficulty',
    series: () => { const tc = targetCurve(T, ids), s = [{ vals: tc, color: 'var(--target)', w: 2.6, dash: '7 5', label: 'TARGET', bold: true }]; if (A.det) s.unshift({ vals: measuredArr(ids), color: personaColor(T.persona), w: 2.4, dots: 2.5, label: 'measured', bold: true }); return s; },
    band: () => targetCurve(T, ids).map((v) => [clamp(v - T.tolerance, 0, 100), clamp(v + T.tolerance, 0, 100)]),
    marks: () => Object.keys(T.pins).filter((id) => ids.includes(id)).map((id) => ({ i: ids.indexOf(id), y: T.pins[id], kind: 'pin' })),
    bosses: () => new Set([...(T.bosses || []), ...Object.entries(T.tags).filter(([, v]) => v === 'boss').map(([k]) => k)]),
    sel: selIdx, onSelect: (i) => { A.selStage = ids[i]; stageBox(); chart.draw(); },
    drag: { valueAt: (i) => targetCurve(T, ids)[i], onDrag: (i, y) => { T.pins[ids[i]] = Math.round(y); stageBox(true); }, onDrop: () => { dirty(); stageBox(); } },
    tip: (i) => { const id = ids[i], tc = targetCurve(T, ids)[i], m = measuredArr(ids)[i]; return { title: 'Stage ' + id, rows: [{ k: 'target', v: Math.round(tc) + ' (' + band(tc) + ')' }, ...(m != null ? [{ k: 'measured', v: Math.round(m) }, { k: 'gap', v: sgn(Math.round(m - tc)) }] : []), ...(T.tags[id] ? [{ k: 'tag', v: T.tags[id] }] : []), ...(T.pins[id] != null ? [{ k: 'pinned', v: 'yes' }] : [])] }; },
  });
  const stage = h('section', { class: 'panel stack' });
  function stageBox(light) {
    const id = A.selStage != null ? String(A.selStage) : null;
    stage.textContent = '';
    if (!id || !ids.includes(id)) { stage.append(h('p', { class: 'hint' }, 'Click a stage (or drag a point of the dashed line up or down) to make it harder, easier, a boss or a breather.')); return; }
    const tc = targetCurve(T, ids)[ids.indexOf(id)], m = measuredArr(ids)[ids.indexOf(id)];
    stage.append(h('h3', null, `Stage ${id}: target ${Math.round(tc)} (${band(tc)})${m != null ? `, measured ${Math.round(m)}` : ''}`));
    const tags = h('div', { class: 'tags' });
    [['much-easier', 'Much easier'], ['easier', 'Easier'], [null, 'As the curve'], ['harder', 'Harder'], ['much-harder', 'Much harder'], ['boss', 'Boss'], ['breather', 'Breather']].forEach(([k, label]) => tags.append(h('button', { type: 'button', 'aria-pressed': String((T.tags[id] || null) === k), onclick: () => { if (k) T.tags[id] = k; else delete T.tags[id]; delete T.pins[id]; dirty(); stageBox(); chart.draw(); } }, label)));
    stage.append(tags);
    stage.append(h('div', { class: 'row' }, h('div', { style: 'flex:1;min-width:200px' }, h('label', null, 'Pin to an exact difficulty'), h('input', { type: 'range', min: 2, max: 98, value: Math.round(tc), oninput: (e) => { T.pins[id] = +e.target.value; dirty(); chart.draw(); } })), T.pins[id] != null ? h('button', { class: 'ghost', type: 'button', onclick: () => { delete T.pins[id]; dirty(); stageBox(); chart.draw(); } }, 'Unpin') : null));
    void light;
  }
  const sumBox = h('div', { class: 'row' });
  function summaryBox() {
    const tc = targetCurve(T, ids), avg = mean(tc);
    sumBox.textContent = '';
    sumBox.append(h('span', null, `Target average difficulty: `, h('b', null, `${Math.round(avg)} (${band(avg)})`), measAvg != null ? ` · measured ${Math.round(measAvg)}` : ''), A.Tdirty ? h('span', { class: 'dirty' }, '● unsaved') : h('span', { class: 'hint' }, 'saved'));
  }
  const actions = h('div', { class: 'row' },
    h('button', { class: 'primary', type: 'button', onclick: async () => { await api('/api/targets', { body: { targets: targetsJson(T, ids) } }); A.Tdirty = false; await refresh(); summaryBox(); } }, 'Save target'),
    h('button', { class: 'ghost', type: 'button', onclick: async () => { await api('/api/targets', { body: { targets: targetsJson(T, ids) } }); A.Tdirty = false; await refresh(); go('calibrate'); } }, 'Save and calibrate →'),
    h('button', { class: 'ghost', type: 'button', onclick: () => { A.T = initT(); A.Tdirty = false; render(); } }, 'Discard changes'),
    h('button', { class: 'ghost', type: 'button', onclick: () => { T.tags = {}; T.pins = {}; dirty(); stageBox(); chart.draw(); } }, 'Clear tags and pins'));
  right.append(h('h3', null, 'Target curve'), h('p', { class: 'hint' }, 'The dashed line is the TARGET, the green band its tolerance, the coloured line what the bot measured. Drag a dashed point to pin it.'), cbox, sumBox, stage, actions);
  root.append(h('div', { class: 'tgrid' }, left, right));
  drawTpl(); drawForm(); chart.draw(); stageBox(); summaryBox();
  root.append(h('p', { class: 'hint' }, `Saved to ${A.st.targetsFile} as one first-try win rate per stage (1 − difficulty/100), so the report, the tuner and the calibrator all read the same numbers.`));
}

// ---------- 3 · CALIBRATE ----------
function viewCalibrate(root) {
  const info = A.st.info, running = A.st.job && A.st.job.status === 'running', cf = A.cform;
  root.append(h('h1', null, '3 · Calibrate'), h('p', { class: 'lead' }, 'Let the studio move the per-stage difficulty lever of your game until the measured curve meets the target. Every round uses a fresh seed (so it does not fit noise); the best result is verified on yet another seed and compared with the untouched game.'));
  if (!info) { root.append(h('div', { class: 'note bad' }, A.st.infoError)); return; }
  if (!info.levers) root.append(h('div', { class: 'note' }, h('b', null, 'This adapter declares no calibration lever. '), 'Calibration by script needs a number per stage that makes it harder or easier (adapter export `levers.stage`). Without it you can still measure against the target (Detect tab) and ask Claude to tune with the agentic loop.'));
  if (!A.det) { root.append(h('div', { class: 'panel stack' }, h('h3', null, 'Measure the game first'), h('p', null, 'Calibration needs the current difficulty and a target. Run a detection (step 1), set the target (step 2), then come back.'), h('button', { class: 'primary', onclick: () => go('detect') }, 'Go to Detect'))); return; }
  const hasTarget = !!A.st.targets;
  if (!hasTarget) root.append(h('div', { class: 'note' }, 'No target saved yet. Set one in the Target tab first.'));
  if (A.Tdirty) root.append(h('div', { class: 'note' }, h('b', null, 'You have unsaved target changes. '), 'Calibration uses the saved target.', h('button', { class: 'ghost', style: 'margin-left:8px', onclick: () => go('target') }, 'Go to Target')));
  const box = h('section', { class: 'card' });
  const lv = info.levers;
  if (lv) box.append(h('p', { class: 'hint' }, `Lever: ${lv.param.replace('{stage}', '<stage>')} (${lv.mode === 'mul' ? 'a multiplier' : 'added ' + (lv.unit || 'units')}; a bigger value makes the stage ${lv.harder > 0 ? 'harder' : 'easier'}${lv.min != null ? `; allowed ${lv.min} to ${lv.max}` : ''}).`));
  box.append(h('div', { class: 'grid3' },
    h('div', null, h('label', null, 'Rounds'), h('input', { type: 'number', min: 2, max: 20, value: cf.rounds, oninput: (e) => { cf.rounds = +e.target.value; } })),
    h('div', null, h('label', null, 'Runs per stage per round'), h('input', { type: 'number', min: 20, max: 500, value: cf.runs, oninput: (e) => { cf.runs = +e.target.value; } })),
    h('div', null, h('label', null, 'Strength of each correction'), h('select', { onchange: (e) => { cf.k = +e.target.value; } }, [[0.5, 'Gentle'], [0.8, 'Normal'], [1.2, 'Strong']].map(([v, l]) => h('option', { value: v, selected: cf.k === v }, l))))));
  if (A.st.config.candidate) box.append(h('label', { class: 'check', style: 'margin-top:10px' }, h('input', { type: 'checkbox', checked: cf.useCand, onchange: (e) => { cf.useCand = e.target.checked; } }), 'Start from the active candidate'));
  box.append(h('div', { class: 'row', style: 'margin-top:12px' }, h('button', { class: 'primary', disabled: running || !lv || !hasTarget, onclick: startCalib }, running ? 'A job is running…' : 'Run calibration'), h('span', { class: 'hint' }, `About ${cf.rounds + 2} measurements of ${info.stages.length} stages × ${cf.runs} runs.`)));
  root.append(box);
  const out = h('div'); root.append(out);
  if (A.st.config.candidate) {
    const c = A.st.config.candidate;
    out.append(h('div', { class: 'panel row' }, h('span', null, h('b', null, 'Active candidate: '), `${Object.keys(c.params).length} lever values${c.from ? ' from ' + c.from : ''}. Detection runs can use it (checkbox on the Detect tab).`), h('span', { class: 'grow' }), h('button', { class: 'ghost', onclick: async () => { await api('/api/candidate', { body: {} }); await refresh(); render(); } }, 'Clear')));
  }
  if (A.calib) calibResults(out, A.calib);
  else out.append(h('div', { class: 'panel empty' }, 'No calibration run yet.'));
}
async function startCalib() {
  const cf = A.cform;
  try { const meta = await api('/api/jobs', { body: { kind: 'calibrate', rounds: cf.rounds, runs: cf.runs, k: cf.k, retries: A.form.retries, seed: A.form.seed, useCandidate: cf.useCand } }); A.calib = null; A.calibRunId = meta.id; await afterStart(meta.id); } catch (e) { alert(e.message); }
}
function lossChart(rounds, total) {
  const w = 520, hgt = 140, pad = 34, mx = Math.max(10, ...rounds.map((r) => r.loss * 100)) * 1.1;
  const x = (i) => pad + (w - pad - 10) * (total > 1 ? i / (total - 1) : 0.5), y = (v) => 10 + (hgt - 28) * (1 - v / mx);
  const s = document.createElementNS('http://www.w3.org/2000/svg', 'svg'); s.setAttribute('viewBox', `0 0 ${w} ${hgt}`); s.style.width = '100%';
  s.innerHTML = [0, 0.5, 1].map((t) => `<line x1="${pad}" x2="${w - 10}" y1="${y(mx * t)}" y2="${y(mx * t)}" stroke="var(--line)"/><text x="${pad - 6}" y="${y(mx * t) + 4}" text-anchor="end" class="ax">${Math.round(mx * t)}</text>`).join('')
    + `<polyline fill="none" stroke="var(--accent)" stroke-width="2.4" points="${rounds.map((r, i) => `${x(i)},${y(r.loss * 100)}`).join(' ')}"/>` + rounds.map((r, i) => `<circle cx="${x(i)}" cy="${y(r.loss * 100)}" r="4" fill="var(--accent)"/><text x="${x(i)}" y="${hgt - 4}" text-anchor="middle" class="ax">${r.round}</text>`).join('');
  return s;
}
function calibResults(out, d) {
  const prog = d.progress, res = d.result, run = d.meta;
  out.append(h('h2', { style: 'margin-top:18px' }, 'Result of ' + run.id), h('span', { class: 'badge ' + run.status }, run.status));
  if (prog && prog.rounds.length) out.append(h('div', { class: 'panel' }, h('h3', null, 'Gap to target per round (points, lower is better)'), lossChart(prog.rounds, prog.total), h('p', { class: 'hint' }, `${prog.rounds.length} of ${prog.total} rounds done. Each round uses a new seed, so the line wobbles a little.`)));
  if (!res) { if (run.status === 'running') out.append(h('p', { class: 'hint' }, 'Running… results appear when the verification finished.')); else out.append(h('div', { class: 'note bad' }, 'This run produced no result. See its console in Runs & logs.')); return; }
  const b = res.before, a = res.after, imp = (b.loss - a.loss) * 100;
  const cards = h('div', { class: 'cards' });
  const stat = (t, v, s, c) => cards.append(h('div', { class: 'stat ' + (c || '') }, h('span', null, t), h('b', null, v), h('em', null, s)));
  stat('Gap before', num(b.loss * 100, 1) + ' pts', 'the game as it is, fresh seed');
  stat('Gap after', num(a.loss * 100, 1) + ' pts', 'best candidate, same seed', imp > 1 ? 'good' : 'warn');
  stat('Flagged stages', `${b.flagged} → ${a.flagged}`, 'serious flags', a.flagged <= b.flagged ? 'good' : 'warn');
  stat('Levers changed', String(res.changes.length), `of ${Object.keys(a.stages).length} stages`);
  out.append(cards);
  if (imp < 1) out.append(h('div', { class: 'note' }, 'The candidate is not clearly better than the game as it is. Either the game already matches this target, or the lever cannot reach it (a stage needs a structural change, not a number). Try a gentler target or look at the stage details.'));
  const ids = Object.keys(a.stages), cbox = h('div', { class: 'chartbox' });
  const chart = Chart(cbox, {
    ids, yMax: 100, yFmt: (v) => Math.round(v), label: 'Difficulty before and after calibration',
    series: () => [
      { vals: ids.map((s) => b.stages[s].win == null ? null : 100 * (1 - b.stages[s].win)), color: 'var(--c-random)', w: 1.8, label: 'before' },
      { vals: ids.map((s) => a.stages[s].win == null ? null : 100 * (1 - a.stages[s].win)), color: personaColor(res.targetPersona), w: 3, label: 'after', bold: true },
      { vals: ids.map((s) => a.stages[s].target == null ? null : 100 * (1 - a.stages[s].target)), color: 'var(--target)', w: 2.2, dash: '7 5', label: 'TARGET', bold: true }],
    tip: (i) => { const s = ids[i]; const f = (x) => x == null ? '-' : Math.round(100 * (1 - x)); return { title: 'Stage ' + s, rows: [{ k: 'before', v: f(b.stages[s].win), c: 'var(--c-random)' }, { k: 'after', v: f(a.stages[s].win), c: personaColor(res.targetPersona) }, { k: 'target', v: f(a.stages[s].target) }] }; },
  });
  out.append(h('h3', { style: 'margin-top:14px' }, 'Difficulty before and after'), cbox); chart.draw();
  const unit = res.lever.unit || '';
  const tw = h('div', { class: 'tablewrap' }, h('table', null, h('thead', null, h('tr', null, h('th', null, 'Stage'), h('th', null, 'From'), h('th', null, 'To'), h('th', null, 'Gap before'), h('th', null, 'Gap after'))),
    h('tbody', null, res.changes.map((c) => { const gb = b.stages[c.stage], ga = a.stages[c.stage]; const g = (x) => x && x.win != null && x.target != null ? sgn(Math.round(100 * (x.win - x.target))) : '-'; return h('tr', null, h('td', null, c.stage), h('td', null, c.from + (unit ? ' ' + unit : '')), h('td', null, h('b', null, c.to + (unit ? ' ' + unit : ''))), h('td', null, g(gb)), h('td', null, g(ga))); }))));
  out.append(h('h3', { style: 'margin-top:14px' }, 'What it changed'), res.changes.length ? tw : h('p', { class: 'hint' }, 'Nothing: every stage was already inside the dead band.'));
  const prompt = () => `Apply the balance-sim calibration "${run.id}" to the game in ${A.st.dir}.\nThe adapter lever is "${res.lever.param}" (${res.lever.mode === 'mul' ? 'multiplier' : 'added ' + (unit || 'units')}, bigger = ${res.lever.harder > 0 ? 'harder' : 'easier'}); see ${A.st.adapter} for how it maps to the game's data files.\nChange ONLY these stages, one data file at a time, with one CHANGELOG line per change, then rebuild and re-run detection to compare:\n` + res.changes.map((c) => `- stage ${c.stage}: ${c.from} -> ${c.to}`).join('\n') + `\nMeasured gap to target: ${num(b.loss * 100, 1)} pts before, ${num(a.loss * 100, 1)} pts after (verified on a fresh seed). Bots are not humans: a real playtest of the changed stages decides.`;
  const copied = h('span', { class: 'hint' });
  const cp = (t) => { navigator.clipboard.writeText(t).then(() => { copied.textContent = 'Copied.'; setTimeout(() => { copied.textContent = ''; }, 1800); }, () => { copied.textContent = 'Copy blocked by the browser.'; }); };
  out.append(h('div', { class: 'row', style: 'margin-top:12px' },
    h('button', { class: 'primary', onclick: async () => { await api('/api/candidate', { body: { params: res.params, from: run.id } }); await refresh(); A.form.useCand = true; render(); } }, 'Use as active candidate'),
    h('button', { class: 'ghost', onclick: () => cp(JSON.stringify(res.params, null, 2)) }, 'Copy values (JSON)'),
    h('button', { class: 'ghost', onclick: () => cp(prompt()) }, 'Copy a prompt for Claude to apply it'), copied));
  out.append(h('p', { class: 'hint' }, 'The studio never edits your game files. "Active candidate" only feeds these values into later runs; applying them to the real data is a separate step (ask Claude with the prompt above).'));
}

// ---------- 4 · RUNS & LOGS ----------
function viewLogs(root) {
  root.append(h('h1', null, 'Runs & logs'), h('p', { class: 'lead' }, 'Every run keeps its console output, its attempt log (one line per attempt), the settings it used and its full report. Replay any attempt as a timeline.'));
  const runs = A.st.runs;
  if (!runs.length) { root.append(h('div', { class: 'panel empty' }, 'No runs yet.')); return; }
  if (!A.logRunId || !runs.find((r) => r.id === A.logRunId)) A.logRunId = runs[0].id;
  const list = h('div', { class: 'runlist' });
  runs.forEach((r) => list.append(h('button', { class: 'run', 'aria-current': String(r.id === A.logRunId), onclick: () => { A.logRunId = r.id; A.logData = null; A.logTab = 'console'; render(); } },
    h('div', { class: 't' }, h('b', null, r.kind === 'detect' ? 'Detection' : 'Calibration'), h('span', { class: 'badge ' + r.status }, r.status)), h('small', null, new Date(r.startedAt).toLocaleString()), h('br'),
    h('small', null, r.summary ? (r.kind === 'detect' ? `avg difficulty ${r.summary.avgDifficulty}${r.summary.gap != null ? ' · gap ' + r.summary.gap : ''}` : `gap ${r.summary.before} → ${r.summary.after}`) : r.id))));
  const pane = h('div'); root.append(h('div', { class: 'runs' }, list, pane));
  const r = runs.find((x) => x.id === A.logRunId), tabs = [['console', 'Console'], ['attempts', 'Attempts'], ['settings', 'Settings'], ['report', 'Report']];
  pane.append(h('div', { class: 'row' }, h('div', { class: 'seg' }, tabs.filter(([k]) => k !== 'attempts' && k !== 'report' || r.kind === 'detect').map(([k, l]) => h('button', { 'aria-selected': String(A.logTab === k), onclick: () => { A.logTab = k; render(); } }, l))), h('span', { class: 'grow' }), h('button', { class: 'ghost danger', onclick: async () => { if (confirm('Delete this run and its logs?')) { await api('/api/runs/' + r.id, { method: 'DELETE' }); await refresh(); await loadDetect(); render(); } } }, 'Delete')));
  const body = h('div', { style: 'margin-top:10px' }); pane.append(body);
  if (A.logTab === 'console') { const pre = h('pre', { class: 'log' }, 'loading…'); body.append(pre); fetch('/api/jobs/' + r.id + '/stream').then(async (res) => { const t = await res.text(); pre.textContent = t.split('\n').filter((l) => l.startsWith('data: ')).map((l) => JSON.parse(l.slice(6))).join('\n') || '(empty)'; }); }
  if (A.logTab === 'settings') { api('/api/runs/' + r.id).then((d) => { body.append(h('pre', { class: 'log' }, JSON.stringify({ options: d.meta.options, summary: d.meta.summary, status: d.meta.status, startedAt: d.meta.startedAt, endedAt: d.meta.endedAt }, null, 2)), d.targets ? h('details', null, h('summary', null, 'Target file used by this run'), h('pre', { class: 'log' }, JSON.stringify(d.targets, null, 2))) : null); }); }
  if (A.logTab === 'report' && r.kind === 'detect') body.append(h('iframe', { class: 'rep', src: '/run/' + r.id + '/report.html', title: 'Full report' }));
  if (A.logTab === 'attempts' && r.kind === 'detect') attemptsView(body, r);
}
function attemptsView(body, r) {
  const f = A.attFilter = A.attFilter || { persona: '', stage: '', result: '' };
  const pers = r.options.personas;
  const bar = h('div', { class: 'row' },
    h('select', { onchange: (e) => { f.persona = e.target.value; render(); } }, h('option', { value: '' }, 'all bots'), pers.map((p) => h('option', { value: p, selected: f.persona === p }, p))),
    h('input', { type: 'text', placeholder: 'stage id', value: f.stage, style: 'width:110px', onchange: (e) => { f.stage = e.target.value.trim(); render(); } }),
    h('select', { onchange: (e) => { f.result = e.target.value; render(); } }, [['', 'any result'], ['win', 'wins'], ['loss', 'losses'], ['stall', 'quit (gave up)']].map(([v, l]) => h('option', { value: v, selected: f.result === v }, l))));
  const out = h('div', { class: 'stack' }); body.append(bar, out);
  const q = new URLSearchParams({ persona: f.persona, stage: f.stage, result: f.result, limit: 300 });
  const rp = h('pre', { class: 'log', hidden: true });
  api('/api/runs/' + r.id + '/attempts?' + q).then((rows) => {
    out.append(h('p', { class: 'hint' }, `${rows.length}${rows.length >= 300 ? '+' : ''} attempts shown.`),
      h('div', { class: 'tablewrap' }, h('table', null, h('thead', null, h('tr', null, ['Bot', 'Stage', 'Run', 'Attempt', 'Result', 'HP / moves left', 'Time', 'Income', ''].map((t, i) => h('th', { class: i === 0 || i === 8 ? 'l' : '' }, t)))),
        h('tbody', null, rows.map((a) => h('tr', { style: 'cursor:default' }, h('td', null, a.persona), h('td', null, a.stage), h('td', null, a.run), h('td', null, a.attempt), h('td', null, a.type === 'stall' ? 'gave up' : a.win ? 'win' : 'loss'), h('td', null, a.hpLeft == null ? '-' : `${num(a.hpLeft)} / ${num(a.hpMax)}`), h('td', null, num(a.time, 1)), h('td', null, num(a.income)), h('td', { class: 'l' }, a.type === 'stall' ? '' : h('button', { class: 'ghost', onclick: async () => { rp.hidden = false; rp.textContent = 'replaying…'; rp.textContent = await (await fetch(`/api/runs/${r.id}/replay?persona=${a.persona}&stage=${a.stage}&run=${a.run}`)).text(); rp.scrollIntoView({ block: 'nearest' }); } }, 'Replay'))))))),
      h('p', { class: 'hint' }, 'Replay re-simulates that exact run (same seed) and prints it as a timeline: every hit, kill, drop and purchase.'), rp);
  });
}

// ---------- main render ----------
async function render() {
  renderTabs(); renderPill();
  const root = $('#view'); root.textContent = '';
  if (!A.st) return;
  try {
    if (A.tab === 'detect') { if (A.det === null) await loadDetect(); viewDetect(root); }
    else if (A.tab === 'target') { if (A.det === null) await loadDetect(); viewTarget(root); }
    else if (A.tab === 'calibrate') { if (!A.calib) await loadCalib(); viewCalibrate(root); }
    else viewLogs(root);
  } catch (e) { root.append(h('div', { class: 'note bad' }, String(e.message || e))); }
}
// poll while a job runs; when it ends reload the data and redraw
async function tick() {
  try {
    const prev = A.st && A.st.job;
    await refresh();
    const j = A.st.job;
    if (j && j.status === 'running') {
      if (!A.es || A.jobWas !== j.id) { watchJob(j.id); A.jobWas = j.id; }
      if (A.tab === 'calibrate' && j.kind === 'calibrate') { A.calibRunId = j.id; A.calib = await api('/api/runs/' + j.id); render(); }
    } else if (prev && prev.status === 'running' || (A.jobWas && !(j && j.status === 'running'))) {
      const done = A.jobWas; A.jobWas = null;
      if (done) { A.det = null; if (done.startsWith('calibrate')) { A.calib = null; A.calibRunId = done; } render(); }
    }
  } catch (e) { /* server restarting */ }
}
let theme = 'auto';
try { theme = localStorage.getItem('bs-theme') || 'auto'; } catch (e) { /* blocked */ }
const applyTheme = () => { if (theme === 'auto') document.documentElement.removeAttribute('data-theme'); else document.documentElement.setAttribute('data-theme', theme); $('#theme').textContent = 'Theme: ' + theme; };
$('#theme').addEventListener('click', () => { theme = theme === 'auto' ? 'dark' : theme === 'dark' ? 'light' : 'auto'; try { localStorage.setItem('bs-theme', theme); } catch (e) { /* ignore */ } applyTheme(); });
$('#dclose').addEventListener('click', () => toggleConsole(false));
applyTheme();
const h0 = location.hash.slice(1); if (TABS.some(([k]) => k === h0)) A.tab = h0;
refresh().then(async () => { if (A.st.job && A.st.job.status === 'running') { A.jobWas = A.st.job.id; watchJob(A.st.job.id); } await render(); setInterval(tick, 2000); });
})();
