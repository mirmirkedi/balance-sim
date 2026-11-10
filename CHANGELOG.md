# Changelog

## 0.3.0
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
