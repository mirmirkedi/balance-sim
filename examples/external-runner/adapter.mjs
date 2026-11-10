// External-runner adapter: for games that run in ANOTHER program (Godot, Unity, a browser, Python ...).
// balance-sim does not play the game itself here. It starts your program, which plays the runs and writes balance-sim logs;
// everything else (analysis, difficulty scores, targets, calibration, studio) works as usual.
//
// Your program must, for each call:
//   - play `runs` runs starting at run number `runFrom` (seed from `seed`; the same run number must give the same game)
//   - write JSONL to <out>/<persona>.jsonl (any file starting with the persona name works: smart_0.jsonl ...)
//   - one line per attempt: {"type":"end","run":R,"persona":"smart","stage":"7","win":true,"hpLeft":..,"hpMax":..,"time":..,"deaths":..,"income":..}
//     campaign mode adds "attempt":N,"campaign":true and a {"type":"stall",...} line when the player gives up (see SKILL.md, "Log format")
//   - take game parameters from `--set key=value` (that is how calibration changes the game)
// The runner splits runs into slices and starts several copies at once, so each copy needs its OWN save/temp files.
//
// This file is a TEMPLATE: set the three marked lines for your game. This one is the Godot version.
//   GODOT_PROJECT=/path/to/project   (folder with project.godot)
//   BOT_SCRIPT=res://tests/balance_sim.gd   (a SceneTree script that plays bots and writes the logs)
import os from 'node:os';

const PROJECT = process.env.GODOT_PROJECT || '.';
const SCRIPT = process.env.BOT_SCRIPT || 'res://tests/balance_sim.gd';

export default {
  stages: Array.from({ length: 30 }, (_, i) => i + 1),       // 1) your stage ids, in play order
  campaign: true,                                              // 2) true when one player lives through all stages
  studio: { genre: 'idle-rpg', runs: 60, retries: 3, personas: ['random', 'novice', 'smart'] },
  maxJobs: Math.max(1, Math.floor(os.cpus().length / 2)),     // a heavy engine: each copy uses a core or more and lots of memory
  external: {
    command: (c) => ({
      command: process.env.GODOT || 'godot',                   // 3) how to start your program
      args: ['--headless', '--path', PROJECT, '--script', SCRIPT, '--', '--out', c.out, '--personas', c.persona, '--runs', String(c.runs),
        '--run-from', String(c.runFrom), '--seed', String(c.seed), '--stages', c.stageArg || `1-${c.stages.length}`, '--retries', String(c.retries),
        ...Object.entries(c.params).flatMap(([k, v]) => ['--set', `${k}=${v}`])],
      cwd: PROJECT,
    }),
  },
};
