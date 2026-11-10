#!/usr/bin/env node
// balance-sim target: step 2 of the workflow for the CONVERSATION mode: decide how hard each stage SHOULD be, together
// with the user, without the web app. It uses the same target model as the studio (scripts/model.mjs), so the result
// can be opened in the studio and calibrated there, or calibrated with calibrate.mjs.
//
// It starts from the difficulty measured by the latest detection run (or --run <id>) and prints measured vs target for
// every stage. Nothing is written unless you pass --write. Show the user the dry run first, agree, then write.
//
//   node target.mjs [--dir <game folder>] [--adapter A] [--targets T] [--run latest|<id>]
//        [--template measured|smooth|linear|slow|fast|scurve|waves|stairs|flat] [--start 10 --end 55] [--area 10 --wave 18]
//        [--shift +10 | --average 35]            move the whole game (relative to the curve, or to an exact average difficulty)
//        [--spread equal|later|earlier|middle]   where that change lands
//        [--tag 12=harder,25=boss,30=breather]   much-easier | easier | harder | much-harder | boss | breather
//        [--pin 5=40]                            exact difficulty for a stage
//        [--bosses 5,10,15] [--boss-bump 15] [--tolerance 15] [--persona smart]
//        [--genre puzzle|roguelike|tower-defense|idle-rpg|action|card|general]  start from the typical shape of this game type and show what is known about it
//        [--list-genres]                         the game types in references/genres.json, with how sure each entry is
//        [--reset]                               forget the saved model, start again from the measured curve
//        [--write]                               save targets.json (the old one is kept as .balance-sim/targets.prev.json)
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openProject, readJson, writeJson } from './project.mjs';
import { scores, summary, band, mean, TAGS, SPREAD, TPL, targetCurve, targetsJson, modelFromTargets, fillGaps } from './model.mjs';

const argv = process.argv.slice(2);
const GENRES = readJson(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'references', 'genres.json'), {});
const genreKeys = Object.keys(GENRES).filter((k) => !k.startsWith('_'));
if (argv.includes('--list-genres')) { for (const k of genreKeys) console.log(`${k.padEnd(14)} ${GENRES[k].basis.padEnd(9)} ${GENRES[k].name}`); process.exit(0); }
const P = openProject(argv);
const adapter = await P.adapter();
const ids = adapter.stages.map(String);
const runId = P.arg('run', 'latest');
const meta = runId === 'latest' ? P.latest('detect') : P.runs().find((r) => r.id === runId);
if (!meta) { console.error('No detection run yet. Run detect.mjs first: a target only makes sense next to the current difficulty.'); process.exit(1); }
const rep = readJson(path.join(P.runDir(meta.id), 'report.json'), null);
if (!rep) { console.error('Run ' + meta.id + ' has no report.'); process.exit(1); }
const sc = scores(rep), sm = summary(rep, sc), byId = new Map(sc.map((s) => [s.id, s]));
const measured = ids.map((id) => { const s = byId.get(id); return s && !s.empty ? s.difficulty : null; });

const old = P.targets();
let T = P.has('reset') ? modelFromTargets(old && { ...old, studio: undefined }, true, measured) : modelFromTargets(old, true, measured);
if (P.has('reset') || !(old && old.studio)) T.snapshot = fillGaps(measured);
const num = (k) => P.arg(k) != null ? +P.arg(k) : null;
if (P.arg('template')) { if (!TPL.some(([k]) => k === P.arg('template'))) { console.error('unknown template ' + P.arg('template') + ' (have: ' + TPL.map(([k]) => k).join(', ') + ')'); process.exit(1); } T.template = P.arg('template'); if (['measured', 'smooth'].includes(T.template)) T.snapshot = fillGaps(measured); }
for (const k of ['start', 'end', 'area', 'wave']) if (num(k) != null) T[k] = num(k);
if (num('boss-bump') != null) T.bossBump = num('boss-bump');
if (num('tolerance') != null) T.tolerance = num('tolerance');
if (P.arg('persona')) T.persona = P.arg('persona');
if (P.arg('bosses')) T.bosses = P.arg('bosses').split(',').map((s) => s.trim()).filter(Boolean);
if (P.arg('spread')) { if (!SPREAD.some(([k]) => k === P.arg('spread'))) { console.error('unknown spread ' + P.arg('spread') + ' (have: ' + SPREAD.map(([k]) => k).join(', ') + ')'); process.exit(1); } T.spread = P.arg('spread'); }
const pairs = (v) => String(v || '').split(',').map((x) => x.trim()).filter(Boolean).map((x) => x.split('='));
for (const [id, tag] of pairs(P.arg('tag'))) { if (!(tag in TAGS)) { console.error('unknown tag ' + tag + ' (have: ' + Object.keys(TAGS).join(', ') + ')'); process.exit(1); } if (!ids.includes(id)) { console.error('unknown stage ' + id); process.exit(1); } T.tags[id] = tag; delete T.pins[id]; }
for (const [id, v] of pairs(P.arg('pin'))) { if (!ids.includes(id)) { console.error('unknown stage ' + id); process.exit(1); } T.pins[id] = +v; }
if (P.has('clear-tags')) { T.tags = {}; T.pins = {}; }
const free = targetCurve({ ...T, average: null }, ids, measured);   // the curve before the average is fixed
if (P.arg('average') != null) T.average = +P.arg('average');
else if (P.arg('shift') != null) T.average = Math.round(mean(free) + +P.arg('shift'));

const genreId = P.arg('genre') || (adapter.studio && adapter.studio.genre) || T.genre || null;
if (P.arg('genre')) { const g = GENRES[P.arg('genre')]; if (!g) { console.error('unknown genre ' + P.arg('genre') + ' (have: ' + genreKeys.join(', ') + ')'); process.exit(1); } Object.assign(T, g.suggest); T.snapshot = null; T.genre = P.arg('genre'); }
else if (genreId && !T.genre) T.genre = genreId;
const tc = targetCurve(T, ids, measured), mAvg = mean(measured.filter((x) => x != null)), tAvg = mean(tc);
console.log(`\nTARGET PROPOSAL (based on ${meta.id}, reference bot ${sm.tp})`);
const G = GENRES[T.genre];
console.log(G ? `game type: ${G.name} [${G.basis}]${G.sources.length ? '' : ' (no source yet: research before trusting numbers)'}` : 'game type: not set. The right curve depends on the game: tell the user what you assume, ask, and research it (SKILL.md, "Game type first").');
if (G && P.has('genre')) { for (const n of G.notes) console.log('  - ' + n); for (const s of G.sources) console.log('  source: ' + s.title + ' ' + s.url); }
console.log(`template: ${T.template}   average: ${Math.round(mAvg)} (${band(mAvg)}) now  ->  ${Math.round(tAvg)} (${band(tAvg)}) target   spread: ${T.spread}   tolerance: +-${T.tolerance}`);
if (Object.keys(T.tags).length || Object.keys(T.pins).length) console.log(`tags: ${Object.entries(T.tags).map(([k, v]) => k + '=' + v).join(', ') || '-'}   pins: ${Object.entries(T.pins).map(([k, v]) => k + '=' + v).join(', ') || '-'}`);
console.log(`\nstage   now  target  change   (now / target: # = 10 points)`);
ids.forEach((id, i) => {
  const m = measured[i], d = m == null ? null : tc[i] - m, bar = (v) => '#'.repeat(Math.round(v / 10)).padEnd(10, '.');
  const mark = T.tags[id] ? ' [' + T.tags[id] + ']' : T.pins[id] != null ? ' [pinned]' : '';
  console.log(`${id.padEnd(6)} ${m == null ? '  -' : String(Math.round(m)).padStart(3)}  ${String(Math.round(tc[i])).padStart(5)}  ${d == null ? '     -' : ((d >= 0 ? '+' : '') + Math.round(d)).padStart(6)}   ${m == null ? ' '.repeat(10) : bar(m)} ${bar(tc[i])}${mark}`);
});
if (rep.onboarding) {
  const early = ids.map((id, i) => [id, 1 - tc[i] / 100]).filter(([id, w]) => rep.onboarding.stages.includes(id) && w < rep.onboarding.smartMin);
  if (early.length) console.log(`\nWARNING opening: stages ${early.map(([id, w]) => id + ' (' + Math.round(w * 100) + '% win)').join(', ')} are in the first ~${rep.onboarding.minutes} minutes but the target lets the reference bot win less than ${Math.round(rep.onboarding.smartMin * 100)}% of the time. The opening should be easy so that even weak players pass: raise the win target there (lower difficulty) unless the user wants a hard start.`);
}
const big = ids.map((id, i) => [id, measured[i] == null ? 0 : tc[i] - measured[i]]).filter(([, d]) => Math.abs(d) >= 12).sort((a, b) => Math.abs(b[1]) - Math.abs(a[1]));
console.log(`\nBIGGEST CHANGES: ${big.slice(0, 8).map(([id, d]) => `${id} ${d >= 0 ? '+' : ''}${Math.round(d)}`).join(', ') || 'none (target is close to the current game)'}`);
if (P.has('write')) {
  fs.mkdirSync(path.dirname(P.targetsPath), { recursive: true });
  if (fs.existsSync(P.targetsPath)) fs.copyFileSync(P.targetsPath, path.join(P.stateDir, 'targets.prev.json'));
  writeJson(P.targetsPath, targetsJson(T, ids, measured, old));
  console.log(`\nWRITTEN to ${P.targetsPath} (previous version kept in .balance-sim/targets.prev.json). Open it in the studio or calibrate with calibrate.mjs.`);
} else console.log('\nDRY RUN: nothing was written. Agree with the user, then run again with --write.');
