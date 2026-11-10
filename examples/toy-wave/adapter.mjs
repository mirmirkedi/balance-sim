// Toy wave shooter: a worked adapter example AND the smoke test for the skill.
// Player shoots one enemy per turn (or drinks a potion), then every living enemy attacks.
// Stage 5 and 10 end with a boss. Player power grows with the stage number.
const NOOP = () => {};
// tiny stateless hash RNG: value depends only on (seed, rolls) so clone() stays exact
function rollAt(seed, n) {
  let t = (seed * 7 + n * 2654435761) >>> 0;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}

class Toy {
  constructor(stage, emit, s) { this.stage = stage; this.emit = emit; this.s = s; }
  // P = tunables handed in by `--set key=value` (multipliers, default 1): enemyHp, enemyAtk, playerDmg
  static init(stage, seed, P = {}) {
    const hpMax = 100 + 10 * (stage - 1);
    const s = {
      seed, rolls: 0, hp: hpMax, hpMax, dmg: Math.round(12 * (1 + 0.12 * (stage - 1)) * (P.playerDmg ?? 1)), potions: 2,
      eHp: P.enemyHp ?? 1, eAtk: P.enemyAtk ?? 1,
      wave: 0, waves: 2 + Math.floor(stage / 4), enemies: [], t: 0, coins: 0, done: false, win: false,
    };
    const g = new Toy(stage, NOOP, s);
    g.spawn();
    return g;
  }
  roll() { return rollAt(this.s.seed, this.s.rolls++); }
  spawn() {
    const { stage } = this, s = this.s;
    const hp = Math.round(20 * (1 + 0.12 * (stage - 1)) * s.eHp), atk = 2.2 * (1 + 0.1 * (stage - 1)) * s.eAtk;
    const count = 2 + Math.floor(stage / 3);
    s.enemies = Array.from({ length: count }, () => ({ kind: 'grunt', hp, max: hp, atk, hits: 0 }));
    if (stage % 5 === 0 && s.wave === s.waves - 1) s.enemies.push({ kind: 'boss', hp: hp * 3, max: hp * 3, atk: atk * 2, hits: 0 });
  }
  time() { return this.s.t; }
  isDone() { return this.s.done; }
  observe() { return this.s; }
  legalActions() {
    const s = this.s, a = s.enemies.map((e, i) => ({ type: 'shoot', i }));
    if (s.potions > 0 && s.hp < s.hpMax) a.push({ type: 'heal' });
    return a;
  }
  step(a) {
    const s = this.s;
    if (a.type === 'heal') {
      const hb = s.hp;
      s.hp = Math.min(s.hpMax, s.hp + 40); s.potions--;
      this.emit('spend', { actor: 'player', before: { hp: hb }, after: { hp: s.hp }, data: { res: 'potion', amount: 1 } });
    } else {
      const e = s.enemies[a.i];
      if (!e) { s.t += 1.5; return; }
      const crit = this.roll() < 0.1, dmg = s.dmg * (crit ? 2 : 1);
      const eb = e.hp; e.hp -= dmg; e.hits++;
      this.emit('shoot', { actor: 'player', target: e.kind, before: { playerHp: s.hp, enemyHp: eb }, after: { playerHp: s.hp, enemyHp: Math.max(0, e.hp) }, data: { kind: e.kind, amount: dmg } });
      if (e.hp <= 0) {
        s.enemies.splice(a.i, 1);
        this.emit('kill', { actor: 'player', target: e.kind, before: { playerHp: s.hp }, after: { playerHp: s.hp }, data: { victim: e.kind, amount: e.hits } });
        const r = this.roll();
        if (r < 0.3) { const c = 5 + this.stage; s.coins += c; this.emit('drop', { data: { item: 'coin', amount: c } }); this.emit('gain', { data: { res: 'coin', amount: c } }); }
        else if (r < 0.38) { s.potions++; this.emit('drop', { data: { item: 'potion', amount: 1 } }); this.emit('gain', { data: { res: 'potion', amount: 1 } }); }
      }
    }
    // enemy turn
    if (s.enemies.length) {
      let dmg = 0;
      for (const e of s.enemies) if (this.roll() < 0.8) dmg += e.atk;
      dmg = Math.round(dmg); const hb = s.hp; s.hp -= dmg;
      this.emit('damage', { actor: 'enemies', target: 'player', before: { hp: hb }, after: { hp: Math.max(0, s.hp) }, data: { source: 'enemy', amount: dmg } });
    }
    s.t += 1.5;
    if (s.hp <= 0) { s.done = true; s.win = false; }
    else if (!s.enemies.length) { s.wave++; if (s.wave >= s.waves) { s.done = true; s.win = true; } else this.spawn(); }
  }
  // clone() for lookahead must NOT share the RNG stream, or the optimizer "sees" future crits and drops.
  clone() { const s = JSON.parse(JSON.stringify(this.s)); s.seed = (s.seed ^ 0x5bd1e995) >>> 0; return new Toy(this.stage, NOOP, s); }
  result() {
    const s = this.s;
    return { win: s.win, hpLeft: Math.max(0, s.hp), hpMax: s.hpMax, time: s.t, deaths: s.win ? 0 : 1, income: s.coins, resources: { coins: s.coins, potions: s.potions } };
  }
}

export default {
  stages: Array.from({ length: 10 }, (_, i) => i + 1),
  create({ stage, seed, emit, params }) { const g = Toy.init(stage, seed, params); g.emit = emit; return g; },
  // sensible human play: drink at low hp, otherwise kill the most dangerous enemy that dies fastest
  policy(game, acts) {
    const s = game.observe();
    if (s.potions > 0 && s.hp < s.hpMax * 0.35 && acts.some((a) => a.type === 'heal')) return acts.find((a) => a.type === 'heal');
    const shoots = acts.filter((a) => a.type === 'shoot');
    shoots.sort((x, y) => s.enemies[y.i].atk / s.enemies[y.i].hp - s.enemies[x.i].atk / s.enemies[x.i].hp);
    return shoots[0] || acts[0];
  },
  // used by the optimizer persona (lookahead on clones)
  evaluate(game) {
    const s = game.observe();
    if (s.done) return s.win ? 100 + s.hp : -100;
    const enemyHp = s.enemies.reduce((a, e) => a + e.hp, 0), threat = s.enemies.reduce((a, e) => a + e.atk, 0);
    return 2 * (s.hp / s.hpMax) - enemyHp / 100 - threat / 20 - (s.waves - s.wave) * 0.1;
  },
};
