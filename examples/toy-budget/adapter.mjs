// Shot-budget puzzle example (cannon / destruction style, like a "ball budget" level).
// The player picks a block and a power; power 3 costs 2 shots but splashes onto the neighbours.
// Continuous choices (aim, power) are DISCRETIZED into a small action list: 3 powers x alive blocks.
// Shows: no policy() needed. `smart` falls back to 1-ply lookahead on clone() + evaluate(); `optimizer` goes 2 deep.
const NOOP = () => {};
function rollAt(seed, n) {
  let t = (seed * 7 + n * 2654435761) >>> 0;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}

class Budget {
  constructor(stage, emit, s) { this.stage = stage; this.emit = emit; this.s = s; }
  static init(stage, seed, P = {}) {
    const n = 6 + stage, base = 18 * (1 + 0.1 * (stage - 1)) * (P.blockHp ?? 1);
    const hp = Array.from({ length: n }, (_, i) => Math.round(base * (stage % 5 === 0 && i === Math.floor(n / 2) ? 3 : 1)));
    const total = hp.reduce((a, b) => a + b, 0);
    // best possible is ~26 damage per shot (power 3 in the middle of a pack); a careful player gets ~18
    const shots = Math.max(3, Math.ceil(total / 17 * (P.budget ?? 1)));
    return new Budget(stage, NOOP, { seed, rolls: 0, hp, shots, shots0: shots, used: 0, done: false, win: false });
  }
  roll() { return rollAt(this.s.seed, this.s.rolls++); }
  time() { return this.s.used * 2; }
  isDone() { return this.s.done; }
  observe() { return this.s; }
  legalActions() {
    const a = [];
    this.s.hp.forEach((h, i) => { if (h > 0) for (const p of [1, 2, 3]) if (p === 1 || this.s.shots >= (p === 3 ? 2 : 1)) a.push({ i, p }); });
    return a;
  }
  step({ i, p }) {
    const s = this.s, cost = p === 3 ? 2 : 1;
    s.shots -= cost; s.used += cost;
    const dmg = p * 8 * (0.8 + 0.4 * this.roll());
    const hit = (k, d) => {
      if (s.hp[k] > 0) {
        const before = s.hp[k]; s.hp[k] = Math.max(0, s.hp[k] - d);
        this.emit('hit', { actor: 'cannon', target: 'block' + k, before: { hp: Math.round(before) }, after: { hp: Math.round(s.hp[k]) }, data: { kind: 'power' + p, amount: Math.round(d) } });
        if (s.hp[k] === 0) this.emit('kill', { target: 'block' + k, data: { victim: 'block', amount: 1 } });
      }
    };
    hit(i, dmg);
    if (p >= 2) { hit(i - 1, dmg * (p === 3 ? 0.6 : 0.3)); hit(i + 1, dmg * (p === 3 ? 0.6 : 0.3)); }
    if (s.hp.every((h) => h <= 0)) { s.done = true; s.win = true; }
    else if (s.shots <= 0) { s.done = true; s.win = false; }
  }
  // clone() for lookahead must NOT share the RNG stream (it would leak the future roll)
  clone() { const s = JSON.parse(JSON.stringify(this.s)); s.seed = (s.seed ^ 0x2545f491) >>> 0; return new Budget(this.stage, NOOP, s); }
  result() {
    const s = this.s, left = s.shots / s.shots0;
    return { win: s.win, hpLeft: Math.max(0, s.shots), hpMax: s.shots0, time: s.used * 2, deaths: s.win ? 0 : 1, income: s.win ? (left > 0.3 ? 3 : left > 0.1 ? 2 : 1) : 0 };
  }
}

export default {
  stages: Array.from({ length: 12 }, (_, i) => i + 1),
  create({ stage, seed, emit, params }) { const g = Budget.init(stage, seed, params); g.emit = emit; return g; },
  // value of a state: shots in hand minus the shots the remaining hp will still need
  evaluate(game) {
    const s = game.observe();
    if (s.done) return s.win ? 100 + s.shots : -100 - s.hp.reduce((a, b) => a + b, 0) / 30;
    return s.shots - s.hp.reduce((a, b) => a + b, 0) / 20;
  },
};
