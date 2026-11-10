// Shared model of the studio: difficulty scores of a detection report and the target-curve model.
// Pure functions, no I/O. Used by the web app (served as /model.mjs) AND by the command line tools detect.mjs and
// target.mjs, so a conversation with the agent and the web studio always compute the same numbers.
//
// Difficulty = 100 x (1 - first-try win rate of the reference bot). 0 = nobody fails, 100 = nobody passes.

export const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
export const mean = (a) => a.length ? a.reduce((s, x) => s + x, 0) / a.length : null;
export const band = (d) => d < 20 ? 'Very easy' : d < 35 ? 'Easy' : d < 50 ? 'Moderate' : d < 65 ? 'Challenging' : d < 80 ? 'Hard' : 'Brutal';

// ---------- scores of a detection report (analyze.mjs report.json) ----------
export function scores(rep) {
  const tp = rep.targetPersona, ids = Object.keys(rep.stages), out = [];
  ids.forEach((id, i) => {
    const st = rep.stages[id], me = st[tp], rnd = st.random;
    if (!me) { out.push({ id, idx: i, empty: true, flags: st.flags || [] }); return; }
    const win = me.win, tries = me.tries ?? me.attempts ?? 1, stall = me.stall || 0;
    out.push({
      id, idx: i, win, lo: me.lo, hi: me.hi, n: me.n, tries, stall, flags: (st.flags || []).filter((f) => f !== 'LOW_N'), lowN: (st.flags || []).includes('LOW_N'),
      difficulty: 100 * (1 - win),
      frustration: clamp(100 * (0.6 * stall + 0.4 * Math.min(1, (tries - 1) / 4)), 0, 100),
      boredom: clamp(100 * (0.7 * clamp((win - 0.85) / 0.15, 0, 1) + 0.3 * (rnd ? rnd.win : 0)), 0, 100),
      skill: rnd ? 100 * (win - rnd.win) : null,
      conf: 100 * (me.hi - me.lo) / 2,
      targetWin: st.target && st.target.win != null ? st.target.win : null,
    });
  });
  const dv = out.map((s) => s.difficulty);   // spike: much harder than the median of the 3 stages before
  out.forEach((s, i) => { if (i < 3 || s.empty) { s.spike = 0; return; } const prev = dv.slice(i - 3, i).filter((x) => x != null).sort((a, b) => a - b); s.spike = prev.length ? s.difficulty - prev[Math.floor(prev.length / 2)] : 0; });
  return out;
}
export function summary(rep, sc) {
  const ok = sc.filter((s) => !s.empty), d = ok.map((s) => s.difficulty), third = Math.max(1, Math.floor(ok.length / 3));
  return {
    avg: mean(d), trend: ok.length > 5 ? mean(ok.slice(-third).map((s) => s.difficulty)) - mean(ok.slice(0, third).map((s) => s.difficulty)) : null,
    spikes: ok.filter((s) => s.spike > 20).length, frustrated: ok.filter((s) => s.frustration >= 45).length, bored: ok.filter((s) => s.boredom >= 60).length,
    skill: mean(ok.filter((s) => s.skill != null).map((s) => s.skill)), conf: mean(ok.map((s) => s.conf)), tp: rep.targetPersona,
    camp: ok.some((s) => s.stall > 0 || s.tries > 1.05),
    hardest: [...ok].sort((a, b) => b.difficulty - a.difficulty).slice(0, 3), easiest: [...ok].sort((a, b) => a.difficulty - b.difficulty).slice(0, 3),
  };
}

// ---------- target model ----------
export const TPL = [['linear', 'Linear ramp'], ['slow', 'Slow start'], ['fast', 'Fast start'], ['scurve', 'S-curve'], ['waves', 'Waves per area'], ['stairs', 'Staircase'], ['flat', 'Flat'], ['smooth', 'Smooth current'], ['measured', 'Keep current']];
export const TAGS = { 'much-easier': -25, easier: -12, harder: 12, 'much-harder': 25, breather: -20, boss: null };
export const SPREAD = [['equal', 'Equally', 'Every stage moves by the same amount.'], ['later', 'Later stages more', 'Early stages barely change, the end of the game takes most of it.'], ['earlier', 'Earlier stages more', 'The start gets the change, the end stays close to now.'], ['middle', 'Middle more', 'The first and last stages stay, the middle takes most of it.']];
export const spreadWeights = (kind, n) => {
  const w = Array.from({ length: n }, (_, i) => { const t = n > 1 ? i / (n - 1) : 0; return kind === 'later' ? 0.15 + 1.7 * t : kind === 'earlier' ? 1.85 - 1.7 * t : kind === 'middle' ? 0.15 + 1.7 * Math.sin(Math.PI * t) : 1; });
  const m = mean(w); return w.map((x) => x / m);
};
export const defaultT = () => ({ genre: null, spread: 'equal', snapshot: null, template: 'linear', start: 8, end: 55, average: null, wave: 18, area: 10, bossBump: 15, tolerance: 15, persona: 'smart', tags: {}, pins: {}, bosses: [] });

// measured: array of difficulty (or null) per stage id, same order as ids. Gaps are filled with the previous value.
export const fillGaps = (m) => { let last = m.find((x) => x != null) ?? 50; return m.map((x) => { if (x != null) last = x; return last; }); };

export function baseCurve(T, ids, measured) {
  const n = ids.length, out = [], m = (T.snapshot && T.snapshot.length === n) ? T.snapshot : (measured || []), haveM = m.some((x) => x != null), mf = haveM ? fillGaps(m) : [];
  for (let i = 0; i < n; i++) {
    const t = n > 1 ? i / (n - 1) : 0, S = +T.start, E = +T.end, area = Math.max(2, +T.area || 10);
    let v;
    switch (T.template) {
      case 'slow': v = S + (E - S) * t * t; break;
      case 'fast': v = S + (E - S) * (1 - (1 - t) * (1 - t)); break;
      case 'scurve': v = S + (E - S) * t * t * (3 - 2 * t); break;
      case 'waves': v = S + (E - S) * t + (+T.wave) * ((i % area) / (area - 1) - 0.5); break;
      case 'stairs': { const steps = Math.ceil(n / area); v = S + (E - S) * (steps > 1 ? Math.floor(i / area) / (steps - 1) : 0); break; }
      case 'flat': v = (S + E) / 2; break;
      case 'measured': v = haveM ? mf[i] : S + (E - S) * t; break;
      case 'smooth': { if (!haveM) { v = S + (E - S) * t; break; } let a = 0, c = 0; for (let k = -3; k <= 3; k++) { const j = i + k; if (j >= 0 && j < n) { a += mf[j]; c++; } } v = a / c; break; }
      default: v = S + (E - S) * t;
    }
    out.push(v);
  }
  return out;
}

export function targetCurve(T, ids, measured) {
  const base = baseCurve(T, ids, measured), noAuto = ['measured', 'smooth'].includes(T.template);   // measured difficulty already contains the bosses
  const tagBoss = new Set(Object.entries(T.tags).filter(([, v]) => v === 'boss').map(([k]) => k));
  const autoBoss = new Set(noAuto ? [] : (T.bosses || []));
  const W = spreadWeights(T.spread || 'equal', ids.length);
  const withMods = (shift) => base.map((v, i) => {
    const id = ids[i], tag = T.tags[id];
    let x = v + shift * W[i];
    if (autoBoss.has(id) || tagBoss.has(id)) x += +T.bossBump;
    if (tag && TAGS[tag] != null) x += TAGS[tag];
    return clamp(x, 2, 98);
  });
  let shift = 0;
  if (T.average != null) { for (let k = 0; k < 10; k++) shift += T.average - mean(withMods(shift)); }   // the average includes tags and bumps
  return withMods(shift).map((v, i) => T.pins[ids[i]] != null ? clamp(T.pins[ids[i]], 2, 98) : v);
}

// the targets.json the analyzer, tuner and calibrator read: one first-try win rate per stage, plus the editable model
export function targetsJson(T, ids, measured, old) {
  const d = targetCurve(T, ids, measured), out = {};
  for (const [k, v] of Object.entries(old || {})) if (!['curve', 'stages', 'studio', 'bosses', 'targetPersona', 'tolerance', '_help', '_note'].includes(k)) out[k] = v;
  const bosses = [...new Set([...(T.bosses || []), ...Object.entries(T.tags).filter(([, v]) => v === 'boss').map(([k]) => k)])];
  return { _note: 'Written by balance-sim (studio or target.mjs). Win rates are 1 - difficulty/100; change them with the target editor or target.mjs.', targetPersona: T.persona, tolerance: +(T.tolerance / 100).toFixed(3), ...out, bosses, stages: Object.fromEntries(ids.map((id, i) => [id, { firstTryWin: +(1 - d[i] / 100).toFixed(3) }])), studio: T };
}

// model T from an existing targets.json (studio block wins; an old plain curve is converted; otherwise defaults)
export function modelFromTargets(t, haveMeasured, measured) {
  const T0 = defaultT();
  if (t && t.studio) return { ...T0, ...t.studio, tags: { ...(t.studio.tags || {}) }, pins: { ...(t.studio.pins || {}) } };
  if (haveMeasured) { T0.template = 'measured'; T0.snapshot = fillGaps(measured); }
  if (t) {
    if (t.curve && !haveMeasured) { T0.start = Math.round(100 * (1 - t.curve.start)); T0.end = Math.round(100 * (1 - t.curve.end)); T0.bossBump = Math.round(100 * (t.curve.bossDrop ?? 0.15)); }
    T0.persona = t.targetPersona || 'smart'; T0.tolerance = Math.round(100 * (t.tolerance ?? 0.12)); T0.bosses = (t.bosses || []).map(String);
  }
  return T0;
}

// one-line result of a detection run, stored in meta.json (the run list of the studio shows it)
export function detectSummary(rep) {
  const tp = rep.targetPersona, st = Object.values(rep.stages);
  const ws = st.map((s) => s[tp] && s[tp].win).filter((x) => x != null);
  const gaps = st.filter((s) => s[tp] && s.target && s.target.win != null).map((s) => Math.abs(s[tp].win - s.target.win));
  return { tp, stages: ws.length, avgDifficulty: ws.length ? Math.round(100 * (1 - mean(ws))) : null, gap: gaps.length ? Math.round(1000 * mean(gaps)) / 10 : null };
}
