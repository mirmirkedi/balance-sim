---
description: Open the balance-sim studio (web app) for the game in the current folder
---

Start the balance-sim studio for the game in the current folder and give the user the URL.
Arguments from the user: $ARGUMENTS

1. Check the game has a bot adapter (`tools/balance/adapter.mjs`). If not, read `~/.claude/skills/balance-sim/SKILL.md` and write one first (step 2 of the workflow, game kinds table, adapter contract incl. the optional `campaign`, `studio` and `levers` exports).
2. Run `node ~/.claude/skills/balance-sim/scripts/studio.mjs --no-open` in the background from the game folder (pass `--adapter` / `--targets` / `--port` if the paths differ) and print the URL it shows.
3. Tell the user the four steps in one line each: Detect (average and per-stage difficulty), Target (template curves, average difficulty, stage tags), Calibrate (automatic lever tuning), Runs and logs. Then stay available: the studio never edits game files, applying a calibration result to the game's data is your job when the user asks.
