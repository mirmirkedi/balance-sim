(function () {
'use strict';
const D = JSON.parse(document.getElementById('d').textContent);
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
const pct = (x) => x == null ? '-' : Math.round(x * 100) + '%';
const num = (x, d) => x == null ? '-' : Number(x).toFixed(d || 0);
const sgn = (x) => (x > 0 ? '+' : x < 0 ? '−' : '') + Math.abs(x);
const tp = D.tp, S = D.stages, n = S.length;
const personaColor = (p) => ({ random: 'var(--c-random)', novice: 'var(--c-novice)', smart: 'var(--c-smart)', optimizer: 'var(--c-optimizer)', oracle: 'var(--c-oracle)' }[p] || 'var(--c-other)');

// ---------- what every flag means (also the glossary) ----------
const FLAGS = {
  BROKEN: ['bad', 'The simulation had errors or timeouts here.', 'Replay it (--replay) to see where it gets stuck, then fix the adapter or the rule.'],
  TOO_HARD: ['bad', 'Much harder than the target: the whole 95% range is below the band.', 'Lower enemy HP or damage for this stage, or give the player something stronger just before it.'],
  TOO_EASY: ['bad', 'Much easier than the target: the whole 95% range is above the band.', 'Raise enemy HP or damage for this stage, or cut what makes the player stronger just before it.'],
  '?HARD': ['warn', 'Probably harder than the target, but the 95% range still touches the band.', 'Run more simulations (--runs 300) before changing numbers.'],
  '?EASY': ['warn', 'Probably easier than the target, but the 95% range still touches the band.', 'Run more simulations (--runs 300) before changing numbers.'],
  WALL: ['bad', 'Too many players fail every retry here and quit. In a campaign this is where the funnel breaks.', 'Ease the stage a little, or let a failed attempt make the player stronger (gold, drops, a hint, a shop item).'],
  SPIKE: ['bad', 'Much harder than the three stages before it, and it is not a boss.', 'Smooth the step with the per-stage multiplier, or move some difficulty to the neighbours.'],
  DIP: ['warn', 'Much easier than the stages before it, so tension drops.', 'Raise it, or make it a deliberate rest stage with a reward.'],
  SLOW: ['warn', 'Takes longer than the target time.', 'Lower enemy HP or add faster tools.'],
  FAST: ['info', 'Finished faster than the target time.', 'Fine if the stage is meant to be a breather. Otherwise raise enemy HP.'],
  DEATHY: ['warn', 'More failed attempts than the target allows.', 'Ease the stage or give earlier stages more reward.'],
  INCOME_LOW: ['warn', 'The player earns less here than the target, so the shop falls behind.', 'Raise the gold reward of this stage.'],
  INCOME_HIGH: ['warn', 'The player earns more here than the target, so money piles up.', 'Lower the gold reward or add a sink the player wants.'],
  RANDOM_WINS: ['warn', 'A random player wins often on a stage that should challenge.', 'Make bad choices cost more, or check the stage really needs the mechanic.'],
  BOT_LOST: ['info', 'Both the smart and the random bot almost never win here, so this stage says nothing about skill: the bots are lost, not necessarily the stage.', 'Use an exact solver (oracle persona) to check it is solvable and how much slack the limit leaves, or a real playtest.'],
  NO_SKILL: ['warn', 'Smart and random players win about equally: skill barely matters here.', 'Add a decision that matters, or tighten the budget.'],
  POLICY_GAP: ['info', 'The optimizer wins much more than the smart bot: the smart policy may be weak, or the game has a hidden strong move.', 'Replay the optimizer and teach the smart policy that move.'],
  COINFLIP: ['warn', 'Wins are decided by a sliver of HP, which feels random.', 'Widen the margin: clearly winnable with good play, or clearly not.'],
  LOW_N: ['info', 'Fewer than 20 players reached this stage, so the numbers are noisy.', 'Run more simulations, or raise --retries so more players get here.'],
};
const sev = (f) => FLAGS[f] ? FLAGS[f][0] : 'info';
const serious = (st) => st.flags.some((f) => sev(f) === 'bad' || (sev(f) === 'warn' && !f.startsWith('?')));
const hard = (st) => st.flags.some((f) => sev(f) === 'bad');
const flagEl = (f) => h('span', { class: 'flag ' + sev(f), title: FLAGS[f] ? FLAGS[f][1] : f }, f);

// ---------- numbers ----------
const me = (st) => st.p[tp];
const delta = (st) => (me(st) && st.target.win != null) ? Math.round((me(st).win - st.target.win) * 100) : null;
const inBand = (st) => { const d = delta(st); return d != null && Math.abs(d) <= Math.round(D.tol * 100); };
const withTarget = S.filter((st) => delta(st) != null);

const METRICS = [
  { k: 'win', label: 'First-try win', fmt: pct, target: true },
  { k: 'tries', label: 'Attempts', fmt: (v) => num(v, 1) },
  { k: 'time', label: 'Time', fmt: (v) => num(v) + 's', target: true },
  { k: 'deaths', label: 'Deaths', fmt: (v) => num(v, 2), target: true },
  { k: 'income', label: 'Income', fmt: (v) => num(v), target: true },
];
if (D.camp) METRICS.push({ k: 'reach', label: 'Players reaching', fmt: pct });
const val = (st, p, k) => k === 'reach' ? st.reach[p] : (st.p[p] ? st.p[p][k] : null);

// ---------- state ----------
const state = { metric: 'win', hidden: new Set(), sel: null, filter: 'all', sort: { k: 'idx', dir: 1 }, hover: null };
const hashStage = () => { const m = /stage=([^&]+)/.exec(location.hash); return m ? S.findIndex((st) => st.id === decodeURIComponent(m[1])) : -1; };

// ---------- header and summary cards ----------
$('#sub').textContent = `Target persona: ${tp}. Band: target ± ${Math.round(D.tol * 100)} points. ${n} stages, ${me(S[0]) ? me(S[0]).n : '?'} players per stage, ${D.camp ? 'campaign mode (one player lives through every stage)' : 'independent runs per stage'}. Made ${D.generated}.`;
function cards() {
  const out = [];
  if (withTarget.length) {
    const gap = withTarget.reduce((a, st) => a + Math.abs(delta(st)), 0) / withTarget.length;
    out.push(['Gap to target', gap.toFixed(1) + ' pts', 'mean win-rate distance', gap <= 8 ? 'good' : gap <= 15 ? 'warn' : 'bad']);
    const ib = withTarget.filter(inBand).length;
    out.push(['Inside the band', `${ib} / ${withTarget.length}`, 'stages', ib / withTarget.length >= 0.8 ? 'good' : ib / withTarget.length >= 0.5 ? 'warn' : 'bad']);
  }
  const bad = S.filter(hard).length;
  out.push(['Serious flags', String(bad), bad ? 'stages need a change' : 'nothing serious', bad === 0 ? 'good' : bad <= 3 ? 'warn' : 'bad']);
  if (D.camp) {
    const last = [...S].reverse().find((st) => st.reach[tp] != null);
    if (last) {
      let worst = null, wd = 0;
      for (let i = 1; i < S.length; i++) { const a = S[i - 1].reach[tp], b = S[i].reach[tp]; if (a != null && b != null && a - b > wd) { wd = a - b; worst = S[i].id; } }
      out.push(['Reach the end', pct(last.reach[tp]), worst ? `biggest drop at stage ${worst}` : 'of players', last.reach[tp] >= 0.3 ? 'good' : last.reach[tp] >= 0.1 ? 'warn' : 'bad']);
    }
  }
  const gaps = S.filter((st) => st.p.random && me(st)).map((st) => me(st).win - st.p.random.win);
  if (gaps.length) { const g = gaps.reduce((a, b) => a + b, 0) / gaps.length; out.push(['Skill depth', pct(g), 'smart minus random', g >= 0.25 ? 'good' : g >= 0.12 ? 'warn' : 'bad']); }
  const mc = S.filter((st) => st.p.novice && me(st)).map((st) => me(st).win - st.p.novice.win);
  if (mc.length) { const g = mc.reduce((a, b) => a + b, 0) / mc.length; out.push(['Mistake cost', pct(g), 'smart minus novice', 'info']); }
  const box = $('#cards');
  out.forEach(([t, v, s, cls]) => box.append(h('div', { class: 'card ' + cls }, h('span', null, t), h('b', null, v), h('em', null, s))));
}
cards();

// ---------- look here first ----------
function worstList() {
  const box = $('#worst');
  const rank = S.map((st, i) => ({ st, i, score: (delta(st) == null ? 0 : Math.abs(delta(st))) + (hard(st) ? 15 : 0) + (serious(st) ? 5 : 0) }))
    .filter((r) => r.score > 0 && (hard(r.st) || (delta(r.st) != null && !inBand(r.st)))).sort((a, b) => b.score - a.score).slice(0, 8);
  if (!rank.length) { box.append(h('span', { class: 'hint' }, 'Every stage is inside the band and nothing serious is flagged.')); return; }
  rank.forEach(({ st, i }) => {
    const d = delta(st);
    box.append(h('button', { class: 'chip', type: 'button', onclick: () => select(i, true) },
      'Stage ' + st.id, d != null ? h('span', { class: 'pts' }, sgn(d) + ' pts') : null, st.flags.filter((f) => f !== 'LOW_N' && !f.startsWith('?')).slice(0, 2).map(flagEl)));
  });
}
worstList();
if (D.camp) {
  // the funnel is only meaningful with campaign data
}

// ---------- chart ----------
let W = 760, H = 330, pw = 0, ph = 0;
const L = 48, R = 14, T = 14, B = 34;
function geom() { const w = ($('#chartwrap').clientWidth || 760) - 16; W = Math.max(300, w); H = Math.round(Math.min(360, Math.max(230, W * 0.46))); pw = W - L - R; ph = H - T - B; }
const xs = (i) => L + (n > 1 ? pw * i / (n - 1) : pw / 2);
function domainMax(k) {
  if (k === 'win' || k === 'reach') return 1;
  let m = 0;
  for (const st of S) { for (const p of D.personas) if (!state.hidden.has(p)) m = Math.max(m, val(st, p, k) || 0); m = Math.max(m, st.target[k] || 0); }
  return m > 0 ? m * 1.1 : 1;
}
function drawChart() {
  geom();
  const m = METRICS.find((x) => x.k === state.metric), top = domainMax(m.k), ys = (v) => T + ph * (1 - Math.min(1, Math.max(0, v / top)));
  let g = '';
  for (let t = 0; t <= 4; t++) { const v = top * t / 4, y = ys(v); g += `<line x1="${L}" x2="${W - R}" y1="${y}" y2="${y}" stroke="var(--line)"/><text x="${L - 7}" y="${y + 4}" text-anchor="end" class="ax">${esc(m.fmt(v))}</text>`; }
  const step = Math.max(1, Math.ceil(n / Math.max(4, Math.floor(pw / 30))));
  S.forEach((st, i) => { if (st.boss) g += `<path d="M${xs(i)},${T + ph + 3} l4,5 l-8,0 z" fill="var(--mut)"/>`; if (i % step === 0 || i === n - 1) g += `<text x="${xs(i)}" y="${H - 8}" text-anchor="middle" class="ax" ${st.boss ? 'font-weight="700"' : ''}>${esc(st.id)}</text>`; });
  if (m.k === 'win' && withTarget.length) {
    const up = S.map((st, i) => st.target.win == null ? null : `${xs(i).toFixed(1)},${ys(Math.min(1, st.target.win + D.tol)).toFixed(1)}`).filter(Boolean);
    const dn = S.map((st, i) => st.target.win == null ? null : `${xs(i).toFixed(1)},${ys(Math.max(0, st.target.win - D.tol)).toFixed(1)}`).filter(Boolean).reverse();
    g += `<polygon points="${up.concat(dn).join(' ')}" fill="var(--band)"/>`;
  }
  if (state.sel != null) g += `<line x1="${xs(state.sel)}" x2="${xs(state.sel)}" y1="${T}" y2="${T + ph}" stroke="var(--accent)" stroke-width="2" opacity=".5"/>`;
  if (m.k === 'win' && !state.hidden.has(tp)) S.forEach((st, i) => { const q = me(st); if (q) g += `<line x1="${xs(i)}" x2="${xs(i)}" y1="${ys(q.lo)}" y2="${ys(q.hi)}" stroke="${personaColor(tp)}" stroke-width="2" opacity=".28"/>`; });
  const path = (get) => { let d = '', pen = false; S.forEach((st, i) => { const v = get(st); if (v == null) { pen = false; return; } d += `${pen ? 'L' : 'M'}${xs(i).toFixed(1)},${ys(v).toFixed(1)}`; pen = true; }); return d; };
  D.personas.filter((p) => !state.hidden.has(p)).forEach((p) => { g += `<path d="${path((st) => val(st, p, m.k))}" fill="none" stroke="${personaColor(p)}" stroke-width="${p === tp ? 3 : 1.6}" stroke-linejoin="round" opacity="${p === tp ? 1 : .85}"/>`; });
  if (m.target && S.some((st) => st.target[m.k] != null)) g += `<path d="${path((st) => st.target[m.k])}" fill="none" stroke="var(--fg)" stroke-width="1.5" stroke-dasharray="5 4"/>`;
  if (!state.hidden.has(tp)) S.forEach((st, i) => { const v = val(st, tp, m.k); if (v != null && st.flags.some((f) => sev(f) === 'bad')) g += `<circle cx="${xs(i)}" cy="${ys(v)}" r="6" fill="none" stroke="var(--bad)" stroke-width="2"/>`; });
  if (state.hover != null) { const i = state.hover; g += `<line x1="${xs(i)}" x2="${xs(i)}" y1="${T}" y2="${T + ph}" stroke="var(--mut)" stroke-dasharray="3 3"/>`; D.personas.filter((p) => !state.hidden.has(p)).forEach((p) => { const v = val(S[i], p, m.k); if (v != null) g += `<circle cx="${xs(i)}" cy="${ys(v)}" r="4" fill="${personaColor(p)}"/>`; }); }
  const svg = $('#chart');
  svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
  svg.innerHTML = g;
}
function tipFor(i, px) {
  const m = METRICS.find((x) => x.k === state.metric), st = S[i], tip = $('#tip');
  let html = `<b>Stage ${esc(st.id)}${st.boss ? ' (boss)' : ''}</b>`;
  D.personas.filter((p) => !state.hidden.has(p)).forEach((p) => { html += `<div><span><i style="background:${personaColor(p)}"></i>${esc(p)}</span><span>${esc(m.fmt(val(st, p, m.k)))}</span></div>`; });
  if (m.target && st.target[m.k] != null) html += `<div><span>target</span><span>${esc(m.fmt(st.target[m.k]))}</span></div>`;
  const fl = st.flags.filter((f) => f !== 'LOW_N');
  if (fl.length) html += `<div style="color:var(--bad)"><span>${esc(fl.join(' '))}</span></div>`;
  tip.innerHTML = html; tip.hidden = false;
  const wrap = $('#chartwrap').getBoundingClientRect(), tw = tip.offsetWidth;
  let left = px + 14; if (left + tw > wrap.width - 6) left = px - tw - 14;
  tip.style.left = Math.max(6, left) + 'px'; tip.style.top = '12px';
}
function idxAt(clientX) {
  const r = $('#chart').getBoundingClientRect(), x = (clientX - r.left) / r.width * W;
  return Math.max(0, Math.min(n - 1, Math.round((x - L) / (pw / Math.max(1, n - 1)))));
}
const svgEl = $('#chart');
svgEl.setAttribute('tabindex', '0');
svgEl.addEventListener('pointermove', (e) => { const i = idxAt(e.clientX); if (i !== state.hover) { state.hover = i; drawChart(); } tipFor(i, e.clientX - $('#chartwrap').getBoundingClientRect().left); });
svgEl.addEventListener('pointerleave', () => { state.hover = null; $('#tip').hidden = true; drawChart(); });
svgEl.addEventListener('click', (e) => select(idxAt(e.clientX), false));
svgEl.addEventListener('keydown', (e) => {
  if (e.key === 'ArrowRight') { select(Math.min(n - 1, (state.sel == null ? -1 : state.sel) + 1), false); e.preventDefault(); }
  if (e.key === 'ArrowLeft') { select(Math.max(0, (state.sel == null ? n : state.sel) - 1), false); e.preventDefault(); }
});

function controls() {
  const seg = $('#metrics');
  METRICS.forEach((m) => seg.append(h('button', { type: 'button', role: 'tab', 'aria-selected': String(m.k === state.metric), onclick: (e) => { state.metric = m.k; [...seg.children].forEach((b) => b.setAttribute('aria-selected', String(b === e.currentTarget))); drawChart(); } }, m.label)));
  const box = $('#personas');
  D.personas.forEach((p) => {
    const b = h('button', { type: 'button', class: 'chip', 'aria-pressed': 'true', onclick: () => { state.hidden.has(p) ? state.hidden.delete(p) : state.hidden.add(p); b.setAttribute('aria-pressed', String(!state.hidden.has(p))); drawChart(); } },
      h('i', { style: 'background:' + personaColor(p) }), p + (p === tp ? ' (target persona)' : ''));
    box.append(b);
  });
  box.append(h('span', { class: 'chip', style: 'border-style:dashed' }, h('i', { style: 'background:var(--fg)' }), 'target'));
}
controls();

// ---------- detail panel ----------
function bar(p, st) {
  const v = st.p[p] ? st.p[p].win : null;
  return h('div', { class: 'pb' }, h('span', null, p), h('div', { class: 'track' }, v != null ? h('div', { class: 'fill', style: `width:${Math.round(v * 100)}%;background:${personaColor(p)}` }) : null, p === tp && st.target.win != null ? h('div', { class: 'tmark', style: `left:${Math.round(st.target.win * 100)}%`, title: 'target' }) : null), h('span', { class: 'v' }, pct(v)));
}
function detail() {
  const box = $('#detail');
  box.textContent = '';
  if (state.sel == null) { box.append(h('p', { class: 'empty' }, 'Click a stage in the chart or the table and it is explained here in plain words.')); return; }
  const st = S[state.sel], q = me(st), tg = st.target, d = delta(st);
  box.append(h('h3', null, `Stage ${st.id}${st.boss ? ' (boss)' : ''}`));
  if (!q) { box.append(h('p', null, `No ${tp} players reached this stage.`)); return; }
  let verdict, cls = 'good';
  if (d == null) { verdict = 'There is no target for this stage.'; cls = 'warn'; }
  else if (Math.abs(d) <= Math.round(D.tol * 100)) verdict = `That is ${Math.abs(d)} points ${d >= 0 ? 'above' : 'below'} the target, so it is inside the band.`;
  else { cls = Math.abs(d) > 25 ? 'bad' : 'warn'; verdict = `That is ${Math.abs(d)} points ${d > 0 ? 'above the target: too easy' : 'below the target: too hard'}.`; }
  box.append(h('p', null, `${tp} clears this stage on the first try ${pct(q.win)} of the time (95% range ${pct(q.lo)} to ${pct(q.hi)}, ${q.n} players). `, tg.win != null ? `The target is ${pct(tg.win)} ± ${Math.round(D.tol * 100)}. ` : '', h('span', { class: 'verdict ' + cls }, verdict)));
  box.append(h('div', { class: 'pbars' }, D.personas.map((p) => bar(p, st))));
  const bits = [];
  if (D.camp) bits.push(`Players needed ${num(q.tries, 1)} attempts on average; ${pct(q.stall)} never cleared it and quit.`, st.reach[tp] != null ? `${pct(st.reach[tp])} of all ${tp} players reached this stage.` : null);
  else bits.push(`A player needs about ${num(q.tries, 1)} attempts to clear it.`);
  bits.push(`Average time ${num(q.time)}s${tg.time != null ? ` (target ${num(tg.time)}s)` : ''}, deaths ${num(q.deaths, 2)}${tg.deaths != null ? ` (target ${num(tg.deaths, 2)})` : ''}, income ${num(q.income)}${tg.income != null ? ` (target ${num(tg.income)})` : ''}.`);
  if (q.bank != null) bits.push(`Gold in the bank when leaving it: ${num(q.bank)}.`);
  box.append(h('p', null, bits.filter(Boolean).join(' ')));
  const r = st.p.random, sm = st.p.smart || q;
  if (r && sm) { const g = sm.win - r.win; box.append(h('p', null, g < 0.1 ? `A random player wins almost as often as a smart one (${pct(r.win)} vs ${pct(sm.win)}): choices barely matter here.` : `Choices matter here: smart beats random by ${Math.round(g * 100)} points.`)); }
  const fl = st.flags;
  if (!fl.length) box.append(h('div', { class: 'fx info' }, h('b', null, 'No flags.'), ' Nothing to change in this stage.'));
  fl.forEach((f) => { const x = FLAGS[f] || ['info', f, '']; box.append(h('div', { class: 'fx ' + x[0] }, flagEl(f), ' ', x[1], x[2] ? h('div', { class: 'try' }, 'What to try: ' + x[2]) : null)); });
  box.append(h('div', { class: 'nav' },
    h('button', { class: 'ghost', type: 'button', onclick: () => select(Math.max(0, state.sel - 1), false), disabled: state.sel === 0 }, '← previous'),
    h('button', { class: 'ghost', type: 'button', onclick: () => select(Math.min(n - 1, state.sel + 1), false), disabled: state.sel === n - 1 }, 'next →'),
    h('button', { class: 'ghost', type: 'button', onclick: () => { state.sel = null; history.replaceState(null, '', location.pathname); redraw(); } }, 'close')));
}

// ---------- table ----------
const COLS = [{ k: 'idx', t: 'stage', get: (st) => st.idx }]
  .concat(D.personas.map((p) => ({ k: 'p:' + p, t: p, get: (st) => val(st, p, 'win') })))
  .concat([{ k: 'target', t: 'target', get: (st) => st.target.win }, { k: 'delta', t: 'Δ pts', get: (st) => delta(st) }, { k: 'ci', t: '95% CI', get: (st) => me(st) ? me(st).lo : null }, { k: 'tries', t: 'tries', get: (st) => val(st, tp, 'tries') }]);
if (D.camp) COLS.push({ k: 'reach', t: 'reach', get: (st) => val(st, tp, 'reach') });
COLS.push({ k: 'time', t: 'time', get: (st) => val(st, tp, 'time') }, { k: 'income', t: 'income', get: (st) => val(st, tp, 'income') }, { k: 'flags', t: 'flags', get: (st) => st.flags.filter((f) => f !== 'LOW_N').length });
const FILTERS = [
  ['all', 'All', () => true],
  ['flag', 'Flagged', serious],
  ['hard', 'Too hard', (st) => st.flags.some((f) => ['TOO_HARD', '?HARD', 'WALL', 'SPIKE', 'DEATHY', 'SLOW'].includes(f))],
  ['easy', 'Too easy', (st) => st.flags.some((f) => ['TOO_EASY', '?EASY', 'DIP', 'RANDOM_WINS', 'FAST'].includes(f))],
  ['runs', 'Needs more runs', (st) => st.flags.some((f) => f === 'LOW_N' || f.startsWith('?'))],
];
function cell(c, st) {
  const v = c.get(st);
  switch (c.k) {
    case 'idx': return h('td', null, st.id + (st.boss ? ' ★' : ''));
    case 'target': return h('td', null, pct(v));
    case 'delta': { const inb = v != null && Math.abs(v) <= Math.round(D.tol * 100); return h('td', { class: v == null ? '' : inb ? 'in' : 'out' }, v == null ? '-' : sgn(v)); }
    case 'ci': return h('td', null, me(st) ? `${Math.round(me(st).lo * 100)}-${Math.round(me(st).hi * 100)}` : '-');
    case 'tries': return h('td', null, num(v, 1));
    case 'reach': return h('td', null, pct(v));
    case 'time': case 'income': return h('td', null, num(v));
    case 'flags': return h('td', { class: 'fl' }, st.flags.map(flagEl));
    default: return h('td', v == null ? { title: 'no player of this persona reached this stage' } : null, pct(v));
  }
}
function table() {
  const t = $('#table'), f = FILTERS.find((x) => x[0] === state.filter)[2], col = COLS.find((c) => c.k === state.sort.k);
  const rows = S.filter(f).sort((a, b) => { const x = col.get(a), y = col.get(b); if (x == null && y == null) return a.idx - b.idx; if (x == null) return 1; if (y == null) return -1; return (x - y) * state.sort.dir || a.idx - b.idx; });
  t.textContent = '';
  t.append(h('thead', null, h('tr', null, COLS.map((c) => h('th', { 'aria-sort': state.sort.k === c.k ? (state.sort.dir > 0 ? 'ascending' : 'descending') : 'none', onclick: () => { state.sort = { k: c.k, dir: state.sort.k === c.k ? -state.sort.dir : 1 }; table(); } }, c.t)))));
  t.append(h('tbody', null, rows.map((st) => { const tr = h('tr', { class: state.sel === st.idx ? 'sel' : '', onclick: () => select(st.idx, true) }, COLS.map((c) => cell(c, st))); return tr; })));
  if (!rows.length) t.append(h('tbody', null, h('tr', null, h('td', { colspan: COLS.length, style: 'text-align:left' }, 'No stage matches this filter.'))));
}
function filters() {
  const seg = $('#filters');
  FILTERS.forEach(([k, label, fn]) => seg.append(h('button', { type: 'button', 'aria-selected': String(k === state.filter), onclick: (e) => { state.filter = k; [...seg.children].forEach((b) => b.setAttribute('aria-selected', String(b === e.currentTarget))); table(); } }, `${label} (${S.filter(fn).length})`)));
}
filters();

// ---------- glossary, copy, theme ----------
Object.entries(FLAGS).forEach(([k, v]) => { $('#glossary').append(h('dt', null, flagEl(k)), h('dd', null, v[1] + ' ' + v[2])); });
$('#copy').addEventListener('click', () => {
  const lines = S.filter(serious).map((st) => `Stage ${st.id}: ${tp} ${pct(me(st) && me(st).win)} vs target ${pct(st.target.win)}${delta(st) != null ? ' (' + sgn(delta(st)) + ' pts)' : ''}, ${st.flags.filter((f) => f !== 'LOW_N').join(' ')}`);
  const text = `Balance report, target persona ${tp}\n` + (lines.join('\n') || 'No flagged stages.');
  const done = () => { $('#copied').textContent = 'Copied.'; setTimeout(() => { $('#copied').textContent = ''; }, 2000); };
  if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(text).then(done, () => { $('#copied').textContent = 'Copy is blocked here; select the table instead.'; });
  else { const ta = h('textarea', { style: 'position:fixed;opacity:0' }); ta.value = text; document.body.append(ta); ta.select(); try { document.execCommand('copy'); done(); } catch (e) { /* ignore */ } ta.remove(); }
});
let theme = 'auto';
try { theme = localStorage.getItem('bs-theme') || 'auto'; } catch (e) { /* storage may be blocked */ }
const applyTheme = () => { if (theme === 'auto') document.documentElement.removeAttribute('data-theme'); else document.documentElement.setAttribute('data-theme', theme); $('#theme').textContent = 'Theme: ' + theme; };
$('#theme').addEventListener('click', () => { theme = theme === 'auto' ? 'dark' : theme === 'dark' ? 'light' : 'auto'; try { localStorage.setItem('bs-theme', theme); } catch (e) { /* ignore */ } applyTheme(); });
applyTheme();

// ---------- selection ----------
function redraw() { drawChart(); detail(); table(); }
function select(i, scroll) {
  state.sel = i;
  try { history.replaceState(null, '', '#stage=' + encodeURIComponent(S[i].id)); } catch (e) { /* file:// may refuse */ }
  redraw();
  if (scroll) $('#detail').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}
const h0 = hashStage();
if (h0 >= 0) state.sel = h0;
else { const w = S.map((st, i) => [st, i]).filter(([st]) => hard(st)).sort((a, b) => Math.abs(delta(b[0]) || 0) - Math.abs(delta(a[0]) || 0))[0]; if (w) state.sel = w[1]; }
redraw();
let rz; window.addEventListener('resize', () => { clearTimeout(rz); rz = setTimeout(drawChart, 80); });
})();
