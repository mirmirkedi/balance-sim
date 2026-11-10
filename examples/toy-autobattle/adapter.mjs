// Idle / auto-battler example: NO decisions during a fight (legalActions() is empty, the runner calls advance()).
// All player skill lives in the SHOP between fights, so this adapter is meant for --campaign mode:
//   node scripts/runner.mjs --adapter examples/toy-autobattle/adapter.mjs --campaign --runs 100
// It shows: profile (persistent state), afterStage (rewards = faucet), shop (spending = sink, skill matters),
// snapshot (bank / power columns), stalls (WALL flag) and retries.
import { chooseItem } from '../../scripts/personas.mjs';

function rollAt(seed, n) {
  let t = (seed * 7 + n * 2654435761) >>> 0;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}
const COST = { atk: 20, hp: 20, inc: 30 }, GROWTH = 1.15;
const cost = (p, k) => Math.round(COST[k] * GROWTH ** p.lv[k]);
const dpsOf = (p) => 10 * (1 + 0.25 * p.lv.atk), hpOf = (p) => 100 * (1 + 0.25 * p.lv.hp);

class Fight {
  constructor(s, emit) { this.s = s; this.emit = emit; }
  time() { return this.s.t; }
  isDone() { return this.s.done; }
  legalActions() { return []; }             // nothing to decide in a fight
  advance() {                               // one second of combat
    const s = this.s, r1 = rollAt(s.seed, s.rolls++), r2 = rollAt(s.seed, s.rolls++);
    const dealt = s.pdps * (0.8 + 0.4 * r1), taken = s.edps * (0.8 + 0.4 * r2);
    s.ehp -= dealt; s.php -= taken; s.t += 1;
    this.emit('damage', { actor: 'squad', target: 'enemy', before: { playerHp: Math.round(s.php + taken), enemyHp: Math.round(s.ehp + dealt) }, after: { playerHp: Math.max(0, Math.round(s.php)), enemyHp: Math.max(0, Math.round(s.ehp)) }, data: { source: 'squad', amount: Math.round(dealt) } });
    if (s.ehp <= 0) { s.done = true; s.win = true; this.emit('kill', { target: 'enemy', data: { victim: s.boss ? 'boss' : 'enemy', amount: s.t } }); }
    else if (s.php <= 0 || s.t >= 120) { s.done = true; s.win = false; }
  }
  result() {
    const s = this.s;
    return { win: s.win, hpLeft: Math.max(0, s.php), hpMax: s.pmax, time: s.t, deaths: s.win ? 0 : 1, income: s.win ? s.reward : s.reward * 0.3 };
  }
}

export default {
  stages: Array.from({ length: 20 }, (_, i) => i + 1),

  // params (--set): enemyHp, enemyDps, reward, startCoins  (multipliers, default 1)
  newProfile({ params }) { return { coins: Math.round(30 * (params.startCoins ?? 1)), lv: { atk: 0, hp: 0, inc: 0 } }; },

  create({ stage, seed, emit, params, profile }) {
    const boss = stage % 5 === 0, mult = boss ? 2.5 : 1;
    const s = {
      seed, rolls: 0, t: 0, done: false, win: false, boss,
      pdps: dpsOf(profile), pmax: hpOf(profile), php: hpOf(profile),
      emax: 60 * 1.22 ** (stage - 1) * mult * (params.enemyHp ?? 1), edps: 4 * 1.15 ** (stage - 1) * (params.enemyDps ?? 1),
      reward: (10 + 4 * stage) * (1 + 0.1 * profile.lv.inc) * (params.reward ?? 1),
    };
    s.ehp = s.emax;
    return new Fight(s, emit);
  },

  // faucet: reward after every attempt (a loss still pays 30%, so players can farm)
  afterStage({ profile, result, stage, emit }) {
    profile.coins += result.income;
    emit('gain', { data: { res: 'coin', amount: Math.round(result.income), kind: 'stage-' + stage } });
  },

  // sink: spend everything; the persona decides how well. Skill = knowing what to buy.
  shop({ profile, persona, rng, opts, emit }) {
    for (let guard = 0; guard < 50; guard++) {
      const items = ['atk', 'hp', 'inc'].filter((k) => cost(profile, k) <= profile.coins);
      const score = (k) => (k === 'inc' ? 0.5 : 1) * (0.25 / (1 + 0.25 * profile.lv[k])) / cost(profile, k);
      const pick = chooseItem(items, score, persona, rng, opts);
      if (!pick) break;
      const c = cost(profile, pick);
      profile.coins -= c; profile.lv[pick]++;
      emit('spend', { data: { res: 'coin', amount: c, kind: pick } });
    }
  },

  snapshot(profile) { return { bank: profile.coins, power: Math.round(dpsOf(profile) * hpOf(profile) / 100) }; },
};
