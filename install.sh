#!/usr/bin/env bash
# Symlink the skill and the /balance command into ~/.claude. Safe to re-run.
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
mkdir -p "$HOME/.claude/skills" "$HOME/.claude/commands"
ln -sfn "$here" "$HOME/.claude/skills/balance-sim"
ln -sfn "$here/commands/balance.md" "$HOME/.claude/commands/balance.md"
echo "installed: ~/.claude/skills/balance-sim -> $here"
echo "installed: ~/.claude/commands/balance.md"
