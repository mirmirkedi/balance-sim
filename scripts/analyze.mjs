#!/usr/bin/env node
// balance-sim analyzer: logs -> difficulty curve, target comparison, per-stage verdicts, economy, diff vs previous run.
//
//   node analyze.mjs --logs logs [--targets targets.json] [--out report.json] [--compare old_report.json]
//                    [--details] [--stage 7]
//
// Prints compact tables (never raw logs). Only `end` events are needed for the curve; --details also reads
// the sampled event logs (kill / damage / drop / gain / spend) for TTK, drop rates and faucet/sink.
import fs from 'node:fs';
import path from 'node:path';

const argv = process.argv.slice(2);
const has = (n) => argv.includes('--' + n);
const arg = (n, d) => { const i = argv.indexOf('--' + n); return i < 0 ? d : argv[i + 1]; };
const logDir = arg('logs', 'logs');
const T = fs.existsSync(arg('targets', '')) ? JSON.parse(fs.readFileSync(arg('targets'), 'utf8')) : {};

// ---------- load ----------
const ends = {};      // persona -> stage -> [end events]
const events = {};    // stage -> persona -> [events]
const personaOrder = ['random', 'novice', 'smart', 'optimizer'];
const stageOrder = [];
for (const f of fs.readdirSync(logDir).filter((x) => x.endsWith('.jsonl'))) {
  const persona = f.replace('.jsonl', '');
  for (const line of fs.readFileSync(path.join(logDir, f), 'utf8').split('\n')) {
    if (!line) continue;
    const e = JSON.parse(line), s = String(e.stage);
    if (!stageOrder.includes(s)) stageOrder.push(s);
    if (e.type === 'end') ((ends[persona] ??= {})[s] ??= []).push(e);
    else ((events[s] ??= {})[persona] ??= []).push(e);
  }
}
const rank = (p) => { const i = personaOrder.indexOf(p); return i < 0 ? 99 : i; };
const personas = Object.keys(ends).sort((a, b) => rank(a) - rank(b));
if (!personas.length) { console.error('no logs in ' + logDir); process.exit(1); }

// ---------- settings ----------
const tp = T.targetPersona || (personas.includes('smart') ? 'smart' : personas[personas.length - 1]);
const tol = T.tolerance ?? 0.12;
const spikeT = T.spikeThreshold ?? 0.2;
const skillGapMin = T.skillGapMin ?? 0.15;
const randomWinMax = T.randomWinMax ?? 0.25;
const bosses = new Set((T.bosses || []).map(String));
const n = stageOrder.length;

function targetFor(stage, i) {
  const o = (T.stages || {})[stage] || {};
  if (o.firstTryWin != null) return { ...o, win: o.firstTryWin };
  const c = T.curve;
  if (!c) return { win: null };
  const f = n > 1 ? i / (n - 1) : 0;
  let w = c.start + (c.end - c.start) * (c.shape === 'ease-in' ? f * f : c.shape === 'ease-out' ? 1 - (1 - f) * (1 - f) : f);
  if (bosses.has(stage)) w -= c.bossDrop ?? 0.15;
  return { ...o, win: Math.max(0.02, Math.min(0.99, w)) };
}

// ---------- per stage stats ----------
const avg = (a, f) => a.length ? a.reduce((s, x) => s + (+f(x) || 0), 0) / a.length : 0;
function stats(list) {
  if (!list || !list.length) return null;
  const wins = list.filter((e) => e.win);
  const p = wins.length / list.length;
  return {
    n: list.length, win: p,
    attempts: 1 / Math.max(p, 0.02),                       // expected tries for a player of this skill (geometric)
    time: avg(list, (e) => e.time), deaths: avg(list, (e) => e.deaths ?? (e.win ? 0 : 1)),
    income: avg(list, (e) => e.income), timeout: avg(list, (e) => e.timeout ? 1 : 0),
    errors: list.filter((e) => e.error).length,
    nearMiss: wins.length ? avg(wins, (e) => e.hpMax ? (e.hpLeft / e.hpMax < 0.15 ? 1 : 0) : 0) : 0,
    hpLeft: wins.length ? avg(wins, (e) => e.hpMax ? e.hpLeft / e.hpMax : 0) : 0,
  };
}
const S = {}; // stage -> persona -> stats
for (const s of stageOrder) { S[s] = {}; for (const p of personas) S[s][p] = stats(ends[p]?.[s]); }

// ---------- verdicts ----------
const flags = {};
const difficulty = stageOrder.map((s) => 1 - (S[s][tp]?.win ?? 0));
stageOrder.forEach((s, i) => {
  const f = (flags[s] = []);
  const st = S[s], me = st[tp], tg = targetFor(s, i);
  if (!me) return;
  if (me.errors || me.timeout > 0.2) f.push('BROKEN');
  if (tg.win != null) {
    if (me.win > tg.win + tol) f.push('TOO_EASY');
    else if (me.win < tg.win - tol) f.push('TOO_HARD');
  }
  // spike / dip vs the median of the previous 3 stages (bosses are allowed to be harder)
  if (i >= 3 && !bosses.has(s)) {
    const prev = difficulty.slice(i - 3, i).sort((a, b) => a - b)[1];
    if (difficulty[i] - prev > spikeT) f.push('SPIKE');
    else if (prev - difficulty[i] > spikeT) f.push('DIP');
  }
  const rnd = st.random, smart = st.smart || st[tp];
  if (rnd && rnd.win > randomWinMax) f.push('RANDOM_WINS');
  if (rnd && smart && smart.win - rnd.win < skillGapMin && smart.win < 0.95) f.push('NO_SKILL');
  if (me.win > 0.15 && me.win < 0.85 && me.n >= 20 && me.nearMiss > 0.5) f.push('COINFLIP');
  if (me.n < 20) f.push('LOW_N');
});

// ---------- print ----------
const pc = (x) => x == null ? '  - ' : String(Math.round(x * 100)).padStart(3) + '%';
console.log(`\nbalance-sim report   logs=${logDir}   target persona=${tp}   tolerance=±${Math.round(tol * 100)}%   stages=${n}\n`);
const head = ['stage'.padEnd(7), ...personas.map((p) => p.slice(0, 6).padStart(6)), 'target'.padStart(7), 'delta'.padStart(6), 'tries'.padStart(6), 'time'.padStart(6), 'death'.padStart(6), 'income'.padStart(7), '  flags'];
console.log(head.join(' '));
stageOrder.forEach((s, i) => {
  const me = S[s][tp], tg = targetFor(s, i);
  const d = me && tg.win != null ? Math.round((me.win - tg.win) * 100) : null;
  console.log([
    s.padEnd(7), ...personas.map((p) => pc(S[s][p]?.win).padStart(6)),
    pc(tg.win).padStart(7), (d == null ? '-' : (d > 0 ? '+' : '') + d).padStart(6),
    (me ? me.attempts.toFixed(1) : '-').padStart(6), (me ? me.time.toFixed(0) : '-').padStart(6),
    (me ? me.deaths.toFixed(2) : '-').padStart(6), (me ? me.income.toFixed(0) : '-').padStart(7), '  ' + flags[s].join(' '),
  ].join(' '));
});

console.log(`\nDifficulty curve for "${tp}" (bar = win rate, | = target)`);
stageOrder.forEach((s, i) => {
  const me = S[s][tp]; if (!me) return;
  const tg = targetFor(s, i), W = 40, fill = Math.round(me.win * W), tpos = tg.win != null ? Math.round(tg.win * W) : -1;
  let bar = '';
  for (let k = 0; k < W; k++) bar += k === tpos ? '|' : k < fill ? '█' : '░';
  console.log(s.padEnd(6), bar, pc(me.win), flags[s].length ? ' ' + flags[s].join(' ') : '');
});

// summary: which stages to touch first
const byFlag = (k) => stageOrder.filter((s) => flags[s].includes(k));
console.log('\nSummary');
let anyBad = false;
for (const k of ['BROKEN', 'TOO_HARD', 'TOO_EASY', 'SPIKE', 'DIP', 'RANDOM_WINS', 'NO_SKILL', 'COINFLIP', 'LOW_N'])
  if (byFlag(k).length) { console.log('  ' + k.padEnd(12), byFlag(k).join(', ')); if (k !== 'LOW_N') anyBad = true; }
if (!anyBad) console.log('  all stages inside the target band');
const gaps = stageOrder.map((s) => (S[s].smart && S[s].random) ? S[s].smart.win - S[s].random.win : null).filter((x) => x != null);
if (gaps.length) console.log(`  skill depth (smart - random win rate), mean over stages: ${pc(gaps.reduce((a, b) => a + b, 0) / gaps.length)}   (low = choices do not matter)`);
if (stageOrder.every((s) => S[s].novice && S[s].smart)) {
  const g = stageOrder.map((s) => S[s].smart.win - S[s].novice.win);
  console.log(`  mistake cost (smart - novice), mean: ${pc(g.reduce((a, b) => a + b, 0) / g.length)}`);
}
console.log('  note: bots are not humans. Real playtest or telemetry overrides this report.');

// ---------- details from sampled event logs ----------
function details(only) {
  const rows = {};
  for (const s of stageOrder) {
    if (only && s !== only) continue;
    const evs = events[s]?.[tp] || [];
    const runsSeen = new Set(evs.map((e) => e.run)).size || 1;
    for (const e of evs) {
      const d = e.data || {};
      const key = `${e.type}:${d.kind ?? d.victim ?? d.item ?? d.res ?? d.source ?? ''}`;
      const r = (rows[s] ??= {})[key] ??= { count: 0, sum: 0, runs: runsSeen };
      r.count++; r.sum += +d.amount || 0;
    }
  }
  console.log(`\nEvent summary for "${tp}" (sampled runs; per-run averages)`);
  for (const s of Object.keys(rows)) {
    console.log(' stage ' + s);
    for (const [k, r] of Object.entries(rows[s]).sort())
      console.log('   ' + k.padEnd(28), 'x' + (r.count / r.runs).toFixed(1).padStart(6), r.sum ? ' amount ' + (r.sum / r.runs).toFixed(1) : '');
  }
  const res = {};
  for (const s of stageOrder) for (const e of events[s]?.[tp] || []) {
    if (e.type !== 'gain' && e.type !== 'spend') continue;
    const k = e.data?.res ?? '?'; res[k] ??= { gain: 0, spend: 0 };
    res[k][e.type] += +e.data?.amount || 0;
  }
  if (Object.keys(res).length) {
    console.log('\nEconomy (faucet vs sink, sampled runs): every faucet needs a sink');
    for (const [k, v] of Object.entries(res)) console.log('  ' + k.padEnd(14), 'gain', String(Math.round(v.gain)).padStart(8), ' spend', String(Math.round(v.spend)).padStart(8), ' ratio', v.spend ? (v.gain / v.spend).toFixed(2) : 'inf');
  }
}
if (has('details') || has('stage')) details(arg('stage'));

// ---------- report + compare ----------
const report = { targetPersona: tp, stages: Object.fromEntries(stageOrder.map((s) => [s, { ...S[s], flags: flags[s] }])) };
if (arg('out')) fs.writeFileSync(arg('out'), JSON.stringify(report, null, 1));
if (arg('compare') && fs.existsSync(arg('compare'))) {
  const old = JSON.parse(fs.readFileSync(arg('compare'), 'utf8'));
  console.log(`\nChange vs ${arg('compare')} ("${tp}")`);
  console.log('stage   win%          time      income    flags');
  for (const s of stageOrder) {
    const a = old.stages?.[s]?.[tp], b = S[s][tp]; if (!a || !b) continue;
    const dw = Math.round((b.win - a.win) * 100);
    if (dw === 0 && Math.abs(b.time - a.time) < 1 && Math.abs(b.income - a.income) < 1) continue;
    console.log(s.padEnd(7), `${pc(a.win)}→${pc(b.win)}`.padEnd(13), `${a.time.toFixed(0)}→${b.time.toFixed(0)}`.padEnd(9), `${a.income.toFixed(0)}→${b.income.toFixed(0)}`.padEnd(9), flags[s].join(' '));
  }
}
