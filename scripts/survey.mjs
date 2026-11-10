#!/usr/bin/env node
// balance-sim survey: WHAT is there to balance in this game, and does the simulation actually see it?
// Difficulty curves only cover stage strength. Games also have drops, an economy, upgrades, enemy and item tables.
// A system nobody measures stays unbalanced (a drop table that never drops looks fine in a win-rate report).
//
//   node survey.mjs [--dir <game folder>] [--logs <log folder>] [--files data/a.json,data/b.json] [--json]
//
// 1. DATA     every number in the game's JSON files (levels, parameters, tables), grouped by system: drops, economy, combat,
//             timing, progression, counts. Run this FIRST, read the files yourself, and ask the user which systems are in scope.
// 2. LOGS     what the bots actually experienced (latest detection run, or --logs): kills, drops per kill, resources gained
//             and spent, items seen. Needs event logs (runner --full N, default 3 runs per persona and stage).
// 3. FINDINGS systems that exist in the data but are invisible or inert in the logs: no drop events at all, stages where
//             enemies die and nothing drops, items that are defined but never seen, resources that are earned and never spent.
// Heuristics by key name: read them as pointers, not verdicts. Nothing is written.
import fs from 'node:fs';
import path from 'node:path';

const argv = process.argv.slice(2);
const arg = (n, d) => { const i = argv.indexOf('--' + n); return i < 0 ? d : argv[i + 1]; };
const has = (n) => argv.includes('--' + n);
const dir = path.resolve(arg('dir', process.cwd()));
const SKIP = new Set(['node_modules', '.git', '.godot', '.import', '.balance-sim', 'logs', 'dist', 'coverage', '.next', '__pycache__']);
const SKIP_FILE = /^(package(-lock)?|tsconfig|manifest|project|export_presets)\.json$|\.import$|report/i;

// ---------- 1. data ----------
function walk(d, depth, out) {
  if (depth > 5) return;
  let list; try { list = fs.readdirSync(d, { withFileTypes: true }); } catch (e) { return; }
  for (const e of list) {
    if (e.name.startsWith('.') && e.name !== '.demo') continue;
    const p = path.join(d, e.name);
    if (e.isDirectory()) { if (!SKIP.has(e.name)) walk(p, depth + 1, out); }
    else if (e.name.endsWith('.json') && !SKIP_FILE.test(e.name) && fs.statSync(p).size < 2_000_000) out.push(p);
  }
}
let files = [];
if (arg('files')) files = arg('files').split(',').map((f) => path.resolve(dir, f));
else walk(dir, 0, files);

const CATS = [
  ['drops', /drop|loot|pity|rarit|gacha|chest|crate|prob|chance|weight|rate/],
  ['economy', /gold|coin|gem|diamond|price|cost|reward|income|currency|shop|sell|buy|upgrade|xp|exp\b|bank|energy|salary|wage|budget/],
  ['combat', /hp|health|dmg|damage|atk|attack|armor|defen[cs]e|crit|speed|range|shield|mana|heal|regen|power|strength/],
  ['timing', /cooldown|duration|interval|delay|timer|seconds|time|tick/],
  ['progression', /stage|level|wave|chapter|unlock|requirement|tier|prestige|rank|area|world/],
  ['counts', /count|amount|num|spawn|size|max|limit|slots|moves|lives|turns/],
];
const catOf = (s) => { const t = s.toLowerCase(); for (const [c, re] of CATS) if (re.test(t)) return c; return 'other'; };
const numeric = (v) => typeof v === 'number' && isFinite(v);
function flatten(v, p, out, depth = 0) {
  if (depth > 8) return;
  if (numeric(v)) out.push({ path: p, value: v });
  else if (Array.isArray(v)) { if (v.length > 400) v = v.slice(0, 400); v.forEach((x, i) => flatten(x, p + '[' + i + ']', out, depth + 1)); }
  else if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) flatten(x, p ? p + '.' + k : k, out, depth + 1);
}
const data = [];
for (const f of files) {
  let j; try { j = JSON.parse(fs.readFileSync(f, 'utf8')); } catch (e) { continue; }
  const nums = []; flatten(j, '', nums);
  if (!nums.length) continue;
  const by = {}; for (const n of nums) { const c = catOf(path.basename(f) + ' ' + n.path.replace(/\[\d+\]/g, '')); (by[c] ??= []).push(n); }
  data.push({ file: path.relative(dir, f), json: j, count: nums.length, cats: Object.fromEntries(Object.entries(by).map(([c, a]) => [c, { n: a.length, example: a[0].path + ' = ' + a[0].value }])) });
}

// ids defined in "entity" files: top-level keys of an object, or id/name/key of array rows (one level of nesting is searched too)
const ENTITY_FILE = /item|drop|loot|gear|equip|enem|unit|card|charact|skill|upgrade|resource|weapon|relic|perk|monster|tile|block|obstacle/i;
function idsOf(j) {
  // a "row" is an object with at least two plain values (hp, atk, name ...); containers (enemies, tiers, byRarity) are searched, not listed
  const ids = new Map(), prim = (v) => v === null || ['number', 'string', 'boolean'].includes(typeof v);
  const isRow = (o) => o && typeof o === 'object' && !Array.isArray(o) && Object.values(o).filter(prim).length >= 2;
  const add = (x) => { if (typeof x === 'string' && x.length >= 3 && x.length <= 40 && !/^tier[\s_]?\d+$/i.test(x)) ids.set(x.toLowerCase(), x); };
  const visit = (x, depth) => {
    if (depth > 3 || !x || typeof x !== 'object') return;
    if (Array.isArray(x)) { x.forEach((r) => { if (isRow(r)) { add(r.id); add(r.name); add(r.key); } else visit(r, depth + 1); }); return; }
    for (const [k, r] of Object.entries(x)) { if (isRow(r)) add(k); else visit(r, depth + 1); }
  };
  visit(j, 0);
  return [...ids.values()];
}

// ---------- 2. logs ----------
let logDir = arg('logs');
if (!logDir) {
  const runs = path.join(dir, '.balance-sim', 'runs');
  try {
    const metas = fs.readdirSync(runs).map((d) => { try { return { d, m: JSON.parse(fs.readFileSync(path.join(runs, d, 'meta.json'), 'utf8')) }; } catch (e) { return null; } }).filter((x) => x && x.m.kind === 'detect' && x.m.status === 'done').sort((a, b) => (b.m.startedAt > a.m.startedAt ? 1 : -1));
    if (metas[0]) logDir = path.join(runs, metas[0].d, 'logs');
  } catch (e) { /* no runs yet */ }
}
const L = { dir: logDir || null, ends: 0, byType: {}, kills: 0, dropsN: 0, drops: {}, gain: {}, spend: {}, stages: {}, text: '' };
if (logDir && fs.existsSync(logDir)) {
  const chunks = [];
  for (const f of fs.readdirSync(logDir).filter((x) => x.endsWith('.jsonl'))) {
    for (const line of fs.readFileSync(path.join(logDir, f), 'utf8').split('\n')) {
      if (!line) continue;
      let e; try { e = JSON.parse(line); } catch (err) { continue; }
      L.byType[e.type] = (L.byType[e.type] || 0) + 1;
      if (e.type === 'end') { L.ends++; continue; }
      if (e.type === 'stall') continue;
      const s = (L.stages[e.stage] ??= { kills: 0, drops: 0, events: 0 }); s.events++;
      if (e.type === 'kill') { L.kills++; s.kills++; }
      if (e.type === 'drop') { L.dropsN++; s.drops++; const it = (e.data && (e.data.item ?? e.data.kind)) ?? '?'; L.drops[it] = (L.drops[it] || 0) + (+(e.data && e.data.amount) || 1); }
      if (e.type === 'gain' || e.type === 'spend') { const bag = e.type === 'gain' ? L.gain : L.spend, k = (e.data && e.data.res) ?? '?'; bag[k] = (bag[k] || 0) + (+(e.data && e.data.amount) || 0); }
      if (chunks.length < 200000) chunks.push(line);
    }
  }
  L.text = chunks.join('\n');
}

// ---------- 3. findings ----------
const findings = [];
const add = (level, text) => findings.push({ level, text });
const evTypes = Object.keys(L.byType).filter((t) => !['end', 'stall'].includes(t));
if (!L.dir) add('info', 'No logs found: run a detection first (detect.mjs or the studio), then survey again to see what the bots experienced.');
else if (!L.ends) add('info', `No end events in ${L.dir}.`);
else if (!evTypes.length) add('warn', 'The logs contain no game events (only end/stall). Drops, economy and items are INVISIBLE to balance-sim: make the adapter/bot program emit kill, drop, gain, spend events (SKILL.md, "Log format") and run with --full 3 or more.');
else {
  if (!L.kills && !L.dropsN) add('warn', `The logs only contain these event types: ${evTypes.join(', ')}. There are no kill and no drop events, so the loot system is INVISIBLE: drops, kill rewards and item balance cannot be judged until the game/bot program emits them (SKILL.md, "Log format"; run with --full 3 or more).`);
  else if (!L.kills) add('warn', 'No kill events: kill rewards cannot be judged per enemy.');
  if (L.kills && !L.dropsN) add('warn', `${L.kills} kills and NOT ONE drop event. Either drops never happen (check chances and tables), or the game does not emit drop events. Either way drops are currently unbalanced or unmeasured.`);
  if (L.kills && L.dropsN) {
    const rate = L.dropsN / L.kills; if (rate < 0.02) add('warn', `Drops are very rare: ${L.dropsN} drops in ${L.kills} kills (${(rate * 100).toFixed(2)}%). Check that this is intended; players may never see the loot system.`);
    const dead = Object.entries(L.stages).filter(([, s]) => s.kills >= 10 && s.drops === 0).map(([k]) => k);
    if (dead.length) add('warn', `Stages with kills but no drop at all: ${dead.slice(0, 15).join(', ')}${dead.length > 15 ? ' ...' : ''}.`);
  }
  for (const k of Object.keys(L.gain)) if (!L.spend[k]) add('warn', `Resource "${k}" is earned (${Math.round(L.gain[k])}) and never spent: a faucet without a sink, or the spending is not logged.`);
  for (const k of Object.keys(L.spend)) if (!L.gain[k]) add('info', `Resource "${k}" is spent but never earned in the logs (starting stock, or the gain is not logged).`);
  for (const k of Object.keys(L.gain)) if (L.spend[k] && L.gain[k] / L.spend[k] > 4) add('warn', `Resource "${k}": earned ${Math.round(L.gain[k])}, spent ${Math.round(L.spend[k])} (${(L.gain[k] / L.spend[k]).toFixed(1)}x). Money piles up unused.`);
  for (const k of Object.keys(L.spend)) if (L.gain[k] && L.spend[k] / L.gain[k] > 1.2) add('info', `Resource "${k}": spent more than earned (${(L.spend[k] / L.gain[k]).toFixed(1)}x): fed by a starting stock or another source.`);
  const lower = L.text.toLowerCase();
  if (L.kills || L.dropsN) for (const d of data.filter((x) => ENTITY_FILE.test(x.file))) {
    const ids = idsOf(d.json), unseen = ids.filter((id) => !lower.includes(id.toLowerCase()));
    if (ids.length && unseen.length) add(unseen.length === ids.length ? 'warn' : 'info', `${d.file}: ${unseen.length} of ${ids.length} defined entries never appear in the sampled logs (${unseen.slice(0, 8).join(', ')}${unseen.length > 8 ? ' ...' : ''}). They may be unreachable, always lose to something else, or just rare/unsampled (try --full 20).`);
  }
}
if (!data.length) add('info', `No JSON data files with numbers found under ${dir}. Point --files at the game's level and parameter files.`);

if (has('json')) { console.log(JSON.stringify({ dir, data: data.map(({ json, ...d }) => d), logs: { dir: L.dir, ends: L.ends, kills: L.kills, drops: L.dropsN, dropItems: L.drops, gain: L.gain, spend: L.spend, eventTypes: L.byType }, findings }, null, 1)); process.exit(0); }
const pad = (s, n) => String(s).padEnd(n);
console.log(`\nSURVEY of ${dir}`);
console.log(`\nDATA: ${data.length} JSON files with numbers (${data.reduce((a, d) => a + d.count, 0)} numbers). Read them: every system below is something the agent must consider and the user must scope.`);
console.log(pad('file', 38) + pad('numbers', 9) + 'systems (count)');
for (const d of [...data].sort((a, b) => b.count - a.count).slice(0, 25)) console.log(pad(d.file, 38) + pad(d.count, 9) + Object.entries(d.cats).sort((a, b) => b[1].n - a[1].n).map(([c, v]) => `${c} ${v.n}`).join(', '));
const totals = {}; for (const d of data) for (const [c, v] of Object.entries(d.cats)) totals[c] = (totals[c] || 0) + v.n;
console.log('\nBY SYSTEM: ' + Object.entries(totals).sort((a, b) => b[1] - a[1]).map(([c, n]) => `${c} ${n}`).join(', '));
console.log(`\nLOGS: ${L.dir || '(none)'}${L.ends ? `  attempts ${L.ends}, kills ${L.kills}, drops ${L.dropsN}, event types: ${evTypes.join(', ') || 'none'}` : ''}`);
if (Object.keys(L.drops).length) console.log('  items seen: ' + Object.entries(L.drops).sort((a, b) => b[1] - a[1]).slice(0, 12).map(([k, n]) => `${k} ${n}`).join(', '));
if (Object.keys(L.gain).length || Object.keys(L.spend).length) console.log('  resources: ' + [...new Set([...Object.keys(L.gain), ...Object.keys(L.spend)])].map((k) => `${k} +${Math.round(L.gain[k] || 0)} / -${Math.round(L.spend[k] || 0)}`).join(', '));
console.log('\nFINDINGS');
if (!findings.length) console.log('  nothing odd in the sampled logs (this does not prove the systems are balanced: only that they are visible and active).');
for (const f of findings) console.log(`  ${f.level === 'warn' ? '!' : '-'} ${f.text}`);
console.log('\nNext: list the systems you found to the user (stage strength, drops, economy, upgrades, enemy/item tables), ask which are in scope, research how this genre balances each (SKILL.md, "What can be balanced here"), then make sure each one is MEASURED (events) before tuning it.');
