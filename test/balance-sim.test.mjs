// Run with: npm test   (node --test)
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const run = (script, args) => execFileSync(process.execPath, [path.join(root, 'scripts', script), ...args], { encoding: 'utf8', maxBuffer: 1 << 28 });
const adapter = (n) => path.join(root, 'examples', n, 'adapter.mjs');
const targets = (n) => path.join(root, 'examples', n, 'targets.json');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bs-test-'));
const lines = (dir, persona) => fs.readFileSync(path.join(dir, persona + '.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
const ends = (dir, persona) => lines(dir, persona).filter((e) => e.type === 'end');
const winRate = (list) => list.filter((e) => e.win).length / list.length;
test.after(() => fs.rmSync(tmp, { recursive: true, force: true }));

test('deterministic: same arguments give byte-identical logs', () => {
  const a = path.join(tmp, 'd1'), b = path.join(tmp, 'd2');
  for (const o of [a, b]) run('runner.mjs', ['--adapter', adapter('toy-wave'), '--runs', '15', '--personas', 'smart,optimizer', '--out', o]);
  for (const p of ['smart', 'optimizer']) assert.equal(fs.readFileSync(path.join(a, p + '.jsonl'), 'utf8'), fs.readFileSync(path.join(b, p + '.jsonl'), 'utf8'));
});

test('stage subset reproduces the same runs as a full pass (seed does not depend on --stages)', () => {
  const full = path.join(tmp, 'full'), sub = path.join(tmp, 'sub');
  run('runner.mjs', ['--adapter', adapter('toy-wave'), '--runs', '20', '--personas', 'smart', '--out', full]);
  run('runner.mjs', ['--adapter', adapter('toy-wave'), '--runs', '20', '--personas', 'smart', '--stages', '7', '--out', sub]);
  const pick = (d) => ends(d, 'smart').filter((e) => e.stage === 7).map((e) => [e.seed, e.win, e.steps]);
  assert.deepEqual(pick(sub), pick(full));
  assert.equal(pick(sub).length, 20);
});

test('turn based wave game: report has curve, CI, flags and json', () => {
  const dir = path.join(tmp, 'wave');
  run('runner.mjs', ['--adapter', adapter('toy-wave'), '--runs', '40', '--out', dir]);
  const out = run('analyze.mjs', ['--logs', dir, '--targets', targets('toy-wave'), '--out', path.join(tmp, 'wave.json'), '--details', '--stage', '5']);
  const rep = JSON.parse(fs.readFileSync(path.join(tmp, 'wave.json'), 'utf8'));
  assert.ok(rep.stages['1'].smart.win >= 0.9, 'stage 1 should be easy');
  assert.ok(rep.stages['1'].smart.lo <= rep.stages['1'].smart.win && rep.stages['1'].smart.hi >= rep.stages['1'].smart.win);
  assert.ok(Array.isArray(rep.stages['9'].flags));
  assert.match(out, /95% CI/);
  assert.match(out, /Economy \(faucet vs sink/);
});

test('idle auto battler in campaign mode: attempts, snapshots, stalls, funnel', () => {
  const dir = path.join(tmp, 'ab');
  run('runner.mjs', ['--adapter', adapter('toy-autobattle'), '--campaign', '--retries', '2', '--runs', '30', '--personas', 'random,smart', '--out', dir]);
  const e = ends(dir, 'smart');
  assert.ok(e.every((x) => x.campaign === true && x.attempt >= 1 && x.attempt <= 3));
  assert.equal(typeof e[0].snap.bank, 'number');
  assert.ok(lines(dir, 'smart').some((x) => x.type === 'stall'), 'the toy boss at stage 5/10 should stall someone');
  const out = run('analyze.mjs', ['--logs', dir, '--targets', targets('toy-autobattle')]);
  assert.match(out, /mode=campaign/);
  assert.match(out, /reach/);
  assert.match(out, /funnel/);
});

test('shop skill matters: smart spends better than random in campaign mode', () => {
  const dir = path.join(tmp, 'shop');
  run('runner.mjs', ['--adapter', adapter('toy-autobattle'), '--campaign', '--runs', '60', '--personas', 'random,smart', '--stages', '1-9', '--out', dir]);
  const first = (p) => ends(dir, p).filter((e) => e.attempt === 1 && e.stage >= 5);
  assert.ok(winRate(first('smart')) > winRate(first('random')), 'smart should beat random on the harder stages');
});

test('shot budget puzzle: lookahead personas beat random by a wide margin', () => {
  const dir = path.join(tmp, 'bud');
  run('runner.mjs', ['--adapter', adapter('toy-budget'), '--runs', '25', '--stages', '1-4', '--personas', 'random,smart', '--out', dir]);
  assert.ok(winRate(ends(dir, 'smart')) - winRate(ends(dir, 'random')) > 0.5);
});

test('sweep compares values of one parameter and names a best one', () => {
  const out = run('sweep.mjs', ['--adapter', adapter('toy-budget'), '--targets', targets('toy-budget'), '--param', 'budget', '--values', '0.8,1', '--runs', '15', '--stages', '1-4']);
  assert.match(out, /best value for budget/);
});

test('replay prints a readable timeline of one exact run', () => {
  const out = run('runner.mjs', ['--adapter', adapter('toy-wave'), '--replay', 'smart:3:2']);
  assert.match(out, /replay smart stage 3 run 2/);
  assert.match(out, /shoot/);
  assert.match(out, /end: (WIN|LOSS)/);
});

test('human calibration and html report', () => {
  const dir = path.join(tmp, 'hum');
  run('runner.mjs', ['--adapter', adapter('toy-wave'), '--runs', '20', '--out', dir]);
  const hf = path.join(tmp, 'humans.json');
  fs.writeFileSync(hf, JSON.stringify({ 1: 0.95, 2: 0.9, 3: 0.85, 4: 0.6 }));
  const html = path.join(tmp, 'r.html');
  const out = run('analyze.mjs', ['--logs', dir, '--targets', targets('toy-wave'), '--humans', hf, '--html', html]);
  assert.match(out, /closest to real players/);
  const h = fs.readFileSync(html, 'utf8');
  assert.ok(h.includes('<svg') && h.includes('prefers-color-scheme'));
});

test('lookahead clones do not share the random stream (no peeking at the future)', async () => {
  const a = (await import(pathToFileURL(adapter('toy-wave')).href)).default;
  const g = a.create({ stage: 3, seed: 5, emit() {}, params: {} });
  assert.notEqual(g.clone().observe().seed, g.observe().seed);
});

test('real time: actionRepeat makes the persona decide every N ticks, the game still ticks every step', async () => {
  const { playRun } = await import(pathToFileURL(path.join(root, 'scripts', 'lib.mjs')).href);
  let decisions = 0, ticks = 0;
  const ad = {
    actionRepeat: 5, stages: [1],
    create() {
      let t = 0;
      return { legalActions() { decisions++; return [{ type: 'fire' }, { type: 'noop' }]; }, step() { ticks++; t++; }, isDone: () => t >= 50, result: () => ({ win: true }) };
    },
  };
  const r = playRun({ adapter: ad, persona: 'random', stage: 1, seed: 1, params: {}, opts: {}, sink() {}, profile: null, maxSteps: 1000 });
  assert.equal(ticks, 50);
  assert.equal(decisions, 10);
  assert.equal(r.res.win, true);
});

test('params from --set reach the adapter', () => {
  const easy = path.join(tmp, 'p1'), hard = path.join(tmp, 'p2');
  const base = ['--adapter', adapter('toy-wave'), '--runs', '30', '--stages', '6', '--personas', 'smart'];
  run('runner.mjs', [...base, '--set', 'enemyHp=0.5', '--out', easy]);
  run('runner.mjs', [...base, '--set', 'enemyHp=2', '--out', hard]);
  assert.ok(winRate(ends(easy, 'smart')) > winRate(ends(hard, 'smart')));
});

test('tune evaluates candidates, adds a baseline, keeps history and shows details', () => {
  const st = path.join(tmp, 'tune-state');
  const base = ['--adapter', adapter('toy-wave'), '--targets', targets('toy-wave'), '--state', st, '--runs', '15', '--stages', '1-6'];
  const out = run('tune.mjs', [...base, '--cand', 'easy:enemyHp=0.7', '--cand', 'hard:enemyHp=1.8']);
  assert.match(out, /baseline loss/);
  assert.match(out, /easy/);
  const hist = run('tune.mjs', ['--state', st, '--history']);
  assert.match(hist, /base/);
  assert.match(hist, /hard/);
  const scout = run('tune.mjs', [...base, '--scout', '2', '--ranges', 'enemyHp=0.8..1.4']);
  assert.match(scout, /s4/);
  const det = run('tune.mjs', ['--state', st, '--adapter', adapter('toy-wave'), '--detail', 'easy']);
  assert.match(det, /stage\s+win\s+target/);
});

test('runner warns when a game is not deterministic for the same seed', () => {
  const bad = path.join(tmp, 'bad-adapter.mjs');
  fs.writeFileSync(bad, `export default { stages: [1], create() { let n = 0; return { legalActions: () => [{ type: 'a' }], step() { n += Math.random() < 0.5 ? 1 : 2; }, isDone: () => n >= 5, result: () => ({ win: true, time: n }) }; } };`);
  const r = spawnSync(process.execPath, [path.join(root, 'scripts', 'runner.mjs'), '--adapter', bad, '--runs', '3', '--personas', 'smart', '--out', path.join(tmp, 'bad-logs')], { encoding: 'utf8' });
  assert.match(r.stderr, /NONDETERMINISTIC/);
});
