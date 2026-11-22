// Loterie TropiTaffs : fonction serveur Vercel.
// Stockage : Upstash Redis (variables KV_REST_API_URL / KV_REST_API_TOKEN ou UPSTASH_REDIS_REST_URL / _TOKEN).
// Admins : variable ADMIN_IDS = identifiants Discord séparés par des virgules.
// Tirage vérifiable : au début de chaque tirage, on publie l'empreinte SHA-256 d'une graine secrète.
// Au tirage, on révèle la graine ; le gagnant = SHA-256(graine + liste des tickets) modulo le nombre de tickets.

const crypto = require("crypto");

const PRICE = 500; // prix d'un ticket en $
const SHARE = 0.1; // part gardée par TropiTaffs (le gagnant reçoit 90 %)
const MIN_PLAYERS = 3; // en dessous, le tirage est reporté à la semaine suivante (tickets et cagnotte gardés)
const MAX_PER_USER = 20; // tickets max par personne et par tirage
const DRAW_DAY = 0; // 0 = dimanche
const DRAW_HOUR = 21; // heure de Paris

const sha = (s) => crypto.createHash("sha256").update(s).digest("hex");
const fmt = (n) => n.toLocaleString("fr-FR").replace(/ | /g, " ") + " $";
const str = (v, max) => (typeof v === "string" ? v.trim().slice(0, max) : "");

/* ---------- Redis (API REST Upstash) ---------- */
const RURL = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
const RTOK = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;
async function redis(cmd) {
  const r = await fetch(RURL, { method: "POST", headers: { Authorization: "Bearer " + RTOK }, body: JSON.stringify(cmd) });
  const j = await r.json();
  if (j.error) throw new Error(j.error);
  return j.result;
}
const getJSON = async (k) => { const v = await redis(["GET", k]); return v ? JSON.parse(v) : null; };
const setJSON = (k, v) => redis(["SET", k, JSON.stringify(v)]);

/* ---------- Dates : prochain tirage (heure de Paris) ---------- */
function parisOffsetMs(d) {
  const p = Object.fromEntries(new Intl.DateTimeFormat("en-GB", { timeZone: "Europe/Paris", hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" }).formatToParts(d).map((x) => [x.type, x.value]));
  return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) - Math.floor(d.getTime() / 1000) * 1000;
}
function nextDraw(after) {
  for (let i = 0; i < 9; i++) {
    const day = new Date(after.getTime() + i * 864e5);
    const p = new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Paris", year: "numeric", month: "2-digit", day: "2-digit", weekday: "short" }).formatToParts(day);
    const g = Object.fromEntries(p.map((x) => [x.type, x.value]));
    const wd = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(g.weekday);
    if (wd !== DRAW_DAY) continue;
    const guess = new Date(Date.UTC(+g.year, +g.month - 1, +g.day, DRAW_HOUR, 0, 0));
    const t = new Date(guess.getTime() - parisOffsetMs(guess));
    if (t > after) return t.getTime();
  }
  return after.getTime() + 7 * 864e5;
}

function newRound(id) {
  const seed = crypto.randomBytes(32).toString("hex");
  return { id, start: Date.now(), end: nextDraw(new Date()), seed, seedHash: sha(seed), buys: [] };
}

/* ---------- Discord ---------- */
async function discordUser(token) {
  if (!token) return null;
  const r = await fetch("https://discord.com/api/users/@me", { headers: { Authorization: "Bearer " + token } });
  return r.ok ? r.json() : null;
}
async function announce(payload) {
  const hook = (process.env.WEBHOOK_URL || "").trim();
  if (!hook) return;
  await fetch(hook, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ username: "TropiTaffs Loterie", allowed_mentions: { parse: [], users: payload.users || [] }, ...payload, users: undefined }) }).catch(() => {});
}

/* ---------- Tirage ---------- */
function ticketList(round) {
  return round.buys.filter((b) => b.status === "paid");
}
function drawWinner(round) {
  const paid = ticketList(round);
  const total = paid.reduce((s, b) => s + b.qty, 0);
  if (!total) return { total: 0 };
  const listing = paid.map((b) => `${b.id}:${b.uid}:${b.qty}`).join(",");
  const h = sha(round.seed + "|" + listing);
  const n = Number(BigInt("0x" + h.slice(0, 15)) % BigInt(total));
  let acc = 0, win = null;
  for (const b of paid) { acc += b.qty; if (n < acc) { win = b; break; } }
  return { total, listing, hash: h, index: n, winner: win };
}

async function ensureRound() {
  let round = await getJSON("lot:cur");
  if (!round) { round = newRound(1); await setJSON("lot:cur", round); return round; }
  if (Date.now() < round.end) return round;

  // Le tirage est dû : on le fait une seule fois (verrou Redis)
  const lock = await redis(["SET", "lot:lock:" + round.id + ":" + round.end, "1", "NX", "EX", "60"]);
  if (lock !== "OK") return round;
  const nPlayers = new Set(ticketList(round).map((b) => b.uid)).size;
  if (nPlayers < MIN_PLAYERS) {
    // Pas assez de joueurs : on garde tous les tickets et on repousse le tirage d'une semaine
    round.end = nextDraw(new Date());
    round.postponed = (round.postponed || 0) + 1;
    await setJSON("lot:cur", round);
    const tickets = ticketList(round).reduce((s, b) => s + b.qty, 0);
    await announce({ content: `🎟️ Tirage n°${round.id} reporté : seulement ${nPlayers} joueur${nPlayers > 1 ? "s" : ""} sur ${MIN_PLAYERS} minimum. Les ${tickets} tickets et la cagnotte de ${fmt(tickets * PRICE)} sont gardés pour la semaine prochaine !` });
    return round;
  }
  const res = drawWinner(round);
  const pot = res.total * PRICE, prize = Math.floor(pot * (1 - SHARE));
  const result = {
    id: round.id, end: round.end, seed: round.seed, seedHash: round.seedHash, tickets: res.total, pot, prize,
    hash: res.hash || null, index: res.index ?? null, listing: res.listing || "",
    winner: res.winner ? { uid: res.winner.uid, name: res.winner.name, mc: res.winner.mc } : null,
    players: ticketList(round).map((b) => ({ name: b.name, mc: b.mc, qty: b.qty })),
  };
  await redis(["LPUSH", "lot:hist", JSON.stringify(result)]);
  await redis(["LTRIM", "lot:hist", "0", "9"]);
  const next = newRound(round.id + 1);
  await setJSON("lot:cur", next);
  await announce(result.winner
    ? { content: `🎉 <@${result.winner.uid}> gagne la loterie n°${result.id} !`, users: [result.winner.uid],
        embeds: [{ title: `🎟️ Tirage n°${result.id}`, color: 0xf2b705, fields: [
          { name: "Gagnant", value: `<@${result.winner.uid}> (${result.winner.mc})`, inline: true },
          { name: "Gain à verser", value: fmt(prize), inline: true },
          { name: "Tickets", value: String(res.total), inline: true },
          { name: "Part TropiTaffs", value: fmt(pot - prize), inline: true } ] }] }
    : { content: `🎟️ Tirage n°${result.id} : aucun ticket payé, pas de gagnant. Nouveau tirage lancé !` });
  return next;
}

function publicState(round, user, isAdmin, hist) {
  const paid = ticketList(round);
  const tickets = paid.reduce((s, b) => s + b.qty, 0);
  const pot = tickets * PRICE;
  const mine = user ? round.buys.filter((b) => b.uid === user.id).map((b) => ({ id: b.id, qty: b.qty, status: b.status, at: b.at })) : [];
  return {
    config: { price: PRICE, share: SHARE, max: MAX_PER_USER, minPlayers: MIN_PLAYERS },
    round: { id: round.id, end: round.end, seedHash: round.seedHash, tickets, pot, prize: Math.floor(pot * (1 - SHARE)), players: new Set(paid.map((b) => b.uid)).size, postponed: round.postponed || 0 },
    mine, isAdmin,
    pending: isAdmin ? round.buys.filter((b) => b.status === "pending").map((b) => ({ id: b.id, name: b.name, mc: b.mc, qty: b.qty, at: b.at })) : undefined,
    last: hist[0] || null,
  };
}

module.exports = async (req, res) => {
  if (!RURL || !RTOK) return res.status(503).json({ error: "La loterie n'est pas encore branchée à sa base de données." });
  try {
    let body = req.body;
    if (typeof body === "string") { try { body = JSON.parse(body); } catch { body = {}; } }
    body = body || {};
    const token = req.method === "POST" ? str(body.token, 200) : "";
    const user = token ? await discordUser(token) : null;
    // Équipe autorisée à valider les paiements (identifiants Discord). ADMIN_IDS peut en ajouter.
    const admins = ["390924523765104642" /* Nexro */, "1403737838536757301" /* Akumaa1702 */, "1470525596885844080" /* lewoodzz */,
      ...(process.env.ADMIN_IDS || "").split(",").map((s) => s.trim()).filter(Boolean)];
    const isAdmin = !!user && admins.includes(user.id);

    let round = await ensureRound();
    const hist = ((await redis(["LRANGE", "lot:hist", "0", "0"])) || []).map((x) => JSON.parse(x));

    if (req.method === "GET") return res.status(200).json(publicState(round, user, isAdmin, hist));
    if (req.method !== "POST") return res.status(405).json({ error: "Méthode non autorisée" });
    const action = str(body.action, 20);
    if (action === "state") return res.status(200).json(publicState(round, user, isAdmin, hist));
    if (!user) return res.status(401).json({ error: "Connecte-toi avec Discord." });
    if (action === "buy") {
      if (Date.now() >= round.end) return res.status(409).json({ error: "Le tirage est en cours, réessaie dans un instant." });
      const qty = Math.floor(Number(body.qty));
      const mc = str(body.mc, 16);
      if (!/^[A-Za-z0-9_]{3,16}$/.test(mc)) return res.status(400).json({ error: "Pseudo Tropimon invalide." });
      const already = round.buys.filter((b) => b.uid === user.id && b.status !== "refused").reduce((s, b) => s + b.qty, 0);
      if (!(qty >= 1) || already + qty > MAX_PER_USER) return res.status(400).json({ error: `Maximum ${MAX_PER_USER} tickets par personne et par tirage (tu en as déjà ${already}).` });
      const buy = { id: crypto.randomBytes(4).toString("hex"), uid: user.id, name: user.username, mc, qty, status: "pending", at: Date.now() };
      round.buys.push(buy);
      await setJSON("lot:cur", round);
      await announce({ embeds: [{ title: "🎟️ Achat de tickets à encaisser", color: 0x3b6fd8, fields: [
        { name: "Joueur", value: `<@${user.id}> (@${user.username})`, inline: true },
        { name: "Pseudo Tropimon", value: mc, inline: true },
        { name: "Tickets", value: `${qty} × ${fmt(PRICE)} = **${fmt(qty * PRICE)}**`, inline: true },
        { name: "À faire", value: "Encaisser en jeu puis valider l'achat dans la partie Loterie du site." } ] }] });
      return res.status(200).json({ ok: true, ...publicState(round, user, isAdmin, hist) });
    }

    if (action === "validate" || action === "refuse") {
      if (!isAdmin) return res.status(403).json({ error: "Réservé à l'équipe TropiTaffs." });
      const b = round.buys.find((x) => x.id === str(body.id, 20));
      if (!b || b.status !== "pending") return res.status(404).json({ error: "Achat introuvable ou déjà traité." });
      b.status = action === "validate" ? "paid" : "refused";
      b.by = user.username;
      await setJSON("lot:cur", round);
      return res.status(200).json({ ok: true, ...publicState(round, user, isAdmin, hist) });
    }

    return res.status(400).json({ error: "Action inconnue." });
  } catch (e) {
    console.error("lottery", e);
    return res.status(500).json({ error: "Erreur du serveur de loterie, réessaie." });
  }
};
