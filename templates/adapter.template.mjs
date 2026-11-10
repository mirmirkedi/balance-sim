// balance-sim adapter template. Copy next to the game (e.g. PR-xx/tools/sim_adapter.mjs) and fill the TODOs.
// The simulator never touches rendering. It only needs the game LOGIC, driven one decision at a time.
//
// Rules for a good adapter:
//  - No real time: advance the game with a fixed dt per step() (fake clock). A 3 minute fight = a few ms.
//  - No Math.random(): use the seed given to create(), so a run can be replayed (--replay).
//  - clone() (needed by `optimizer` / lookahead) must NOT share the random stream: reseed it, or the bot peeks at the future.
//  - Emit an event for everything that matters for balance (see "Log format" in SKILL.md).
//  - result() must be cheap and always valid (also after a loss or a timeout).
//  - Read tunables from `params` so `sweep.mjs` / `--set key=value` can move them without editing code.
//
// import { chooseItem } from '<skill dir>/scripts/personas.mjs';   // helper for shop() decisions

export default {
  // TODO: stage ids in play order. The curve is drawn in this order.
  stages: [1, 2, 3],

  // ---- game kinds: pick what applies, delete the rest -------------------------------------------------
  // turn based / puzzle ......... legalActions() lists the moves; step(action) plays one.
  // real time ................... actionRepeat: 5   -> persona decides every 5 steps; in between the same action repeats,
  //                               or idleAction (e.g. {type:'noop'}) if you define it.
  // auto battler / idle / merge . legalActions() returns [] and the game has advance() (one tick). Skill lives in shop().
  // physics / aiming ............ discretize aim & power into 8-24 candidate actions in legalActions().
  // actionRepeat: 1,
  // idleAction: { type: 'noop' },

  // ---- campaign mode (--campaign): one player lives through all stages and keeps a profile -----------
  // newProfile({ seed, params, startStage }) { return { coins: 0, level: 1 }; },
  // afterStage({ profile, stage, result, won, attempt, persona, rng, emit, params }) { /* rewards (faucet) */ },
  // shop({ profile, stage, persona, rng, opts, emit }) { /* spending (sink): chooseItem(items, score, persona, rng, opts) */ },
  // snapshot(profile) { return { bank: profile.coins, power: 0 }; },   // columns "bank" and "power" in the report

  // TODO: build one playable run of `stage`. In campaign mode `profile` is the player's persistent state.
  create({ stage, seed, emit, params, profile }) {
    // const rng = mulberry32(seed);        // import from scripts/rng.mjs if you need one
    // const game = Engine.newRun(GAME_DATA, stage, rng, params, profile);
    return {
      // actions the player may take RIGHT NOW (plain objects). Keep the list small (<= ~50).
      legalActions() { return []; },
      // apply one action and fast-forward until the next decision. Call emit(type, {...}) inside.
      step(action) {},
      // only for games with nothing to decide: advance one tick
      // advance() {},
      isDone() { return true; },
      // optional: seconds of game time so far (else the step count is used)
      time() { return 0; },
      // optional: deep copy that emits nothing and has its own random stream. Needed for the `optimizer`.
      // clone() {},
      result() {
        return {
          win: false,            // required
          hpLeft: 0, hpMax: 1,   // near-miss detection (any "health": lives, base hp, moves or shots left)
          time: 0,               // game seconds
          deaths: 0,             // lives lost / continues used
          income: 0,             // soft currency earned in this stage
          resources: {},         // anything else worth tracking
        };
      },
    };
  },

  // How `smart` plays. Pick ONE of the three (policy is the easiest to get right):
  // policy(game, actions, rng) { return actions[0]; },
  // scoreAction(game, action) { return 0; },          // highest score wins
  // evaluate(game) { return 0; },                      // state value; with clone() gives 1-ply lookahead (smart) and 2-ply (optimizer)
};
