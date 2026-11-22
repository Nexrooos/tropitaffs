// Demandes de Pokémon : le joueur décrit le Pokémon voulu (IV, talent, prix proposé).
// On vérifie son compte Discord et les données, puis on envoie la demande dans #Tropitaff.
const FAMILIES = require("../data/pokemon.json");

const BY_NUM = new Map(), FAM_OF = new Map();
for (const fam of FAMILIES) for (const m of fam) { BY_NUM.set(m.n, m); FAM_OF.set(m.n, fam); }
const RAR = { common: "Commun", uncommon: "Peu commun", rare: "Rare", "ultra-rare": "Ultra-rare", none: "Pas d'apparition (évolution / reproduction)" };
const RPTS = { common: 0, uncommon: 1, rare: 2, "ultra-rare": 3, none: 2 }, IVPTS = { any: 0, good: 1, "3": 2, "4": 3, "5": 4, "6": 5 };
const DIFF = [[1, "Facile"], [3, "Moyen"], [5, "Difficile"], [7, "Très difficile"], [99, "Extrême"]];
const rKey = (r) => r.replace("*", "");
const rLabel = (r) => (RAR[rKey(r)] || RAR.none) + (r.endsWith("*") ? " (Poké Snack)" : "");
function difficulty(n, iv, tc) {
  const fam = FAM_OF.get(n), i = fam.findIndex((m) => m.n === n);
  const pts = Math.min(...fam.slice(0, i + 1).map((m) => RPTS[rKey(m.r)])) + IVPTS[iv] + (tc ? 2 : 0);
  return DIFF.find((d) => pts <= d[0])[1];
}

const IVS = {
  any: "Peu importe",
  good: "Bons IV (toutes les stats ≥ 20)",
  "3": "3 IV parfaits (31)",
  "4": "4 IV parfaits (31)",
  "5": "5 IV parfaits (31)",
  "6": "6 IV parfaits (31)",
};

const str = (v, max) => (typeof v === "string" ? v.trim().slice(0, max) : "");
const clean = (s) => s.replace(/@(everyone|here)/gi, "@​$1");
const fmt = (n) => n.toLocaleString("fr-FR").replace(/ | /g, " ") + " $";

module.exports = async (req, res) => {
  if (req.method !== "POST") return res.status(405).json({ error: "Méthode non autorisée" });
  const hook = (process.env.WEBHOOK_URL || "").trim();
  if (!hook) return res.status(503).json({ error: "Envoi pas encore configuré." });

  let body = req.body;
  if (typeof body === "string") { try { body = JSON.parse(body); } catch { body = {}; } }
  body = body || {};

  const token = str(body.token, 200);
  if (!token) return res.status(401).json({ error: "Connecte-toi avec Discord." });
  let user;
  try {
    const r = await fetch("https://discord.com/api/users/@me", { headers: { Authorization: "Bearer " + token } });
    if (!r.ok) return res.status(401).json({ error: "Ta connexion Discord a expiré, reconnecte-toi." });
    user = await r.json();
  } catch {
    return res.status(502).json({ error: "Discord ne répond pas, réessaie." });
  }

  const mc = str(body.mc, 16);
  if (!/^[A-Za-z0-9_]{3,16}$/.test(mc)) return res.status(400).json({ error: "Pseudo Tropimon invalide." });
  const mon = BY_NUM.get(Number(body.n));
  if (!mon) return res.status(400).json({ error: "Pokémon inconnu." });
  const iv = IVS[str(body.iv, 5)] ? str(body.iv, 5) : null;
  if (!iv) return res.status(400).json({ error: "Choisis les IV souhaités." });

  const ab = str(body.ability, 40);
  let talent, isTc = false;
  if (!ab || ab === "any") talent = "Peu importe";
  else if (mon.ab.includes(ab)) talent = ab;
  else if (mon.tc && ab === mon.tc) {
    if (!body.patch) return res.status(400).json({ error: "Le talent caché demande un Patch Talent." });
    talent = `${ab} (talent caché, Patch Talent fourni par le joueur)`; isTc = true;
  } else return res.status(400).json({ error: "Talent invalide pour ce Pokémon." });

  const price = Math.floor(Number(body.price));
  if (!(price >= 1 && price <= 100000000)) return res.status(400).json({ error: "Indique le prix que tu es prêt à mettre." });
  const notes = clean(str(body.notes, 500));

  const avatar = user.avatar
    ? `https://cdn.discordapp.com/avatars/${user.id}/${user.avatar}.png?size=128`
    : `https://cdn.discordapp.com/embed/avatars/${Number(BigInt(user.id) >> 22n) % 6}.png`;
  const fields = [
    { name: "Joueur", value: `<@${user.id}> (@${user.username})`, inline: true },
    { name: "Pseudo Tropimon", value: mc, inline: true },
    { name: "Pokémon", value: `${mon.fr} (n°${mon.n})`, inline: true },
    { name: "Rareté", value: rLabel(mon.r), inline: true },
    { name: "Difficulté estimée", value: difficulty(mon.n, iv, isTc), inline: true },
    { name: "IV souhaités", value: IVS[iv], inline: true },
    { name: "Talent", value: talent, inline: true },
    { name: "Prix proposé", value: fmt(price), inline: true },
  ];
  if (notes) fields.push({ name: "Précisions", value: notes });

  try {
    const r = await fetch(hook, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        username: "TropiTaffs Pokémon",
        allowed_mentions: { parse: [] },
        embeds: [{ title: "🔎 Demande de Pokémon", color: 0x3b6fd8, timestamp: new Date().toISOString(), thumbnail: { url: avatar }, fields,
          footer: { text: "Demande notée, rien n'est promis : recontacter le joueur si on a le Pokémon." } }],
      }),
    });
    if (!r.ok) throw new Error("webhook " + r.status);
  } catch {
    return res.status(502).json({ error: "L'envoi vers Discord a échoué, réessaie." });
  }
  return res.status(200).json({ ok: true });
};
