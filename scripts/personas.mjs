// Personas = how a simulated player picks an action. Game-independent; the game gives the knowledge.
//
// A persona is  (game, rng, adapter, opts) -> action
//   game.legalActions()  list of actions the player may take right now
//   adapter.policy(game, actions, rng)        OPTIONAL hand-written "sensible move" (best for most games)
//   adapter.scoreAction(game, action)         OPTIONAL score per action, highest wins
//   game.clone() + adapter.evaluate(game)     OPTIONAL lookahead (needed by `optimizer`)
//
// Mapping to the global balancing rule (novice / average / optimizer):
//   novice -> novice, average -> smart, optimizer -> optimizer, random = floor / sanity check.

const pick = (arr, rng) => arr[Math.floor(rng() * arr.length)];

function smart(game, rng, adapter) {
  const acts = game.legalActions();
  if (!acts.length) return null;
  if (adapter.policy) return adapter.policy(game, acts, rng);
  if (adapter.scoreAction) {
    let best = [], bs = -Infinity;
    for (const a of acts) {
      const s = adapter.scoreAction(game, a);
      if (s > bs) { bs = s; best = [a]; } else if (s === bs) best.push(a);
    }
    return pick(best, rng);
  }
  if (game.clone && adapter.evaluate) return lookahead(game, acts, rng, adapter, 1);
  throw new Error('adapter needs policy(), scoreAction() or clone()+evaluate() for smart/novice/optimizer personas');
}

// depth-limited search on clones; value = adapter.evaluate(state), higher is better
function lookahead(game, acts, rng, adapter, depth) {
  let best = [], bv = -Infinity;
  for (const a of acts) {
    const v = valueAfter(game, a, adapter, depth);
    if (v > bv + 1e-9) { bv = v; best = [a]; } else if (Math.abs(v - bv) <= 1e-9) best.push(a);
  }
  return pick(best, rng);
}
function valueAfter(game, a, adapter, depth) {
  const c = game.clone();
  c.step(a);
  if (c.isDone() || depth <= 1) return adapter.evaluate(c);
  let bv = -Infinity;
  for (const b of c.legalActions()) bv = Math.max(bv, valueAfter(c, b, adapter, depth - 1));
  return bv === -Infinity ? adapter.evaluate(c) : bv;
}

export const PERSONAS = {
  random(game, rng) {
    const acts = game.legalActions();
    return acts.length ? pick(acts, rng) : null;
  },
  // smart, but with some probability plays a random legal move (misses, misclicks, bad reads)
  novice(game, rng, adapter, opts) {
    const acts = game.legalActions();
    if (!acts.length) return null;
    return rng() < (opts.noviceError ?? 0.25) ? pick(acts, rng) : smart(game, rng, adapter);
  },
  smart,
  // looks 2 moves ahead if the game can clone itself, otherwise same as smart
  optimizer(game, rng, adapter, opts) {
    const acts = game.legalActions();
    if (!acts.length) return null;
    if (game.clone && adapter.evaluate) return lookahead(game, acts, rng, adapter, opts.depth ?? 2);
    return smart(game, rng, adapter);
  },
};
