# balance-sim

Game-independent balance simulator, packaged as a Claude Code skill.
Bots play every level thousands of times, every shot / kill / drop / purchase is logged, and the analyzer prints the difficulty curve against a target curve (win rate with 95% CI, time, deaths, income) with a verdict per stage.

```
stage   random novice  smart optimi  target  delta   95% CI  tries   time  death  income   flags
4         100%   100%   100%   100%     83%    +17   96-100    1.0      8   0.00      26   ?EASY FAST RANDOM_WINS
5          11%    32%    43%    43%     59%    -16    34-53    1.6     33   0.57      30   ?HARD COINFLIP
10          0%     0%     0%     0%     40%    -40      0-4    3.0     49   3.00       0   TOO_HARD WALL NO_SKILL
```

## What it does

- **Any mechanic.** Turn based, shot-budget puzzles, real time (`actionRepeat`), idle / auto battlers (`advance()`), and whole campaigns with an economy (`--campaign`: profile, rewards, shop, retries, quit points).
- **Personas** `random`, `novice`, `smart`, `optimizer`. The gaps between them show skill depth, mistake cost and weak policies.
- **Verdicts** `TOO_EASY/HARD` (only when the whole 95% interval is outside the band), `SPIKE`, `WALL`, `NO_SKILL`, `COINFLIP`, `INCOME_LOW`, `SLOW`, `POLICY_GAP`, ...
- **Sweep** one parameter over several values and pick the best (`sweep.mjs`).
- **Agentic tuning** (`tune.mjs`): the agent proposes parameter sets, the script measures them (loss, remaining flags, per-stage deltas, history); the agent interprets and iterates.
- **Replay** any single run as a timeline (`--replay smart:7:12`).
- **Calibrate** bots against real playtest numbers (`--humans`).
- **HTML report** with curve, target band and flagged stages (`--html`).

## Install

```bash
git clone https://github.com/mirmirkedi/balance-sim ~/code/balance-sim
cd ~/code/balance-sim && ./install.sh     # symlinks the skill and the /balance command into ~/.claude
npm test                                   # 14 end-to-end tests
```

Then in Claude Code: `/balance`, or just say "balance layalım" (Claude asks whether to use this skill).

## Use without Claude

```bash
node scripts/runner.mjs  --adapter examples/toy-wave/adapter.mjs --runs 100 --out logs/base
node scripts/analyze.mjs --logs logs/base --targets examples/toy-wave/targets.json --html logs/base.html
node scripts/sweep.mjs   --adapter examples/toy-budget/adapter.mjs --targets examples/toy-budget/targets.json \
                         --param budget --values 0.8,0.9,1 --runs 40
node scripts/runner.mjs  --adapter examples/toy-autobattle/adapter.mjs --campaign --runs 100 --out logs/camp
node scripts/runner.mjs  --adapter examples/toy-wave/adapter.mjs --replay smart:7:12
```

Write an adapter for your own game from `templates/adapter.template.mjs`. Workflow, adapter contract, log format and the verdict table: [SKILL.md](SKILL.md).

## Layout

| path | what |
|---|---|
| `SKILL.md` | the skill (workflow, game kinds, personas, adapter contract, log format, verdicts) |
| `scripts/runner.mjs` | plays stages with personas (normal, `--campaign`, `--replay`), writes JSONL logs |
| `scripts/analyze.mjs` | curve + CI, all target metrics, funnel, calibration, economy, `--compare`, `--html` |
| `scripts/sweep.mjs` | one parameter, several values, best fit to the target curve |
| `scripts/tune.mjs` | evaluates multi-parameter candidates (agent chosen or scouted in agent ranges), keeps history |
| `scripts/personas.mjs`, `lib.mjs`, `rng.mjs` | personas (+ `chooseItem` for shops), shared run loop, seeded RNG |
| `templates/` | adapter and target-curve templates |
| `examples/` | `toy-wave` (turn based), `toy-budget` (shot-budget puzzle), `toy-autobattle` (idle, campaign), `pr15-html-vm` (a real single-HTML game run headless in a Node vm; set `PR15_GAME=/path/to/game.html`) |
| `commands/balance.md` | the `/balance` slash command |
| `test/` | end-to-end tests (`npm test`) |

## Status

Tested on three toy mechanics and one real game (PR-15, headless via `vm`; tuned from 22 to 9 points mean error against its target curve, see "Lessons from tuning PR-15" in SKILL.md). Bots are not humans: real playtests override the report. The HTML report's chart has not been checked in a browser yet (structure only).
