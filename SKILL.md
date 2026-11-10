---
name: balance-sim
description: Game-independent balance simulator. Plays every level/stage/wave thousands of times with bot personas (random, novice, smart, optimizer), logs every shot/kill/drop/purchase, and prints the difficulty curve against a target curve (win rate with confidence interval, time, deaths, income) with per-stage verdicts (too easy/hard, spike, wall, no skill, economy leaks). Works for turn based, real time, puzzle/shot-budget, idle/auto-battler and campaign/economy games; has parameter sweeps, run replay, calibration against real players and an HTML report. Use when the user wants to balance, tune difficulty, "balance layalım", "balans", "zorluk eğrisi", check which levels are too easy or hard, or sanity-check an economy. When the user says they want to balance a game, ASK first whether to use this skill ("balance-sim ile mi yapalım?") before starting.
---

# balance-sim

Goal: replace "feels too hard" with numbers. Which stages are easy, which are hard, how hard, and *why* (what happened shot by shot).
The game only has to expose a small adapter, so it works for any mechanic.

Scripts: `scripts/` next to this file (installed at `~/.claude/skills/balance-sim/`). Node 18+. Run tests: `npm test`.

## Workflow (in this order, never skip 1)

1. **Target curve first.** Copy `templates/targets.template.json` into the game's `parameters/` and fill it.
   First-try win rate of the *average* player (persona `smart`) per stage via a `curve` (start, end, shape, `bosses`, `bossDrop`), plus optional `timeCurve`, `deathsCurve`, `incomeCurve`, or per-stage overrides under `stages`.
   Typical: start 0.90-0.95, end 0.40-0.55, bosses 10-20 points lower. Ask the user if unsure.
2. **Adapter.** Copy `templates/adapter.template.mjs` next to the game and fill it. Finished examples, one per mechanic:
   - `examples/toy-wave` turn based waves (policy + evaluate, drops, potions)
   - `examples/toy-budget` shot-budget puzzle, aiming discretized, no policy, lookahead only
   - `examples/toy-autobattle` idle / auto battler, no decisions in a fight, campaign + shop + economy
3. **Run**
   ```bash
   S=~/.claude/skills/balance-sim/scripts
   node $S/runner.mjs  --adapter <adapter.mjs> --runs 100 --out logs/base
   node $S/analyze.mjs --logs logs/base --targets <targets.json> --out logs/base.json --html logs/base.html
   ```
   Flags: `--stages 1-20` or `--stages 5,boss1`, `--personas random,novice,smart,optimizer`, `--runs N`, `--seed N`, `--full K` (keep full event logs for the first K runs per persona+stage), `--novice-error 0.25`, `--set key=value` (params for the adapter), `--campaign --retries 2`.
4. **Read the report** (verdict table below). Fix the worst stage group first.
5. **One variable at a time.** `node $S/sweep.mjs --adapter A --targets T --param enemyHp --values 0.8,0.9,1,1.1 --stages 1-12 --fit-stages 5-12 --runs 60` runs one parameter over several values and prints win rate per stage, error against the target curve and the best value (warns when the curve is a cliff: use finer steps; a single parameter cannot fix a shape problem). Apply the winner in the game's data file, re-run, and use `analyze.mjs --compare logs/base.json` for the delta. One CHANGELOG line per change.
6. **Why is a stage odd?** `analyze.mjs --details --stage 7` (kills per enemy, damage taken, drop rates, faucet vs sink). To watch one run: `runner.mjs --adapter A --replay smart:7:12` (persona:stage:run) prints that exact run as a timeline; same seed, same run, also in a full pass.
7. **Calibrate against reality.** With real playtest or telemetry first-try win rates in `humans.json` (`{"1":0.96,"2":0.9,...}`) run `analyze.mjs --humans humans.json`: it shows which persona is closest (MAE, correlation, bias). Use that persona as `targetPersona`, or shift the target by the bias. Real data always overrides the bot.
8. **Report to the user in plain words:** stage table with verdicts, the 3 biggest problems, what you changed and the new numbers, and that bots are not humans. Offer the HTML report.

Run the big validation (many runs, all stages, campaign) last, after content changes. While iterating use `--runs 30 --stages a-b`. Below ~50 runs the CI is wide: trust `?EASY`/`?HARD` only as "run more".

## Which kind of game is it?

| game | legalActions() | extra |
|---|---|---|
| turn based, cards, match-3, puzzle | the moves | `policy` or `evaluate`+`clone` |
| shot / move budget (cannon, destruction) | discretized aim x power (8-60 candidates) | `evaluate`+`clone` for lookahead; beam pruning keeps it fast |
| real time (shooter, runner, tower defense) | the choices per decision | `actionRepeat: N` (decide every N ticks), `idleAction` for the ticks in between |
| idle, auto battler, merge board | `[]` (nothing to decide in a fight) | `advance()`, and put the skill in `shop()` / `afterStage()` in `--campaign` mode |
| roguelike, RPG, economy | fight moves | `--campaign`: a profile with gold, gear, levels persists across stages |

**Campaign mode** (`--campaign`): one simulated player walks the stages in order, keeps a `profile` (`newProfile`), earns (`afterStage`), spends (`shop`, persona skill matters via `chooseItem`), retries a lost stage up to `--retries` times and quits at a wall. The report then shows first-try win, tries per stage, `reach` (funnel), `bank` and `power` (from `snapshot`), and `WALL`. Use it whenever the economy or upgrades decide difficulty. Without it every stage is independent, so `create()` must set a realistic player strength for that stage.

## Personas

| persona | plays like | maps to global rule |
|---|---|---|
| `random` | uniform random legal move (random shop choice) | floor / sanity check |
| `novice` | smart but errs `--novice-error` (25%) of decisions | novice |
| `smart` | `policy()` / `scoreAction()` / 1-ply lookahead | average (default target persona) |
| `optimizer` | 2-ply lookahead (beam 6) on `clone()` | optimizer |

Never judge difficulty with one bot, the gaps are the signal: random wins a lot = choices do not matter; smart ~ random = no skill depth; smart >> novice = mistakes are punished; optimizer >> smart = hidden strong strategy or a weak `smart` policy.

## Adapter contract

```
stages: [ids]                        play order
create({stage, seed, emit, params, profile}) -> game
game: legalActions() step(a) isDone() result()          required
      time() advance() clone() observe()                 optional
adapter: policy | scoreAction | evaluate                 how smart plays
         actionRepeat idleAction                          real time
         newProfile afterStage shop snapshot              campaign
result(): {win, hpLeft, hpMax, time, deaths, income, resources}
```
Always: fixed dt per step, no `Math.random()`, deterministic in `seed`, `clone()` reseeds its own random stream (otherwise the lookahead sees future rolls), emit events for everything that matters.

## Log format (JSONL per persona, one object per line)

Added by the runner: `run, seed, persona, stage, step, t, type`. Campaign adds `attempt, campaign:true`.
`type:"end"` once per attempt: `win, hpLeft, hpMax, time, deaths, income, resources, timeout, steps, error, snap`. `type:"stall"`: player quit the stage.
Game events via `emit(type, {actor, target, before, after, data})`:

| type | when | `data` |
|---|---|---|
| `shoot` / `hit` | any damaging action | `kind`, `amount` |
| `damage` | player or base takes damage | `source`, `amount` |
| `kill` | enemy dies | `victim`, `amount` (hits needed) |
| `drop` | item or currency dropped | `item`, `amount` |
| `gain` / `spend` | resource enters / leaves the economy | `res`, `amount` |

Put the state that matters in `before`/`after` (player hp, enemy hp, shots left). Full event logs are kept for the first `--full` runs per persona+stage; `end` lines for all.

## Verdicts

| flag | meaning | typical fix |
|---|---|---|
| `TOO_EASY` / `TOO_HARD` | whole 95% CI of the target persona is outside target ± tolerance | enemy hp/count/attack, player power, budget |
| `?EASY` / `?HARD` | point estimate is outside the band, CI still touches it | run more before changing anything |
| `SPIKE` / `DIP` | difficulty jumped / dropped > 20 points vs median of previous 3 stages (not bosses) | smooth the ramp; teach a new mechanic first |
| `WALL` | campaign: > `stallMax` of players quit here | lower the gate, add farming income or a power-up |
| `SLOW` / `FAST` | time off the `timeCurve` by > 30% | pacing, enemy hp |
| `DEATHY` | more failed attempts than the `deathsCurve` | smooth the ramp, add checkpoints |
| `INCOME_LOW` / `INCOME_HIGH` | income off the `incomeCurve` | faucet size; every faucet needs a sink |
| `RANDOM_WINS` | random bot wins > 25% | add real threat, cut budget, force a decision |
| `NO_SKILL` | smart - random < 15 points (and smart < 95%) | choices must matter: counters, trade-offs |
| `POLICY_GAP` | optimizer beats smart by > 20 points | smart policy is weak, or a dominant option exists |
| `COINFLIP` | win 15-85% and most wins are near-miss | luck decides: reduce variance, add pity |
| `BROKEN` | errors or > 20% timeouts | fix soft-locks first |
| `LOW_N` | fewer than 20 runs | `--runs` |

Also: cliff shape (all 100% then 0%: the ramp is a staircase), `tries` (>3 on a non-boss stage is frustrating), skill depth (smart - random) and mistake cost (smart - novice) at the end of the report.

## Balancing rules (user's global CLAUDE.md, keep following them)

- All numbers live in small JSON files; the adapter reads the same files as the game.
- Change one variable at a time, re-run, then the next (that is `sweep.mjs`).
- Buff weak options instead of nerfing strong ones. Add pity to random drops. Every faucet needs a sink.
- Real playtest or telemetry overrides the bot. Say so in every report.

## Known limits

- A bot is as good as its `policy`/`evaluate`. If `smart` is weak the curve is too pessimistic; a perfect solver makes it too optimistic. Calibrate with `--humans`, spot-check with `--replay`.
- Games where each level needs one specific strategy (unique-solution puzzles, hand-made tower-defense levels) are hard for generic bots: use the game's solver as the `smart` persona and read the random win rate and `tries` as the main signal.
- The campaign player is simple: spends all money immediately, retries blindly. Model a smarter or lazier player by changing `shop()`.
- Statistics: win rates have ±5 points of noise at 100 runs; the report prints the 95% Wilson interval.

## References (searched 2026-11)

- Gudmundsson et al., *Human-like playtesting with deep learning* (match-3): agents trained on human play predict level difficulty better than tree search.
- Politowski et al. 2023: autonomous agents to find difficulty spikes and check skill vs luck.
- Anghileri (Polimi): simulating several strategies predicts level success rate better than one.
- ITU thesis on mobile puzzles: an agent's top ~10% runs correlate with human results.
- RaidEnv (2023): playtesting agents must generalize when content changes: re-run after every data change.
- Machinations (commercial) covers economy flow; no open-source faucet/sink simulator found, `--details` and campaign `bank` do a minimal one.
