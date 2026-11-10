# Changelog

## 0.4.0
- **Survey** (`scripts/survey.mjs`): scans the game's JSON data by system and checks the logs for what the bots saw: no kill/drop events (loot invisible), kills but no drops, stages without drops, items or enemies defined but never seen, resources earned and never spent. SKILL.md: "What can be balanced here? Survey the game first" (list systems, ask scope, research per genre, make them visible, agree numbers).
- **External runner adapters** for games in Godot, Unity or any other program: `adapter.external.command(ctx)`; the runner slices runs, runs copies in parallel and joins the logs. Template `examples/external-runner/`; smoke-tested on the Godot port of PR-15.
- Calibration safety nets: noise guard (dead band plus one standard error), warnings when a lever is pushed far, `--lever <name>` for other declared levers.
- Default `--jobs` follows free cores (cores minus load); adapters can cap it with `maxJobs`.
- **Parallel runner**: `--jobs N` (default cores - 1, max 8). Same seeds, byte-for-byte same logs as one process (tested), about 3x faster on 4 workers. Detect, calibrate, options and sweep use it automatically. SKILL.md tells agents how to parallelize independent work without oversubscribing the CPU.
- **Content mix as a lever**: adapter `levers.compose` + `calibrate.mjs --compose` swap content types per stage (enemies, tile types, obstacles: "2 grunts -> 2 archers", "2 plain tiles -> 2 stones") when a stage is far off target, then the numeric lever fine-tunes. Adapter-defined `noun`, `power` per type, optional `valid(stage, mix)` to refuse unplayable mixes (unsolvable puzzles). Studio: "Also swap ... types" checkbox, mixes shown in the changes table.
- **Option balance**: `scripts/options.mjs` (usage share + ablation: win-rate change when one option is removed, verdicts DEAD / MANDATORY / DOMINANT / HARMFUL). Runner now counts chosen actions (`acts` on every `end` event) and supports `--set ban.<option>=1`.

## 0.3.0
- **Game type first**: `references/genres.json` (per-genre notes, suggested shape, honest confidence, sources), a game type picker in the studio, `target.mjs --genre/--list-genres`, adapter `studio.genre`, and SKILL.md rules: ask about the game, consult the file, research the web when unsure, write findings back, never present an unsourced number as a standard.
- **Conversation mode**: work by talking with the agent instead of the web app. `detect.mjs` (scores), `target.mjs` (dry-run target proposal, `--write` to save), `calibrate.mjs`; SKILL.md tells the agent to explain, give its own opinion, and agree the target with the user. Same numbers and same run folder as the studio (`scripts/model.mjs`, `scripts/project.mjs`).
- Studio: "Make the whole game harder or easier" is always visible (average slider, +/-5/10, where the change lands), "What happens next" and a one-click verify detection after calibration.
- **Studio**: local web app (`scripts/studio.mjs`): Detect (average and per-stage difficulty, frustration, boredom, skill, confidence), Target (starts from the measured curve; average difficulty with a choice where the change lands; template curves; stage tags; drag to pin), Calibrate (`scripts/calibrate.mjs`, per-stage lever, fresh seed per round, verified on another seed), Runs and logs (console, attempt log, replay, settings, full report).
- `oracle` persona (the game's exact solver, one run per stage), `BOT_LOST` flag, `RANDOM_WINS` only on stages meant to challenge.
- Interactive HTML report (tooltips, explanations, filters, glossary, target explained, dark mode).
- Determinism guard (`NONDETERMINISTIC` warning), run progress output, `--campaign` retries guidance.
- Adapter exports `campaign`, `studio`, `levers` (optional).
- Examples: `pr14-puzzle` (headless engine + solver), `pr15-html-vm` (real single-HTML game in a Node vm) are reference adapters of real games and need those games to run; `toy-*` run anywhere.

## 0.2.0
- Campaign mode, 95% intervals, sweep, replay, human calibration, HTML report, three toy mechanics.

## 0.1.0
- Runner, personas, analyzer, adapter contract, `/balance` command.
