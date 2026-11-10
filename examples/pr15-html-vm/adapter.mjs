// balance-sim adapter for PR-15 (auto-combat wave game with merge weapons, gear, characters and events).
//
// Runs the REAL game code from PR-15/game.html headless inside a Node vm (no browser, no canvas) and drives it:
//  - combat is automatic in the game, so a fight has no decisions: the runner calls game.advance()
//  - real decisions: gear (equip or sell), special-event choices, fight/run, multiverse, paid offers -> legalActions()
//  - meta play between stages (draw weapons, merge, equip, level up, bag, chests, switch character) -> shop()
// Needs --campaign: the player's backpack, gear and levels carry over from stage to stage.
//
//   S=~/.claude/skills/balance-sim/scripts
//   node $S/runner.mjs --adapter tools/balance/adapter.mjs --campaign --retries 3 --runs 50 --stages 1-30 --personas random,novice,smart --out /tmp/pr15
//   node $S/analyze.mjs --logs /tmp/pr15 --targets tools/balance/targets.json
//
// Tunables (--set), any path into the game's TUNE / CFG objects, e.g.  --set TUNE.enemy.hp=1.3  --set TUNE.stage.hpA=0.2
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const SIM = process.env.BALANCE_SIM || path.join(os.homedir(), '.claude/skills/balance-sim');
const { mulberry32 } = await import(pathToFileURL(path.join(SIM, 'scripts/rng.mjs')).href);
const { chooseItem } = await import(pathToFileURL(path.join(SIM, 'scripts/personas.mjs')).href);
const GAME = process.env.PR15_GAME || path.resolve(here, '../../game.html');

// ---------- headless browser stand-in ----------
function anyProxy() {
  const p = new Proxy(function () {}, {
    get: (t, k) => (k === Symbol.toPrimitive ? () => '' : k === 'length' ? 0 : k === Symbol.iterator ? () => [][Symbol.iterator]() : p),
    apply: () => p, construct: () => p, set: () => true, has: () => true,
  });
  return p;
}
const host = { rnd: Math.random, pending: null, cbs: [], cleared: false, defeated: false, g0: 0, emit() {} };
const ctx = vm.createContext({
  __host: host, document: anyProxy(), navigator: anyProxy(), console,
  localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
  performance: { now: () => 0 }, requestAnimationFrame: () => 0, setTimeout: () => 0, clearTimeout() {}, setInterval: () => 0, clearInterval() {},
  ResizeObserver: class { observe() {} },
});
ctx.window = ctx; ctx.self = ctx;

const html = fs.readFileSync(GAME, 'utf8');
const m = html.match(/<script>([\s\S]*)<\/script>/);
if (!m) throw new Error('no game script found in ' + GAME);
vm.runInContext(m[1].replace(/init\(\);\s*initUi\(\);\s*$/, ''), ctx, { filename: 'game.html' });
vm.runInContext(fs.readFileSync(path.join(here, 'ctx.js'), 'utf8'), ctx, { filename: 'ctx.js' });
const api = ctx.__api;

// ---------- persona decisions ----------
const pick = (a, rng) => a[Math.floor(rng() * a.length)];
function smartPolicy(p, acts) {
  const f = (pred) => acts.find(pred) || acts[0];
  if (p.kind === 'gear') return f((a) => a.type === (p.hasCur && p.powerDiff < 0 ? 'sell' : 'equip'));
  if (p.kind === 'choice') return f((a) => a.c === (p.sack < 4 ? 'help' : 'rob'));
  if (p.kind === 'event') return f((a) => a.type === (p.hpRatio >= (p.boss ? 0.6 : 0.5) ? 'fight' : 'run'));
  if (p.kind === 'multi') return f((a) => a.type === (p.hpRatio >= 0.7 ? 'fight' : 'run'));
  if (p.kind === 'paid') return f((a) => a.type === 'sell');
  return acts[0];
}
const SCORE = { merge: 90, toSlot: 85, swap: 80, draw: 70, switch: 60, level: 50, bag: 40 };
const score = (a) => a.bad ? -50 : a.k === 'chest' ? 20 + 5 * a.t : a.k === 'swap' ? 80 + Math.min(10, a.gain / 10) : SCORE[a.k] ?? 0;

class Pr15 {
  constructor(stage, emit) { this.stage = stage; this.emit = emit; this._p = undefined; }
  pending() { return this._p === undefined ? (this._p = api.pend()) : this._p; }
  time() { return api.state().t; }
  isDone() { const s = api.state(); return s.cleared || s.defeated; }
  legalActions() {
    const p = this.pending(); if (!p) return [];
    if (p.kind === 'gear') return p.hasCur ? [{ type: 'equip' }, { type: 'sell' }] : [{ type: 'equip' }];
    if (p.kind === 'choice') return ['rob', 'none', 'help'].map((c) => ({ type: 'choice', c }));
    if (p.kind === 'event' || p.kind === 'multi') return [{ type: 'fight' }, { type: 'run' }];
    if (p.kind === 'paid') return p.offer === 'equip' ? [{ type: 'sell' }, { type: 'no' }] : [{ type: 'no' }];
    return [];
  }
  step(a) { api.resolve(a); this._p = undefined; }
  advance() { api.tick(20); this._p = undefined; }   // one second of fighting
  result() {
    const s = api.state();
    return { win: s.cleared, hpLeft: Math.max(0, s.hp), hpMax: s.max, time: s.t, deaths: s.defeated ? 1 : 0, income: s.gold - s.g0, resources: { gold: s.gold, blue: s.blue, sack: s.sack } };
  }
}

let appliedParams = '';
export default {
  stages: Array.from({ length: 40 }, (_, i) => i + 1),

  newProfile() { return { S: api.fresh() }; },

  create({ stage, seed, emit, params, profile }) {
    if (!profile) throw new Error('PR-15 needs --campaign (backpack, gear and levels carry over between stages)');
    const key = JSON.stringify(params || {});
    if (key !== appliedParams) { for (const [k, v] of Object.entries(params || {})) if (/^(TUNE|CFG)\./.test(k)) api.setPath(k, v); appliedParams = key; }
    host.rnd = mulberry32(seed); host.emit = emit;
    api.use(profile.S); api.setup(stage);
    return new Pr15(stage, emit);
  },

  // how `smart` decides inside a stage
  policy(game, acts) { return smartPolicy(game.pending(), acts); },

  // meta play after every attempt (win or loss): resolve gear, then draw / merge / equip / level / bag / chests
  shop({ profile, persona, rng, opts, emit }) {
    api.use(profile.S); host.emit = emit;
    const err = persona === 'novice' ? (opts.noviceError ?? 0.25) : 0;
    const gear = () => {
      for (let g = 0; g < 60; g++) {
        const p = api.pendGear(); if (!p) break;
        const best = smartPolicy(p, p.hasCur ? [{ type: 'equip' }, { type: 'sell' }] : [{ type: 'equip' }]);
        const any = p.hasCur ? pick([{ type: 'equip' }, { type: 'sell' }], rng) : { type: 'equip' };
        api.resolve(persona === 'random' || rng() < err ? any : best);
      }
    };
    gear();
    for (let g = 0; g < 300; g++) {
      const acts = api.meta(persona === 'random');
      if (!acts.length) break;
      const a = chooseItem(acts, score, persona, rng, opts);
      const spent = api.exec(a);
      if (spent) emit('spend', { data: spent });
      gear();
    }
  },

  snapshot(profile) { api.use(profile.S); return api.snap(); },
};
