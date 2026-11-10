#!/usr/bin/env bash
# Symlink the skill and the /balance and /balance-studio commands into ~/.claude. Safe to re-run.
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
mkdir -p "$HOME/.claude/skills" "$HOME/.claude/commands"
ln -sfn "$here" "$HOME/.claude/skills/balance-sim"
ln -sfn "$here/commands/balance.md" "$HOME/.claude/commands/balance.md"
ln -sfn "$here/commands/balance-studio.md" "$HOME/.claude/commands/balance-studio.md"
echo "installed: ~/.claude/skills/balance-sim -> $here"
echo "installed: ~/.claude/commands/balance.md, balance-studio.md"
echo "open the studio in a game folder:  node ~/.claude/skills/balance-sim/scripts/studio.mjs"
