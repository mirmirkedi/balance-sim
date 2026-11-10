#!/usr/bin/env node
// balance-sim calibrate: move a game's per-stage difficulty levers until the measured curve meets the target.
// This is the mechanical half of "balance it": the adapter declares ONE lever per stage (a number that makes the stage
// harder or easier), this script nudges every stage's lever in proportion to how far the stage is from its target,
// re-measures with a fresh seed each round (so it does not fit noise) and finally verifies the best result on a
// separate seed. The agent (or the user, in the studio) still decides what the target is and whether the result makes sense.
//
//   node calibrate.mjs --adapter A --targets T --out dir [--rounds 6] [--runs 60] [--retries 10] [--campaign]
//                      [--personas smart] [--seed 21] [--k 0.8] [--base params.json] [--stages 1-40]
//
// Adapter contract (optional export):
//   levers: { stage: { param: 'TUNE.stage.adj.{stage}', mode: 'mul' | 'add', harder: +1 | -1,
//                      min, max, default, step, integer, read(stageId), unit } }
//     param    parameter name handed to the adapter as --set; {stage} is replaced by the stage id
//     mode     mul: value *= exp(k * delta * harder);  add: value += k * delta * step * harder
//     harder   +1 if a bigger value makes the stage harder, -1 if it makes it easier (extra moves)
//     read     optional: the value the game currently has for that stage (default `default`)
// Output in <out>: progress.json (live), rounds/<n>.json, result.json
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const arg = (n, d) => { const i = argv.indexOf('--' + n); return i < 0 ? d : argv[i + 1]; };
const has = (n) => argv.includes('--' + n);
if (!arg('adapter') || !arg('targets')) { console.error('usage: calibrate.mjs --adapter A --targets T --out dir [--rounds 6] [--runs 60]'); process.exit(1); }

const adapter = (await import(pathToFileURL(path.resolve(arg('adapter'))).href)).default;
const lever = adapter.levers && adapter.levers.stage;
if (!lever) { console.error('[calib] this adapter declares no levers.stage, so there is nothing to calibrate automatically. Measure with a detection run and tune by hand or with the agent (SKILL.md, tuning loop).'); process.exit(2); }
const T = JSON.parse(fs.readFileSync(arg('targets'), 'utf8'));
const tp = T.targetPersona || 'smart';
const out = path.resolve(arg('out', 'calib-out'));
fs.mkdirSync(path.join(out, 'rounds'), { recursive: true });
const rounds = +arg('rounds', 6), runs = +arg('runs', 60), seed0 = +arg('seed', 21), K = +arg('k', 0.8), retries = arg('retries', '10');
const mode = lever.mode || 'mul', harder = lever.harder ?? 1, step = lever.step ?? 8, dead = +arg('deadband', 0.04);
const base = arg('base') && fs.existsSync(arg('base')) ? JSON.parse(fs.readFileSync(arg('base'), 'utf8')) : {};
const all = adapter.stages.map(String);
let ids = all;
const sel = arg('stages');
if (sel && /^\d+(-\d+)?$/.test(sel)) { const [a, b] = sel.split('-').map(Number); ids = all.slice(a - 1, b || a); }

const paramOf = (s) => lever.param.replace('{stage}', s);
const baseline = (s) => { const v = lever.read ? lever.read(s) : undefined; return v ?? lever.default ?? (mode === 'mul' ? 1 : 0); };
const snap = (v) => lever.integer ? Math.round(v) : +v.toFixed(3);
const clamp = (v) => Math.min(lever.max ?? Infinity, Math.max(lever.min ?? -Infinity, v));
const vals = new Map(ids.map((s) => [s, baseline(s)]));

const run = (script, args) => execFileSync(process.execPath, [path.join(here, script), ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 1 << 28 });
const paramsFrom = (vm) => {
  const p = { ...base };
  for (const [s, v] of vm) if (snap(v) !== snap(baseline(s))) p[paramOf(s)] = snap(v);
  return p;
};
function measure(params, seed, nRuns, tag) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bcal-'));
  const sets = Object.entries(params).flatMap(([k, v]) => ['--set', `${k}=${v}`]);
  run('runner.mjs', ['--adapter', arg('adapter'), '--personas', tp, '--runs', String(nRuns), '--seed', String(seed), ...(has('campaign') ? ['--campaign', '--retries', retries] : []), ...(sel ? ['--stages', sel] : []), ...sets, '--out', dir]);
  run('analyze.mjs', ['--logs', dir, '--targets', arg('targets'), '--out', path.join(dir, 'report.json')]);
  const rep = JSON.parse(fs.readFileSync(path.join(dir, 'report.json'), 'utf8'));
  fs.rmSync(dir, { recursive: true, force: true });
  const stages = {}, errs = [];
  let flagged = 0;
  for (const [s, v] of Object.entries(rep.stages)) {
    const r = v[tp], t = v.target && v.target.win;
    const flags = (v.flags || []).filter((f) => f !== 'LOW_N');
    stages[s] = { win: r ? r.win : null, target: t ?? null, n: r ? r.n : 0, flags };
    if (r && t != null) errs.push(Math.abs(r.win - t));
    if (flags.some((f) => !f.startsWith('?') && !['RANDOM_WINS', 'NO_SKILL', 'BOT_LOST', 'POLICY_GAP', 'COINFLIP'].includes(f))) flagged++;
  }
  const loss = errs.length ? errs.reduce((a, b) => a + b, 0) / errs.length : NaN;
  console.log(`[calib] ${tag}: loss ${(loss * 100).toFixed(1)} pts, ${flagged} flagged stages (${errs.length} stages with a target)`);
  return { loss, flagged, stages };
}

// when run by hand inside <game>/.balance-sim/runs/<id>/ (conversation mode) register the run like the studio does
const metaPath = path.join(out, 'meta.json'), registered = /[\\/]\.balance-sim[\\/]runs[\\/]/.test(out) && !fs.existsSync(metaPath);
if (registered) {
  fs.writeFileSync(metaPath, JSON.stringify({ id: path.basename(out), kind: 'calibrate', status: 'running', startedAt: new Date().toISOString(), options: { personas: [tp], runs, retries: +retries, seed: seed0 - 20, stages: sel || null, campaign: has('campaign'), params: base, rounds, k: K, via: 'calibrate.mjs' } }, null, 2) + '\n');
  if (!fs.existsSync(path.join(out, 'targets.json'))) fs.copyFileSync(arg('targets'), path.join(out, 'targets.json'));
}
const progress = { status: 'running', startedAt: new Date().toISOString(), lever: { param: lever.param, mode, harder, unit: lever.unit || '' }, targetPersona: tp, rounds: [], total: rounds };
const save = () => fs.writeFileSync(path.join(out, 'progress.json'), JSON.stringify(progress));
save();

console.log(`[calib] lever ${lever.param} (${mode}, ${harder > 0 ? 'bigger = harder' : 'bigger = easier'}), ${ids.length} stages, ${rounds} rounds x ${runs} runs, persona ${tp}`);
let best = { loss: Infinity, params: paramsFrom(vals), round: 0 };
for (let r = 1; r <= rounds; r++) {
  const params = paramsFrom(vals);
  const m = measure(params, seed0 + r, runs, `round ${r}/${rounds}`);
  fs.writeFileSync(path.join(out, 'rounds', r + '.json'), JSON.stringify({ round: r, params, ...m }, null, 1));
  progress.rounds.push({ round: r, loss: m.loss, flagged: m.flagged, changed: Object.keys(params).length - Object.keys(base).length });
  save();
  if (m.loss < best.loss) best = { loss: m.loss, params, round: r };
  if (r === rounds) break;
  let moved = 0;
  for (const [s, st] of Object.entries(m.stages)) {
    if (!vals.has(s) || st.win == null || st.target == null || st.n < 12) continue;
    const delta = st.win - st.target;               // > 0: easier than the target
    if (Math.abs(delta) < dead) continue;
    const v = vals.get(s);
    vals.set(s, clamp(mode === 'mul' ? v * Math.exp(K * delta * harder) : v + K * delta * step * harder));
    moved++;
  }
  console.log(`[calib] moved ${moved} stage levers`);
  if (!moved) { console.log('[calib] every stage is inside the dead band, stopping early'); break; }
}

// fair before/after: same fresh seed and more runs for the untouched game and for the best candidate
const vSeed = 9000 + seed0, vRuns = Math.max(runs, 80);
console.log('[calib] verifying on a fresh seed (' + vRuns + ' runs per stage)');
const before = measure({ ...base }, vSeed, vRuns, 'before (baseline)');
const after = measure(best.params, vSeed, vRuns, `after (best = round ${best.round})`);
const changes = Object.entries(best.params).filter(([k]) => !(k in base)).map(([k, v]) => {
  const s = ids.find((x) => paramOf(x) === k);
  return { stage: s, param: k, from: s != null ? snap(baseline(s)) : null, to: v };
});
const result = { status: 'done', targetPersona: tp, lever: progress.lever, bestRound: best.round, before, after, params: best.params, changes, rounds: progress.rounds, runs, verifyRuns: vRuns, finishedAt: new Date().toISOString() };
fs.writeFileSync(path.join(out, 'result.json'), JSON.stringify(result, null, 1));
progress.status = 'done'; save();
if (registered) { const m = JSON.parse(fs.readFileSync(metaPath, 'utf8')); m.status = 'done'; m.endedAt = new Date().toISOString(); m.summary = { before: Math.round(before.loss * 1000) / 10, after: Math.round(after.loss * 1000) / 10, changed: changes.length }; fs.writeFileSync(metaPath, JSON.stringify(m, null, 2) + '\n'); }
console.log(`[calib] done: ${(before.loss * 100).toFixed(1)} -> ${(after.loss * 100).toFixed(1)} pts, ${changes.length} levers changed`);
