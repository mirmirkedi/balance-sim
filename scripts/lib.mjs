// Shared helpers for runner / sweep / tests.
import { PERSONAS } from './personas.mjs';
import { mulberry32 } from './rng.mjs';

// Seed depends ONLY on (base seed, index of the stage in adapter.stages, run, attempt), never on which
// stages were selected, so `--stages 9` reproduces exactly the runs of a full pass.
export const seedFor = (seed0, stageIdx, run, attempt = 0) =>
  (seed0 * 1000003 + stageIdx * 7919 + run * 104729 + attempt * 15485863) >>> 0;

// repeated `--set key=value` -> params object handed to adapter.create()/newProfile()
export function parseSet(argv) {
  const p = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] !== '--set' || !argv[i + 1]) continue;
    const [k, ...v] = argv[i + 1].split('='), raw = v.join('=');
    p[k] = raw !== '' && !isNaN(+raw) ? +raw : raw === 'true' ? true : raw === 'false' ? false : raw;
  }
  return p;
}

// Play ONE attempt of one stage with one persona.
// Handles three kinds of games with the same loop:
//  - turn based / puzzle : persona picks from game.legalActions() each step
//  - real time           : adapter.actionRepeat = N -> persona decides every N steps, the choice (or
//                          adapter.idleAction) is repeated in between
//  - auto battler / idle : legalActions() is empty -> game.advance() (or idleAction) moves time on
export function playRun({ adapter, persona, stage, seed, params, opts, sink, profile, maxSteps }) {
  const rng = mulberry32(seed ^ 0x9e3779b9); // persona randomness, separate from the game's own RNG
  let step = 0, game = null, error = null, res;
  const acts = {};   // how often each action (or option) was chosen: feeds scripts/options.mjs
  const emit = (type, e = {}) => sink({ ...e, type, step, t: game && game.time ? game.time() : step });
  try {
    game = adapter.create({ stage, seed, emit, params, profile });
    // --set ban.<option>=1 removes that action (action.option, else action.type) from the player's choices, unless nothing else is left.
    // The ablation test (options.mjs) uses it to measure what an option is worth. Clones used for lookahead are not filtered.
    const banned = (a) => params && params['ban.' + (a.option ?? a.type)];
    if (params && Object.keys(params).some((k) => k.startsWith('ban.')) && game.legalActions) {
      const orig = game.legalActions.bind(game);
      game.legalActions = () => { const l = orig(); const f = l.filter((a) => !banned(a)); return f.length ? f : l; };
    }
    const every = adapter.actionRepeat || 1;
    let last = null;
    while (!game.isDone() && step < maxSteps) {
      let a = null;
      if (step % every === 0) { a = PERSONAS[persona](game, rng, adapter, opts); last = a; }
      else a = adapter.idleAction ?? last;
      if (a == null) {
        if (game.advance) game.advance();
        else if (adapter.idleAction !== undefined) game.step(adapter.idleAction);
        else break;
      } else game.step(a);
      if (a != null && typeof a === 'object') { const k = a.option ?? a.type; if (k != null) acts[k] = (acts[k] || 0) + 1; }
      step++;
    }
    res = game.result();
    res.timeout = !game.isDone();
  } catch (err) {
    error = String((err && err.stack) || err).split('\n').slice(0, 3).join(' | ');
    res = { win: false };
  }
  return { res, steps: step, error, acts };
}

// one readable line per event, for --replay
export function fmtEvent(e) {
  const bits = [`t=${(+e.t).toFixed(1).padStart(6)}`, e.type.padEnd(8)];
  if (e.actor || e.target) bits.push(`${e.actor ?? ''}${e.target ? ' -> ' + e.target : ''}`);
  if (e.before) bits.push(JSON.stringify(e.before));
  if (e.after) bits.push('=> ' + JSON.stringify(e.after));
  if (e.data) bits.push(JSON.stringify(e.data));
  return bits.join('  ');
}
