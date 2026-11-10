# balance-sim

Game-independent balance simulator, packaged as a Claude Code skill.
Bots play every level thousands of times, every shot / kill / drop / purchase is logged, and the analyzer prints the difficulty curve against a target curve with a verdict per stage.

```
stage   random novice  smart optimi  target  delta  tries   time  death  income   flags
8          80%    99%   100%   100%     60%    +40    1.0     49   0.00      62   TOO_EASY RANDOM_WINS
9           1%    22%    29%    48%     55%    -26    3.4     55   0.71      74   TOO_HARD SPIKE
```

## Install

```bash
git clone <this repo> ~/code/balance-sim
cd ~/code/balance-sim && ./install.sh     # symlinks the skill and the /balance command into ~/.claude
```

Then in Claude Code: `/balance`, or just say "balance layalım" (Claude asks whether to use this skill).

## Use without Claude

```bash
node scripts/runner.mjs  --adapter examples/toy-wave/adapter.mjs --runs 100 --out logs/base
node scripts/analyze.mjs --logs logs/base --targets examples/toy-wave/targets.json --details --stage 9
```

Write an adapter for your own game from `templates/adapter.template.mjs`. Full workflow, log format and verdict table: [SKILL.md](SKILL.md).

## Layout

| path | what |
|---|---|
| `SKILL.md` | the skill (workflow, personas, log format, verdicts) |
| `scripts/runner.mjs` | plays stages with personas, writes JSONL logs |
| `scripts/analyze.mjs` | curve, verdicts, details, economy, `--compare` |
| `scripts/personas.mjs` | random / novice / smart / optimizer |
| `templates/` | adapter and target-curve templates |
| `examples/toy-wave/` | finished adapter, doubles as smoke test |
| `commands/balance.md` | the `/balance` slash command |

## Status

Works on the toy example only. Not yet tried on a real game. Known gaps are tracked in the issues.
