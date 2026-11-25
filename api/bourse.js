// Bourse TropiTaffs : cours des ressources d'après les ventes relevées à l'Hôtel des ventes de Tropimon.
// Public : lecture du cours. Équipe : ajout / suppression de ventes et de l'offre actuelle.
const { ADMINS, redis } = require("./_team.js");

const ITEMS = { farine: "Farine" };
const KEY = "bourse";
// Ventes relevées sur les captures de l'Hôtel des ventes (17 au 22/11/2026)
const SEED = {
  farine: {
    ask: { p: 400, q: 64, d: "2026-11-25" },
    sales: [
      ...Array(5).fill({ d: "2026-11-17", q: 64, p: 350 }),
      ...Array(6).fill({ d: "2026-11-20", q: 64, p: 350 }),
      { d: "2026-11-20", q: 64, p: 395 },
      ...Array(3).fill({ d: "2026-11-21", q: 64, p: 400 }),
      { d: "2026-11-22", q: 42, p: 330 },
    ],
  },
};

const str = (v, max) => (typeof v === "string" ? v.trim().slice(0, max) : "");
const int = (v, min, max) => { const n = Math.round(Number(v)); return Number.isFinite(n) && n >= min && n <= max ? n : null; };
const isDate = (d) => /^\d{4}-\d{2}-\d{2}$/.test(d) && !isNaN(Date.parse(d));

async function load() {
  const raw = await redis(["GET", KEY]);
  if (raw) return JSON.parse(raw);
  await redis(["SET", KEY, JSON.stringify(SEED)]);
  return JSON.parse(JSON.stringify(SEED));
}

module.exports = async (req, res) => {
  if (req.method !== "POST") return res.status(405).json({ error: "Méthode non autorisée" });
  let body = req.body;
  if (typeof body === "string") { try { body = JSON.parse(body); } catch { body = {}; } }
  body = body || {};
  const action = str(body.action, 10) || "state";

  // L'équipe est reconnue si un jeton Discord valide est fourni
  let isAdmin = false;
  const token = str(body.token, 200);
  if (token) {
    try {
      const r = await fetch("https://discord.com/api/users/@me", { headers: { Authorization: "Bearer " + token } });
      if (r.ok) isAdmin = ADMINS.includes((await r.json()).id);
    } catch {}
  }

  let data;
  try { data = await load(); } catch { return res.status(503).json({ error: "Bourse indisponible." }); }
  const out = () => res.status(200).json({ items: ITEMS, data, isAdmin });

  if (action === "state") return out();
  if (!isAdmin) return res.status(403).json({ error: "Réservé à l'équipe TropiTaffs." });

  const item = str(body.item, 30);
  if (!ITEMS[item]) return res.status(400).json({ error: "Ressource inconnue." });
  const cur = data[item] || (data[item] = { ask: null, sales: [] });

  if (action === "add" || action === "ask") {
    const d = str(body.d, 10), q = int(body.q, 1, 64 * 27), p = int(body.p, 1, 10000000);
    if (!isDate(d) || !q || !p) return res.status(400).json({ error: "Date, quantité ou prix invalide." });
    if (action === "add") { cur.sales.push({ d, q, p }); cur.sales.sort((a, b) => a.d.localeCompare(b.d)); if (cur.sales.length > 500) cur.sales.splice(0, cur.sales.length - 500); }
    else cur.ask = { d, q, p };
  } else if (action === "del") {
    const i = int(body.i, 0, cur.sales.length - 1);
    if (i === null) return res.status(400).json({ error: "Vente introuvable." });
    cur.sales.splice(i, 1);
  } else if (action === "noask") {
    cur.ask = null;
  } else return res.status(400).json({ error: "Action inconnue." });

  await redis(["SET", KEY, JSON.stringify(data)]);
  return out();
};
