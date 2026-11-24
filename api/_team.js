// Équipe TropiTaffs : identifiants Discord autorisés à voir les outils de l'équipe.
// Les fichiers commençant par _ dans api/ ne sont pas des pages publiques sur Vercel.
module.exports.ADMINS = [
  "390924523765104642", // Nexro
  "1403737838536757301", // Akumaa1702
  "1470525596885844080", // lewoodzz
  "373545014594240512", // Nairfol (demandes de Pokémon, ajoutée à la demande de Nexro)
  ...(process.env.ADMIN_IDS || "").split(",").map((s) => s.trim()).filter(Boolean),
];
const RURL = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
const RTOK = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;
module.exports.redis = async (cmd) => {
  if (!RURL || !RTOK) throw new Error("Base de données non configurée");
  const r = await fetch(RURL, { method: "POST", headers: { Authorization: "Bearer " + RTOK }, body: JSON.stringify(cmd) });
  const j = await r.json();
  if (j.error) throw new Error(j.error);
  return j.result;
};

// Comptes Discord bannis du site (commandes impossibles, abusives ou sans l'argent).
// Ils ne peuvent plus commander, faire de demande de Pokémon ni acheter de tickets.
module.exports.BANNED = [
];
module.exports.BAN_MSG = "Tu as été banni du site TropiTaffs. Contacte l'équipe sur Discord si tu penses que c'est une erreur.";
