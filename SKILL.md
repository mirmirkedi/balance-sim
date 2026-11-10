---
name: balance-sim
description: Game-independent balance simulator. Plays every level/stage/wave thousands of times with bot personas (random, novice, smart, optimizer), logs every shot/kill/drop/purchase, and prints the difficulty curve against a target curve with per-stage verdicts (too easy, too hard, spike, no skill, economy leaks). Use when the user wants to balance, tune difficulty, "balance layalım", "balans", "zorluk eğrisi", check which levels are too easy or hard, or sanity-check an economy. When the user says they want to balance a game, ASK first whether to use this skill ("balance-sim ile mi yapalım?") before starting.
---

# balance-sim

Goal: replace "feels too hard" with numbers. Which stages are easy, which are hard, how hard, and *why* (what happened shot by shot).
Works for any game (waves, merge, puzzle, idle, cannon, card) because the game only has to expose a tiny adapter.

Scripts live in `~/.claude/skills/balance-sim/scripts/`. Needs only Node 18+.

## Workflow (do in this order, never skip 1)

1. **Target curve first.** Copy `templates/targets.template.json` into the game's `parameters/` (or `tools/`) and fill it.
   Per stage: first-try win rate of the *average* player (persona `smart`), time, deaths, income. A `curve` block (start, end, shape, `bosses`, `bossDrop`) generates a default; override single stages under `stages`.
   Typical: start 0.90-0.95, end 0.40-0.55, bosses 10-20 points lower. Ask the user if unsure. Their rule: write the curve before tuning.
2. **Adapter.** Copy `templates/adapter.template.mjs` next to the game and fill it (see "Integration modes"). Look at `examples/toy-wave/adapter.mjs` for a finished one.
3. **Run**
   ```bash
   node ~/.claude/skills/balance-sim/scripts/runner.mjs --adapter <adapter.mjs> --runs 100 --out logs/base
   node ~/.claude/skills/balance-sim/scripts/analyze.mjs --logs logs/base --targets <targets.json> --out logs/base_report.json
   ```
   Flags: `--stages 1-20` or `--stages 5,boss1`, `--personas random,novice,smart,optimizer`, `--runs N`, `--seed N`, `--full K` (keep full event logs for the first K runs per persona+stage, default 3), `--novice-error 0.25`.
4. **Read the report** (see "Reading the verdicts"). Fix the worst stage group first, not everything at once.
5. **One variable at a time.** Change one number in the game's data file, re-run, and use `--compare logs/base_report.json` to see the delta. Keep a line per change in the game's CHANGELOG if it has one.
6. **Details when a stage is odd:** `analyze.mjs --logs ... --details --stage 7` prints kills per enemy, damage taken, drop rates, faucet vs sink. Open `logs/<persona>.jsonl` and grep a `run` to replay one bad run (same seed = same run).
7. **Report to the user in plain words:** table of stages with the verdict, the 3 biggest problems, what you changed and the new numbers. Say clearly that bots are not humans.

Run the big validation (many runs, all stages) last, after content changes. Use small `--runs 30 --stages a-b` while iterating.

## Personas

| persona | plays like | maps to global rule |
|---|---|---|
| `random` | uniform random legal move | floor / sanity check |
| `novice` | smart but errs `--novice-error` (25%) of moves | novice |
| `smart` | game's `policy()` / `scoreAction()` / 1-ply lookahead | average (default target persona) |
| `optimizer` | 2-ply lookahead on `clone()`, needs `evaluate()` | optimizer |

Rules of thumb from the research (see References): never judge difficulty with one bot, use several strategies; the *gap* between personas is the signal.
- random wins a lot -> choices do not matter / too easy.
- smart ~ random -> no skill depth (`NO_SKILL`).
- smart wins, novice loses -> mistakes are punished (usually good).
- optimizer >> smart -> hidden strong strategy, check for a dominant option.

## Integration modes (pick the cheapest that works)

- **A. Pure engine module** (PR-19 style: `game/engine.js` + `GAME_DATA`). Import it in the adapter and call its step/tick functions. Best, ~1000+ runs/s.
- **B. Single HTML artifact.** Extract the logic into a function/module first if it is not tangled with the DOM; that refactor is usually worth it. If not possible: load the script in Node `vm` with stubbed `document`/`window`/`requestAnimationFrame`, replace `Date.now`/`performance.now`/`setTimeout` with a fake clock and step it with fixed `dt`, replace `Math.random` with the seeded rng.
- **C. In-page harness** (PR-15 `harness.js` style, clicks real buttons). Slowest. Use only when logic cannot be pulled out; copy the runner loop into the page, return the JSONL as a string, write it to `logs/<persona>.jsonl` yourself. The analyzer does not care how the logs were produced.

Whatever the mode: fixed dt per `step()`, no `Math.random()`, no waiting on animations, deterministic given `seed`.
`step(action)` = apply one player decision and fast-forward to the next decision (or one fixed tick for real-time games, with the action chosen each tick, `noop` allowed).

## Log format (JSONL, one object per line)

Added by the runner: `run, seed, persona, stage, step, t, type`.
`type:"end"` (always written, one per run): `win, hpLeft, hpMax, time, deaths, income, resources, timeout, steps, error`.
Game events via `emit(type, {actor, target, before, after, data})`; use these types so `--details` understands them:

| type | when | `data` |
|---|---|---|
| `shoot` / `hit` | player attack, any action that deals damage | `kind`, `amount` |
| `damage` | player or base takes damage | `source`, `amount` |
| `kill` | enemy dies | `victim`, `amount` (= hits or shots needed) |
| `drop` | item or currency dropped | `item`, `amount` |
| `gain` / `spend` | any resource enters / leaves the economy | `res`, `amount` |
| anything else | free form, counted by type | `kind` |

Put the state that matters in `before`/`after` (player hp, enemy hp, shots left, moves left...). That is what answers "at that moment how much hp did the player have and how many enemies were left".

## Reading the verdicts

| flag | meaning | typical fix |
|---|---|---|
| `TOO_EASY` / `TOO_HARD` | target persona is outside target ± tolerance | change enemy hp/count/attack, player power, budget |
| `SPIKE` | difficulty jumped > 20 points vs median of previous 3 stages (not at bosses) | smooth the ramp, move the new mechanic one stage later or teach it first |
| `DIP` | sudden easy stage after harder ones | raise it, or keep as a breather on purpose |
| `RANDOM_WINS` | random bot wins > 25% | add real threat, cut budget, require a decision |
| `NO_SKILL` | smart - random < 15 points (and smart < 95%) | choices must matter: add counters, resource trade-offs |
| `COINFLIP` | win rate 15-85% and most wins are near-miss | luck decides; reduce variance (crit, drops, spawns) or add pity |
| `BROKEN` | errors or > 20% timeouts | fix soft-locks first, balance later |
| `LOW_N` | fewer than 20 runs | raise `--runs` |

Also look at: cliff shape (all 100% then 0%: the ramp is a staircase, smooth the scaling exponent; `examples/toy-wave` shows exactly this), `tries` column (expected attempts for that persona, >3 on non-boss = frustrating), time column (too long = grind), economy ratio (gain/spend far from 1 over a chapter: faucet without sink).

## Balancing rules (from the user's global CLAUDE.md, keep following them)

- All numbers live in small JSON files; the adapter reads the same files as the game.
- Change one variable at a time, re-run, then the next.
- Buff weak options instead of nerfing strong ones. Add pity to random drops. Every faucet needs a sink.
- Real playtest or telemetry overrides the bot. State this in every report.

## Known limits

- Bots do not feel boredom, misread UI or take risks; use `novice` + the user's own playtest notes to calibrate the target curve.
- If `smart` is weak the curve is too pessimistic; if the policy is a perfect solver it is too optimistic. Spot-check by replaying one run from the JSONL.
- Games where every level needs a specific strategy (puzzle/tower-defense with unique solutions) are hard for generic bots; use the solver in the game if it has one as the `smart` persona and treat random win rate as the main signal.

## References (searched 2026-11)

- Gudmundsson et al., *Human-like playtesting with deep learning* (match-3): agents trained on human play predict level difficulty better than tree search.
- Politowski et al. 2023: autonomous agents to find difficulty spikes and check skill vs luck.
- Anghileri (Polimi): simulating several strategies predicts level success rate better than one.
- ITU thesis on mobile puzzles: the agent's top ~10% runs correlate with human results -> optionally compare `optimizer`'s best runs with the real best players.
- RaidEnv (2023): agent playtesting must generalize when content changes -> keep personas game-independent, re-run after every data change.
- Machinations (commercial) covers economy flow; no open-source faucet/sink simulator found, so `--details` does a minimal one.
