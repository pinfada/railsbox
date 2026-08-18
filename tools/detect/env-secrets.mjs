// Le bloc `env:` de railsbox.yml est PUBLIÉ. C'est le fait que ce module
// existe pour rappeler.
//
// Ces variables sont écrites verbatim dans `/app/.railsbox/app-env.sh` par
// `tools/build-v86-image/base/app.Dockerfile`, donc à l'intérieur du disque
// applicatif — un artefact que le navigateur de chaque visiteur télécharge, et
// qu'un curieux monte hors ligne avec un `mount -o loop`. Le `chmod 600` posé
// dessus ne protège rien : le visiteur est root dans sa propre VM, et le
// fichier `.ext2` se lit de toute façon sans la traverser. SECURITY.md le dit
// sans détour — « il n'y a pas de serveur à protéger », tout ce qui est
// embarqué est lisible par quiconque visite la sandbox.
//
// Un `RAILS_MASTER_KEY` ou un jeton d'API réel déclaré là n'est donc pas
// « configuré » : il est PUBLIÉ, définitivement, dans un artefact que
// railsbox pousse lui-même sur GitHub Pages. La détection refuse la
// construction avant qu'elle ait lieu, plutôt que d'imposer une rotation de
// clé après coup.
//
// Deux signaux, volontairement grossiers :
//   · le NOM annonce un secret (`…SECRET…`, `…TOKEN…`, `…MASTER_KEY…`) ;
//   · la VALEUR porte le préfixe d'un jeton connu, quel que soit le nom.
//
// Aucun des deux ne prouve quoi que ce soit — une démonstration porte
// légitimement un faux `DEMO_TOKEN`. D'où la dérogation `env_assume_public:`,
// qui NOMME chaque clé assumée publique. Nommer est le point : une dérogation
// globale reviendrait à supprimer le contrôle, et personne ne relit un contrôle
// supprimé.
import { SEVERITY, createFinding } from "./findings.mjs";

/** @typedef {import("./findings.mjs").Finding} Finding */

/**
 * Fragments de noms qui annoncent un secret. Comparés en MAJUSCULES et en
 * sous-chaîne : `RAILS_MASTER_KEY`, `mon_secret_a_moi` et `Token` matchent
 * tous les trois. La liste est délibérément courte — elle vise ce qu'un
 * développeur Rails écrit spontanément, pas l'exhaustivité.
 */
export const ENV_SECRET_NAME_HINTS = Object.freeze([
  "MASTER_KEY",
  "SECRET",
  "PASSWORD",
  "TOKEN",
  "API_KEY",
  "PRIVATE_KEY",
  "CREDENTIALS",
  "ACCESS_KEY",
  // Trouvés en mangeant notre propre nourriture : la première application
  // privée passée au détecteur portait MEDICAL_DATA_ENCRYPTION_KEY, et aucun
  // motif ne la voyait. Une clé de chiffrement ou de signature est un secret
  // par définition ; « KEY » seul serait trop large (PUBLIC_KEY, KEYBOARD).
  "ENCRYPTION_KEY",
  "SIGNING_KEY",
]);

/**
 * Préfixes de jetons émis par des services répandus, reconnaissables à l'œil
 * nu et donc reconnaissables ici. Le dépôt n'a pas de règles gitleaks propres
 * (`.gitleaks.toml` ne porte qu'une allowlist et s'en remet aux règles par
 * défaut de l'outil) : cette liste est écrite à la main, et son rôle n'est pas
 * de tout attraper mais d'attraper ce qu'un copier-coller de `.env` amène.
 *
 * Chaque motif est ancré : une valeur qui CONTIENT « sk- » quelque part n'est
 * pas un jeton, une valeur qui COMMENCE par « sk- » suivi de vingt caractères
 * en est un jusqu'à preuve du contraire.
 */
const TOKEN_VALUE_PATTERNS = Object.freeze([
  // GitHub : jetons classiques (ghp_, gho_, ghu_, ghs_, ghr_) et fine-grained.
  /^gh[pousr]_[A-Za-z0-9]{20,}$/,
  /^github_pat_[A-Za-z0-9_]{20,}$/,
  // Stripe, clés secrètes et restreintes, live comme test.
  /^[sr]k_(live|test)_[A-Za-z0-9]{10,}$/,
  // OpenAI et compatibles.
  /^sk-[A-Za-z0-9_-]{20,}$/,
  // AWS : identifiants de clé d'accès, permanents et temporaires.
  /^(AKIA|ASIA)[0-9A-Z]{16}$/,
  // Slack : jetons de bot, d'application, d'utilisateur.
  /^xox[abprs]-[A-Za-z0-9-]{10,}$/,
  // GitLab : jetons d'accès personnels.
  /^glpat-[A-Za-z0-9_-]{15,}$/,
  // Google : clés d'API.
  /^AIza[A-Za-z0-9_-]{30,}$/,
  // Clé privée au format PEM, collée telle quelle dans le YAML.
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
]);

/**
 * Le nom de cette variable annonce-t-il un secret ?
 * @param {string} name nom de la variable
 * @returns {string|null} fragment reconnu, ou `null`
 */
export function secretNameHint(name) {
  const majuscules = String(name).toUpperCase();
  return ENV_SECRET_NAME_HINTS.find((indice) => majuscules.includes(indice)) ?? null;
}

/**
 * La valeur porte-t-elle le préfixe d'un jeton connu ?
 * @param {unknown} value valeur déclarée
 * @returns {boolean} vrai si la valeur ressemble à un jeton émis
 */
export function looksLikeSecretValue(value) {
  const texte = typeof value === "string" ? value.trim() : "";
  if (texte === "") return false;
  return TOKEN_VALUE_PATTERNS.some((motif) => motif.test(texte));
}

/**
 * Diagnostics BLOQUANTS pour les variables du bloc `env:` qui ressemblent à
 * des secrets et ne sont pas explicitement assumées publiques.
 *
 * Bloquant et non avertissement : un avertissement se lit après coup, dans un
 * journal de CI, quand l'artefact est déjà publié et la clé déjà à faire
 * tourner. Le seul moment où le diagnostic sert est AVANT la construction.
 *
 * La valeur suspecte n'est JAMAIS recopiée dans le message : le rapport part
 * dans les journaux de CI, publics eux aussi sur un dépôt public.
 * @param {{ env?: Record<string, unknown>|null, assumePublic?: readonly string[]|null }} entree
 * @returns {readonly Finding[]} un diagnostic par clé suspecte, dans l'ordre de déclaration
 */
export function envSecretFindings({ env, assumePublic } = {}) {
  if (!env || typeof env !== "object") return Object.freeze([]);
  // La dérogation NOMME ses clés : comparaison exacte, aucun joker.
  const assumees = new Set(Array.isArray(assumePublic) ? assumePublic : []);
  /** @type {Finding[]} */
  const findings = [];
  for (const [key, value] of Object.entries(env)) {
    if (assumees.has(key)) continue;
    const indice = secretNameHint(key);
    const motif = indice !== null ? `son nom contient « ${indice} »` : null;
    const raison =
      motif ??
      (looksLikeSecretValue(value)
        ? "sa valeur a la forme d'un jeton émis par un service connu"
        : null);
    if (raison === null) continue;
    findings.push(
      createFinding(
        SEVERITY.BLOCKING,
        "env-secret-published",
        `La variable « ${key} » du bloc env: ressemble à un secret (${raison}). Le bloc env: ` +
          "est écrit tel quel dans le disque applicatif, que le navigateur de chaque visiteur " +
          "télécharge : la déclarer ici, c'est la publier.",
        { key, reason: indice !== null ? "name" : "value", hint: indice ?? undefined },
      ),
    );
  }
  return Object.freeze(findings);
}
