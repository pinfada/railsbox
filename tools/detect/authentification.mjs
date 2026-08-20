// Quel mécanisme d'authentification l'application utilise — et surtout : est-ce
// que railsbox sait l'ouvrir ?
//
// POURQUOI CE MODULE EXISTE. `auto_login` promet « le visiteur arrive
// connecté ». La promesse repose sur un middleware qui pose l'utilisateur là où
// l'application ira le chercher. Encore faut-il que ce soit le MÊME endroit.
//
// Le 20/08/2026, sur une application Rails 8.1 réelle : l'auto-connexion s'est
// exécutée, a trouvé l'utilisateur, a écrit une session Rack — et l'application
// ne l'a jamais lue, parce qu'elle relit
// `Session.find_by(id: cookies.signed[:session_id])`. Le visiteur est arrivé
// déconnecté SANS AUCUN MESSAGE : construction verte, journal muet, aucune
// exception. Du point de vue de railsbox, le travail avait été fait.
//
// C'est ça, le défaut de fond — pas l'absence d'un mécanisme en particulier.
// railsbox en gère trois par convention, et offre `auto_login_code` pour tout
// le reste ; ce qui manquait, c'est de DIRE lequel a été reconnu, et d'avertir
// quand aucun ne l'est. Ajouter un quatrième mécanisme sans ce garde-fou
// n'aurait fait que déplacer le silence d'un cran.

/**
 * Mécanismes reconnus, du plus spécifique au plus général.
 *
 * L'ordre compte : une application Devise porte AUSSI une session Rack, et
 * c'est Warden qui décide de `current_user`. Une application Rails 8 porte une
 * session Rack qui ne sert pas à l'authentification.
 */
export const MECANISMES = Object.freeze({
  WARDEN: "warden",
  SESSION_COOKIE: "session-cookie",
  SESSION_RACK: "session-rack",
  JETON: "jeton",
  INCONNU: "inconnu",
});

/**
 * Ce que railsbox sait ouvrir sans code fourni par le mainteneur.
 * @type {readonly string[]}
 */
export const MECANISMES_COUVERTS = Object.freeze([
  MECANISMES.WARDEN,
  MECANISMES.SESSION_COOKIE,
  MECANISMES.SESSION_RACK,
]);

/** Libellé affiché dans le rapport, par mécanisme. */
export const LIBELLES = Object.freeze({
  [MECANISMES.WARDEN]: "Warden (Devise)",
  [MECANISMES.SESSION_COOKIE]: "session en base + cookie signé (générateur Rails 8)",
  [MECANISMES.SESSION_RACK]: "session Rack (session[:user_id])",
  [MECANISMES.JETON]: "jeton (JWT) — non couvert",
  [MECANISMES.INCONNU]: "non reconnu",
});

/** Gems qui installent Warden, donc le mécanisme que railsbox sait piloter. */
const GEMS_WARDEN = Object.freeze(["devise", "warden"]);

/** Gems d'authentification par jeton : explicitement hors du champ du cookie. */
const GEMS_JETON = Object.freeze(["devise-jwt", "knock", "jwt_sessions", "doorkeeper"]);

/**
 * Signature de l'authentification intégrée de Rails 8 : le cookie signé qui
 * porte l'identifiant d'un enregistrement de session. C'est cette LECTURE qui
 * caractérise le mécanisme, pas le nom du modèle — un modèle « Session » métier
 * (une séance, un cours) ne la contient jamais.
 */
const LECTURE_COOKIE_SESSION = /cookies\s*\.\s*signed\s*\[\s*:session_id\s*\]/;

/**
 * Écriture d'un identifiant d'utilisateur dans la session Rack, sous ses formes
 * courantes. `session[:user_id] = …`, `session[:current_user_id] = …`.
 */
const ECRITURE_SESSION_RACK = /session\s*\[\s*:\s*\w*user\w*_id\s*\]\s*=/i;

/**
 * Déduit le mécanisme d'authentification de l'application.
 *
 * Volontairement conservateur : en cas de doute il rend `inconnu`, ce qui
 * produit un avertissement, jamais un refus. Se tromper de mécanisme coûterait
 * plus cher que d'avouer ne pas savoir.
 * @param {{gems?: readonly string[], sources?: string, modeles?: readonly string[]}} entree gems du lock, sources d'authentification concaténées, noms de modèles
 * @returns {string} une valeur de MECANISMES
 */
export function detectMecanismeAuth(entree = {}) {
  const gems = (entree.gems ?? []).map((nom) => String(nom).toLowerCase());
  const sources = String(entree.sources ?? "");
  const modeles = (entree.modeles ?? []).map((nom) => String(nom).toLowerCase());

  if (gems.some((nom) => GEMS_WARDEN.includes(nom))) return MECANISMES.WARDEN;
  if (modeles.includes("session") && LECTURE_COOKIE_SESSION.test(sources)) {
    return MECANISMES.SESSION_COOKIE;
  }
  if (ECRITURE_SESSION_RACK.test(sources)) return MECANISMES.SESSION_RACK;
  if (gems.some((nom) => GEMS_JETON.includes(nom))) return MECANISMES.JETON;
  return MECANISMES.INCONNU;
}

/**
 * Dit si railsbox sait ouvrir une session pour ce mécanisme.
 * @param {string} mecanisme valeur rendue par detectMecanismeAuth
 * @returns {boolean} vrai si l'auto-connexion par convention fonctionnera
 */
export function mecanismeCouvert(mecanisme) {
  return MECANISMES_COUVERTS.includes(mecanisme);
}

/**
 * Message de l'avertissement émis quand `auto_login` est déclaré et qu'aucun
 * mécanisme connu n'a été reconnu.
 *
 * Il doit dire les trois choses qui manquaient cette nuit-là : ce que railsbox
 * a cherché, pourquoi l'échec serait SILENCIEUX, et la sortie de secours.
 * @param {string} mecanisme mécanisme détecté
 * @returns {string} message du diagnostic
 */
export function messageMecanismeInconnu(mecanisme) {
  const constat =
    mecanisme === MECANISMES.JETON
      ? "l'application s'authentifie par JETON"
      : "aucun mécanisme d'authentification connu n'a été reconnu";
  return (
    `auto_login est déclaré, mais ${constat}. railsbox sait ouvrir une session ` +
    "pour Warden (Devise), pour une session Rack (session[:user_id]) et pour la session " +
    "en base à cookie signé du générateur Rails 8. En dehors de ces trois cas, " +
    "l'auto-connexion s'exécutera, trouvera l'utilisateur, écrira une session que " +
    "l'application ne lira pas — et le visiteur arrivera DÉCONNECTÉ sans qu'aucune " +
    "erreur ne soit levée : ni construction rouge, ni ligne dans le journal. C'est " +
    "précisément ce silence qui coûte cher."
  );
}
