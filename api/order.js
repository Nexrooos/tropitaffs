// Fonction serveur Vercel : reçoit une commande du site, vérifie le compte Discord
// du client, recalcule le total et l'envoie dans le salon via le webhook.
// L'URL du webhook est dans la variable d'environnement WEBHOOK_URL (jamais dans le code).

const PLATS = { 3: [900, 1305], 4: [1600, 2320], 5: [2500, 3625], 6: [3600, 5220], 7: [4900, 7105] };
const CATALOG = {
  sable: ["Shulker de sable", 350],
  verre: ["Shulker de verre", 450],
  mousse: ["Shulker de mousse", 300],
  trap: ["Shulker de trappes en bambou", 1400],
  planches: ["Shulker de planches de bambou", 180],
  stone: ["Shulker de stone", 500],
  fer: ["Shulker de blocs de fer", 7000],
  bisball: ["Shulker de Bis Ball", 1000, 10],
};
// Shulkers de baies : les 70 baies de Cobblemon, toutes au même prix
const BERRY_PRICE = 300;
for (const n of require("../data/berries.json")) {
  const id = "baie-" + n.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
  CATALOG[id] = ["Shulker de " + n, BERRY_PRICE];
}
// Shulkers de Poké Balls : 600 $ (cuivre), 800 $ (fer), 1 000 $ (or) selon le métal du craft ; 10 max par personne
for (const b of require("../data/balls.json")) CATALOG[b.id] = ["Shulker de " + b.name, b.price];
for (const [n, [sans, avec]] of Object.entries(PLATS)) {
  CATALOG["p" + n] = [`Plat ${n}x${n} (sans matériaux)`, sans];
  CATALOG["m" + n] = [`Plat ${n}x${n} (avec matériaux)`, avec];
}
// Personnes mentionnées (notifiées) à chaque nouvelle commande
// Qui mentionner selon les articles commandés
const NOTIFY_BY_ITEM = {
  bisball: "373545014594240512", // Nairfol, pour les Bis Ball
  fer: "430041267767083008", // So_Clever / Abdoulaye, pour les blocs de fer
};
const KINDS = ["Farm d'une autre ressource", "Plateforme personnalisée", "Ferme à fer", "Autre"];

const fmt = (n) => n.toLocaleString("fr-FR").replace(/ | /g, " ") + " $";
const str = (v, max) => (typeof v === "string" ? v.trim().slice(0, max) : "");
const clean = (s) => s.replace(/@(everyone|here)/gi, "@​$1");

module.exports = async (req, res) => {
  if (req.method !== "POST") return res.status(405).json({ error: "Méthode non autorisée" });
  const hook = (process.env.WEBHOOK_URL || "").trim().replace(/^["']|["']$/g, "");
  if (!/^https:\/\/(canary\.|ptb\.)?discord(app)?\.com\/api\/webhooks\/\d+\/[\w-]+$/.test(hook)) return res.status(503).json({ error: "Webhook mal configuré (format de WEBHOOK_URL invalide).", code: "bad_hook_format", len: hook.length });
  if (!hook) return res.status(503).json({ error: "Envoi automatique pas encore configuré." });

  let body = req.body;
  if (typeof body === "string") { try { body = JSON.parse(body); } catch { body = {}; } }
  body = body || {};

  // 1. Vérifier le compte Discord avec le jeton du client
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

  // 2. Valider le reste
  const mc = str(body.mc, 16);
  if (!/^[A-Za-z0-9_]{3,16}$/.test(mc)) return res.status(400).json({ error: "Pseudo Tropimon invalide." });
  const coords = clean(str(body.coords, 120));
  const notes = clean(str(body.notes, 800));

  const cart = body.cart && typeof body.cart === "object" ? body.cart : {};
  const lines = [];
  let total = 0;
  for (const [id, q] of Object.entries(cart)) {
    const item = CATALOG[id];
    const qty = Math.floor(Number(q));
    if (!item || !(qty >= 1 && qty <= 99)) continue;
    if (item[2] && qty > item[2]) return res.status(400).json({ error: `Maximum ${item[2]} × ${item[0]} par personne.` });
    total += qty * item[1];
    lines.push(`${qty} × ${item[0]} = ${fmt(qty * item[1])}`);
  }
  const customs = (Array.isArray(body.customs) ? body.customs : []).slice(0, 5).map((c) => ({
    kind: KINDS.includes(c && c.kind) ? c.kind : "Autre",
    desc: clean(str(c && c.desc, 500)),
    qty: clean(str(c && c.qty, 60)),
    budget: clean(str(c && c.budget, 30)),
  }));
  const ballTotal = Object.entries(cart).filter(([id]) => id.startsWith("ball-")).reduce((t, [, q]) => t + Math.max(0, Math.floor(Number(q)) || 0), 0);
  if (ballTotal > 10) return res.status(400).json({ error: "Maximum 10 shulkers de Poké Balls par personne." });
  if (!lines.length && !customs.length) return res.status(400).json({ error: "Ta commande est vide." });
  const cdetail = customs
    .map((c) => `• **${c.kind}**${c.qty ? " (" + c.qty + ")" : ""}${c.budget ? " — budget " + c.budget : ""}\n${c.desc}`)
    .join("\n");

  // 3. Envoyer dans le salon
  const notify = [...new Set(Object.entries(NOTIFY_BY_ITEM).filter(([id]) => Number(cart[id]) > 0).map(([, u]) => u))];
  const avatar = user.avatar
    ? `https://cdn.discordapp.com/avatars/${user.id}/${user.avatar}.png?size=128`
    : `https://cdn.discordapp.com/embed/avatars/${Number(BigInt(user.id) >> 22n) % 6}.png`;
  const fields = [
    { name: "Discord", value: `<@${user.id}> (@${user.username}) ✅ connecté`, inline: true },
    { name: "Pseudo Tropimon", value: mc, inline: true },
    { name: "Articles", value: (lines.join("\n") || "Aucun article du catalogue").slice(0, 1000) },
  ];
  if (cdetail) fields.push({ name: "Demandes personnalisées (sur devis)", value: cdetail.slice(0, 1000) });
  fields.push({ name: "Total estimé", value: fmt(total) + (customs.length ? " + devis" : ""), inline: true });
  if (coords) fields.push({ name: "Livraison", value: coords, inline: true });
  if (notes) fields.push({ name: "Précisions", value: notes });

  try {
    const r = await fetch(hook, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        username: "TropiTaffs Commandes",
        ...(notify.length ? { content: notify.map((id) => `<@${id}>`).join(" ") + " nouvelle commande !" } : {}),
        allowed_mentions: { parse: [], users: notify },
        embeds: [{ title: "🛒 Nouvelle commande", color: 0xe3352f, timestamp: new Date().toISOString(), thumbnail: { url: avatar }, fields }],
      }),
    });
    if (!r.ok) {
      const detail = (await r.text().catch(() => "")).slice(0, 300);
      console.error("webhook", r.status, detail);
      return res.status(502).json({ error: "L'envoi vers Discord a échoué, réessaie.", code: "webhook_" + r.status, detail });
    }
  } catch (e) {
    console.error("webhook fetch", e);
    return res.status(502).json({ error: "L'envoi vers Discord a échoué, réessaie.", code: "fetch_error", detail: String(e).slice(0, 200) });
  }
  return res.status(200).json({ ok: true });
};
