#!/usr/bin/env node
// balance-sim detect: step 1 of the workflow for the CONVERSATION mode (no web app): measure how hard the game is
// right now and print the difficulty scores, so the agent can talk them through with the user.
// It writes the same run folder as the web studio (<game>/.balance-sim/runs/<id>/), so the studio shows these runs too.
//
//   node detect.mjs [--dir <game folder>] [--adapter tools/balance/adapter.mjs] [--targets tools/balance/targets.json]
//                   [--personas random,novice,smart] [--runs 100] [--retries 10] [--seed 1] [--stages 1-20]
//                   [--set key=value ...]  [--json]
//
// Output: summary (average difficulty, ramp, spikes, frustration, boredom, skill), a per-stage table and the stages worth a look.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { openProject, readJson, writeJson } from './project.mjs';
import { scores, summary, band, detectSummary } from './model.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const P = openProject(argv);
const adapter = await P.adapter();
const studio = adapter.studio || {}, campaign = !!adapter.campaign;
const personas = (P.arg('personas') || (studio.personas || ['random', 'novice', 'smart']).join(',')).split(',');
const runs = +(P.arg('runs') || studio.runs || 100), retries = +(P.arg('retries') ?? studio.retries ?? 2), seed = +(P.arg('seed') || 1), stages = P.arg('stages') || null;
const params = {};
argv.forEach((a, i) => { if (a === '--set' && argv[i + 1]) { const [k, ...v] = argv[i + 1].split('='); const raw = v.join('='); params[k] = raw !== '' && !isNaN(+raw) ? +raw : raw; } });

const id = P.newRunId('detect'), dir = P.runDir(id);
fs.mkdirSync(dir, { recursive: true });
const t = P.targets();
if (t) writeJson(path.join(dir, 'targets.json'), t);
const options = { personas, runs, retries, seed, stages, campaign, params, rounds: 6, k: 0.8, via: 'detect.mjs' };
const meta = { id, kind: 'detect', status: 'running', startedAt: new Date().toISOString(), options };
writeJson(path.join(dir, 'meta.json'), meta);
const run = (script, args) => execFileSync(process.execPath, [path.join(here, script), ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 1 << 28 });
const sets = Object.entries(params).flatMap(([k, v]) => ['--set', `${k}=${v}`]);
let log = '';
try {
  log += run('runner.mjs', ['--adapter', P.adapterPath, '--seed', String(seed), '--personas', personas.join(','), '--runs', String(runs), ...(campaign ? ['--campaign', '--retries', String(retries)] : []), ...(stages ? ['--stages', stages] : []), ...sets, '--out', path.join(dir, 'logs')]);
  log += run('analyze.mjs', ['--logs', path.join(dir, 'logs'), ...(t ? ['--targets', path.join(dir, 'targets.json')] : []), '--out', path.join(dir, 'report.json'), '--html', path.join(dir, 'report.html')]);
  meta.status = 'done';
} catch (e) { meta.status = 'failed'; log += String(e.stdout || '') + String(e.stderr || e.message); }
fs.writeFileSync(path.join(dir, 'console.log'), log);
meta.endedAt = new Date().toISOString();
const rep = readJson(path.join(dir, 'report.json'), null);
meta.summary = rep ? detectSummary(rep) : null;
writeJson(path.join(dir, 'meta.json'), meta);
if (meta.status !== 'done' || !rep) { console.error('detection failed, see ' + path.join(dir, 'console.log')); console.error(log.slice(-1200)); process.exit(1); }

const sc = scores(rep), sm = summary(rep, sc), ok = sc.filter((s) => !s.empty);
if (P.has('json')) { console.log(JSON.stringify({ run: id, summary: sm, stages: sc }, null, 1)); process.exit(0); }
const f0 = (x) => x == null ? '  -' : String(Math.round(x)).padStart(3);
console.log(`\nDETECTION ${id}`);
console.log(`reference bot: ${sm.tp}   runs per stage: ${runs}   stages with data: ${ok.length}/${sc.length}${campaign ? `   campaign, ${retries} retries` : ''}`);
console.log(`\nAVERAGE DIFFICULTY ${Math.round(sm.avg)} / 100 (${band(sm.avg)})`);
if (sm.trend != null) console.log(`ramp (last third minus first third): ${sm.trend >= 0 ? '+' : ''}${Math.round(sm.trend)} points`);
console.log(`spikes (much harder than the 3 stages before): ${sm.spikes}   frustrating stages: ${sm.frustrated}   boring stages: ${sm.bored}   skill reward: ${sm.skill == null ? 'n/a' : Math.round(sm.skill) + ' pts'}   mean confidence: +-${Math.round(sm.conf)}`);
console.log(`\nstage  difficulty  frustr  bored  skill  +-conf  win   tries  flags`);
for (const s of sc) {
  if (s.empty) { console.log(`${s.id.padEnd(6)} (no player reached it)`); continue; }
  const bar = '#'.repeat(Math.round(s.difficulty / 10)).padEnd(10, '.');
  console.log(`${s.id.padEnd(6)} ${f0(s.difficulty)} ${bar} ${f0(s.frustration)}    ${f0(s.boredom)}   ${f0(s.skill)}    ${f0(s.conf)}    ${String(Math.round(100 * s.win)).padStart(3)}%  ${s.tries.toFixed(1).padStart(4)}   ${s.flags.join(' ')}${s.lowN ? ' (few players)' : ''}`);
}
const look = ok.filter((s) => s.spike > 20 || s.frustration >= 45 || s.flags.some((f) => ['WALL', 'TOO_HARD', 'TOO_EASY', 'SPIKE', 'ONBOARDING_HARD'].includes(f))).sort((a, b) => Math.abs(b.spike) + b.frustration - Math.abs(a.spike) - a.frustration).slice(0, 8);
if (rep.onboarding) console.log(`\nOPENING (first ~${rep.onboarding.minutes} min = stages ${rep.onboarding.stages.join(', ')}${rep.onboarding.timeKnown ? '' : ', no play time in the logs so the first 3 stages'}): even weak players should pass here (${rep.onboarding.persona || 'target bot'} >= ${Math.round(100 * (rep.onboarding.persona ? rep.onboarding.minWin : rep.onboarding.smartMin))}% first try). ${rep.onboarding.persona ? '' : 'No novice persona in this run: checked with the target bot only. '}${ok.filter((s) => s.flags.includes('ONBOARDING_HARD')).map((s) => s.id).join(', ') || 'No stage in the opening is flagged.'}`);
console.log(`\nWORTH A LOOK: ${look.length ? look.map((s) => `${s.id} (difficulty ${Math.round(s.difficulty)}${s.spike > 20 ? `, spike +${Math.round(s.spike)}` : ''}${s.frustration >= 45 ? `, frustration ${Math.round(s.frustration)}` : ''})`).join('; ') : 'nothing stands out'}`);
const gid = adapter.studio && adapter.studio.genre;
console.log(gid ? `\ngame type (from the adapter): ${gid}. Advice and the shape of a good curve depend on it: see references/genres.json and SKILL.md "Game type first".` : '\ngame type: not declared. Ask the user what kind of game it is before recommending a curve (SKILL.md, "Game type first").');
console.log(`\nfull report: ${path.join(dir, 'report.html')}`);
console.log('Bots are not humans: these scores describe the bots. Difficulty = 100 x (1 - first-try win rate of the reference bot).');
