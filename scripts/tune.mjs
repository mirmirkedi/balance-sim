#!/usr/bin/env node
// balance-sim tune: the TOOL of the agentic tuning loop. It does not decide anything.
// The agent (Claude) reads the report, picks which parameters to move and by how much, calls this script,
// reads the result, and decides the next step. This script only evaluates parameter sets fast and keeps a history.
//
//   node tune.mjs --adapter A --targets T --state tune-state \
//        --cand "a:enemyHp=1.2,playerDmg=1.1" --cand "b:enemyHp=1.4"     explicit candidates (agent chosen)
//        [--scout 12 --ranges "enemyHp=0.8..1.6,playerDmg=0.9..1.3"]      random scouting inside agent-chosen ranges
//        [--base k=v ...]            fixed params for all candidates   [--stages 1-20] [--runs 60] [--persona smart]
//        [--campaign --retries 2] [--seed 1] [--detail name]           stage-by-stage view of one candidate
//   node tune.mjs --state tune-state --history [--top 10]              what was tried so far, best first
//
// Every evaluation is appended to <state>/history.jsonl: {id, name, params, loss, flagged, stages:{s:{win,target,flags}}}.
// loss = mean |win - target| over the fit stages (lower is better). It is a number, not a verdict:
// the agent must still read the shape (which stages are off, which flags remain) before choosing.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const arg = (n, d) => { const i = argv.indexOf('--' + n); return i < 0 ? d : argv[i + 1]; };
const all = (n) => argv.flatMap((a, i) => a === '--' + n ? [argv[i + 1]] : []);
const has = (n) => argv.includes('--' + n);
const state = arg('state', 'tune-state');
fs.mkdirSync(state, { recursive: true });
const histFile = path.join(state, 'history.jsonl');
const readHist = () => fs.existsSync(histFile) ? fs.readFileSync(histFile, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : [];
const pc = (x) => x == null ? '   - ' : String(Math.round(x * 100)).padStart(4) + '%';
const fmtParams = (p) => Object.entries(p).map(([k, v]) => `${k}=${v}`).join(' ') || '(defaults)';

if (has('history')) {
  const h = readHist().sort((a, b) => a.loss - b.loss).slice(0, +arg('top', 10));
  if (!h.length) { console.log('no history yet'); process.exit(0); }
  console.log('id  loss   flagged  params');
  for (const e of h) console.log(String(e.id).padEnd(3), (Math.round(e.loss * 100) + ' pts').padEnd(6), String(e.flagged).padEnd(8), e.name + '  ' + fmtParams(e.params));
  process.exit(0);
}

if (!arg('adapter')) { console.error('usage: tune.mjs --adapter A --targets T --cand "name:k=v,k=v" [--scout N --ranges "k=a..b"] | --history'); process.exit(1); }
const targets = arg('targets') && fs.existsSync(arg('targets')) ? JSON.parse(fs.readFileSync(arg('targets'), 'utf8')) : {};
if (!arg('targets') && !arg('detail')) console.error('warning: no --targets, loss cannot be computed');
const persona = arg('persona', targets.targetPersona || 'smart');
const runs = arg('runs', '60'), seed = arg('seed', '1');
const camp = has('campaign') ? ['--campaign', '--retries', arg('retries', '2')] : [];
const baseParams = Object.fromEntries(all('base').map((s) => { const i = s.indexOf('='); return [s.slice(0, i), s.slice(i + 1)]; }));

const parseCand = (s) => {
  const i = s.indexOf(':');
  const name = i < 0 ? 'c' + Math.random().toString(36).slice(2, 6) : s.slice(0, i);
  const body = i < 0 ? s : s.slice(i + 1);
  const params = {};
  for (const kv of body.split(',').filter(Boolean)) { const j = kv.indexOf('='); params[kv.slice(0, j)] = kv.slice(j + 1); }
  return { name, params };
};
const cands = all('cand').map(parseCand);

if (arg('scout')) {   // random scouting in agent-chosen ranges, seeded so it repeats
  const ranges = Object.fromEntries(String(arg('ranges', '')).split(',').filter(Boolean).map((kv) => {
    const [k, r] = kv.split('='); const [a, b] = r.split('..').map(Number); return [k, [a, b]];
  }));
  if (!Object.keys(ranges).length) { console.error('--scout needs --ranges "k=a..b,..."'); process.exit(1); }
  let x = (+seed * 2654435761) >>> 0;
  const rnd = () => { x = (x + 0x6d2b79f5) >>> 0; let t = x; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
  const hs = readHist().length;
  for (let n = 0; n < +arg('scout'); n++) {
    const params = {};
    for (const [k, [a, b]] of Object.entries(ranges)) params[k] = +(a + rnd() * (b - a)).toFixed(3);
    cands.push({ name: 's' + (hs + n + 1), params });
  }
}

const run = (script, args) => execFileSync(process.execPath, [path.join(here, script), ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 1 << 28 });
const evaluate = (cand) => {
  const params = { ...baseParams, ...cand.params };
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'btune-'));
  const sets = Object.entries(params).flatMap(([k, v]) => ['--set', `${k}=${v}`]);
  run('runner.mjs', ['--adapter', arg('adapter'), '--personas', persona, '--runs', runs, '--seed', seed, ...(arg('stages') ? ['--stages', arg('stages')] : []), ...camp, ...sets, '--out', dir]);
  run('analyze.mjs', ['--logs', dir, ...(arg('targets') ? ['--targets', arg('targets')] : []), '--out', path.join(dir, 'report.json')]);
  const rep = JSON.parse(fs.readFileSync(path.join(dir, 'report.json'), 'utf8'));
  fs.rmSync(dir, { recursive: true, force: true });
  const stages = {};
  const errs = [];
  let flagged = 0;
  for (const [s, v] of Object.entries(rep.stages)) {
    const r = v[persona], t = v.target?.win;
    const flags = (v.flags || []).filter((f) => f !== 'LOW_N');
    stages[s] = { win: r?.win ?? null, target: t ?? null, flags };
    if (r && t != null) errs.push(Math.abs(r.win - t));
    if (flags.some((f) => !f.startsWith('?'))) flagged++;
  }
  const loss = errs.length ? errs.reduce((a, b) => a + b, 0) / errs.length : NaN;
  return { params, loss, flagged, stages };
};

if (!cands.length && !arg('detail')) { console.error('nothing to do: pass --cand, --scout or --detail'); process.exit(1); }
const hist = readHist();
if (!hist.length && !cands.some((c) => !Object.keys(c.params).length) && cands.length) cands.unshift({ name: 'base', params: {} });   // always have a baseline

const results = [];
for (const c of cands) {
  const r = evaluate(c);
  const entry = { id: readHist().length + 1, name: c.name, ...r, persona, runs: +runs, at: new Date().toISOString() };
  fs.appendFileSync(histFile, JSON.stringify(entry) + '\n');
  results.push(entry);
}

if (results.length) {
  const base = readHist().find((e) => e.name === 'base');
  console.log(`\ntune: ${results.length} candidates, persona=${persona}, runs=${runs}${base ? `, baseline loss ${Math.round(base.loss * 100)} pts` : ''}\n`);
  console.log('id  name'.padEnd(14), 'loss'.padStart(7), 'flagged'.padStart(8), '  params');
  for (const e of [...results].sort((a, b) => a.loss - b.loss)) console.log(`${String(e.id).padEnd(3)} ${e.name}`.padEnd(14), (Number.isNaN(e.loss) ? 'n/a' : Math.round(e.loss * 100) + ' pts').padStart(7), String(e.flagged).padStart(8), ' ', fmtParams(e.params));
  const best = [...results].sort((a, b) => a.loss - b.loss)[0];
  // the lines the agent should interpret: where the best candidate is still off
  const tol = targets.tolerance ?? 0.15;
  const off = Object.entries(best.stages).filter(([, v]) => v.target != null && v.win != null && Math.abs(v.win - v.target) > tol);
  console.log(`\nbest of this batch: ${best.name}. Stages still outside +-${Math.round(tol * 100)} pts of the target: ${off.length ? off.map(([s, v]) => `${s}(${v.win > v.target ? '+' : ''}${Math.round((v.win - v.target) * 100)})`).join(' ') : 'none'}`);
  const fl = Object.entries(best.stages).filter(([, v]) => v.flags.length).map(([s, v]) => `${s}:${v.flags.join('/')}`);
  if (fl.length) console.log('flags: ' + fl.join('  '));
  console.log('A low loss is not a verdict. Read the shape, replay a flagged stage, then choose the next candidates. History: tune.mjs --state ' + state + ' --history');
}

if (arg('detail')) {
  const e = readHist().filter((h) => h.name === arg('detail')).pop();
  if (!e) { console.error('no candidate named ' + arg('detail')); process.exit(1); }
  console.log(`\n${e.name}  ${fmtParams(e.params)}  loss ${Math.round(e.loss * 100)} pts\nstage    win  target  delta  flags`);
  for (const [s, v] of Object.entries(e.stages)) console.log(s.padEnd(7), pc(v.win), pc(v.target).padStart(6), (v.win != null && v.target != null ? (v.win - v.target > 0 ? '+' : '') + Math.round((v.win - v.target) * 100) : '-').padStart(6), ' ', v.flags.join(' '));
}
