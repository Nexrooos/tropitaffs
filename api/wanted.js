// Demandes de Pokémon (normaux ou shiny).
// Cycle de vie : "open" (en attente) → "hunting" (un membre de l'équipe s'en occupe) → "sold" (échange fait)
//                le joueur peut annuler ("cancelled") tant que ce n'est pas vendu.
// Les demandes en cours restent privées (le joueur voit les siennes, l'équipe voit tout).
// Seules les ventes terminées sont publiques (Pokémon, IV, talent caché, shiny, prix) pour suivre les prix.
const FAMILIES = require("../data/pokemon.json");
const { ADMINS, redis } = require("./_team.js");
const crypto = require("crypto");

const BY_ID = new Map(), FAM_OF = new Map();
for (const fam of FAMILIES) for (const m of fam) { BY_ID.set(m.id, m); FAM_OF.set(m.id, fam); }
const RAR = { common: "Commun", uncommon: "Peu commun", rare: "Rare", "ultra-rare": "Ultra-rare", none: "Pas d'apparition (évolution, œuf ou fossile)" };
const RPTS = { common: 0, uncommon: 1, rare: 2, "ultra-rare": 3, none: 2 };
const STATS = ["PV", "Attaque", "Défense", "Atq. Spé.", "Déf. Spé.", "Vitesse"];
const ivPoints = (iv) => Math.min(5, [0, 1, 1, 2, 3, 4, 5][iv.filter((v) => v === 31).length] + (iv.some((v) => v >= 25 && v < 31) ? 1 : 0));
const DIFF = [[1, "Facile"], [3, "Moyen"], [5, "Difficile"], [7, "Très difficile"], [99, "Extrême"]];
const SHINY_PTS = 4;
const rKey = (r) => r.replace("*", "");
const rLabel = (r) => (RAR[rKey(r)] || RAR.none) + (r.endsWith("*") ? " (Poké Snack)" : "");
function difficulty(id, iv, tc, shiny) {
  const fam = FAM_OF.get(id), i = fam.findIndex((m) => m.id === id);
  const pts = Math.min(...fam.slice(0, i + 1).map((m) => RPTS[rKey(m.r)])) + (shiny ? SHINY_PTS : ivPoints(iv)) + (tc ? 2 : 0);
  return DIFF.find((d) => pts <= d[0])[1];
}

const str = (v, max) => (typeof v === "string" ? v.trim().slice(0, max) : "");
const clean = (s) => s.replace(/@(everyone|here)/gi, "@​$1");
const fmt = (n) => n.toLocaleString("fr-FR").replace(/ | /g, " ") + " $";
const ivText = (iv) => iv.every((v) => v === 0) ? "Peu importe"
  : STATS.map((st, i) => (iv[i] === 31 ? `**${st} 31**` : iv[i] > 0 ? `${st} ≥ ${iv[i]}` : `${st} peu importe`)).join(" · ");
const label = (w) => `${w.shiny ? "✨ " : ""}${w.pokemon}${w.shiny ? " shiny" : ""}`;

async function loadAll() {
  const raw = (await redis(["HGETALL", "wanted"])) || [];
  const all = [];
  for (let i = 0; i < raw.length; i += 2) all.push(JSON.parse(raw[i + 1]));
  return all;
}
const save = (w) => redis(["HSET", "wanted", w.id, JSON.stringify(w)]);
const forPlayer = (w) => ({ id: w.id, at: w.at, pid: w.pid, pokemon: w.pokemon, shiny: !!w.shiny, iv: w.iv, talent: w.talent, tc: w.tc, price: w.price,
  status: w.status, hunter: w.hunter || null, soldPrice: w.soldPrice || null, updated: w.updated || w.at });

async function notify(hook, payload) {
  try {
    const r = await fetch(hook, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ username: "TropiTaffs Pokémon", ...payload }) });
    return r.ok;
  } catch { return false; }
}

module.exports = async (req, res) => {
  if (req.method !== "POST") return res.status(405).json({ error: "Méthode non autorisée" });
  const hook = (process.env.WEBHOOK_URL || "").trim();

  let body = req.body;
  if (typeof body === "string") { try { body = JSON.parse(body); } catch { body = {}; } }
  body = body || {};
  const action = str(body.action, 10);

  // ---------- Public : dernières ventes (sans le nom des joueurs) ----------
  if (action === "sales") {
    try {
      const sales = (await loadAll()).filter((w) => w.status === "sold")
        .sort((a, b) => b.soldAt - a.soldAt).slice(0, 40)
        .map((w) => ({ pid: w.pid, pokemon: w.pokemon, shiny: !!w.shiny, iv: w.iv, tc: w.tc, price: w.soldPrice, at: w.soldAt }));
      return res.status(200).json({ sales });
    } catch { return res.status(503).json({ error: "Historique indisponible." }); }
  }

  // ---------- Tout le reste demande un compte Discord ----------
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
  const isAdmin = ADMINS.includes(user.id);

  try {
    // ---------- Joueur : mes demandes, annuler ----------
    if (action === "mine") {
      const mine = (await loadAll()).filter((w) => w.uid === user.id).sort((a, b) => b.at - a.at).map(forPlayer);
      return res.status(200).json({ mine });
    }
    if (action === "cancel") {
      const all = await loadAll();
      const w = all.find((x) => x.id === str(body.id, 20));
      if (!w || w.uid !== user.id) return res.status(404).json({ error: "Demande introuvable." });
      if (w.status === "sold" || w.status === "cancelled") return res.status(409).json({ error: "Cette demande ne peut plus être annulée." });
      const wasHunted = w.status === "hunting" ? w.hunterId : null;
      w.status = "cancelled"; w.updated = Date.now();
      await save(w);
      if (hook) await notify(hook, { ...(wasHunted ? { content: `<@${wasHunted}>`, allowed_mentions: { parse: [], users: [wasHunted] } } : { allowed_mentions: { parse: [] } }),
        embeds: [{ title: "❌ Demande annulée par le joueur", color: 0x7a7f8c, description: `${w.mc} a annulé sa demande : **${label(w)}** (${fmt(w.price)}).${wasHunted ? " Tu peux arrêter la chasse." : ""}` }] });
      return res.status(200).json({ mine: all.filter((x) => x.uid === user.id).sort((a, b) => b.at - a.at).map(forPlayer) });
    }

    // ---------- Équipe ----------
    if (["list", "take", "release", "sold", "reopen", "remove"].includes(action)) {
      if (!isAdmin) return res.status(403).json({ error: "Réservé à l'équipe TropiTaffs." });
      const all = await loadAll();
      if (action !== "list") {
        const w = all.find((x) => x.id === str(body.id, 20));
        if (!w) return res.status(404).json({ error: "Demande introuvable." });
        if (w.status === "cancelled" && action !== "remove") return res.status(409).json({ error: "Le joueur a annulé cette demande." });
        w.updated = Date.now();
        if (action === "take") {
          w.status = "hunting"; w.hunter = user.global_name || user.username; w.hunterId = user.id;
          if (hook) await notify(hook, { content: `<@${w.uid}> 🎯 **${w.hunter}** est en train de farmer ton **${label(w)}** !`,
            allowed_mentions: { parse: [], users: [w.uid] } });
        } else if (action === "release") {
          w.status = "open"; w.hunter = null; w.hunterId = null;
        } else if (action === "sold") {
          const p = Math.floor(Number(body.price));
          if (!(p >= 1 && p <= 100000000)) return res.status(400).json({ error: "Prix de vente invalide." });
          w.status = "sold"; w.soldPrice = p; w.soldAt = Date.now(); w.seller = user.global_name || user.username;
          if (hook) await notify(hook, { content: `<@${w.uid}> ✅ Ton **${label(w)}** est livré, merci pour ta commande !`,
            allowed_mentions: { parse: [], users: [w.uid] },
            embeds: [{ title: "✅ Vente enregistrée", color: 0x2f9e55, description: `**${label(w)}** vendu à ${w.mc} pour **${fmt(p)}** par ${w.seller}.` }] });
        } else if (action === "reopen") {
          w.status = "open"; w.soldPrice = null; w.soldAt = null; w.hunter = null; w.hunterId = null;
        } else if (action === "remove") {
          w.status = "removed";
        }
        await save(w);
      }
      const list = all.filter((w) => w.status !== "removed")
        .sort((a, b) => (a.status === "sold") - (b.status === "sold") || b.price - a.price || a.at - b.at);
      return res.status(200).json({ requests: list });
    }
  } catch (e) {
    console.error("wanted", e);
    return res.status(503).json({ error: "Base de données indisponible, réessaie." });
  }

  // ---------- Nouvelle demande ----------
  if (!hook) return res.status(503).json({ error: "Envoi pas encore configuré." });
  const mc = str(body.mc, 16);
  if (!/^[A-Za-z0-9_]{3,16}$/.test(mc)) return res.status(400).json({ error: "Pseudo Tropimon invalide." });
  const mon = BY_ID.get(str(body.id, 30) || String(Math.floor(Number(body.n))));
  if (!mon) return res.status(400).json({ error: "Pokémon inconnu." });
  const shiny = body.shiny === true;
  let iv = Array.isArray(body.iv) && body.iv.length === 6 ? body.iv.map((v) => Math.floor(Number(v))) : null;
  if (shiny) iv = [0, 0, 0, 0, 0, 0]; // pas d'IV pour un shiny : il est déjà shiny
  if (!iv || iv.some((v) => !(v >= 0 && v <= 31))) return res.status(400).json({ error: "IV invalides (entre 0 et 31)." });

  const ab = str(body.ability, 40);
  let talent, isTc = false;
  if (!ab || ab === "any") talent = "Peu importe";
  else if (mon.ab.includes(ab)) talent = ab;
  else if (mon.tc && ab === mon.tc) { talent = `${ab} (talent caché)`; isTc = true; }
  else return res.status(400).json({ error: "Talent invalide pour ce Pokémon." });

  const price = Math.floor(Number(body.price));
  if (!(price >= 1 && price <= 100000000)) return res.status(400).json({ error: "Indique le prix que tu es prêt à mettre." });
  const notes = clean(str(body.notes, 500));
  const dif = difficulty(mon.id, iv, isTc, shiny);

  const w = { id: crypto.randomBytes(4).toString("hex"), at: Date.now(), uid: user.id, name: user.username, mc, n: mon.n, pid: mon.id, pokemon: mon.fr,
    shiny, iv, talent, tc: isTc, price, difficulty: dif, rarity: rLabel(mon.r), notes, status: "open" };
  try { await save(w); } catch (e) { console.error("wanted store", e); return res.status(503).json({ error: "Base de données indisponible, réessaie." }); }

  const avatar = user.avatar
    ? `https://cdn.discordapp.com/avatars/${user.id}/${user.avatar}.png?size=128`
    : `https://cdn.discordapp.com/embed/avatars/${Number(BigInt(user.id) >> 22n) % 6}.png`;
  const fields = [
    { name: "Joueur", value: `<@${user.id}> (@${user.username})`, inline: true },
    { name: "Pseudo Tropimon", value: mc, inline: true },
    { name: "Pokémon", value: `${label(w)} (n°${mon.n})`, inline: true },
    { name: "Rareté", value: rLabel(mon.r), inline: true },
    { name: "Difficulté estimée", value: dif, inline: true },
    { name: "IV souhaités", value: shiny ? "Aucune exigence (shiny)" : ivText(iv) },
    { name: "Talent", value: talent, inline: true },
    { name: "Prix proposé", value: fmt(price), inline: true },
  ];
  if (notes) fields.push({ name: "Précisions", value: notes });
  const ok = await notify(hook, { allowed_mentions: { parse: [] },
    embeds: [{ title: shiny ? "✨ Demande de Pokémon shiny" : "🔎 Demande de Pokémon", color: shiny ? 0xf2b705 : 0x3b6fd8, timestamp: new Date().toISOString(),
      thumbnail: { url: avatar }, fields, footer: { text: "Sur le site : « Je m'en occupe » prévient le joueur, « Vendu » l'ajoute à l'historique public." } }] });
  if (!ok) return res.status(502).json({ error: "L'envoi vers Discord a échoué, réessaie." });
  return res.status(200).json({ ok: true });
};
