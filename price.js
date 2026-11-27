// Prix conseillé d'une demande Pokémon TropiTaffs (partagé entre le site et l'API).
// Hypothèses (données de l'équipe, novembre 2026) :
//  - 1 Poké Snack = 1 farine ; farine à 373 $ le stack de 64 (médiane des ventes du 17 au 22/11/2026)
//  - 1 snack = 9 apparitions ; répartition des raretés au snack : 83,25 / 11,25 / 4,125 / 1,375 %
//  - on farme dans le meilleur habitat (poids du wiki Tropimon), sinon part médiane de la rareté
//  - IV tirés au hasard de 0 à 31 ; boost IV = +10 points répartis au hasard sur les stats (max 31)
//  - 2 baies dans le snack : +5 IV chacune sur une stat au choix (+10 sur une stat, ou +5 sur deux)
//    baies à 300 $ la shulker de 1 728 (prix TropiTaffs)
//  - talent caché : 10 % avec le boost TC, 0 % sans ; chaque boost coûte 11 150 $ l'heure (1 h minimum)
//  - une plateforme vide une shulker de snacks (432) en 1 h environ
(function (root) {
  const FARINE_STACK = 373, SNACK = FARINE_STACK / 64, SPAWNS = 9, PER_HOUR = 432, BOOST = 11150, TC_RATE = 0.1;
  const BERRY = 300 / 1728, BERRIES_PER_SNACK = 2;
  const SHARE = { c: 0.8325, u: 0.1125, r: 0.04125, x: 0.01375 };
  const RMAP = { common: "c", uncommon: "u", rare: "r", "ultra-rare": "x" };

  // Toutes les façons de répartir les 10 points du boost sur 6 stats, avec leur probabilité
  const SPLITS = [];
  (function build() {
    const fact = [1]; for (let i = 1; i <= 10; i++) fact[i] = fact[i - 1] * i;
    const rec = (left, k, cur) => {
      if (k === 5) { const a = [...cur, left]; SPLITS.push([a, fact[10] / a.reduce((p, x) => p * fact[x], 1) / Math.pow(6, 10)]); return; }
      for (let x = 0; x <= left; x++) rec(left - x, k + 1, [...cur, x]);
    };
    rec(10, 0, []);
  })();
  const statP = (req, add) => (32 - Math.max(0, req - add)) / 32;
  // Bonus fixes possibles des 2 baies : rien, +10 sur une stat, ou +5 sur deux stats
  const BERRY_OPTS = [[0, 0, 0, 0, 0, 0]];
  for (let i = 0; i < 6; i++) { const b = [0, 0, 0, 0, 0, 0]; b[i] = 10; BERRY_OPTS.push(b); }
  for (let i = 0; i < 6; i++) for (let j = i + 1; j < 6; j++) { const b = [0, 0, 0, 0, 0, 0]; b[i] = 5; b[j] = 5; BERRY_OPTS.push(b); }
  function ivProbWith(iv, boost, bonus) {
    if (!boost) return iv.reduce((p, v, i) => p * statP(v, bonus[i]), 1);
    return SPLITS.reduce((s, [a, pr]) => s + pr * iv.reduce((p, v, i) => p * statP(v, a[i] + bonus[i]), 1), 0);
  }
  // Meilleure chance d'obtenir les IV demandés, en choisissant au mieux les baies
  function ivProb(iv, boost, berries = true) {
    if (!berries) return ivProbWith(iv, boost, BERRY_OPTS[0]);
    let best = 0, bonus = BERRY_OPTS[0];
    for (const b of BERRY_OPTS) { if (b.some((x, i) => x && !iv[i])) continue; const p = ivProbWith(iv, boost, b); if (p > best) { best = p; bonus = b; } }
    return best;
  }
  function bestBerries(iv, boost) {
    let best = -1, bonus = BERRY_OPTS[0];
    for (const b of BERRY_OPTS) { if (b.some((x, i) => x && !iv[i])) continue; const p = ivProbWith(iv, boost, b); if (p > best) { best = p; bonus = b; } }
    return bonus;
  }

  let DEF = null;
  function defaults(H) {
    if (DEF && DEF.H === H) return DEF;
    const by = {}; Object.values(H).forEach(([r, p]) => (by[r] = by[r] || []).push(p / 1000));
    const med = (a) => { a.sort((x, y) => x - y); const m = a.length >> 1; return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2; };
    DEF = { H }; for (const r in by) DEF[r] = med(by[r]);
    return DEF;
  }
  const nice = (v) => { const s = v < 1000 ? 50 : v < 10000 ? 100 : v < 100000 ? 1000 : 10000; return Math.ceil(v / s) * s; };

  // fam : famille (entrées {id, fr, r, p}), H : habitats {id: [rareté, part ×1000]}
  function estimate(fam, id, iv, tc, shiny, H) {
    if (shiny || !H) return null;
    const D = defaults(H);
    let m = fam.find((x) => x.id === id), best = null;
    for (let k = 0; m && k < 5; k++) {
      let r, part, hab = false;
      if (H[m.id]) { r = H[m.id][0]; part = H[m.id][1] / 1000; hab = true; }
      else { r = RMAP[String(m.r).replace("*", "")]; part = r && D[r]; }
      if (r && part) { const per = 1 / (SPAWNS * SHARE[r] * part); if (!best || per < best.per) best = { per, id: m.id, fr: m.fr, hab }; }
      m = m.p && fam.find((x) => x.id === m.p);
    }
    if (!best) return null;
    const opts = [false, true].map((boost) => {
      const p = ivProb(iv, boost) * (tc ? TC_RATE : 1), snacks = best.per / p;
      const berries = iv.some((v) => v > 0);
      // Un boost s'achète par heure : on compte au moins 1 h dès qu'il en faut un
      const nBoosts = (boost ? 1 : 0) + (tc ? 1 : 0), hours = snacks / PER_HOUR;
      const cost = snacks * (SNACK + (berries ? BERRY * BERRIES_PER_SNACK : 0)) + nBoosts * BOOST * Math.max(1, hours);
      return { boost, snacks, cost, berries: berries ? bestBerries(iv, boost) : null };
    });
    const o = opts[0].cost <= opts[1].cost ? opts[0] : opts[1];
    return { boost: o.boost, berries: o.berries, tc: !!tc, snacks: o.snacks, hours: o.snacks / PER_HOUR, shulkers: o.snacks / 432, price: nice(o.cost), via: best };
  }

  const api = { estimate, ivProb, FARINE_STACK };
  if (typeof module !== "undefined" && module.exports) module.exports = api; else root.TTPrice = api;
})(typeof window !== "undefined" ? window : globalThis);
