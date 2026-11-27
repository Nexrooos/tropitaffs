// Prix conseillé d'une demande Pokémon TropiTaffs (partagé entre le site et l'API).
// Hypothèses (données de l'équipe, novembre 2026) :
//  - 1 Poké Snack = 1 farine ; farine à 373 $ le stack de 64 (médiane des ventes du 17 au 22/11/2026)
//  - 1 snack = 9 apparitions ; répartition des raretés au snack : 83,25 / 11,25 / 4,125 / 1,375 %
//  - on farme dans le meilleur habitat (poids du wiki Tropimon), sinon part médiane de la rareté
//  - IV tirés au hasard de 0 à 31 ; boost IV = +10 points répartis au hasard sur les stats (max 31)
//  - talent caché : 10 % avec le boost TC, 0 % sans ; chaque boost coûte 11 150 $ l'heure
//  - une plateforme vide une shulker de snacks (432) en 1 h environ
(function (root) {
  const FARINE_STACK = 373, SNACK = FARINE_STACK / 64, SPAWNS = 9, PER_HOUR = 432, BOOST = 11150, TC_RATE = 0.1;
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
  function ivProb(iv, boost) {
    if (!boost) return iv.reduce((p, v) => p * statP(v, 0), 1);
    return SPLITS.reduce((s, [a, pr]) => s + pr * iv.reduce((p, v, i) => p * statP(v, a[i]), 1), 0);
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
      const perSnack = SNACK + (boost ? BOOST / PER_HOUR : 0) + (tc ? BOOST / PER_HOUR : 0);
      return { boost, snacks, cost: snacks * perSnack };
    });
    const o = opts[0].cost <= opts[1].cost ? opts[0] : opts[1];
    return { boost: o.boost, tc: !!tc, snacks: o.snacks, hours: o.snacks / PER_HOUR, shulkers: o.snacks / 432, price: nice(o.cost), via: best };
  }

  const api = { estimate, ivProb, FARINE_STACK };
  if (typeof module !== "undefined" && module.exports) module.exports = api; else root.TTPrice = api;
})(typeof window !== "undefined" ? window : globalThis);
