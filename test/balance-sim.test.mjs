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
  // the page is self-contained: data is embedded JSON, the chart is drawn by the embedded script in the browser
  assert.ok(h.includes('<svg') && h.includes('prefers-color-scheme') && !h.includes('"__DATA__"') && !h.includes('/*JS*/'));
  const m = /<script id="d" type="application\/json">([\s\S]*?)<\/script>/.exec(h);
  const data = JSON.parse(m[1]);
  assert.equal(data.tp, 'smart');
  assert.ok(data.stages.length > 3 && data.stages[0].p.smart && Array.isArray(data.stages[0].flags));
  assert.ok(!/https?:\/\//.test(h.replace(/https?:\/\/www\.w3\.org[^"']*/g, '')), 'no network resources');
});

test('RANDOM_WINS is not raised on tutorial stages whose target is above 80%', () => {
  const dir = path.join(tmp, 'rw'), t = path.join(tmp, 'rw-targets.json');
  fs.writeFileSync(t, JSON.stringify({ targetPersona: 'smart', tolerance: 0.15, curve: { start: 0.95, end: 0.95, shape: 'linear' } }));
  run('runner.mjs', ['--adapter', adapter('toy-wave'), '--runs', '30', '--stages', '1-2', '--personas', 'random,smart', '--out', dir]);
  const rep = path.join(tmp, 'rw.json');
  run('analyze.mjs', ['--logs', dir, '--targets', t, '--out', rep]);
  const r = JSON.parse(fs.readFileSync(rep, 'utf8'));
  for (const st of Object.values(r.stages)) assert.ok(!st.flags.includes('RANDOM_WINS'));
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
  fs.writeFileSync(bad, `export default { stages: [1], policy: (g) => g.legalActions()[0], create() { let n = 0; return { legalActions: () => [{ type: 'a' }], step() { n += Math.random() < 0.5 ? 1 : 2; }, isDone: () => n >= 200, result: () => ({ win: true, time: n }) }; } };`);
  const r = spawnSync(process.execPath, [path.join(root, 'scripts', 'runner.mjs'), '--adapter', bad, '--runs', '3', '--personas', 'smart', '--out', path.join(tmp, 'bad-logs')], { encoding: 'utf8' });
  assert.match(r.stderr, /NONDETERMINISTIC/);
});

test('oracle persona (adapter solver) runs once per stage and always plays the solver line', () => {
  const ad = path.join(tmp, 'oracle-adapter.mjs');
  fs.writeFileSync(ad, `export default { stages: [1, 2], oracle: (g) => g.legalActions()[0] ?? null,
    create() { let n = 0; return { legalActions: () => (n < 3 ? [{ type: 'go' }] : []), step() { n++; }, isDone: () => n >= 3, result: () => ({ win: true, time: n }) }; } };`);
  const dir = path.join(tmp, 'oracle-logs');
  run('runner.mjs', ['--adapter', ad, '--runs', '7', '--personas', 'random,oracle', '--out', dir]);
  assert.equal(ends(dir, 'oracle').length, 2);   // 2 stages x 1 run
  assert.equal(ends(dir, 'random').length, 14);  // 2 stages x 7 runs
});

test('BOT_LOST replaces NO_SKILL when both bots almost never win', () => {
  const dir = path.join(tmp, 'lost'), ad = path.join(tmp, 'hard-adapter.mjs');
  fs.writeFileSync(ad, `export default { stages: [1], policy: (g) => g.legalActions()[0],
    create() { let n = 0; return { legalActions: () => [{ type: 'a' }], step() { n++; }, isDone: () => n >= 5, result: () => ({ win: false, time: n }) }; } };`);
  run('runner.mjs', ['--adapter', ad, '--runs', '30', '--personas', 'random,smart', '--out', dir]);
  const rep = path.join(tmp, 'lost.json');
  run('analyze.mjs', ['--logs', dir, '--out', rep]);
  const fl = JSON.parse(fs.readFileSync(rep, 'utf8')).stages['1'].flags;
  assert.ok(fl.includes('BOT_LOST') && !fl.includes('NO_SKILL'));
});

test('studio: serves the app, saves a target, runs a detection job and exposes the logs', async () => {
  const { spawn } = await import('node:child_process');
  const proj = path.join(tmp, 'studio-proj');
  fs.mkdirSync(proj, { recursive: true });
  const port = 4300 + Math.floor(Math.random() * 500);
  const child = spawn(process.execPath, [path.join(root, 'scripts', 'studio.mjs'), '--no-open', '--port', String(port), '--dir', proj, '--adapter', adapter('toy-wave'), '--targets', path.join(proj, 'targets.json')], { stdio: ['ignore', 'pipe', 'pipe'] });
  try {
    await new Promise((res, rej) => { const t = setTimeout(() => rej(new Error('studio did not start')), 15000); child.stdout.on('data', (d) => { if (String(d).includes('127.0.0.1')) { clearTimeout(t); res(); } }); child.on('exit', () => rej(new Error('studio exited'))); });
    const base = `http://127.0.0.1:${port}`;
    const get = async (p) => (await fetch(base + p)).json();
    const post = async (p, body) => (await fetch(base + p, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })).json();
    assert.ok((await (await fetch(base + '/')).text()).includes('Balance Studio'));
    const st = await get('/api/state');
    assert.ok(st.info.stages.length > 3 && !st.infoError && st.info.levers.param === 'stageMul.{stage}');
    await post('/api/targets', { targets: { targetPersona: 'smart', tolerance: 0.15, stages: { 1: { firstTryWin: 0.9 } } } });
    const job = await post('/api/jobs', { kind: 'detect', personas: ['random', 'smart'], runs: 8, retries: 0, seed: 1, stages: '1-3' });
    assert.ok(job.id);
    for (let i = 0; i < 60; i++) { const s = await get('/api/state'); if (!s.job || s.job.status !== 'running') break; await new Promise((r) => setTimeout(r, 500)); }
    const run = await get('/api/runs/' + job.id);
    assert.equal(run.meta.status, 'done');
    assert.ok(run.report.stages['1'].smart && run.meta.summary.avgDifficulty != null);
    const att = await get(`/api/runs/${job.id}/attempts?persona=smart&limit=5`);
    assert.ok(att.length > 0 && att[0].persona === 'smart');
    assert.ok((await (await fetch(`${base}/run/${job.id}/report.html`)).text()).includes('Balance report'));
    // calibration through the studio: the toy adapter declares a per-stage lever
    const cal = await post('/api/jobs', { kind: 'calibrate', rounds: 2, runs: 20, seed: 1, retries: 0 });
    assert.ok(cal.id, JSON.stringify(cal));
    for (let i = 0; i < 120; i++) { const s2 = await get('/api/state'); if (!s2.job || s2.job.status !== 'running') break; await new Promise((r) => setTimeout(r, 500)); }
    const c = await get('/api/runs/' + cal.id);
    assert.equal(c.meta.status, 'done');
    assert.ok(c.result && c.result.before && c.result.after && Array.isArray(c.result.changes));
  } finally { child.kill(); }
});

test('calibrate refuses politely when the adapter declares no lever', () => {
  const r = spawnSync(process.execPath, [path.join(root, 'scripts', 'calibrate.mjs'), '--adapter', adapter('toy-budget'), '--targets', targets('toy-budget'), '--out', path.join(tmp, 'nolever')], { encoding: 'utf8' });
  assert.equal(r.status, 2);
  assert.match(r.stderr, /no levers\.stage/);
});

test('model: average difficulty is kept exactly and the spread decides where the change lands', async () => {
  const M = await import(pathToFileURL(path.join(root, 'scripts', 'model.mjs')).href);
  const ids = Array.from({ length: 20 }, (_, i) => String(i + 1)), measured = ids.map((_, i) => 10 + i * 2);
  const T = { ...M.defaultT(), template: 'measured', snapshot: measured, average: 40 };
  const eq = M.targetCurve({ ...T, spread: 'equal' }, ids, measured), later = M.targetCurve({ ...T, spread: 'later' }, ids, measured);
  assert.ok(Math.abs(M.mean(eq) - 40) < 0.5 && Math.abs(M.mean(later) - 40) < 0.5);
  assert.ok(later[0] < eq[0] && later[19] > eq[19]);                       // later = early stages move less, last stages more
  const keep = M.targetCurve({ ...M.defaultT(), template: 'measured', snapshot: measured }, ids, measured);
  assert.ok(keep.every((v, i) => Math.abs(v - measured[i]) < 1e-9));       // "keep current" equals the measurement
  const j = M.targetsJson(T, ids, measured, {});
  assert.equal(Object.keys(j.stages).length, 20);
  assert.ok(Math.abs(j.stages['1'].firstTryWin - (1 - eq[0] / 100)) < 0.001);
});

test('conversation mode: detect.mjs prints scores, target.mjs is a dry run until --write', () => {
  const proj = path.join(tmp, 'conv-proj');
  fs.mkdirSync(proj, { recursive: true });
  const common = ['--dir', proj, '--adapter', adapter('toy-wave'), '--targets', path.join(proj, 'targets.json')];
  const det = run('detect.mjs', [...common, '--runs', '30']);
  assert.match(det, /AVERAGE DIFFICULTY/);
  assert.match(det, /WORTH A LOOK/);
  const dry = run('target.mjs', [...common, '--shift', '+10', '--spread', 'later', '--tag', '3=boss']);
  assert.match(dry, /DRY RUN/);
  assert.ok(!fs.existsSync(path.join(proj, 'targets.json')));
  const wr = run('target.mjs', [...common, '--shift', '+10', '--write']);
  assert.match(wr, /WRITTEN/);
  const t = JSON.parse(fs.readFileSync(path.join(proj, 'targets.json'), 'utf8'));
  assert.ok(t.studio && Object.keys(t.stages).length === 10);
  const runs = fs.readdirSync(path.join(proj, '.balance-sim', 'runs'));
  assert.ok(runs.some((d) => d.startsWith('detect-')));                      // same run folder as the web studio
});
