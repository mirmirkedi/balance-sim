# balance-sim

Game-independent balance simulator and studio, packaged as a Claude Code skill.
Bots play every stage thousands of times and log every shot / kill / drop / purchase. You see how hard the game is, set how hard it should be (whole game, single stages, template curves), and let the studio calibrate towards it. Works for turn based, puzzle, real time, idle and campaign games, written in Node or in another engine (Godot, Unity, a browser: the game program just writes the logs).

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
- **Several levers, not one number.** Per stage it can scale a stat (`levers.stage`), swap the stage's content types (enemies, tile types, obstacles: `levers.compose`, `--compose`, with a `valid()` veto for unsolvable puzzles) or use another declared lever (`--lever player`). It skips stages that are only noise, and warns when one lever is pushed far (a x20 multiplier means the cause is elsewhere).
- **Option balance** (`options.mjs`): how often each action or upgrade is chosen and how much the win rate drops without it: dead, mandatory, dominant options.
- **Any engine.** Node games get an adapter. A game in Godot, Unity or anything else gets an *external runner* adapter: balance-sim starts your program, which plays the bots and writes the same logs; analysis, studio and calibration work unchanged. Template: `examples/external-runner/`.
- **Parallel by default.** The runner splits runs across worker processes (`--jobs N`, default free cores, at most 8) and the logs are identical to a single process.
- **Sweep** one parameter over several values and pick the best (`sweep.mjs`).
- **Agentic tuning** (`tune.mjs`): the agent proposes parameter sets, the script measures them (loss, remaining flags, per-stage deltas, history); the agent interprets and iterates.
- **Genre-aware advice.** The right curve depends on the kind of game. `references/genres.json` holds what is known per type (puzzle, roguelike, tower defense, idle RPG, action, card) with an honest confidence level and sources; the studio shows it next to the target editor and the agent researches the web when a type is missing, then writes the findings back. There is no sourced numeric benchmark for most genres, and the tool says so.
- **Replay** any single run as a timeline (`--replay smart:7:12`).
- **Check the bots against real players** with playtest numbers (`--humans`).
- **Interactive HTML report** (`--html`): summary cards, "look here first", metric and persona toggles, hover tooltips, click a stage for a plain-words explanation with what to try, sortable and filterable table, flag glossary, dark mode. One self-contained file, no network.

## Quick start (the normal way: with Claude)

You do not write any code. You talk to Claude Code in the game's folder:

1. **Install once** (below), then say "balance this game" (or "balance layalım") or run `/balance-studio`.
2. **Claude builds the connector first.** The studio needs a small adapter file in the game (`tools/balance/adapter.mjs`) that lets the bots play it: which actions exist, how a step works, who won. Claude reads your game and writes it (it reuses a headless engine or an existing bot if the game has one, runs single-file web games in a Node `vm`, and for Godot or Unity games uses an external-runner adapter around the game's own bot program). It also declares what calibration may change per stage (`levers`: a stat multiplier, optionally the content mix or another lever), so calibration can work. Claude checks the adapter with a short run before going on.
3. **Claude starts the studio** (`node ~/.claude/skills/balance-sim/scripts/studio.mjs`) and gives you the URL.
4. **You use the four steps in the browser:**
   - **Detect.** See how hard the game is *right now*: an average difficulty and a difficulty score for every stage. No target needed yet.
   - **Target.** The editor starts from that measured curve. Make the whole game harder or easier (average difficulty slider, +5/+10), tag single stages (harder, easier, boss, breather), drag a point, or switch to a template curve.
   - **Calibrate.** The studio moves the per-stage lever until the measured curve meets your target and verifies it on a fresh seed.
   - **Runs and logs.** Console, attempt log, replay, full report of every run.
5. **Claude applies the result.** The studio never edits your game. Press "Copy a prompt for Claude to apply it" and paste it: Claude changes the game's data files one stage at a time with a CHANGELOG line, rebuilds, and you detect again to compare.

Bots are not humans: the scores describe the bots. A real playtest of the changed stages decides.

## Two ways to work

- **Web studio** (click): `/balance-studio`, four steps in the browser (above).
- **Conversation mode** (talk): tell Claude "elle yapalım" / "let's do it by talking". Claude measures with `detect.mjs`, explains the result in plain words, gives its own opinion ("I would ease 12 by 8 and raise 15 by 6, because..."), asks yours, previews the target with `target.mjs` (a dry run until you agree), calibrates with `calibrate.mjs`, applies the change to your game data and measures again. Same numbers and same run folder as the studio, so you can open the web app any time and see the whole history.

## Install

```bash
git clone https://github.com/mirmirkedi/balance-sim ~/code/balance-sim
cd ~/code/balance-sim && ./install.sh     # symlinks the skill, /balance and /balance-studio into ~/.claude
npm test                                   # 29 end-to-end tests
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

Write an adapter for your own game from `templates/adapter.template.mjs` (Node games) or `examples/external-runner/adapter.mjs` (a game in another engine). Workflow, adapter contract, log format and the verdict table: [SKILL.md](SKILL.md).

## Layout

| path | what |
|---|---|
| `SKILL.md` | the skill (workflow, game kinds, personas, adapter contract, log format, verdicts) |
| `scripts/runner.mjs` (parallel by default, `--jobs N`) | plays stages with personas (normal, `--campaign`, `--replay`), writes JSONL logs |
| `scripts/report/` | template, css and js of the interactive HTML report |
| `scripts/studio.mjs`, `scripts/studio/` | the web app: local server + single page app (detect, target, calibrate, logs) |
| `scripts/detect.mjs`, `scripts/target.mjs` | conversation mode: measure with scores, preview and write a target from the command line |
| `scripts/model.mjs`, `scripts/project.mjs` | shared scores and target model (web and command line use the same numbers), run folder helpers |
| `scripts/calibrate.mjs` | moves per-stage levers until the measured curve meets the target; `--compose` also swaps content types (enemies, tile types, obstacles) (used by the studio, also a CLI) |
| `scripts/options.mjs` | option balance: how often each action/upgrade is chosen and what the win rate loses when it is removed (dead, mandatory, dominant options) |
| `scripts/analyze.mjs` | curve + CI, all target metrics, funnel, calibration, economy, `--compare`, `--html` |
| `scripts/sweep.mjs` | one parameter, several values, best fit to the target curve |
| `scripts/tune.mjs` | evaluates multi-parameter candidates (agent chosen or scouted in agent ranges), keeps history |
| `scripts/personas.mjs`, `lib.mjs`, `rng.mjs` | personas (+ `chooseItem` for shops), shared run loop, seeded RNG |
| `templates/` | adapter and target-curve templates |
| `examples/` | `toy-wave` (turn based, with stat and content-mix levers), `toy-budget` (shot-budget puzzle), `toy-autobattle` (idle, campaign), `external-runner` (template for games in Godot/Unity/other programs), `pr14-puzzle` and `pr15-html-vm` (reference adapters of two real prototypes: one wraps a headless engine and an exact solver, the other runs a single-HTML game in a Node `vm`; they need those games to run). Start from `toy-wave` for a complete example with the studio levers. |
| `commands/` | the `/balance` and `/balance-studio` slash commands |
| `CHANGELOG.md` | what changed per version |
| `test/` | end-to-end tests (`npm test`) |

## Status

Tested on three toy mechanics and two real games:
- **PR-15** (internal prototype, single-HTML idle RPG, headless via `vm`): tuned from 22 to 9 points mean error against its target curve, see "Lessons from tuning PR-15" in SKILL.md.
- **PR-14** (internal prototype, egg-nest tile puzzle, headless engine + exact solver): baseline measured, all 100 levels proven solvable, bots lose from level 11 on; not tuned yet because the intended difficulty is undecided.

- **PR-15 Godot port** (internal, Godot 4.7, bots run the real game code headless): the external-runner adapter ran a short smoke test against it (3 stages, 2 players) and the analysis worked on the logs. A full calibration through balance-sim has not been done there yet.

Known gaps: the player's own power curve is not a lever unless the adapter declares one (`--lever player`); a Godot/Unity project needs a bot program that writes the logs (the template shows the contract; no generic one exists); no screenshots in this README yet; bots are not humans and are not calibrated to real players (use `--humans`); target curves in the examples are guesses; the `smart` policy of each game is simple; there is no LLM-played persona yet; a long run (3000+ runs with `optimizer`/`oracle`) takes tens of minutes. Real playtests override the report.

## For agents

Read `SKILL.md`, especially "Warnings for agents": bots are not players, ask before changing game data, check the game folder before every run, and keep determinism and noise in mind.
