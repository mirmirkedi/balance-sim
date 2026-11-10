// balance-sim adapter for PR-14 (egg-nest tile puzzle, move limit per level).
//
// The game already has a headless engine (build/engine.js) and an exact solver (build/exact.js), so this adapter only
// wraps them. No browser, no vm. One stage = one level (1..100). One action = one tap on a group or one swipe; the
// player acts when the board has settled (same model as the solver).
//
//   node ~/.claude/skills/balance-sim/scripts/runner.mjs --adapter tools/balance/adapter.mjs --personas random,novice,smart,optimizer,oracle --runs 40
//
// Tunables (--set key=value):
//   extraMoves=1        added to every level's move limit (the main difficulty knob of a puzzle)
//   extra.<id>=2        extra moves for one level only (per-level correction, like PR-15's stage.adj)
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '../..');
const E = require(path.join(root, 'build/engine.js'));
const X = require(path.join(root, 'build/exact.js'));

const levels = fs.readdirSync(path.join(root, 'levels')).filter((f) => /^level_\d+\.json$/.test(f)).sort()
  .map((f) => JSON.parse(fs.readFileSync(path.join(root, 'levels', f), 'utf8')));
const byId = new Map(levels.map((l) => [String(l.id), l]));
const limitOf = (lv, params) => lv.moves + (+params['extraMoves'] || 0) + (+params['extra.' + lv.id] || 0);

const apply = (s, a) => {
  const r = a.k === 'tap' ? E.tap(s, a.c, a.r) : a.k === 'egg' ? E.swipeEgg(s, a.id, a.dc) : E.swipe(s, a.c, a.r, a.dc, a.dr);
  if (r.ok) E.settle(s);
  return r.ok;
};

class Puzzle {
  constructor(lv, limit, seed, emit, s) {
    this.lv = lv; this.limit = limit; this.emit = emit;
    if (s) this.s = s;
    else { this.s = E.create({ grid: lv.grid, nests: lv.nests, moves: limit }, seed); this.s.noEvents = true; E.settle(this.s); }
    this._acts = null;
  }
  legalActions() { if (this.s.over) return []; return this._acts ??= X.actions(this.s); }
  step(a) {
    const before = this.s.delivered;
    this._acts = null;
    if (!apply(this.s, a)) return;
    this.emit('move', { kind: a.k, left: this.s.moves, delivered: this.s.delivered });
    if (this.s.delivered > before) this.emit('deliver', { count: this.s.delivered, of: this.s.totalEggs });
    if (this.s.over && this.s.over !== 'win') this.emit('fail', { reason: this.s.over });
  }
  isDone() { return !!this.s.over || this.legalActions().length === 0; }
  time() { return this.s.used; }
  result() {
    const s = this.s;
    return { win: s.over === 'win', hpLeft: s.over === 'win' ? s.moves : 0, hpMax: this.limit, time: s.used, deaths: s.over === 'win' ? 0 : 1, income: 0, resources: { movesLeft: s.moves, delivered: s.delivered, why: s.over || 'stuck' } };
  }
  // clone for lookahead: the copy gets its own random stream so lookahead cannot peek at the future shuffle
  clone() { const c = E.clone(this.s); c.rngS = (c.rngS ^ 0x9e3779b9) >>> 0; c.noEvents = true; return new Puzzle(this.lv, this.limit, 0, () => {}, c); }
  observe() { return { moves: this.s.moves, delivered: this.s.delivered }; }
}

// how close are the eggs to their nests (higher = better). An egg must get over to the column of its nest and then fall.
function evaluate(g) {
  const s = g.s;
  if (s.over === 'win') return 1e6 + s.moves;
  if (s.over === 'wrong') return -1e6;
  let v = s.delivered * 1000;
  for (const e of s.eggs) {
    if (e.state === 2) continue;
    const n = s.nests.find((q) => q.color === e.color && !q.done) || s.nests.find((q) => q.color === e.color);
    const ec = Math.floor(e.x), er = Math.floor(e.y);
    v -= Math.abs(n.c - ec) * 14 + (s.R - 1 - er) * 6;
  }
  // removing blocks around the eggs frees them; fewer breakable obstacles is slightly better
  v -= E.countBreakable(s) * 0.5;
  return v + s.moves * 0.2;
}

const plans = new Map();   // limit+level -> solver path (the level is deterministic, solve once)
function oracle(g) {
  if (!g.plan) {
    const key = g.lv.id + ':' + g.limit;
    if (!plans.has(key)) { const r = X.decide({ grid: g.lv.grid, nests: g.lv.nests }, g.limit); plans.set(key, r.status === 'SOLVABLE' ? r.path.slice() : []); }
    g.plan = plans.get(key).slice();
  }
  return g.plan.shift() ?? null;
}

export default {
  stages: levels.map((l) => String(l.id)),
  // --- balance-sim studio: how to run it and which knob calibrates a level ---
  campaign: false,
  studio: { genre: 'puzzle', runs: 30, personas: ['random', 'novice', 'smart'] },
  levers: {
    // extra.<id> moves added to ONE level's limit. More moves = easier, so bigger is easier (harder = -1).
    stage: { param: 'extra.{stage}', mode: 'add', harder: -1, min: -3, max: 10, default: 0, step: 12, integer: true, unit: 'moves' },
  },
  evaluate, oracle,
  create({ stage, seed, emit, params }) {
    const lv = byId.get(String(stage));
    return new Puzzle(lv, limitOf(lv, params || {}), seed, emit);
  },
};
