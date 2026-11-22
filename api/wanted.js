// Demandes de Pokémon : le joueur décrit le Pokémon voulu (IV, talent, prix proposé).
// On vérifie son compte Discord et les données, puis on envoie la demande dans #Tropitaff.
const FAMILIES = require("../data/pokemon.json");
const { ADMINS, redis } = require("./_team.js");
const crypto = require("crypto");

const BY_NUM = new Map(), FAM_OF = new Map();
for (const fam of FAMILIES) for (const m of fam) { BY_NUM.set(m.n, m); FAM_OF.set(m.n, fam); }
const RAR = { common: "Commun", uncommon: "Peu commun", rare: "Rare", "ultra-rare": "Ultra-rare", none: "Pas d'apparition (évolution / reproduction)" };
const RPTS = { common: 0, uncommon: 1, rare: 2, "ultra-rare": 3, none: 2 };
const STATS = ["PV", "Attaque", "Défense", "Atq. Spé.", "Déf. Spé.", "Vitesse"];
const ivPoints = (iv) => Math.min(5, [0, 1, 1, 2, 3, 4, 5][iv.filter((v) => v === 31).length] + (iv.some((v) => v >= 25 && v < 31) ? 1 : 0));
const DIFF = [[1, "Facile"], [3, "Moyen"], [5, "Difficile"], [7, "Très difficile"], [99, "Extrême"]];
const rKey = (r) => r.replace("*", "");
const rLabel = (r) => (RAR[rKey(r)] || RAR.none) + (r.endsWith("*") ? " (Poké Snack)" : "");
function difficulty(n, iv, tc) {
  const fam = FAM_OF.get(n), i = fam.findIndex((m) => m.n === n);
  const pts = Math.min(...fam.slice(0, i + 1).map((m) => RPTS[rKey(m.r)])) + ivPoints(iv) + (tc ? 2 : 0);
  return DIFF.find((d) => pts <= d[0])[1];
}



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

  // Outils de l'équipe : liste des demandes triées par prix, marquer une demande comme traitée
  const action = str(body.action, 10);
  if (action === "list" || action === "done" || action === "reopen") {
    if (!ADMINS.includes(user.id)) return res.status(403).json({ error: "Réservé à l'équipe TropiTaffs." });
    const raw = (await redis(["HGETALL", "wanted"])) || [];
    const all = [];
    for (let i = 0; i < raw.length; i += 2) all.push(JSON.parse(raw[i + 1]));
    if (action !== "list") {
      const w = all.find((x) => x.id === str(body.id, 20));
      if (!w) return res.status(404).json({ error: "Demande introuvable." });
      w.status = action === "done" ? "done" : "open"; w.by = user.username;
      await redis(["HSET", "wanted", w.id, JSON.stringify(w)]);
    }
    all.sort((a, b) => b.price - a.price || a.at - b.at);
    return res.status(200).json({ requests: all });
  }

  const mc = str(body.mc, 16);
  if (!/^[A-Za-z0-9_]{3,16}$/.test(mc)) return res.status(400).json({ error: "Pseudo Tropimon invalide." });
  const mon = BY_NUM.get(Number(body.n));
  if (!mon) return res.status(400).json({ error: "Pokémon inconnu." });
  const iv = Array.isArray(body.iv) && body.iv.length === 6 ? body.iv.map((v) => Math.floor(Number(v))) : null;
  if (!iv || iv.some((v) => !(v >= 0 && v <= 31))) return res.status(400).json({ error: "IV invalides (entre 0 et 31)." });
  const ivText = iv.every((v) => v === 0) ? "Peu importe"
    : STATS.map((st, i) => (iv[i] === 31 ? `**${st} 31**` : iv[i] > 0 ? `${st} ≥ ${iv[i]}` : `${st} peu importe`)).join(" · ");

  const ab = str(body.ability, 40);
  let talent, isTc = false;
  if (!ab || ab === "any") talent = "Peu importe";
  else if (mon.ab.includes(ab)) talent = ab;
  else if (mon.tc && ab === mon.tc) { talent = `${ab} (talent caché)`; isTc = true; } else return res.status(400).json({ error: "Talent invalide pour ce Pokémon." });

  const price = Math.floor(Number(body.price));
  if (!(price >= 1 && price <= 100000000)) return res.status(400).json({ error: "Indique le prix que tu es prêt à mettre." });
  const notes = clean(str(body.notes, 500));
  const dif = difficulty(mon.n, iv, isTc);

  const avatar = user.avatar
    ? `https://cdn.discordapp.com/avatars/${user.id}/${user.avatar}.png?size=128`
    : `https://cdn.discordapp.com/embed/avatars/${Number(BigInt(user.id) >> 22n) % 6}.png`;
  const fields = [
    { name: "Joueur", value: `<@${user.id}> (@${user.username})`, inline: true },
    { name: "Pseudo Tropimon", value: mc, inline: true },
    { name: "Pokémon", value: `${mon.fr} (n°${mon.n})`, inline: true },
    { name: "Rareté", value: rLabel(mon.r), inline: true },
    { name: "Difficulté estimée", value: dif, inline: true },
    { name: "IV souhaités", value: ivText },
    { name: "Talent", value: talent, inline: true },
    { name: "Prix proposé", value: fmt(price), inline: true },
  ];
  if (notes) fields.push({ name: "Précisions", value: notes });

  const id = crypto.randomBytes(4).toString("hex");
  try {
    await redis(["HSET", "wanted", id, JSON.stringify({ id, at: Date.now(), uid: user.id, name: user.username, mc, n: mon.n, pokemon: mon.fr,
      iv, talent, tc: isTc, price, difficulty: dif, rarity: rLabel(mon.r), notes, status: "open" })]);
  } catch (e) { console.error("wanted store", e); }
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
