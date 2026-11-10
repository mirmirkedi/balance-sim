---
name: balance-sim
description: Game-independent balance simulator. Plays every level/stage/wave thousands of times with bot personas (random, novice, smart, optimizer), logs every shot/kill/drop/purchase, and prints the difficulty curve against a target curve (win rate with confidence interval, time, deaths, income) with per-stage verdicts (too easy/hard, spike, wall, no skill, economy leaks). Works for turn based, real time, puzzle/shot-budget, idle/auto-battler and campaign/economy games; has a local web studio (detect current difficulty, set a target curve, auto-calibrate per-stage levers, run logs), parameter sweeps, run replay, calibration against real players and an HTML report. Use when the user wants to balance, tune difficulty, "balance layalım", "balans", "zorluk eğrisi", check which levels are too easy or hard, or sanity-check an economy. When the user says they want to balance a game, ASK first whether to use this skill ("balance-sim ile mi yapalım?") before starting.
---

# balance-sim

Goal: replace "feels too hard" with numbers. Which stages are easy, which are hard, how hard, and *why* (what happened shot by shot).
The game only has to expose a small adapter, so it works for any mechanic.

Scripts: `scripts/` next to this file (installed at `~/.claude/skills/balance-sim/`). Node 18+. Run tests: `npm test`.

## Game type first: advice depends on the genre (both modes)

There is no universal "perfect curve". What good looks like depends on the kind of game, the session length, the audience (casual, mid-core, hardcore), retries/lives/hints and the monetization. So BEFORE you recommend a target:
1. **Find out the game type** and the goal. Read the genre from the adapter (`studio.genre`) or ask the user. Ask the few questions that change the advice: who plays it, how long a session is, what a failed attempt costs, whether walls are meant to exist.
2. **Read `references/genres.json`** (the studio shows it in the Target tab; `target.mjs --genre <id>` prints it; `--list-genres` lists the types). Each entry has notes, a suggested starting shape, a `basis` and sources.
3. **If the genre is missing, thin (`basis: judgment`, no sources) or the game is unusual: research it on the web** (WebSearch; use the extended mode for niche genres). Prefer primary sources: postmortems, GDC/Game Developer articles, papers, official docs, the studio's own blog. Discard content farms, mirror sites that copy university names, and forum rumor stated as fact.
4. **Write what you learned back into `references/genres.json`** (notes, sources with URLs, date, honest `basis`) so the next game of that type starts smarter.
5. **Be honest about certainty when you advise.** Say which part is sourced, which is one developer's anecdote, which is your own judgment. NEVER present a number as an industry standard unless a source says so. State: "no sourced first-try win-rate benchmark exists for this genre; here is what practitioners do, here is my reasoning, what do you want?". As of 2026-11 sources agree on the SHAPE (sawtooth over a straight ramp, scheduled boss peaks, avoid sudden spikes, find spikes with logs and funnels) but not on numbers.
6. **Adapt the method to the genre:** puzzles use the oracle persona and completion-rate language; run-based games look at a survival curve and where runs end, not first-try wins per stage; idle/auto-battler games measure retries and quit rate in campaign mode, walls are fine when the player can get stronger; skill-based games need real playtests because bots only approximate reflexes.

## Studio: the web app (start here when the user wants to see and click)

Order of work with the user: (1) **you write the connector first** (`tools/balance/adapter.mjs`, step 2 of the workflow, including `campaign`/`studio`/`levers`) and check it with a short run; (2) start the studio and give the URL; (3) the user measures the game as it is BEFORE any target exists; (4) only then the target is set, starting from the measured curve; (5) calibrate; (6) you apply the result to the game's data on request. `node ~/.claude/skills/balance-sim/scripts/studio.mjs` in the game folder opens a local web app. Four steps in the UI:
1. **Detect:** runs the bots on every stage and shows the average difficulty (0-100) and per-stage difficulty, frustration, boredom, skill and confidence scores.
2. **Target:** pick the game type (shows what is usually recommended, how sure that is and the sources); starts from the measured curve (frozen at save); make the whole game harder or easier with the average difficulty slider, tag stages, drag points, or pick a template curve (linear, slow start, fast start, S-curve, waves per area, staircase, flat, smooth current, keep current), a fixed average difficulty, tags per stage (harder, easier, boss, breather) and drag-to-pin. Saves `targets.json` with one first-try win rate per stage (1 - difficulty/100).
3. **Calibrate:** moves the adapter's per-stage `levers.stage` until the measured curve meets the target (`scripts/calibrate.mjs`, fresh seed per round, verified on another seed). Result: before/after, a table of lever changes, "use as active candidate", a prompt for Claude to apply it.
4. **Runs and logs:** console, attempt log with replay, settings and the full report of every run (state in `<game>/.balance-sim/`).
The studio never edits game files. Applying calibrated values to the game's data is the agent's job (copy the prompt). Optional adapter exports it reads: `campaign: true`, `studio: { runs, retries, personas }`, `levers: { stage: { param: 'TUNE.stage.adj.{stage}', mode: 'mul' | 'add', harder: 1 | -1, min, max, default, step, integer, unit, read(stageId) } }` (see `examples/pr15-html-vm`, `examples/pr14-puzzle`). Without `levers` Detect and Target still work; tune with the agentic loop below.

## Conversation mode: talk it through, no web app

Use it when the user says they want to do it by talking ("elle", "konuşarak", "web açma", "sen anlat, ben karar vereyim") or does not want a browser. You are the user's balance partner: you measure, explain, give an OPINION, propose, agree, then act. Same workflow and same numbers as the studio (`scripts/model.mjs`), runs land in the same `.balance-sim/runs/` folder, so the user can open the studio later and see everything.

1. **Connector first** (adapter, as always).
2. **Detect:** `node ~/.claude/skills/balance-sim/scripts/detect.mjs` in the game folder (flags: `--runs`, `--retries`, `--personas`, `--stages`, `--adapter`). Prints the average difficulty, ramp, spikes, frustration, boredom, skill and a per-stage table.
3. **Explain in plain words, in the user's language** (and say which game type you assume and why, see "Game type first"): what the average means for a player, the shape of the curve, the 3-5 stages that matter and why, what the bots cannot tell. Short, with numbers.
4. **Give your opinion, not only data.** Say what YOU would do and why ("Bence stage 12-14 tek seferde sıçrıyor, 12'yi 8 puan indirip 15'i 6 artırırdım, çünkü..."), offer 2-3 options with a recommendation, then ASK what they think ("senin fikrin ne?"). Ask about the intended audience and goal if unknown (casual or hardcore, retries, lives, hints). Never choose the target alone.
5. **Preview the target:** `node ~/.claude/skills/balance-sim/scripts/target.mjs --shift +10 --spread later --tag 12=easier,25=boss` (also `--template`, `--average`, `--pin`, `--bosses`, `--tolerance`). It starts from the measured curve and is a DRY RUN until `--write`. Show the user the average before/after and the biggest changes, adjust until they agree, then run it again with `--write`.
6. **Calibrate:** `node ~/.claude/skills/balance-sim/scripts/calibrate.mjs --adapter A --targets T --out <game>/.balance-sim/runs/calibrate-<name> --rounds 6 --runs 60 [--campaign --retries 10]` (needs `levers.stage`). Read the result with the user: before/after gap, which stages moved, what a number cannot fix (then propose structural changes).
7. **Apply to the game data** one stage at a time with a CHANGELOG line (ask first), rebuild, then run `detect.mjs` again as the CHECK (not a restart) and compare with the earlier run. If it is off, adjust the target or calibrate again.
Rules: confirm before writing a target or editing game files; say when numbers are uncertain (few players, bots are not humans); always show the average difficulty before and after; keep each message short. If the user later wants to click around, start the studio.

## Cost: run it on Haiku

Running the simulations and reading the report is mechanical, so it should not burn the big model's tokens (the user asked for this).
- If this session already runs on Haiku, just follow the workflow.
- Otherwise delegate workflow steps 3, 5, 6, 7 (run, analyze, sweep, replay, humans calibration) to a subagent: `Agent` with `model: "haiku"` (Haiku 5.5, `claude-haiku-5-5`) and `effort: "medium"`. Give it the exact commands and paths and ask it to return only: the stage table, the Summary block, and the best sweep value. Never let raw JSONL logs or full reports flow back into the main conversation.
- Keep on the main model: understanding a complicated game's code to write its adapter (step 2), choosing which number to change, and the plain-words report to the user. Filling the adapter template for a simple game can go to the Haiku subagent too.
- One subagent per job (a baseline run, a sweep). Do not spawn one per persona or per stage.

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

## Tuning loop (agentic): the agent decides, scripts only measure

Use when one-variable sweeps are not enough (the curve has the wrong SHAPE: a wall at stage 5, everything easy after 15). `scripts/tune.mjs` never picks numbers by itself. You do, by reading results. Do not replace this with a blind optimizer.

1. **Diagnose first.** From the baseline report list the problem stages and the reason (use `--details` and `--replay`): boss HP too high? income too low so the shop is empty? one formula too steep? Write one sentence per problem.
2. **Choose the levers.** Pick 2-4 parameters that plausibly cause it (`parameters/*.json` keys the adapter reads from `params`). Say why each. Set sane ranges (never "make the enemy harmless to hit the curve"). Keep parameters the user said are fixed out of it.
3. **Evaluate candidates** (this is the mechanical part, delegate to Haiku, see Cost):
   ```bash
   node $S/tune.mjs --adapter A --targets T --state tune-state --runs 60 \
        --cand "hpUp:enemyHp=1.3" --cand "hpUp+gold:enemyHp=1.3,goldMul=1.2"      # your hypotheses
   node $S/tune.mjs --adapter A --targets T --state tune-state --scout 12 --ranges "enemyHp=0.9..1.5,goldMul=1..1.4"   # optional random scouting inside YOUR ranges
   ```
   Baseline is added automatically. The history is kept in `tune-state/history.jsonl`; `--history` lists it, `--detail <name>` shows a candidate stage by stage.
4. **Interpret, do not just take the lowest loss.** Check: which stages are still outside the tolerance and in which direction; are the remaining flags (WALL, SPIKE, NO_SKILL) gone or moved; did the shape improve or only the average; does the result make design sense (a boss still feels like a boss, money still has a sink). Replay one flagged stage of the best candidate. Low loss with a changed character of the game is a bad candidate.
5. **Next round.** Write down what you learned (lever X moves stages a-b by about N points), narrow the ranges or change levers, and repeat 3-4. Stop when the problem stages are inside the band, or when two rounds bring no gain (then the formula or the mechanic must change, not the numbers). Typically 3-5 rounds.
6. **Verify and hand over.** Take the best 1-2 candidates, run them with `--runs 200` on all personas (`runner.mjs` + `analyze.mjs --compare`), and also check `random` and `novice` did not break. Then apply ONE change at a time to the data file with a CHANGELOG line, as in the balancing rules. Tell the user what changed and why, and that bots are not humans: a real playtest of the changed stages decides.

Bots run now, an LLM-played persona can be added later as an extra persona with the same log format.

## Which kind of game is it?

| game | legalActions() | extra |
|---|---|---|
| turn based, cards, match-3, puzzle | the moves | `policy` or `evaluate`+`clone` |
| shot / move budget (cannon, destruction) | discretized aim x power (8-60 candidates) | `evaluate`+`clone` for lookahead; beam pruning keeps it fast |
| real time (shooter, runner, tower defense) | the choices per decision | `actionRepeat: N` (decide every N ticks), `idleAction` for the ticks in between |
| idle, auto battler, merge board | `[]` (nothing to decide in a fight) | `advance()`, and put the skill in `shop()` / `afterStage()` in `--campaign` mode |
| roguelike, RPG, economy | fight moves | `--campaign`: a profile with gold, gear, levels persists across stages |

**Campaign mode** (`--campaign`): one simulated player walks the stages in order, keeps a `profile` (`newProfile`), earns (`afterStage`), prepares before EVERY attempt (`shop`: spends, equips, merges, levels; persona skill matters via `chooseItem`), retries a lost stage up to `--retries` times and quits at a wall. The report then shows first-try win, tries per stage, `reach` (funnel), `bank` and `power` (from `snapshot`), and `WALL`. Use it whenever the economy or upgrades decide difficulty. Without it every stage is independent, so `create()` must set a realistic player strength for that stage.

## Games whose code is one HTML file (proven on PR-15)

Do not click through the UI. Run the real shipped code headless, see `examples/pr15-html-vm/` (adapter.mjs + ctx.js):
1. Read the game's `<script>` from `game.html`, drop the boot call (`init();`), run it with `vm.runInContext` in a context with a catch-all Proxy as `document`, stub `localStorage`, `setTimeout`, `requestAnimationFrame`.
2. A second script, run in the same context (`ctx.js`), replaces every function that opens a screen (modals, toasts, reveal panels) with a pending decision, wraps the damage/kill/commit functions to `emit` events, and exposes a small `__api` (setup, tick, state, resolve, meta actions). Combat, drops and rewards keep running the original functions.
3. Seed `Math.random` inside the context with the run seed; apply `--set TUNE.x.y=v` by writing into the game's own tuning object.
4. The auto-combat part has no decisions, so the runner calls `advance()`; real decisions (gear, event choices, fight or run) come out as `legalActions()`; backpack/level/store play goes into `shop()` with `--campaign`.
It took one adapter file plus one context file and runs ~3000 attempts in 6 seconds.

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
         levers.stage / levers.compose / options          what calibration may change (see below)
result(): {win, hpLeft, hpMax, time, deaths, income, resources}
```
Always: fixed dt per step, no `Math.random()`, deterministic in `seed`, `clone()` reseeds its own random stream (otherwise the lookahead sees future rolls), emit events for everything that matters.

## Enemy mix and option balance (beyond one number per stage)

**Content mix (enemies, tile types, obstacles, pickups).** A stage can be made harder by scaling numbers (`levers.stage`) OR by changing WHICH content it is built from: "level 12: two archers instead of two grunts" in an action game, "two stone blocks instead of two plain tiles" in a tile puzzle, a harder pickup table in an idle game. Declare it with `levers.compose`; what the types are depends on the game, so look at how its stages are made first (spawn list, grid cells, drop table):
```
compose: { noun: 'enemy',                          // or 'tile', 'obstacle': what the studio calls them
           param: 'comp.{stage}',                 // gets "grunt:3,brute:1" as a string
           types: [{id:'grunt', power:1}, {id:'archer', power:1.4}, {id:'brute', power:2.5}],   // power = difficulty one unit adds
           read: (stage) => ({grunt: 4}),         // the mix the stage has now
           valid: (stage, mix) => true,           // optional: refuse mixes the game cannot play (e.g. unsolvable puzzle: ask the solver)
           protect: ['boss'] }                    // never swapped
```
The adapter turns the mix into the real stage when `params['comp.<stage>']` is present: a spawn list, or for a hand-drawn grid a rule for which cells change (it owns positions, the calibrator only knows counts). `power` is an estimate (hp x damage for enemies; for tiles, blockers and rare types count more): improve it by measuring with `options.mjs` or a few runs. `calibrate.mjs --compose` (studio: "Also swap <noun> types") replaces 1-3 units of a type with another when a stage is more than 15 pts off target, keeping the unit count, then the numeric lever fine-tunes. For puzzles always give `valid` (an unsolvable level is worse than a hard one). Use it when stat scaling feels wrong (enemies turning into sponges, a puzzle that only gets harder by fewer moves) or when the designer wants a stage to introduce a type. The result lists the new mixes ("grunt:4 -> grunt:2,archer:2"): show them to the user and ask before applying, like every other change.

**Option balance.** Stage difficulty does not tell whether the player's choices are balanced. Run `node scripts/options.mjs --adapter A [--stages 1-10] [--runs 60] [--persona smart]`: it counts how often each action/upgrade is chosen (the runner counts `action.option ?? action.type`) and re-runs the same seeds with ONE option removed (`--set ban.<option>=1`). Read: big negative effect = MANDATORY (game depends on it), rarely used and no effect = DEAD, one option taking >=60% of choices and costing the most when removed = DOMINANT, win rate rises without it = HARMFUL. Fix by buffing the weak option, not nerfing the strong one (global rule). Options outside `legalActions()` (a shop, upgrades) must read `params['ban.<id>']` themselves, and set `action.option` when one action type covers several options. Bots pick by their own policy: DOMINANT may only mean "dominant for this bot", say so and confirm with real play. The player's own growth curve (power per stage vs enemy power) is NOT checked yet: read `snap.power` in campaign logs by hand.

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
| `BOT_LOST` | smart and random both win < 10% | the bots cannot judge this stage; check with the oracle (solver) persona or a real playtest |
| `oracle` persona | adapter has `oracle(game)` (exact solver) | puzzles: proves solvability and slack; runs once per stage |
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

## Lessons from tuning PR-15 (read before a real game)

- **Determinism first.** A game that calls `Math.random()` directly makes every comparison noise. Override it inside the vm (`Math.random = () => host.rnd()`). `runner.mjs` now warns `NONDETERMINISTIC` when the same seed gives two runs.
- **Use `--retries 10` while tuning a campaign.** With 2 retries players quit at the first wall, later stages get almost no samples and are biased towards lucky or strong players. Tune with generous retries, then check the real funnel with `--retries 2` and tell the user how many players quit where.
- **Smooth curves cannot fix a sawtooth.** If boss or odd stages stay off while the global curve fits, add a per-stage multiplier table to the game's data (PR-15: `TUNE.stage.adj`, applied to enemy HP and damage) and correct it by damped fixed-point iteration: `adj *= exp(0.7 * (win - target))` for stages more than 10 points off, 6-9 rounds, a new `--seed` each round. Damage alone saturated (the hero kills first), so scale HP too.
- **Shell quoting.** In zsh an unquoted `$SETS` is not split into words, so `--set` flags silently vanish and you measure the defaults. Use arrays, `${=SETS}`, or call `tune.mjs` (it passes arguments as an array).
- **Evaluate on a new seed** before declaring a candidate good; the tuner's own seed is overfitted. PR-15 went from 22 to 9 points mean error against the target on a fresh seed.

## Speed: parallel runs (tool and agents)

- **The runner is parallel by default**: `--jobs N` (default = CPU cores - 1, at most 8; `--jobs 1` turns it off). Runs are split between worker processes; seeds depend only on (stage, run), so the logs are identical to a single process (tested). It speeds up detect, calibrate rounds, `options.mjs` and sweeps alike (about 3x with 4 workers on the toy game). `--replay` always runs in one process.
- **Agents may work in parallel too**, but only on independent things: different games, or different questions about one game (a detection and an `options.mjs` ablation), each with its own `--out` folder. Calibration rounds depend on the previous round and stay sequential. Never let two processes write the same run folder or the same `targets.json`.
- **Do not oversubscribe the machine.** All parallel work shares the same cores: with K tasks at once, pass `--jobs` about cores/K to each, otherwise everything slows down and timing-based guard rails misfire. The studio runs one job at a time on purpose.
- If a worker fails, the runner prints its error and stops; a game with global state is fine (every worker is its own process), a game that writes files during play is not (give each run its own folder or turn `--jobs 1`).

## Warnings for agents using this skill

- **Bots are not players.** Every number describes the bots. Never say "the game is balanced"; say "the reference bot wins X% first try". Real playtests or telemetry (`--humans`) override the bots. Right after a calibration, say what it did NOT check.
- **Ask before changing anything that is not a report**: writing `targets.json`, applying a calibration candidate to game data, editing game files, swapping content types. Dry-run first (`target.mjs` prints, `--write` saves). The studio never edits game files; keep it that way.
- **Check the game folder before every run.** `git status`, and make sure the files the adapter reads still exist. Someone else may change the tree mid-session (it happened: a prototype was replaced by another project). If the tree is in flux, run on a `git archive` export in a temp folder and never touch their files.
- **Determinism first.** If the runner prints `NONDETERMINISTIC`, stop: route every random call through the seeded rng (a `Math.random` override in a vm adapter works). Nothing else is trustworthy until it is quiet.
- **Noise is real.** Rounds of a calibration swing several points (a toy run moved 18-27 pts between rounds). Judge a change on a fresh seed with more runs, not on the round that looked best; thin late-stage data (`LOW_N`) needs `--retries 10` in campaign mode, and a flag with a `?` is not a verdict.
- **One kind of change at a time.** Numeric levers first; add `--compose` only when stat scaling is not enough, and re-measure after. For puzzles give `compose.valid` (solver check): an unsolvable level is worse than a hard one. `power` per type is an estimate, verify it.
- **Option balance is about the bot.** DOMINANT / DEAD describe what this persona picks. Buff the weak option, do not nerf the strong one; confirm with real play. Options outside `legalActions()` must honor `ban.<id>` or the ablation is meaningless (`BAN_IGNORED`).
- **Genre numbers are not standards.** Quote `references/genres.json` with its `basis`; if it says judgment, say it is your judgment. If you research something new, write it back with sources.
- **Shell traps (zsh)**: an unquoted `$VAR` is not word-split (use arrays or `${=VAR}`), so `--set` arguments can be silently dropped and a "verification" runs the defaults. Print the effective parameters of a verification run.
- **Keep the repo clean.** No game data, personal names, paths of private projects or run logs in commits or screenshots (use a neutral demo folder). Follow the user's own rules for commit messages and attribution (check their CLAUDE.md); do not add trailers they forbid.

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
