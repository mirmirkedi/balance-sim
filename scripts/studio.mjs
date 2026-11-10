#!/usr/bin/env node
// balance-sim studio: a local web app that runs the whole balancing workflow for ONE game.
//
//   cd <game folder> && node ~/.claude/skills/balance-sim/scripts/studio.mjs [--adapter tools/balance/adapter.mjs]
//                                                   [--targets tools/balance/targets.json] [--port 4173] [--no-open]
//
// 1. Detect     run the bots on every stage, get an average difficulty and a difficulty score per stage
// 2. Target     pick a template curve, set the average difficulty, tag stages (harder / easier / boss / breather)
// 3. Calibrate  move the adapter's per-stage levers until the measured curve meets the target (scripts/calibrate.mjs)
// 4. Logs       every run keeps its console output, attempt log, parameters and report; replay any attempt
//
// No dependencies. The server only listens on 127.0.0.1. State lives in <game folder>/.balance-sim/.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { spawn, exec } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { detectSummary } from './model.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const arg = (n, d) => { const i = argv.indexOf('--' + n); return i < 0 ? d : argv[i + 1]; };
const has = (n) => argv.includes('--' + n);
const projectDir = path.resolve(arg('dir', process.cwd()));
// a relative path from the command line may be relative to where you typed it or to the game folder: use whichever exists
const show = (p) => { const r = path.relative(projectDir, p); return r.startsWith('..') ? p : r; };
const where = (v) => { const a = path.resolve(process.cwd(), v), b = path.resolve(projectDir, v); return path.isAbsolute(v) || fs.existsSync(a) ? a : b; };
const adapterPath = where(arg('adapter', 'tools/balance/adapter.mjs'));
const targetsPath = where(arg('targets', 'tools/balance/targets.json'));
const port = +arg('port', 4173);
const stateDir = path.join(projectDir, '.balance-sim'), runsDir = path.join(stateDir, 'runs'), cfgPath = path.join(stateDir, 'config.json');
fs.mkdirSync(runsDir, { recursive: true });
if (!fs.existsSync(path.join(stateDir, '.gitignore'))) fs.writeFileSync(path.join(stateDir, '.gitignore'), 'runs/\n');
const web = path.join(here, 'studio');

// ---------- project: adapter facts and saved settings ----------
let info = null, infoError = null;
async function loadAdapter() {
  info = null; infoError = null;
  if (!fs.existsSync(adapterPath)) { infoError = `No adapter at ${show(adapterPath)}. Ask Claude to write one for this game (balance-sim SKILL.md, step 2), or pass --adapter.`; return; }
  try {
    const a = (await import(pathToFileURL(adapterPath).href + '?t=' + Date.now())).default;
    const l = a.levers && a.levers.stage;
    info = {
      stages: a.stages.map(String), campaign: !!a.campaign, studio: a.studio || {}, hasOracle: !!a.oracle, hasEvaluate: !!a.evaluate,
      levers: l ? { param: l.param, mode: l.mode || 'mul', harder: l.harder ?? 1, min: l.min ?? null, max: l.max ?? null, default: l.default ?? null, unit: l.unit || '', integer: !!l.integer } : null,
      leverValues: l ? Object.fromEntries(a.stages.map(String).map((s) => [s, l.read ? l.read(s) : l.default ?? null])) : null,
    };
  } catch (e) { infoError = 'The adapter did not load: ' + (e && e.message ? e.message : e); }
}
const readJson = (p, d) => { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch (e) { return d; } };
const writeJson = (p, o) => fs.writeFileSync(p, JSON.stringify(o, null, 2) + '\n');
const defaults = () => ({ personas: (info && info.studio.personas) || ['random', 'novice', 'smart'], runs: (info && info.studio.runs) || 100, retries: (info && info.studio.retries) || 2, seed: 1, candidate: null });
const config = () => ({ ...defaults(), ...readJson(cfgPath, {}) });
const targets = () => readJson(targetsPath, null);

// ---------- runs on disk ----------
const idOk = (s) => /^[\w-]+$/.test(String(s));
const runDir = (id) => path.join(runsDir, id);
const listRuns = () => fs.readdirSync(runsDir).filter((d) => fs.existsSync(path.join(runsDir, d, 'meta.json'))).map((d) => readJson(path.join(runsDir, d, 'meta.json'), null)).filter(Boolean).sort((a, b) => (b.startedAt > a.startedAt ? 1 : -1));
const stamp = (kind) => kind + '-' + new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14) + '-' + Math.random().toString(36).slice(2, 5);

// ---------- jobs (one at a time) ----------
let job = null;   // { id, kind, status, lines, subs, child, stopped }
const emitLine = (j, text) => { for (const l of String(text).split('\n')) { if (!l.trim()) continue; j.lines.push(l); fs.appendFileSync(path.join(runDir(j.id), 'console.log'), l + '\n'); for (const s of j.subs) s.write(`data: ${JSON.stringify(l)}\n\n`); } };
function step(j, script, args) {
  return new Promise((resolve) => {
    emitLine(j, `$ node ${script} ${args.join(' ').slice(0, 220)}`);
    const child = spawn(process.execPath, [path.join(here, script), ...args], { cwd: projectDir, env: process.env });
    j.child = child;
    child.stdout.on('data', (d) => emitLine(j, d.toString()));
    child.stderr.on('data', (d) => emitLine(j, d.toString()));
    child.on('close', (code) => { j.child = null; resolve(code); });
  });
}
const setArgs = (params) => Object.entries(params || {}).flatMap(([k, v]) => ['--set', `${k}=${v}`]);

async function startJob(kind, o) {
  if (job && job.status === 'running') throw new Error('Another job is running: ' + job.id);
  if (!info) throw new Error(infoError || 'No adapter');
  const cfg = config(), id = stamp(kind), dir = runDir(id);
  fs.mkdirSync(dir, { recursive: true });
  const t = targets();
  if (t) writeJson(path.join(dir, 'targets.json'), t);
  const cand = o.useCandidate && cfg.candidate ? cfg.candidate.params : null;
  const options = { personas: o.personas || cfg.personas, runs: +(o.runs || cfg.runs), retries: +(o.retries ?? cfg.retries), seed: +(o.seed || cfg.seed), stages: o.stages || null, campaign: info.campaign, params: cand || {}, rounds: +(o.rounds || 6), k: +(o.k || 0.8) };
  const meta = { id, kind, status: 'running', startedAt: new Date().toISOString(), options };
  writeJson(path.join(dir, 'meta.json'), meta);
  fs.writeFileSync(path.join(dir, 'console.log'), '');
  const j = job = { id, kind, status: 'running', lines: [], subs: new Set(), child: null, stopped: false };
  (async () => {
    let code = 0;
    const common = ['--adapter', adapterPath, '--seed', String(options.seed), ...(options.campaign ? ['--campaign', '--retries', String(options.retries)] : []), ...(options.stages ? ['--stages', options.stages] : [])];
    if (kind === 'detect') {
      code = await step(j, 'runner.mjs', [...common, '--personas', options.personas.join(','), '--runs', String(options.runs), ...setArgs(options.params), '--out', path.join(dir, 'logs')]);
      if (!code && !j.stopped) code = await step(j, 'analyze.mjs', ['--logs', path.join(dir, 'logs'), ...(t ? ['--targets', path.join(dir, 'targets.json')] : []), '--out', path.join(dir, 'report.json'), '--html', path.join(dir, 'report.html')]);
    } else {
      if (!t) { emitLine(j, 'Save a target first (Target tab).'); code = 1; }
      else {
        if (options.params && Object.keys(options.params).length) writeJson(path.join(dir, 'base.json'), options.params);
        code = await step(j, 'calibrate.mjs', ['--adapter', adapterPath, '--targets', path.join(dir, 'targets.json'), '--out', dir, '--rounds', String(options.rounds), '--runs', String(options.runs), '--k', String(options.k), '--seed', String(options.seed + 20), '--retries', String(options.retries), ...(options.campaign ? ['--campaign'] : []), ...(options.stages ? ['--stages', options.stages] : []), ...(fs.existsSync(path.join(dir, 'base.json')) ? ['--base', path.join(dir, 'base.json')] : [])]);
      }
    }
    meta.status = j.stopped ? 'stopped' : code ? 'failed' : 'done';
    meta.endedAt = new Date().toISOString();
    meta.summary = summarize(id, kind);
    writeJson(path.join(dir, 'meta.json'), meta);
    j.status = meta.status;
    for (const s of j.subs) { s.write(`event: done\ndata: ${JSON.stringify(meta.status)}\n\n`); s.end(); }
    j.subs.clear();
  })();
  return meta;
}
function summarize(id, kind) {
  const dir = runDir(id);
  if (kind === 'detect') { const rep = readJson(path.join(dir, 'report.json'), null); return rep ? detectSummary(rep) : null; }
  const res = readJson(path.join(dir, 'result.json'), null);
  return res ? { before: Math.round(res.before.loss * 1000) / 10, after: Math.round(res.after.loss * 1000) / 10, changed: res.changes.length } : null;
}

// ---------- http ----------
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json' };
const send = (res, code, body, type) => { res.writeHead(code, { 'content-type': type || 'application/json', 'cache-control': 'no-store' }); res.end(typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body)); };
const body = (req) => new Promise((resolve) => { let b = ''; req.on('data', (d) => { b += d; if (b.length > 5e6) req.destroy(); }); req.on('end', () => { try { resolve(b ? JSON.parse(b) : {}); } catch (e) { resolve({}); } }); });

function attempts(id, q) {
  const dir = path.join(runDir(id), 'logs'), out = [];
  if (!fs.existsSync(dir)) return out;
  const limit = Math.min(+q.get('limit') || 300, 2000), pf = q.get('persona'), sf = q.get('stage'), rf = q.get('result');
  for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.jsonl'))) {
    const persona = f.replace('.jsonl', '');
    if (pf && pf !== persona) continue;
    for (const line of fs.readFileSync(path.join(dir, f), 'utf8').split('\n')) {
      if (!line || !(line.includes('"type":"end"') || line.includes('"type":"stall"'))) continue;
      const e = JSON.parse(line);
      if (sf && String(e.stage) !== sf) continue;
      if (e.type === 'stall') { if (rf && rf !== 'stall') continue; } else if (rf === 'win' && !e.win) continue; else if (rf === 'loss' && e.win) continue; else if (rf === 'stall') continue;
      out.push({ persona, stage: String(e.stage), run: e.run, attempt: e.attempt || 1, type: e.type, win: !!e.win, hpLeft: e.hpLeft, hpMax: e.hpMax, time: e.time, income: e.income, error: e.error || null, seed: e.seed });
      if (out.length >= limit) return out;
    }
  }
  return out;
}
function replay(id, q) {
  return new Promise((resolve) => {
    const meta = readJson(path.join(runDir(id), 'meta.json'), null);
    if (!meta) return resolve('unknown run');
    const o = meta.options, ex = o.campaign ? ['--campaign', '--retries', String(o.retries)] : [];
    const child = spawn(process.execPath, [path.join(here, 'runner.mjs'), '--adapter', adapterPath, '--seed', String(o.seed), ...ex, ...setArgs(o.params), '--replay', `${q.get('persona')}:${q.get('stage')}:${q.get('run')}`], { cwd: projectDir, env: process.env });
    let text = '';
    child.stdout.on('data', (d) => { text += d; }); child.stderr.on('data', (d) => { text += d; });
    child.on('close', () => resolve(text.split('\n').slice(0, 400).join('\n')));
  });
}

const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, 'http://x'), p = u.pathname;
  try {
    if (req.method === 'GET' && (p === '/' || p === '/app.js' || p === '/app.css')) {
      const f = p === '/' ? 'app.html' : p.slice(1);
      return send(res, 200, fs.readFileSync(path.join(web, f)), MIME[path.extname(f)]);
    }
    if (req.method === 'GET' && p === '/api/genres') return send(res, 200, readJson(path.join(here, '..', 'references', 'genres.json'), {}));
    if (req.method === 'GET' && p === '/model.mjs') return send(res, 200, fs.readFileSync(path.join(here, 'model.mjs')), MIME['.js']);
    if (p === '/api/state') return send(res, 200, { project: path.basename(projectDir), dir: projectDir, adapter: show(adapterPath), targetsFile: show(targetsPath), info, infoError, config: config(), targets: targets(), runs: listRuns(), job: job ? { id: job.id, kind: job.kind, status: job.status } : null });
    if (p === '/api/reload' && req.method === 'POST') { await loadAdapter(); return send(res, 200, { ok: !infoError, error: infoError }); }
    if (p === '/api/config' && req.method === 'POST') { const b = await body(req); const c = { ...config(), ...b }; writeJson(cfgPath, c); return send(res, 200, c); }
    if (p === '/api/targets' && req.method === 'POST') {
      const b = await body(req);
      if (!b.targets || typeof b.targets !== 'object') return send(res, 400, { error: 'targets object missing' });
      if (fs.existsSync(targetsPath)) fs.copyFileSync(targetsPath, path.join(stateDir, 'targets.prev.json'));
      fs.mkdirSync(path.dirname(targetsPath), { recursive: true });
      writeJson(targetsPath, b.targets);
      return send(res, 200, { ok: true });
    }
    if (p === '/api/candidate' && req.method === 'POST') { const b = await body(req); const c = config(); c.candidate = b.params ? { params: b.params, from: b.from || null, savedAt: new Date().toISOString() } : null; writeJson(cfgPath, c); return send(res, 200, c); }
    if (p === '/api/jobs' && req.method === 'POST') { const b = await body(req); try { return send(res, 200, await startJob(b.kind === 'calibrate' ? 'calibrate' : 'detect', b)); } catch (e) { return send(res, 409, { error: e.message }); } }
    let m;
    if ((m = /^\/api\/jobs\/([\w-]+)\/stream$/.exec(p))) {
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive' });
      if (job && job.id === m[1] && job.status === 'running') { for (const l of job.lines) res.write(`data: ${JSON.stringify(l)}\n\n`); job.subs.add(res); req.on('close', () => job && job.subs.delete(res)); }
      else { const f = path.join(runDir(m[1]), 'console.log'); if (idOk(m[1]) && fs.existsSync(f)) for (const l of fs.readFileSync(f, 'utf8').split('\n')) if (l) res.write(`data: ${JSON.stringify(l)}\n\n`); res.write('event: done\ndata: "done"\n\n'); res.end(); }
      return;
    }
    if ((m = /^\/api\/jobs\/([\w-]+)\/stop$/.exec(p)) && req.method === 'POST') { if (job && job.id === m[1] && job.child) { job.stopped = true; job.child.kill(); } return send(res, 200, { ok: true }); }
    if ((m = /^\/api\/runs\/([\w-]+)$/.exec(p))) {
      const id = m[1], dir = runDir(id);
      if (!fs.existsSync(path.join(dir, 'meta.json'))) return send(res, 404, { error: 'no such run' });
      if (req.method === 'DELETE') { if (job && job.id === id && job.status === 'running') return send(res, 409, { error: 'running' }); fs.rmSync(dir, { recursive: true, force: true }); return send(res, 200, { ok: true }); }
      return send(res, 200, { meta: readJson(path.join(dir, 'meta.json'), null), report: readJson(path.join(dir, 'report.json'), null), progress: readJson(path.join(dir, 'progress.json'), null), result: readJson(path.join(dir, 'result.json'), null), targets: readJson(path.join(dir, 'targets.json'), null) });
    }
    if ((m = /^\/api\/runs\/([\w-]+)\/attempts$/.exec(p)) && idOk(m[1])) return send(res, 200, attempts(m[1], u.searchParams));
    if ((m = /^\/api\/runs\/([\w-]+)\/replay$/.exec(p)) && idOk(m[1])) return send(res, 200, await replay(m[1], u.searchParams), 'text/plain; charset=utf-8');
    if ((m = /^\/run\/([\w-]+)\/report\.html$/.exec(p)) && idOk(m[1]) && fs.existsSync(path.join(runDir(m[1]), 'report.html'))) return send(res, 200, fs.readFileSync(path.join(runDir(m[1]), 'report.html')), MIME['.html']);
    send(res, 404, { error: 'not found' });
  } catch (e) { send(res, 500, { error: String(e && e.message || e) }); }
});

await loadAdapter();
server.on('error', (e) => { console.error(e.code === 'EADDRINUSE' ? `Port ${port} is busy. Use --port.` : e.message); process.exit(1); });
server.listen(port, '127.0.0.1', () => {
  const url = `http://127.0.0.1:${port}/`;
  console.log(`balance-sim studio for ${path.basename(projectDir)}\n  ${url}\n  adapter: ${show(adapterPath)}${infoError ? '\n  ' + infoError : ` (${info.stages.length} stages${info.campaign ? ', campaign' : ''}${info.levers ? ', calibration levers' : ', no calibration levers'})`}\n  state:   ${path.relative(projectDir, stateDir)}/\nCtrl+C to stop.`);
  if (!has('no-open')) exec(process.platform === 'darwin' ? `open "${url}"` : process.platform === 'win32' ? `start "" "${url}"` : `xdg-open "${url}"`, () => {});
});
