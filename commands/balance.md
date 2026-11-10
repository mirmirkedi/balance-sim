---
description: Balance a game with bot simulation (difficulty curve, per-stage verdicts, economy)
---

Use the `balance-sim` skill (`~/.claude/skills/balance-sim/SKILL.md`) to balance the game in the current folder.
Arguments from the user: $ARGUMENTS

Start by reading the skill. Follow its "Cost: run it on Haiku" section: delegate the mechanical runs and report reading
to a subagent with model "haiku" and effort "medium" (unless this session already runs on Haiku). Then check whether the game already has a `parameters/` folder and a sim adapter or bot
(`tools/sim.mjs`, `harness.js`, `bot.js`); reuse what exists. If there is no target curve file yet, ask the user for the
target (start win rate, end win rate, boss stages) or propose one from the skill defaults before running anything.
