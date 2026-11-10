// Runs INSIDE the vm context that holds the real PR-15 game code (game.html script).
// It replaces everything that needs a screen (modals, toasts, rendering) with headless decision points
// and exposes a small __api that the balance-sim adapter drives. Game rules themselves are NOT touched:
// combat, drops, equipment, weapons and rewards all run the original functions.
(function () {
  const H = __host;
  Math.random = () => H.rnd();

  // ---- UI stubs ----
  toast = bump = showOver = hideOver = updTop = renderSlots = renderNav = log = save = function () {};
  mockAd = mockBuy = function () {};
  openModal = function () { throw new Error('openModal reached headless (an unhandled UI path): ' + String(new Error().stack).split('\n')[2]); };

  // rewards panel: no screen, but gear still has to be decided (that is a real player decision)
  reveal = function (title, list, o, cb) { processEq(/Complete!/.test(title) ? null : cb); };
  processEq = function (cb) {
    if (cb) H.cbs.push(cb);
    if (S.pendingEq.length) { H.pending = { kind: 'gear', item: S.pendingEq[0] }; return; }
    const c = [...new Set(H.cbs)]; H.cbs.length = 0; c.forEach((f) => f());
  };

  // encounter screens become pending decisions
  choiceUI = (e) => { H.pending = { kind: 'choice', e }; };
  eventUI = (e) => { H.pending = { kind: 'event', e }; };
  multiUI = (e) => { H.pending = { kind: 'multi', e }; };
  paidUI = (e) => { H.pending = { kind: 'paid', e }; };
  buffUI = () => advance(); // raid only, not simulated

  // stage outcome flags
  const _sd = stageDone; stageDone = function () { H.cleared = true; _sd(); };
  onDefeat = function () { H.defeated = true; };

  // ---- balance events ----
  const E = (type, o) => H.emit(type, o);
  const _hit = hit;
  hit = function (t, dmg, act) {
    const eb = t.hp, pb = B.hp;
    _hit(t, dmg, act);
    const w = act && act.src && act.src.slot != null;
    E('hit', { actor: w ? 'weapon' + act.src.slot : 'hero', target: t.t, before: { playerHp: Math.round(pb), enemyHp: Math.round(eb) }, after: { playerHp: Math.round(B.hp), enemyHp: Math.round(Math.max(0, t.hp)) }, data: { kind: w ? 'weapon' : 'hero', amount: Math.round(eb - t.hp) } });
  };
  const _dc = dieCheck;
  dieCheck = function (t) { const was = t.alive; _dc(t); if (was && !t.alive) E('kill', { target: t.t, data: { victim: t.t, amount: 1 } }); };
  const _eh = enemyHit;
  enemyHit = function (e) {
    const b = B.hp; _eh(e);
    if (B.hp < b) E('damage', { actor: e.t, target: 'hero', before: { hp: Math.round(b) }, after: { hp: Math.round(B.hp) }, data: { source: e.t, amount: Math.round(b - B.hp) } });
  };
  const _commit = commit;
  commit = function (list) {
    list.forEach((it) => {
      if (it.k === 'gold' || it.k === 'blue' || it.k === 'sack') E('gain', { data: { res: it.k, amount: it.n } });
      else if (it.k === 'eq') E('drop', { data: { item: 'gear:' + RAR[it.item.r], amount: 1 } });
      else if (it.k === 'bp') E('drop', { data: { item: 'blueprint:' + it.ch, amount: it.n } });
    });
    return _commit(list);
  };

  globalThis.__api = {
    fresh() { S = freshState(); S.mute = true; S.tips = { start: 1, sack: 1, equip: 1, merge: 1, locked: 1, raid: 1 }; S.test = false; return S; },
    use(s) { S = s; },
    getPath(p) { const a = p.split('.'); let o = a[0] === 'TUNE' ? TUNE : CFG; for (let i = 1; i < a.length; i++) { if (o == null) return undefined; o = o[a[i]]; } return o; },
    setPath(p, v) { const a = p.split('.'); let o = a[0] === 'TUNE' ? TUNE : CFG; for (let i = 1; i < a.length - 1; i++) o = o[a[i]]; o[a[a.length - 1]] = v; },

    // one stage attempt, exactly like startMain() but without the screen
    setup(stage) {
      S.stage = stage; H.cleared = false; H.defeated = false; H.pending = null; H.cbs.length = 0;
      B.timers = []; B.fx = []; B.txt = []; B.proj = []; B.t = 0; H.g0 = S.gold;
      startMain();
    },
    tick(n) { for (let i = 0; i < n && !H.pending && !H.cleared && !H.defeated; i++) step(0.05); },
    state() { return { t: B.t, hp: B.hp, max: B.max, gold: S.gold, blue: S.blue, sack: S.sack, g0: H.g0, cleared: H.cleared, defeated: H.defeated, pending: !!H.pending }; },
    snap() { return { bank: S.gold, blue: S.blue, sack: S.sack, power: totalPower(S.active), lvl: S.chars[S.active].lvl, bag: S.bag, stage: S.stage }; },

    // pending decision (gear / choice / event / multiverse / paid offer)
    pend() {
      const p = H.pending; if (!p) return null;
      const o = { kind: p.kind, hpRatio: B.hp / B.max, sack: S.sack };
      if (p.kind === 'gear') {
        const id = S.active, cur = S.chars[id].eq[p.item.c], alt = S.chars[id].eq.slice(); alt[p.item.c] = p.item;
        o.hasCur = !!cur; o.powerDiff = powerOf(calcFinal(id, null, alt)) - totalPower(id); o.sell = sellVal(p.item);
      }
      if (p.kind === 'event') o.boss = p.e.type === 'boss';
      if (p.kind === 'paid') o.offer = p.e.offer;
      return o;
    },
    pendGear() { if (!S.pendingEq.length) return null; H.pending = { kind: 'gear', item: S.pendingEq[0] }; return this.pend(); },
    resolve(a) {
      const p = H.pending; H.pending = null;
      if (p.kind === 'gear') {
        const it = S.pendingEq[0];
        if (a.type === 'equip') { S.chars[S.active].eq[it.c] = it; refreshStats(); } else S.gold += sellVal(it);
        S.pendingEq.shift(); processEq(); return;
      }
      if (p.kind === 'choice') {
        const s = S.stage, g = (n) => Math.round((TUNE.gold.event0 + TUNE.gold.eventS * s) * n * goldMul());
        let l;
        if (a.c === 'rob') l = Math.random() < .6 ? [{ k: 'gold', n: g(2.4) }] : [{ k: 'eq', item: genEquip(eqRar(s, 0)) }];
        else if (a.c === 'none') l = Math.random() < .5 ? [{ k: 'gold', n: g(.5) }] : [];
        else { const r = Math.random(); l = r < .5 ? [{ k: 'sack', n: 2 }] : r < .8 ? [{ k: 'eq', item: genEquip(eqRar(s, 1)) }] : [{ k: 'gold', n: g(1.3) }]; }
        commit(l); if (!l.length) return advance(); return reveal('Event', l, {}, advance);
      }
      if (p.kind === 'event') return a.type === 'run' ? advance() : fightEnc(p.e);
      if (p.kind === 'multi') { if (a.type === 'run') return advance(); G.mv = { e: p.e, i: 0 }; return spawn(p.e.waves[0], multOf(), 1.1, 1); }
      if (p.kind === 'paid') { if (a.type === 'sell') S.gold += sellVal(genEquip(p.e.eqR)); return advance(); }
    },

    // meta actions between stages (what a player does on the backpack / character / store screens)
    meta(includeBad) {
      const out = [], un = slotsUnlocked(), id = S.active, all = [];
      S.pack.forEach((w, i) => w && all.push({ k: 'pk', i, w }));
      S.equipped.slice(0, un).forEach((w, i) => w && all.push({ k: 'eq', i, w }));
      for (let a = 0; a < all.length; a++) for (let b = a + 1; b < all.length; b++) {
        if (all[a].w.r === all[b].w.r && all[a].w.r < 8) {
          const dst = all[a].k === 'eq' ? all[a] : all[b], src = dst === all[a] ? all[b] : all[a];
          out.push({ k: 'merge', src: { k: src.k, i: src.i }, dst: { k: dst.k, i: dst.i } });
        }
      }
      const free = []; for (let i = 0; i < un; i++) if (!S.equipped[i]) free.push(i);
      S.pack.forEach((w, j) => { if (w && free.length) out.push({ k: 'toSlot', src: { k: 'pk', i: j }, dst: { k: 'eq', i: free[0] } }); });
      for (let i = 0; i < un; i++) {
        const e = S.equipped[i]; if (!e) continue;
        S.pack.forEach((w, j) => {
          if (!w) return;
          const d = wDef(w).dps - wDef(e).dps;
          if (d > wDef(e).dps * 0.05) out.push({ k: 'swap', src: { k: 'pk', i: j }, dst: { k: 'eq', i }, gain: d });
          else if (includeBad && d < 0) out.push({ k: 'swap', src: { k: 'pk', i: j }, dst: { k: 'eq', i }, gain: d, bad: true });
        });
      }
      if (S.sack > 0 && S.pack.includes(null)) out.push({ k: 'draw' });
      const c = S.chars[id]; if (isOwned(id) && S.gold >= lvlCost(c.lvl)) out.push({ k: 'level', cost: lvlCost(c.lvl) });
      if (S.bag < 9 && S.blue >= bagCost(S.bag)) out.push({ k: 'bag', cost: bagCost(S.bag) });
      [1, 2, 3].forEach((t) => { if (S.blue >= CFG.chestCost[t - 1]) out.push({ k: 'chest', t, cost: CFG.chestCost[t - 1] }); });
      CHD.forEach((ch) => { if (ch.id !== id && isOwned(ch.id) && totalPower(ch.id) > totalPower(id) * 1.05) out.push({ k: 'switch', id: ch.id }); });
      return out;
    },
    exec(a) {
      if (a.k === 'merge' || a.k === 'toSlot' || a.k === 'swap') { dropW(a.src, a.dst); return null; }
      if (a.k === 'draw') { const i = S.pack.indexOf(null); S.pack[i] = rollWeapon(); S.sack--; return null; }
      if (a.k === 'level') { S.gold -= a.cost; S.chars[S.active].lvl++; refreshStats(); return { res: 'gold', amount: a.cost, kind: 'level' }; }
      if (a.k === 'bag') { S.blue -= a.cost; S.bag++; return { res: 'blue', amount: a.cost, kind: 'bag' }; }
      if (a.k === 'chest') { S.blue -= a.cost; commit(chestLoot(a.t)); return { res: 'blue', amount: a.cost, kind: 'chest' + a.t }; }
      if (a.k === 'switch') { S.active = a.id; refreshStats(); return null; }
      return null;
    },
  };
})();
