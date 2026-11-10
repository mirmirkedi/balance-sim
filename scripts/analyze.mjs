#!/usr/bin/env node
// balance-sim analyzer: logs -> difficulty curve with confidence intervals, target comparison (win, time,
// deaths, income), per-stage verdicts, campaign funnel, economy, calibration against real players,
// diff vs a previous run and an optional self-contained HTML report.
//
//   node analyze.mjs --logs logs [--targets targets.json] [--out report.json] [--compare old_report.json]
//                    [--humans humans.json] [--html report.html] [--details] [--stage 7]
//
// Prints compact tables (never raw logs). Only `end`/`stall` events are needed for the curve; --details also
// reads the sampled event logs (kill / damage / drop / gain / spend) for TTK, drop rates and faucet/sink.
import fs from 'node:fs';
import path from 'node:path';

const argv = process.argv.slice(2);
const has = (n) => argv.includes('--' + n);
const arg = (n, d) => { const i = argv.indexOf('--' + n); return i < 0 ? d : argv[i + 1]; };
const logDir = arg('logs', 'logs');
const readJson = (p) => (p && fs.existsSync(p)) ? JSON.parse(fs.readFileSync(p, 'utf8')) : {};
const T = readJson(arg('targets'));

// ---------- load ----------
const ends = {};      // persona -> stage -> [end events]
const events = {};    // stage -> persona -> [events]
const personaOrder = ['random', 'novice', 'smart', 'optimizer', 'oracle'];
const stageOrder = [];
for (const f of fs.readdirSync(logDir).filter((x) => x.endsWith('.jsonl'))) {
  const persona = f.replace('.jsonl', '');
  for (const line of fs.readFileSync(path.join(logDir, f), 'utf8').split('\n')) {
    if (!line) continue;
    const e = JSON.parse(line), s = String(e.stage);
    if (!stageOrder.includes(s)) stageOrder.push(s);
    if (e.type === 'end') ((ends[persona] ??= {})[s] ??= []).push(e);
    else if (e.type !== 'stall') ((events[s] ??= {})[persona] ??= []).push(e);
  }
}
const rank = (p) => { const i = personaOrder.indexOf(p); return i < 0 ? 99 : i; };
const personas = Object.keys(ends).sort((a, b) => rank(a) - rank(b));
if (!personas.length) { console.error('no logs in ' + logDir); process.exit(1); }

// ---------- settings ----------
const tp = T.targetPersona || (personas.includes('smart') ? 'smart' : personas[personas.length - 1]);
const tol = T.tolerance ?? 0.12;               // win rate band (absolute)
const mtol = T.metricTolerance ?? 0.3;         // time / deaths / income band (relative)
const spikeT = T.spikeThreshold ?? 0.2;
const skillGapMin = T.skillGapMin ?? 0.15;
const randomWinMax = T.randomWinMax ?? 0.25;
const stallMax = T.stallMax ?? 0.1;            // campaign: share of players allowed to quit on one stage
const policyGapMax = T.policyGapMax ?? 0.2;    // optimizer - smart
const bosses = new Set((T.bosses || []).map(String));
const n = stageOrder.length;

const curveAt = (c, f) => c.start + (c.end - c.start) * (c.shape === 'ease-in' ? f * f : c.shape === 'ease-out' ? 1 - (1 - f) * (1 - f) : f);
function targetFor(stage, i) {
  const o = (T.stages || {})[stage] || {};
  const f = n > 1 ? i / (n - 1) : 0, boss = bosses.has(stage);
  const out = { win: null, time: null, deaths: null, income: null };
  if (o.firstTryWin != null) out.win = o.firstTryWin;
  else if (T.curve) out.win = Math.max(0.02, Math.min(0.99, curveAt(T.curve, f) - (boss ? (T.curve.bossDrop ?? 0.15) : 0)));
  const m = (key, curve) => o[key] != null ? o[key] : curve ? curveAt(curve, f) * (boss ? (curve.bossMul ?? 1) : 1) : null;
  out.time = m('timeSec', T.timeCurve); out.deaths = m('deaths', T.deathsCurve); out.income = m('income', T.incomeCurve);
  return out;
}

// ---------- per stage stats ----------
const avg = (a, f) => a.length ? a.reduce((s, x) => s + (+f(x) || 0), 0) / a.length : 0;
const sum = (a, f) => a.reduce((s, x) => s + (+f(x) || 0), 0);
function wilson(k, N, z = 1.96) {
  if (!N) return [0, 1];
  const p = k / N, d = 1 + z * z / N, c = p + z * z / (2 * N), m = z * Math.sqrt(p * (1 - p) / N + z * z / (4 * N * N));
  return [Math.max(0, (c - m) / d), Math.min(1, (c + m) / d)];
}
function stats(list) {
  if (!list || !list.length) return null;
  if (!list[0].campaign) {
    const wins = list.filter((e) => e.win), p = wins.length / list.length;
    const [lo, hi] = wilson(wins.length, list.length);
    return {
      campaign: false, n: list.length, win: p, lo, hi, attempts: 1 / Math.max(p, 0.02), stall: 0,
      time: avg(list, (e) => e.time), deaths: avg(list, (e) => e.deaths ?? (e.win ? 0 : 1)),
      income: avg(list, (e) => e.income), timeout: avg(list, (e) => e.timeout ? 1 : 0), errors: list.filter((e) => e.error).length,
      nearMiss: wins.length ? avg(wins, (e) => e.hpMax ? (e.hpLeft / e.hpMax < 0.15 ? 1 : 0) : 0) : 0,
      hpLeft: wins.length ? avg(wins, (e) => e.hpMax ? e.hpLeft / e.hpMax : 0) : 0,
    };
  }
  // campaign: one player = one run id, several attempts per stage
  const by = new Map();
  for (const e of list) (by.get(e.run) ?? by.set(e.run, []).get(e.run)).push(e);
  const players = [...by.values()].map((a) => a.sort((x, y) => x.attempt - y.attempt));
  const N = players.length, firstWins = players.filter((p) => p[0].win).length;
  const clearedP = players.filter((p) => p.some((e) => e.win)), winEnds = clearedP.map((p) => p.find((e) => e.win));
  const [lo, hi] = wilson(firstWins, N);
  const last = players.map((p) => p[p.length - 1].snap || {});
  return {
    campaign: true, n: N, win: firstWins / N, lo, hi, attempts: avg(players, (p) => p.length), stall: 1 - clearedP.length / N,
    time: avg(players, (p) => sum(p, (e) => e.time)), deaths: avg(players, (p) => p.filter((e) => !e.win).length),
    income: winEnds.length ? avg(winEnds, (e) => e.income) : 0,
    timeout: avg(players.flat(), (e) => e.timeout ? 1 : 0), errors: players.flat().filter((e) => e.error).length,
    nearMiss: winEnds.length ? avg(winEnds, (e) => e.hpMax ? (e.hpLeft / e.hpMax < 0.15 ? 1 : 0) : 0) : 0,
    hpLeft: winEnds.length ? avg(winEnds, (e) => e.hpMax ? e.hpLeft / e.hpMax : 0) : 0,
    bank: last.some((s) => s.bank != null) ? avg(last, (s) => s.bank) : null,
    power: last.some((s) => s.power != null) ? avg(last, (s) => s.power) : null,
  };
}
const S = {}; // stage -> persona -> stats
for (const s of stageOrder) { S[s] = {}; for (const p of personas) S[s][p] = stats(ends[p]?.[s]); }
const camp = personas.some((p) => stageOrder.some((s) => S[s][p]?.campaign));
const firstN = {}; // players at the first stage per persona, for the reach column
for (const p of personas) { const s0 = stageOrder.find((s) => S[s][p]); firstN[p] = s0 ? S[s0][p].n : 0; }
const reach = (s, p) => S[s][p] && firstN[p] ? S[s][p].n / firstN[p] : null;

// ---------- verdicts ----------
const flags = {};
const difficulty = stageOrder.map((s) => 1 - (S[s][tp]?.win ?? 0));
stageOrder.forEach((s, i) => {
  const f = (flags[s] = []);
  const st = S[s], me = st[tp], tg = targetFor(s, i);
  if (!me) return;
  if (me.errors || me.timeout > 0.2) f.push('BROKEN');
  if (tg.win != null) {
    // confident only when the whole 95% interval is outside the band; otherwise a "?" flag asks for more runs
    if (me.lo > tg.win + tol) f.push('TOO_EASY');
    else if (me.hi < tg.win - tol) f.push('TOO_HARD');
    else if (me.win > tg.win + tol) f.push('?EASY');
    else if (me.win < tg.win - tol) f.push('?HARD');
  }
  if (tg.time != null) { if (me.time > tg.time * (1 + mtol)) f.push('SLOW'); else if (me.time < tg.time * (1 - mtol)) f.push('FAST'); }
  if (tg.deaths != null && me.deaths > tg.deaths + Math.max(0.1, tg.deaths * mtol)) f.push('DEATHY');
  if (tg.income != null) { if (me.income < tg.income * (1 - mtol)) f.push('INCOME_LOW'); else if (me.income > tg.income * (1 + mtol)) f.push('INCOME_HIGH'); }
  if (me.campaign && me.stall > stallMax) f.push('WALL');
  if (i >= 3 && !bosses.has(s)) {   // spike / dip vs the median of the previous 3 stages (bosses may be harder)
    const prev = difficulty.slice(i - 3, i).sort((a, b) => a - b)[1];
    if (difficulty[i] - prev > spikeT) f.push('SPIKE'); else if (prev - difficulty[i] > spikeT) f.push('DIP');
  }
  const rnd = st.random, smart = st.smart || st[tp];
  // random winning is only a problem where the stage is meant to challenge (target <= 80%); tutorial stages are allowed to be trivial
  if (rnd && rnd.win > randomWinMax && (tg.win == null || tg.win <= 0.8)) f.push('RANDOM_WINS');
  // when even the smart bot almost never wins, the gap to random says nothing about skill: the bot is lost, not the stage
  if (rnd && smart && smart.win < 0.1 && rnd.win < 0.1) f.push('BOT_LOST');
  else if (rnd && smart && smart.win - rnd.win < skillGapMin && smart.win < 0.95) f.push('NO_SKILL');
  if (st.optimizer && st.smart && st.optimizer.win - st.smart.win > policyGapMax) f.push('POLICY_GAP');
  if (me.win > 0.15 && me.win < 0.85 && me.n >= 20 && me.nearMiss > 0.5) f.push('COINFLIP');
  if (me.n < 20) f.push('LOW_N');
});

// ---------- print ----------
const pc = (x) => x == null ? '  - ' : String(Math.round(x * 100)).padStart(3) + '%';
const num = (x, d = 0) => x == null ? '-' : x.toFixed(d);
console.log(`\nbalance-sim report   logs=${logDir}   target persona=${tp}   win band=±${Math.round(tol * 100)}%   stages=${n}${camp ? '   mode=campaign' : ''}\n`);
const head = ['stage'.padEnd(7), ...personas.map((p) => p.slice(0, 6).padStart(6)), 'target'.padStart(7), 'delta'.padStart(6), '95% CI'.padStart(8), 'tries'.padStart(6)];
if (camp) head.push('reach'.padStart(6), 'bank'.padStart(7));
head.push('time'.padStart(6), 'death'.padStart(6), 'income'.padStart(7), '  flags');
console.log(head.join(' '));
stageOrder.forEach((s, i) => {
  const me = S[s][tp], tg = targetFor(s, i);
  const d = me && tg.win != null ? Math.round((me.win - tg.win) * 100) : null;
  const row = [
    s.padEnd(7), ...personas.map((p) => pc(S[s][p]?.win).padStart(6)),
    pc(tg.win).padStart(7), (d == null ? '-' : (d > 0 ? '+' : '') + d).padStart(6),
    (me ? `${Math.round(me.lo * 100)}-${Math.round(me.hi * 100)}` : '-').padStart(8), num(me?.attempts, 1).padStart(6),
  ];
  if (camp) row.push(pc(reach(s, tp)).padStart(6), num(me?.bank).padStart(7));
  row.push(num(me?.time).padStart(6), num(me?.deaths, 2).padStart(6), num(me?.income).padStart(7), '  ' + flags[s].join(' '));
  console.log(row.join(' '));
});

console.log(`\nDifficulty curve for "${tp}" (bar = first-try win rate, | = target)`);
stageOrder.forEach((s, i) => {
  const me = S[s][tp]; if (!me) return;
  const tg = targetFor(s, i), W = 40, fill = Math.round(me.win * W), tpos = tg.win != null ? Math.round(tg.win * W) : -1;
  let bar = '';
  for (let k = 0; k < W; k++) bar += k === tpos ? '|' : k < fill ? '█' : '░';
  console.log(s.padEnd(6), bar, pc(me.win), flags[s].length ? ' ' + flags[s].join(' ') : '');
});

const byFlag = (k) => stageOrder.filter((s) => flags[s].includes(k));
console.log('\nSummary');
let anyBad = false;
for (const k of ['BROKEN', 'TOO_HARD', 'TOO_EASY', '?HARD', '?EASY', 'WALL', 'SPIKE', 'DIP', 'SLOW', 'FAST', 'DEATHY', 'INCOME_LOW', 'INCOME_HIGH', 'RANDOM_WINS', 'NO_SKILL', 'BOT_LOST', 'POLICY_GAP', 'COINFLIP', 'LOW_N'])
  if (byFlag(k).length) { console.log('  ' + k.padEnd(12), byFlag(k).join(', ')); if (k !== 'LOW_N' && !k.startsWith('?')) anyBad = true; }
if (!anyBad) console.log('  all stages inside the target band');
if (stageOrder.some((s) => flags[s].some((x) => x.startsWith('?')))) console.log('  "?" = point estimate is outside the band but the 95% interval still touches it: run more (--runs) before changing numbers');
const gaps = stageOrder.map((s) => (S[s].smart && S[s].random) ? S[s].smart.win - S[s].random.win : null).filter((x) => x != null);
if (gaps.length) console.log(`  skill depth (smart - random win rate), mean over stages: ${pc(gaps.reduce((a, b) => a + b, 0) / gaps.length)}   (low = choices do not matter)`);
if (stageOrder.every((s) => S[s].novice && S[s].smart)) {
  const g = stageOrder.map((s) => S[s].smart.win - S[s].novice.win);
  console.log(`  mistake cost (smart - novice), mean: ${pc(g.reduce((a, b) => a + b, 0) / g.length)}`);
}
if (camp) {
  const last = [...stageOrder].reverse().find((s) => S[s][tp]);
  if (last) console.log(`  funnel "${tp}": ${pc(reach(last, tp))} of players reach stage ${last}; biggest drop at stage ${stageOrder.reduce((b, s, i) => { const r0 = i ? reach(stageOrder[i - 1], tp) ?? 0 : 1, r1 = reach(s, tp) ?? 0; return r0 - r1 > b.d ? { s, d: r0 - r1 } : b; }, { s: '-', d: -1 }).s}`);
}
console.log('  note: bots are not humans. Real playtest or telemetry overrides this report (use --humans to calibrate).');

// ---------- calibration against real players ----------
const H = readJson(arg('humans'));
const hStages = Object.keys(H).filter((s) => stageOrder.includes(s));
if (hStages.length >= 2) {
  const hv = (s) => typeof H[s] === 'object' ? H[s].win : H[s];
  console.log(`\nCalibration vs real players (${hStages.length} stages with data)`);
  const rows = personas.map((p) => {
    const st = hStages.filter((s) => S[s][p]), xs = st.map((s) => S[s][p].win), ys = st.map(hv);
    const mae = avg(xs.map((x, i) => Math.abs(x - ys[i])), (x) => x);
    const mx = avg(xs, (x) => x), my = avg(ys, (x) => x);
    const cov = sum(xs.map((x, i) => (x - mx) * (ys[i] - my)), (x) => x), vx = sum(xs, (x) => (x - mx) ** 2), vy = sum(ys, (y) => (y - my) ** 2);
    return { p, mae, corr: vx && vy ? cov / Math.sqrt(vx * vy) : 0, bias: mx - my };
  });
  for (const r of rows) console.log('  ' + r.p.padEnd(10), 'MAE', pc(r.mae), ' corr', r.corr.toFixed(2), ' bot - human', (r.bias >= 0 ? '+' : '') + Math.round(r.bias * 100) + '%');
  const best = rows.reduce((a, b) => a.mae < b.mae ? a : b);
  console.log(`  closest to real players: ${best.p}${best.p !== tp ? `   -> set "targetPersona": "${best.p}" or shift the target by its bias` : ''}`);
}

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

// ---------- report, compare, html ----------
const report = {
  targetPersona: tp,
  stages: Object.fromEntries(stageOrder.map((s, i) => [s, { ...S[s], target: targetFor(s, i), flags: flags[s] }])),
};
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
if (arg('html')) {
  // the page is one self-contained file: data as JSON + css + js from scripts/report/ (no network needed)
  const dir = path.join(path.dirname(new URL(import.meta.url).pathname), 'report');
  const pick = (x) => x && ({ win: x.win, lo: x.lo, hi: x.hi, n: x.n, tries: x.attempts, stall: x.stall, time: x.time, deaths: x.deaths, income: x.income, bank: x.bank ?? null, power: x.power ?? null, nearMiss: x.nearMiss });
  const data = {
    tp, tol, mtol, camp, personas, logDir, generated: new Date().toISOString().slice(0, 10),
    stages: stageOrder.map((s, i) => ({
      id: s, idx: i, target: targetFor(s, i), flags: flags[s], boss: bosses.has(s),
      p: Object.fromEntries(personas.map((p) => [p, pick(S[s][p])])),
      reach: Object.fromEntries(personas.map((p) => [p, reach(s, p)])),
    })),
  };
  const read = (f) => fs.readFileSync(path.join(dir, f), 'utf8');
  const json = JSON.stringify(data).replace(/</g, '\\u003c');
  fs.writeFileSync(arg('html'), read('template.html').replace('/*CSS*/', () => read('report.css')).replace('/*JS*/', () => read('report.js')).replace('"__DATA__"', () => json));
  console.log(`\nHTML report -> ${arg('html')}`);
}
