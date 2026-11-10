// balance-sim adapter template. Copy next to the game (e.g. PR-xx/tools/sim_adapter.mjs) and fill the TODOs.
// The simulator never touches rendering. It only needs the game LOGIC, driven one decision at a time.
//
// Rules for a good adapter:
//  - No real time: advance the game with a fixed dt per step() (fake clock). A 3 minute fight = a few ms.
//  - No Math.random(): use the seed given to create() so a run can be replayed.
//  - Emit an event for everything that matters for balance (see "Event types" in SKILL.md).
//  - result() must be cheap and always valid (also after a loss or a timeout).
//
// import the real game logic here, e.g.  import Engine from '../game/engine.js';
// import { mulberry32 } from '<skill dir>/scripts/rng.mjs';   // seeded rng helper

export default {
  // TODO: stage ids in play order. The curve is drawn in this order.
  stages: [1, 2, 3],

  // TODO: build one playable run of `stage`, with the player strength a normal player would have there
  // (progression state per stage comes from the game data, not from the simulator).
  create({ stage, seed, emit }) {
    // const rng = mulberry32(seed);
    // const game = Engine.newRun(GAME_DATA, stage, rng);
    return {
      // actions the player may take RIGHT NOW (plain objects). Keep the list small (<= ~50).
      legalActions() { return []; },
      // apply one action and fast-forward the game until the next decision. Call emit(type, {...}) inside.
      step(action) {},
      isDone() { return true; },
      // optional: seconds of game time so far (else step count is used)
      time() { return 0; },
      // optional: deep copy that emits nothing. Needed for the `optimizer` persona.
      // clone() {},
      result() {
        return {
          win: false,            // required
          hpLeft: 0, hpMax: 1,   // near-miss detection (any "health": lives, base hp, moves left)
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
  // evaluate(game) { return 0; },                      // state value for lookahead (needs clone())
};
