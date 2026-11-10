# balance-sim

Game-independent balance simulator and studio, packaged as a Claude Code skill.
Bots play every stage thousands of times and log every shot / kill / drop / purchase. You see how hard the game is, set how hard it should be (whole game, single stages, template curves), and let the studio calibrate towards it. Works for turn based, puzzle, real time, idle and campaign games.

Requirements: Node 18+, no npm dependencies. The web app listens on 127.0.0.1 only and never edits your game files.

```
stage   random novice  smart optimi  target  delta   95% CI  tries   time  death  income   flags
4         100%   100%   100%   100%     83%    +17   96-100    1.0      8   0.00      26   ?EASY FAST RANDOM_WINS
5          11%    32%    43%    43%     59%    -16    34-53    1.6     33   0.57      30   ?HARD COINFLIP
10          0%     0%     0%     0%     40%    -40      0-4    3.0     49   3.00       0   TOO_HARD WALL NO_SKILL
```

## What it does

- **Studio (web app).** `node scripts/studio.mjs` in a game folder: detect the difficulty (average and per stage), pick a target curve (templates, average difficulty, stage tags), auto-calibrate the per-stage lever, browse run logs and replay attempts. See SKILL.md.
- **Any mechanic.** Turn based, shot-budget puzzles, real time (`actionRepeat`), idle / auto battlers (`advance()`), and whole campaigns with an economy (`--campaign`: profile, rewards, shop, retries, quit points).
- **Personas** `random`, `novice`, `smart`, `optimizer` (2-move lookahead) and `oracle` (the game's exact solver, for puzzles). The gaps between them show skill depth, mistake cost and weak policies.
- **Verdicts** `TOO_EASY/HARD` (only when the whole 95% interval is outside the band), `SPIKE`, `WALL`, `NO_SKILL`, `BOT_LOST`, `COINFLIP`, `INCOME_LOW`, `SLOW`, `POLICY_GAP`, ...
- **Sweep** one parameter over several values and pick the best (`sweep.mjs`).
- **Agentic tuning** (`tune.mjs`): the agent proposes parameter sets, the script measures them (loss, remaining flags, per-stage deltas, history); the agent interprets and iterates.
- **Replay** any single run as a timeline (`--replay smart:7:12`).
- **Check the bots against real players** with playtest numbers (`--humans`).
- **Interactive HTML report** (`--html`): summary cards, "look here first", metric and persona toggles, hover tooltips, click a stage for a plain-words explanation with what to try, sortable and filterable table, flag glossary, dark mode. One self-contained file, no network.

## Quick start (the normal way: with Claude)

You do not write any code. You talk to Claude Code in the game's folder:

1. **Install once** (below), then say "balance this game" (or "balance layalım") or run `/balance-studio`.
2. **Claude builds the connector first.** The studio needs a small adapter file in the game (`tools/balance/adapter.mjs`) that lets the bots play it: which actions exist, how a step works, who won. Claude reads your game and writes it (it reuses a headless engine or an existing bot if the game has one, otherwise it runs the real game code in a Node `vm`). It also declares the one number per stage that makes it harder or easier (`levers`), so calibration can work. Claude checks the adapter with a short run before going on.
3. **Claude starts the studio** (`node ~/.claude/skills/balance-sim/scripts/studio.mjs`) and gives you the URL.
4. **You use the four steps in the browser:**
   - **Detect.** See how hard the game is *right now*: an average difficulty and a difficulty score for every stage. No target needed yet.
   - **Target.** The editor starts from that measured curve. Make the whole game harder or easier (average difficulty slider, +5/+10), tag single stages (harder, easier, boss, breather), drag a point, or switch to a template curve.
   - **Calibrate.** The studio moves the per-stage lever until the measured curve meets your target and verifies it on a fresh seed.
   - **Runs and logs.** Console, attempt log, replay, full report of every run.
5. **Claude applies the result.** The studio never edits your game. Press "Copy a prompt for Claude to apply it" and paste it: Claude changes the game's data files one stage at a time with a CHANGELOG line, rebuilds, and you detect again to compare.

Bots are not humans: the scores describe the bots. A real playtest of the changed stages decides.

## Install

```bash
git clone https://github.com/mirmirkedi/balance-sim ~/code/balance-sim
cd ~/code/balance-sim && ./install.sh     # symlinks the skill, /balance and /balance-studio into ~/.claude
npm test                                   # 19 end-to-end tests
```

Then in Claude Code, in the game's folder: `/balance-studio`, or just say "balance this game" / "balance layalım" (Claude asks whether to use this skill).

## Try it in a minute (no game needed)

```bash
git clone https://github.com/mirmirkedi/balance-sim && cd balance-sim
npm run studio          # opens the web app on a small demo game (nothing in your projects is touched)
```

Click **Run detection**, then **Target** (move the average difficulty up by 10), **Save and calibrate**, **Run calibration**. About two minutes, no dependencies besides Node 18+.

## Without Claude (you already have an adapter)

```bash
cd <game folder>
node ~/.claude/skills/balance-sim/scripts/studio.mjs                     # the web app (or: node <clone>/scripts/studio.mjs)
node ~/.claude/skills/balance-sim/scripts/studio.mjs --adapter path/to/adapter.mjs --targets path/to/targets.json --port 4173
```

## Command line tools

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
| `scripts/report/` | template, css and js of the interactive HTML report |
| `scripts/studio.mjs`, `scripts/studio/` | the web app: local server + single page app (detect, target, calibrate, logs) |
| `scripts/calibrate.mjs` | moves per-stage levers until the measured curve meets the target (used by the studio, also a CLI) |
| `scripts/analyze.mjs` | curve + CI, all target metrics, funnel, calibration, economy, `--compare`, `--html` |
| `scripts/sweep.mjs` | one parameter, several values, best fit to the target curve |
| `scripts/tune.mjs` | evaluates multi-parameter candidates (agent chosen or scouted in agent ranges), keeps history |
| `scripts/personas.mjs`, `lib.mjs`, `rng.mjs` | personas (+ `chooseItem` for shops), shared run loop, seeded RNG |
| `templates/` | adapter and target-curve templates |
| `examples/` | `toy-wave` (turn based), `toy-budget` (shot-budget puzzle), `toy-autobattle` (idle, campaign), `pr14-puzzle` and `pr15-html-vm` (reference adapters of two real prototypes: one wraps a headless engine and an exact solver, the other runs a single-HTML game in a Node `vm`; they need those games to run). Start from `toy-wave` for a complete example with the studio levers. |
| `commands/` | the `/balance` and `/balance-studio` slash commands |
| `CHANGELOG.md` | what changed per version |
| `test/` | end-to-end tests (`npm test`) |

## Status

Tested on three toy mechanics and two real games:
- **PR-15** (internal prototype, single-HTML idle RPG, headless via `vm`): tuned from 22 to 9 points mean error against its target curve, see "Lessons from tuning PR-15" in SKILL.md.
- **PR-14** (internal prototype, egg-nest tile puzzle, headless engine + exact solver): baseline measured, all 100 levels proven solvable, bots lose from level 11 on; not tuned yet because the intended difficulty is undecided.

Known gaps: bots are not humans and are not calibrated to real players (use `--humans`); target curves in the examples are guesses; the `smart` policy of each game is simple; there is no LLM-played persona yet; a long run (3000+ runs with `optimizer`/`oracle`) takes tens of minutes. Real playtests override the report.
