#!/usr/bin/env node
// balance-sim options: are the player's choices balanced against each other?
// stage difficulty says how hard the levels are; this says whether every action/upgrade/option is worth taking.
//
//   node options.mjs --adapter A [--stages 1-10] [--runs 60] [--persona smart] [--seed 5] [--options heal,shoot] [--set k=v ...] [--campaign --retries 10] [--json]
//
// 1. USAGE     baseline run: how often the persona chose each option (action.option, else action.type, counted by the runner).
// 2. ABLATION  the same runs with ONE option removed (`--set ban.<option>=1`): the win-rate change is what the option is worth.
//              Options the adapter handles outside legalActions() (a shop, upgrades) must read params['ban.<id>'] itself.
// Verdicts: DEAD (not used and removing it changes nothing), MANDATORY (removing it costs >= 25 pts), DOMINANT (>= 60% of
// all choices AND removing it costs the most), HARMFUL (win rate rises without it), BAN_IGNORED (the option was still chosen: it was the
// only legal action, or the adapter does not honor ban.<id>). Buff weak options
// instead of nerfing strong ones (see SKILL.md). Differences smaller than 2 standard errors are reported as "no clear effect".
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const arg = (n, d) => { const i = argv.indexOf('--' + n); return i < 0 ? d : argv[i + 1]; };
const has = (n) => argv.includes('--' + n);
if (!arg('adapter')) { console.error('usage: options.mjs --adapter A [--stages 1-10] [--runs 60] [--persona smart] [--options a,b]'); process.exit(1); }
const adapter = (await import(pathToFileURL(path.resolve(arg('adapter'))).href)).default;
const persona = arg('persona', 'smart'), runs = arg('runs', '60'), seed = arg('seed', '5');
const sets = []; argv.forEach((a, i) => { if (a === '--set' && argv[i + 1]) sets.push('--set', argv[i + 1]); });
const campaign = has('campaign') ? ['--campaign', '--retries', arg('retries', '10')] : [];
const stageArg = arg('stages') ? ['--stages', arg('stages')] : [];

function play(extra) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bopt-'));
  execFileSync(process.execPath, [path.join(here, 'runner.mjs'), '--adapter', arg('adapter'), '--personas', persona, '--runs', runs, '--seed', seed, '--no-check', ...campaign, ...stageArg, ...sets, ...extra, '--out', dir], { stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 1 << 28 });
  const ends = fs.readFileSync(path.join(dir, persona + '.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)).filter((e) => e.type === 'end' && (!e.campaign || e.attempt === 1));
  fs.rmSync(dir, { recursive: true, force: true });
  const byStage = {}; for (const e of ends) { const b = (byStage[e.stage] ??= { n: 0, w: 0 }); b.n++; b.w += e.win ? 1 : 0; }
  const n = ends.length, w = ends.filter((e) => e.win).length, acts = {};
  for (const e of ends) for (const [k, c] of Object.entries(e.acts || {})) acts[k] = (acts[k] || 0) + c;
  return { n, p: n ? w / n : 0, acts, byStage, runsPlayed: ends.length };
}

console.error('baseline ...');
const base = play([]);
const totalActs = Object.values(base.acts).reduce((a, b) => a + b, 0) || 1;
const declared = (adapter.options || []).map((o) => (typeof o === 'string' ? o : o.id));
const ids = (arg('options') ? arg('options').split(',') : declared.length ? declared : Object.keys(base.acts));
const rows = [];
for (const id of ids) {
  console.error('without ' + id + ' ...');
  const r = play(['--set', `ban.${id}=1`]);
  const d = r.p - base.p, se = Math.sqrt(base.p * (1 - base.p) / base.n + r.p * (1 - r.p) / r.n) || 0.01, share = (base.acts[id] || 0) / totalActs;
  const worst = Object.keys(base.byStage).map((s) => [s, (r.byStage[s] ? r.byStage[s].w / r.byStage[s].n : 0) - base.byStage[s].w / base.byStage[s].n]).sort((a, b) => a[1] - b[1])[0];
  rows.push({ id, share, uses: (base.acts[id] || 0) / base.n, delta: d, se, significant: Math.abs(d) > 2 * se, worstStage: worst ? worst[0] : null, worstDelta: worst ? worst[1] : null, noAction: (r.acts[id] || 0) > 0 });
}
const maxLoss = Math.min(0, ...rows.map((r) => r.delta));
for (const r of rows) {
  const v = [];
  if (r.share < 0.03 && !r.significant) v.push('DEAD');
  else if (!r.significant) v.push('NO_CLEAR_EFFECT');
  if (r.significant && r.delta <= -0.25) v.push('MANDATORY');
  if (r.share >= 0.6 && r.delta === maxLoss && r.significant) v.push('DOMINANT');
  if (r.significant && r.delta > 0.03) v.push('HARMFUL');
  if (r.noAction) v.push('BAN_IGNORED');
  r.verdict = v;
}
if (has('json')) { console.log(JSON.stringify({ persona, runs: base.n, baselineWin: base.p, options: rows }, null, 1)); process.exit(0); }
const pct = (x) => (x * 100).toFixed(1).padStart(5) + '%';
console.log(`\nOPTION BALANCE (${persona}, ${base.n} runs, baseline first-try win ${pct(base.p).trim()})`);
console.log('option         share  uses/run  win without it   effect           worst stage       verdict');
for (const r of rows.sort((a, b) => a.delta - b.delta)) console.log(`${r.id.padEnd(14)} ${pct(r.share)} ${r.uses.toFixed(1).padStart(8)}  ${pct(base.p + r.delta)}      ${((r.delta >= 0 ? '+' : '') + (r.delta * 100).toFixed(1) + ' pts' + (r.significant ? '' : ' (noise)')).padEnd(16)} ${(r.worstStage != null ? 'stage ' + r.worstStage + ' ' + (r.worstDelta * 100).toFixed(0) + ' pts' : '-').padEnd(17)} ${r.verdict.join(' ') || 'ok'}`);
console.log('\nHow to read it: "effect" = win-rate change when the option is removed. Big negative = the game depends on it (MANDATORY); no clear effect and rarely used = DEAD (buff it or cut it). Fix weak options by buffing them, not by nerfing the strong one.');
console.log('Bots choose by their own policy: an option nobody picks may still matter to humans, and a "dominant" one may only be dominant for this bot. Check with real play.');
