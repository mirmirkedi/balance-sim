#!/usr/bin/env node
// balance-sim runner: plays every stage many times with several personas and writes JSONL logs.
//
//   node runner.mjs --adapter ./adapter.mjs [--stages 1-20|id,id] [--runs 100]
//                   [--personas random,novice,smart,optimizer] [--seed 1]
//                   [--full 3] [--max-steps 5000] [--out logs] [--novice-error 0.25]
//
// Log files: <out>/<persona>.jsonl, one JSON object per line.
//   type "end"  : one per run (always written)   {win, hpLeft, hpMax, time, deaths, income, resources, timeout, steps}
//   other types : game events from adapter emit() (written only for the first --full runs per persona+stage,
//                 so logs stay small while the curve still uses every run)
// Every line also carries: run, seed, persona, stage, step, t.
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { PERSONAS } from './personas.mjs';
import { mulberry32 } from './rng.mjs';

const argv = process.argv.slice(2);
const arg = (n, d) => { const i = argv.indexOf('--' + n); return i < 0 ? d : argv[i + 1]; };
const adapterPath = arg('adapter');
if (!adapterPath) { console.error('usage: runner.mjs --adapter ./adapter.mjs [--stages 1-20] [--runs 100] [--personas ...]'); process.exit(1); }

const adapter = (await import(pathToFileURL(path.resolve(adapterPath)).href)).default;
const runs = +arg('runs', 100), seed0 = +arg('seed', 1), fullRuns = +arg('full', 3);
const maxSteps = +arg('max-steps', 5000), outDir = arg('out', 'logs');
const personas = String(arg('personas', 'random,novice,smart,optimizer')).split(',');
const opts = { noviceError: +arg('novice-error', 0.25), depth: +arg('depth', 2) };

// stage selection: "1-20" = 1-based index range into adapter.stages, otherwise comma separated ids
const all = adapter.stages;
let stages = all;
const sel = arg('stages');
if (sel) stages = /^\d+(-\d+)?$/.test(sel)
  ? (([a, b]) => all.slice(a - 1, (b || a)))(sel.split('-').map(Number))
  : sel.split(',').map((s) => all.find((x) => String(x) === s)).filter((x) => x !== undefined);

fs.mkdirSync(outDir, { recursive: true });
for (const p of personas) {
  if (!PERSONAS[p]) { console.error('unknown persona ' + p + ' (have: ' + Object.keys(PERSONAS).join(', ') + ')'); process.exit(1); }
  fs.writeFileSync(path.join(outDir, p + '.jsonl'), '');
}

const t0 = Date.now();
let total = 0;
for (const persona of personas) {
  const file = path.join(outDir, persona + '.jsonl');
  for (const [si, stage] of stages.entries()) {
    for (let r = 0; r < runs; r++) {
      const seed = seed0 * 1_000_003 + si * 7919 + r * 104729;
      const lines = [];
      let step = 0, game = null;
      const base = () => ({ run: r, seed, persona, stage, step, t: game && game.time ? game.time() : step });
      const emit = (type, e = {}) => {
        if (r >= fullRuns && type !== 'end') return;
        lines.push(JSON.stringify({ ...base(), type, ...e }));
      };
      const rng = mulberry32(seed ^ 0x9e3779b9); // persona randomness, separate from the game's own RNG
      let res, error = null;
      try {
        game = adapter.create({ stage, seed, emit });
        while (!game.isDone() && step < maxSteps) {
          const a = PERSONAS[persona](game, rng, adapter, opts);
          if (a == null) break;
          game.step(a);
          step++;
        }
        res = game.result();
        res.timeout = !game.isDone();
      } catch (err) { error = String(err && err.stack || err).split('\n').slice(0, 3).join(' | '); res = { win: false }; }
      lines.push(JSON.stringify({ ...base(), type: 'end', ...res, steps: step, error }));
      fs.appendFileSync(file, lines.join('\n') + '\n');
      total++;
    }
  }
}
console.log(`balance-sim: ${total} runs (${personas.join(', ')}) x ${stages.length} stages x ${runs} in ${((Date.now() - t0) / 1000).toFixed(1)}s -> ${outDir}/`);
