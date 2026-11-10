#!/usr/bin/env node
// balance-sim runner: plays every stage many times with several personas and writes JSONL logs.
//
//   node runner.mjs --adapter ./adapter.mjs [--stages 1-20|id,id] [--runs 100]
//                   [--personas random,novice,smart,optimizer] [--seed 1]
//                   [--full 3] [--max-steps 5000] [--out logs] [--novice-error 0.25]
//                   [--set key=value ...]            params for the adapter (also used by sweep.mjs)
//                   [--campaign] [--retries 2]       one player lives through all stages, keeps a profile
//                   [--replay persona:stage:run]     re-simulate one run and print it as a timeline
//                   [--jobs N]                       worker processes (default: CPU cores - 1, at most 8; 1 = off). Runs are split
//                                                    between workers, seeds depend only on (stage, run), so the result is identical to --jobs 1.
//
// Log files: <out>/<persona>.jsonl, one JSON object per line.
//   type "end"   : one per attempt (always written)  {win, hpLeft, hpMax, time, deaths, income, resources, timeout, steps, error, acts}
//                  campaign mode adds: attempt, campaign:true, snap (adapter.snapshot(profile))
//   type "stall" : campaign only, the player gave up on this stage after 1 + retries attempts
//   other types  : game events from adapter emit() (only for the first --full runs per persona+stage)
// Every line also carries: run, seed, persona, stage, step, t.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { PERSONAS } from './personas.mjs';
import { mulberry32 } from './rng.mjs';
import { playRun, seedFor, parseSet, fmtEvent } from './lib.mjs';

const argv = process.argv.slice(2);
const arg = (n, d) => { const i = argv.indexOf('--' + n); return i < 0 ? d : argv[i + 1]; };
const has = (n) => argv.includes('--' + n);
const adapterPath = arg('adapter');
if (!adapterPath) { console.error('usage: runner.mjs --adapter ./adapter.mjs [--stages 1-20] [--runs 100] [--personas ...] [--campaign] [--set k=v]'); process.exit(1); }

const adapter = (await import(pathToFileURL(path.resolve(adapterPath)).href)).default;
const params = parseSet(argv);
let runs = +arg('runs', 100), personas = String(arg('personas', 'random,novice,smart,optimizer')).split(',');
const seed0 = +arg('seed', 1), maxSteps = +arg('max-steps', 5000), outDir = arg('out', 'logs');
let fullRuns = +arg('full', 3);
const campaign = has('campaign'), retries = +arg('retries', 2);
const opts = { noviceError: +arg('novice-error', 0.25), depth: +arg('depth', 2) };

// stage selection: "1-20" = 1-based index range into adapter.stages, otherwise comma separated ids
const all = adapter.stages;
let stages = all;
const sel = arg('stages');
if (sel) stages = /^\d+(-\d+)?$/.test(sel)
  ? (([a, b]) => all.slice(a - 1, (b || a)))(sel.split('-').map(Number))
  : sel.split(',').map((s) => all.find((x) => String(x) === s)).filter((x) => x !== undefined);

// --shard i/N (set by the parent when --jobs > 1): this process plays only the runs with index % N == i
const shard = arg('shard') ? (([i, n]) => ({ i, n }))(arg('shard').split('/').map(Number)) : null;
const cores = (os.availableParallelism ? os.availableParallelism() : os.cpus().length);
// default workers: free cores (cores minus the current load), at most 8; an adapter can lower it (adapter.maxJobs, e.g. a heavy engine)
let jobs = has('jobs') ? Math.max(1, +arg('jobs')) : Math.max(1, Math.min(8, Math.round(cores - os.loadavg()[0]) - 1));
jobs = Math.min(jobs, adapter.maxJobs || Infinity, (adapter.external && adapter.external.maxJobs) || Infinity);
if (shard || arg('replay')) jobs = 1;
jobs = Math.min(jobs, Math.max(1, runs));

// --replay persona:stage:run
let replay = null;
if (arg('replay')) {
  const [p, s, r] = arg('replay').split(':');
  const stage = all.find((x) => String(x) === s);
  if (stage === undefined) { console.error('replay: unknown stage ' + s); process.exit(1); }
  replay = { persona: p, stage, run: +r, lines: [] };
  personas = [p]; fullRuns = Infinity;
  stages = campaign ? all.slice(0, all.indexOf(stage) + 1) : [stage];
}

for (const p of personas) if (!PERSONAS[p]) { console.error('unknown persona ' + p + ' (have: ' + Object.keys(PERSONAS).join(', ') + ')'); process.exit(1); }
if (!replay) {
  fs.mkdirSync(outDir, { recursive: true });
  for (const p of personas) fs.writeFileSync(path.join(outDir, p + '.jsonl'), '');
}
const flush = (persona, stage, lines) => {
  if (replay) { if (stage === replay.stage) replay.lines.push(...lines.map((l) => JSON.parse(l))); }
  else fs.appendFileSync(path.join(outDir, persona + '.jsonl'), lines.join('\n') + '\n');
};

// ---- external adapter: the game runs in ANOTHER program (Godot, Unity, a browser, Python ...) that writes balance-sim logs ----
// adapter.external = { command(ctx) -> { command, args, cwd?, env? }, maxJobs? }  ctx = { persona, runs, runFrom, seed, stages (ids), stageArg,
// campaign, retries, params, out }. The program plays `runs` runs starting at run number `runFrom` and writes JSONL (same format as
// below) to <ctx.out>/<persona>*.jsonl. The runner splits runs into slices, runs them in parallel and joins the files.
if (adapter.external) {
  if (replay) { console.error('--replay is not available for external adapters: replay inside the game program.'); process.exit(1); }
  const J = Math.max(1, jobs), per = Math.max(1, Math.min(runs, Math.floor(J / personas.length) || 1)), tasks = [];
  for (const p of personas) for (let j = 0; j < per; j++) {
    const from = Math.floor(runs * j / per), n = Math.floor(runs * (j + 1) / per) - from;
    if (n > 0) tasks.push({ p, from, n, out: path.join(os.tmpdir(), `bsim-ext-${process.pid}-${p}-${from}`) });
  }
  const t1 = Date.now(); let next = 0, failed = null;
  const runTask = (t) => new Promise((resolve) => {
    fs.mkdirSync(t.out, { recursive: true });
    const spec = adapter.external.command({ persona: t.p, runs: t.n, runFrom: t.from, seed: seed0, stages: stages.map(String), stageArg: sel || null, campaign, retries, params, out: t.out });
    const c = spawn(spec.command, spec.args || [], { cwd: spec.cwd || process.cwd(), env: { ...process.env, ...(spec.env || {}) }, stdio: ['ignore', 'pipe', 'pipe'] });
    let tail = ''; const keep = (d) => { tail = (tail + d).slice(-2000); };
    c.stdout.on('data', keep); c.stderr.on('data', keep);
    c.on('error', (e) => { failed = failed || `could not start ${spec.command}: ${e.message}`; resolve(); });
    c.on('close', (code) => { if (code !== 0) failed = failed || `${t.p} slice from run ${t.from} exited with ${code}:\n${tail}`; resolve(); });
  });
  const worker = async () => { while (next < tasks.length && !failed) await runTask(tasks[next++]); };
  console.error(`  external adapter: ${tasks.length} slices, ${Math.min(J, tasks.length)} at a time`);
  await Promise.all(Array.from({ length: Math.min(J, tasks.length) }, worker));
  if (failed) { console.error('external run failed: ' + failed); process.exit(1); }
  let total = 0;
  for (const t of tasks) for (const f of fs.readdirSync(t.out).sort()) {
    if (!f.endsWith('.jsonl') || !f.startsWith(t.p) || !/^[._]/.test(f.slice(t.p.length))) continue;
    const body = fs.readFileSync(path.join(t.out, f), 'utf8'); total += body.split('\n').filter((l) => l.includes('"type":"end"')).length;
    fs.appendFileSync(path.join(outDir, t.p + '.jsonl'), body.endsWith('\n') || !body ? body : body + '\n');
  }
  for (const t of tasks) fs.rmSync(t.out, { recursive: true, force: true });
  console.log(`balance-sim: ${total} ${campaign ? 'attempts (campaign)' : 'runs'} (${personas.join(', ')}) x ${stages.length} stages x ${runs} in ${((Date.now() - t1) / 1000).toFixed(1)}s via external adapter (${tasks.length} slices) -> ${outDir}/`);
  process.exit(0);
}

// Guard: the same seed must give the same run. A game that calls Math.random() directly makes every comparison noise.
if (!replay && !has('no-check')) {
  const st = stages[0], seedC = seedFor(seed0, all.indexOf(st), 0, 1);
  const once = () => {
    const profile = campaign && adapter.newProfile ? adapter.newProfile({ seed: seedC, params, startStage: st }) : null;
    const pr = playRun({ adapter, persona: 'smart', stage: st, seed: seedC, params, opts, sink() {}, profile, maxSteps });
    return JSON.stringify([pr.res, pr.steps, pr.error]);
  };
  try { if (once() !== once()) console.error('WARNING: NONDETERMINISTIC. The same seed gave two different runs of stage ' + st + '. Route every random call of the game through the seeded rng (see SKILL.md, "Determinism"). Results and --replay are unreliable until fixed.'); }
  catch (e) { /* adapters that need a campaign profile are checked only in --campaign mode */ }
}

// ---- parallel: split the runs between worker processes, then concatenate their logs ----
if (jobs > 1 && !replay) {
  const strip = (a, flag) => { const o = []; for (let i = 0; i < a.length; i++) { if (a[i] === flag) { i++; continue; } o.push(a[i]); } return o; };
  let base = argv; for (const f of ['--jobs', '--out', '--shard', '--no-check']) base = strip(base, f);
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bsim-par-')), t1 = Date.now();
  const self = fileURLToPath(import.meta.url);
  const kids = Array.from({ length: jobs }, (_, i) => new Promise((resolve) => {
    const out = path.join(tmp, String(i));
    const c = spawn(process.execPath, [self, ...base, '--jobs', '1', '--shard', `${i}/${jobs}`, '--no-check', '--out', out], { stdio: ['ignore', 'pipe', 'pipe'] });
    let so = '', se = '';
    c.stdout.on('data', (d) => { so += d; }); c.stderr.on('data', (d) => { se += d; if (i === 0) process.stderr.write(d); });
    c.on('close', (code) => resolve({ i, out, code, so, se }));
  }));
  const done = await Promise.all(kids);
  const bad = done.find((k) => k.code !== 0);
  if (bad) { console.error('worker ' + bad.i + ' failed:\n' + bad.se.slice(-1500)); process.exit(1); }
  let n = 0;
  for (const k of done) { n += +((/balance-sim: (\d+)/.exec(k.so) || [])[1] || 0); }
  for (const p of personas) for (const k of done) { const f = path.join(k.out, p + '.jsonl'); if (fs.existsSync(f)) fs.appendFileSync(path.join(outDir, p + '.jsonl'), fs.readFileSync(f)); }
  fs.rmSync(tmp, { recursive: true, force: true });
  console.log(`balance-sim: ${n} ${campaign ? 'attempts (campaign)' : 'runs'} (${personas.join(', ')}) x ${stages.length} stages x ${runs} in ${((Date.now() - t1) / 1000).toFixed(1)}s with ${jobs} workers -> ${outDir}/`);
  process.exit(0);
}

const t0 = Date.now();
let total = 0;
const runIdxs = (n) => replay ? [replay.run] : Array.from({ length: n }, (_, i) => i).filter((i) => !shard || i % shard.n === shard.i);

for (const persona of personas) {
  if (!replay && personas.length > 1) console.error(`  ${persona} ... (${((Date.now() - t0) / 1000).toFixed(0)}s elapsed)`);
  if (!campaign) {
    for (const stage of stages) {
      const si = all.indexOf(stage);
      for (const r of runIdxs(PERSONAS[persona].deterministic ? 1 : runs)) {
        const seed = seedFor(seed0, si, r), lines = [];
        const base = { run: r, seed, persona, stage };
        const sink = (e) => { if (r < fullRuns || e.type === 'end') lines.push(JSON.stringify({ ...base, ...e })); };
        const pr = playRun({ adapter, persona, stage, seed, params, opts, sink, profile: null, maxSteps });
        sink({ type: 'end', step: pr.steps, t: pr.res.time ?? pr.steps, ...pr.res, steps: pr.steps, error: pr.error, acts: pr.acts });
        flush(persona, stage, lines);
        total++;
      }
    }
  } else {
    for (const r of runIdxs(PERSONAS[persona].deterministic ? 1 : runs)) {
      const prng = mulberry32(seedFor(seed0, 99991, r) ^ 0x51ed270b);   // shop / spending randomness
      let profile = adapter.newProfile ? adapter.newProfile({ seed: seedFor(seed0, 99991, r), params, startStage: stages[0] }) : null;
      for (const stage of stages) {
        const si = all.indexOf(stage);
        let cleared = false;
        for (let attempt = 1; attempt <= retries + 1; attempt++) {
          const seed = seedFor(seed0, si, r, attempt), lines = [];
          const base = { run: r, seed, persona, stage, attempt, campaign: true };
          const sink = (e) => { if (r < fullRuns || e.type === 'end' || e.type === 'stall') lines.push(JSON.stringify({ ...base, ...e })); };
          // the player prepares BEFORE every attempt: spends what earlier attempts brought (persona skill matters here)
          if (adapter.shop) adapter.shop({ profile, stage, attempt, persona, rng: prng, opts, params, emit: (type, e = {}) => sink({ ...e, type, step: 0, t: 0 }) });
          const pr = playRun({ adapter, persona, stage, seed, params, opts, sink, profile, maxSteps });
          const won = !!pr.res.win;
          const hook = { profile, stage, result: pr.res, won, attempt, persona, rng: prng, opts, params, emit: (type, e = {}) => sink({ ...e, type, step: 0, t: pr.res.time ?? 0 }) };
          if (adapter.afterStage) adapter.afterStage(hook);   // rewards, progression (income of the finished attempt)
          sink({ type: 'end', step: pr.steps, t: pr.res.time ?? pr.steps, ...pr.res, steps: pr.steps, error: pr.error, acts: pr.acts, snap: adapter.snapshot ? adapter.snapshot(profile) : null });
          total++;
          if (won) { cleared = true; flush(persona, stage, lines); break; }
          if (attempt > retries) sink({ type: 'stall', step: pr.steps, t: pr.res.time ?? 0 });
          flush(persona, stage, lines);
        }
        if (!cleared) break;   // player quits: later stages get no data (the funnel shows it)
      }
    }
  }
}

if (replay) {
  const ev = replay.lines;
  console.log(`replay ${replay.persona} stage ${replay.stage} run ${replay.run}  (${ev.filter((e) => e.type !== 'end').length} events)`);
  for (const e of ev) {
    if (e.type === 'end') console.log(`--- attempt ${e.attempt ?? 1} end: ${e.win ? 'WIN' : 'LOSS'}  hp ${e.hpLeft}/${e.hpMax}  time ${(+e.time).toFixed(1)}  income ${e.income}${e.snap ? '  snap ' + JSON.stringify(e.snap) : ''}${e.error ? '  ERROR ' + e.error : ''}`);
    else console.log((e.attempt ? `a${e.attempt} ` : '') + fmtEvent(e));
  }
} else {
  console.log(`balance-sim: ${total} ${campaign ? 'attempts (campaign)' : 'runs'} (${personas.join(', ')}) x ${stages.length} stages x ${runs} in ${((Date.now() - t0) / 1000).toFixed(1)}s -> ${outDir}/`);
}
