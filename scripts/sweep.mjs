#!/usr/bin/env node
// balance-sim sweep: change ONE adapter parameter over several values and see how the curve moves.
// This is the "one variable at a time" rule, automated.
//
//   node sweep.mjs --adapter ./adapter.mjs --targets targets.json --param enemyHp --values 0.8,1,1.2
//                  [--stages 1-10] [--runs 60] [--persona smart] [--campaign] [--retries 2]
//                  [--fit-stages 5-9] [--set other=1 ...]
//
// The adapter reads the parameter from `params` (created by `--set key=value`).
// Output: win rate per stage for each value, error against the target curve, and the best value.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const arg = (n, d) => { const i = argv.indexOf('--' + n); return i < 0 ? d : argv[i + 1]; };
const has = (n) => argv.includes('--' + n);
const param = arg('param'), values = String(arg('values', '')).split(',').filter(Boolean);
if (!arg('adapter') || !param || values.length < 2) { console.error('usage: sweep.mjs --adapter A --targets T --param name --values a,b,c [--stages 1-10] [--runs 60]'); process.exit(1); }

const targets = arg('targets') && fs.existsSync(arg('targets')) ? JSON.parse(fs.readFileSync(arg('targets'), 'utf8')) : {};
const persona = arg('persona', targets.targetPersona || 'smart');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bsweep-'));
const extraSets = argv.flatMap((a, i) => a === '--set' ? ['--set', argv[i + 1]] : []);
const camp = has('campaign') ? ['--campaign', '--retries', arg('retries', '2')] : [];
const node = (script, args) => execFileSync(process.execPath, [path.join(here, script), ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 1 << 28 });

const reports = {};
for (const v of values) {
  const dir = path.join(tmp, 'v_' + v);
  node('runner.mjs', ['--adapter', arg('adapter'), '--personas', persona, '--runs', arg('runs', '60'), '--seed', arg('seed', '1'),
    ...(arg('stages') ? ['--stages', arg('stages')] : []), ...camp, ...extraSets, '--set', `${param}=${v}`, '--out', dir]);
  node('analyze.mjs', ['--logs', dir, ...(arg('targets') ? ['--targets', arg('targets')] : []), '--out', path.join(dir, 'report.json')]);
  reports[v] = JSON.parse(fs.readFileSync(path.join(dir, 'report.json'), 'utf8'));
}

const stages = Object.keys(reports[values[0]].stages);
let fit = stages;
if (arg('fit-stages')) { const [a, b] = arg('fit-stages').split('-').map(Number); fit = stages.slice(a - 1, b || a); }
const pc = (x) => x == null ? '   - ' : String(Math.round(x * 100)).padStart(4) + '%';
console.log(`\nsweep ${param}  persona=${persona}  runs=${arg('runs', '60')}  fit stages=${fit.length}\n`);
console.log(['stage'.padEnd(7), ...values.map((v) => (param.slice(0, 5) + '=' + v).padStart(11)), 'target'.padStart(8)].join(' '));
for (const s of stages) {
  const tg = reports[values[0]].stages[s].target?.win;
  console.log([s.padEnd(7), ...values.map((v) => pc(reports[v].stages[s]?.[persona]?.win).padStart(11)), pc(tg).padStart(8)].join(' '));
}
const err = {}, nflag = {};
for (const v of values) {
  const xs = fit.map((s) => { const r = reports[v].stages[s]?.[persona], t = reports[v].stages[s]?.target?.win; return t != null && r ? Math.abs(r.win - t) : null; }).filter((x) => x != null);
  err[v] = xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null;
  nflag[v] = fit.filter((s) => (reports[v].stages[s]?.flags || []).some((f) => !['LOW_N'].includes(f) && !f.startsWith('?'))).length;
}
console.log('\nvalue'.padEnd(10), 'mean |win - target|'.padStart(22), 'flagged stages'.padStart(16));
for (const v of values) console.log(String(v).padEnd(9), (err[v] == null ? 'no target' : Math.round(err[v] * 100) + ' pts').padStart(22), String(nflag[v]).padStart(16));
// steepness: how much the fit stages move between two neighbouring values (a cliff needs finer steps)
let steep = 0;
for (let k = 1; k < values.length; k++) {
  const d = fit.map((s) => Math.abs((reports[values[k]].stages[s]?.[persona]?.win ?? 0) - (reports[values[k - 1]].stages[s]?.[persona]?.win ?? 0)));
  steep = Math.max(steep, d.reduce((a, b) => a + b, 0) / Math.max(1, d.length));
}
if (steep > 0.3) console.log(`\nwarning: the curve is steep in ${param} (up to ${Math.round(steep * 100)} pts mean change between neighbouring values). Use finer steps around the best value.`);
const ranked = values.filter((v) => err[v] != null).sort((a, b) => err[a] - err[b] || nflag[a] - nflag[b]);
if (ranked.length) {
  const best = ranked[0], idx = values.indexOf(best);
  console.log(`\nbest value for ${param}: ${best}  (${Math.round(err[best] * 100)} pts from the target curve)`);
  if (idx === 0 || idx === values.length - 1) console.log(`  the best value is at the edge of the range: the optimum may lie outside ${values[0]}..${values[values.length - 1]}`);
  console.log('  one parameter cannot fix a shape problem: if no value gets the error low, change the scaling formula or a different parameter.');
}
fs.rmSync(tmp, { recursive: true, force: true });
