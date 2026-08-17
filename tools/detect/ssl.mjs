// Lecture de `config.force_ssl` et `config.assume_ssl` dans l'environnement de
// production.
//
// Pourquoi ce module existe. `config.force_ssl = true` est le défaut d'un
// `rails new` depuis Rails 7 : il est présent dans l'écrasante majorité des
// applications que railsbox vise. Or la sandbox sert l'application en clair
// derrière le pont série. Le proxy annonce déjà `x-forwarded-proto: https`
// (sw-proxy.js) et railsbox neutralise `force_ssl` dans le guest
// (tools/build-v86-image/force-ssl.mjs) : le réglage n'est donc PAS bloquant.
// Il reste à le NOMMER, parce qu'une application qui redirige en boucle est
// l'une des pannes les plus opaques à diagnostiquer depuis un navigateur, et
// que le mainteneur doit savoir ce que railsbox a fait de son réglage.
//
// Le piège à éviter est le faux positif : la forme conditionnelle
// (`config.force_ssl = ENV["FORCE_SSL"].present?`) est répandue, et signaler
// une application qui a DÉJÀ le bon comportement décrédibilise le rapport. On
// n'annonce donc « actif » que si l'expression est vraie variable ABSENTE.

/** Réglages SSL reconnus, dans l'ordre où on les cherche. */
const SETTINGS = Object.freeze(["force_ssl", "assume_ssl"]);

/**
 * Variable d'environnement qui désarme la neutralisation de `force_ssl`.
 * Déclarée ici parce que la détection doit savoir la reconnaître dans le bloc
 * `env:` de railsbox.yml, et le générateur d'initialiseur doit l'écrire.
 */
export const KEEP_FORCE_SSL_VARIABLE = "RAILSBOX_KEEP_FORCE_SSL";

/** Valeur qui active le désarmement. */
export const KEEP_FORCE_SSL_VALUE = "1";

/**
 * @typedef {object} SslSetting
 * @property {"actif"|"inactif"|"conditionnel-actif"|"conditionnel-inactif"|"inconnu"} state état déduit
 * @property {string|null} env variable d'environnement qui le pilote, le cas échéant
 * @property {string} expression membre droit de l'affectation, tel qu'écrit
 * @property {number} line numéro de ligne dans le fichier
 */

/**
 * Retire le commentaire d'une ligne Ruby, en respectant les chaînes.
 * @param {string} line ligne brute
 * @returns {string} ligne sans commentaire
 */
function stripComment(line) {
  let quote = null;
  for (let index = 0; index < line.length; index += 1) {
    const char = line[index];
    if (quote) {
      if (char === "\\") index += 1;
      else if (char === quote) quote = null;
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      continue;
    }
    if (char === "#") return line.slice(0, index);
  }
  return line;
}

/** `ENV.fetch("NOM", "défaut")` ou `ENV.fetch("NOM", défaut)`. */
const ENV_FETCH =
  /ENV\.fetch\(\s*["']([A-Za-z_][A-Za-z0-9_]*)["']\s*,\s*(?:["']([^"']*)["']|(\w+))\s*\)/;
/** `ENV.fetch("NOM") { "défaut" }`. */
const ENV_FETCH_BLOCK =
  /ENV\.fetch\(\s*["']([A-Za-z_][A-Za-z0-9_]*)["']\s*\)\s*\{\s*["']?([^"'}]*)["']?\s*\}/;
/** `ENV["NOM"]`, sans valeur par défaut : vaut `nil` quand la variable manque. */
const ENV_INDEX = /ENV\[\s*["']([A-Za-z_][A-Za-z0-9_]*)["']\s*\]/;
/** Comparaison finale : `… == "true"` ou `… != "false"`. */
const COMPARISON = /(==|!=)\s*["']([^"']*)["']\s*$/;

/**
 * Évalue une expression Ruby de configuration comme si la variable
 * d'environnement qu'elle interroge était ABSENTE.
 *
 * On ne couvre que les formes réellement rencontrées dans les
 * `config/environments/production.rb` : tout le reste rend « inconnu », et un
 * inconnu ne déclenche aucun diagnostic.
 * @param {string} expression membre droit de l'affectation
 * @returns {{state: SslSetting["state"], env: string|null}} état déduit
 */
export function evaluateSslExpression(expression) {
  const text = String(expression).trim().replace(/\s+/g, " ");
  if (text === "true") return { state: "actif", env: null };
  if (text === "false") return { state: "inactif", env: null };

  const fetch = ENV_FETCH.exec(text) ?? ENV_FETCH_BLOCK.exec(text);
  const index = ENV_INDEX.exec(text);
  const name = fetch?.[1] ?? index?.[1] ?? null;
  if (!name) return { state: "inconnu", env: null };

  // Valeur vue par Ruby quand la variable manque : le défaut du `fetch`, ou
  // `nil` pour un simple `ENV[…]`.
  const fallback = fetch ? (fetch[2] ?? fetch[3] ?? "") : null;

  const comparison = COMPARISON.exec(text);
  if (comparison) {
    const equal = fallback !== null && fallback === comparison[2];
    const truthy = comparison[1] === "==" ? equal : !equal;
    return { state: truthy ? "conditionnel-actif" : "conditionnel-inactif", env: name };
  }
  if (/\.present\?\s*$/.test(text)) {
    const truthy = fallback !== null && fallback !== "";
    return { state: truthy ? "conditionnel-actif" : "conditionnel-inactif", env: name };
  }
  if (fetch && (fallback === "true" || fallback === "false")) {
    return {
      state: fallback === "true" ? "conditionnel-actif" : "conditionnel-inactif",
      env: name,
    };
  }
  // `ENV["X"]` nu : `nil` est faux, donc SSL désactivé sans la variable.
  if (!fetch && /^!?\s*ENV\[/.test(text)) {
    const negated = text.startsWith("!");
    return { state: negated ? "conditionnel-actif" : "conditionnel-inactif", env: name };
  }
  return { state: "inconnu", env: name };
}

/**
 * Relève les réglages SSL déclarés dans un environnement Rails.
 *
 * La DERNIÈRE affectation gagne, comme en Ruby : un fichier qui pose
 * `config.force_ssl = true` puis le corrige plus bas termine à la seconde
 * valeur.
 * @param {string|null|undefined} text contenu de config/environments/production.rb
 * @returns {{force_ssl: SslSetting|null, assume_ssl: SslSetting|null}} réglages relevés
 */
export function detectSslSettings(text) {
  /** @type {{force_ssl: SslSetting|null, assume_ssl: SslSetting|null}} */
  const result = { force_ssl: null, assume_ssl: null };
  if (typeof text !== "string") return result;
  const lines = text.split(/\r?\n/);
  for (let index = 0; index < lines.length; index += 1) {
    const line = stripComment(lines[index]);
    for (const setting of SETTINGS) {
      const pattern = new RegExp(`(?:^|[\\s.])config\\.${setting}\\s*=\\s*(.+)$`);
      const match = pattern.exec(line);
      if (!match) continue;
      const expression = match[1].trim();
      const { state, env } = evaluateSslExpression(expression);
      result[setting] = { state, env, expression, line: index + 1 };
    }
  }
  return result;
}

/**
 * Indique si un réglage force la couche TLS dans la sandbox.
 * @param {SslSetting|null} setting réglage relevé
 * @returns {boolean} vrai si l'application redirigerait en https
 */
export function isSslEnforced(setting) {
  if (!setting) return false;
  return setting.state === "actif" || setting.state === "conditionnel-actif";
}
