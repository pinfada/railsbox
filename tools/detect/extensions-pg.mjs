// Quelles extensions PostgreSQL une application exige, et la base les a-t-elle ?
//
// LE DÉFAUT QUE CE MODULE FERME. Sur woofed-crm, deuxième application tierce
// candidate, une migration appelle `enable_extension 'vector'`. La base ne
// fournit pas pgvector : la construction échouait après QUATRE MINUTES sur
// « extension "vector" is not available », un message qui ne nomme aucun
// remède. Deux `grep` sur `db/migrate` donnent la réponse en deux secondes.
//
// C'est exactement la doctrine de docs/chantiers.md : « Quand un code d'échec
// aval peut devenir un refus amont, c'est ce qu'il faut faire : un remède lu en
// dix secondes vaut mieux que le même remède lu après neuf minutes. »
//
// Ce module est pur : il ne lit aucun fichier, il extrait et il compare.
import { BASE_REVISIONS } from "../build-v86-image/split-config.mjs";

/**
 * Extensions que la base fournit, et révision qui a INTRODUIT chacune.
 *
 * RELEVÉ, PAS SUPPOSÉ : `SELECT name FROM pg_available_extensions` exécuté le
 * 21/08/2026 dans ghcr.io/pinfada/railsbox-base:3.3-r2. Ce sont les modules
 * contrib livrés avec PostgreSQL 15 de Debian bookworm.
 *
 * `vector` fait exception : pgvector n'existe dans AUCUNE suite Debian
 * (bookworm, backports, trixie tous vérifiés), et une extension de SERVEUR ne
 * peut pas passer par la surcouche de l'ADR 0006 — PostgreSQL 15 cherche son
 * fichier de contrôle dans le `sharedir` compilé en dur, et
 * `extension_control_path` n'arrive qu'en PostgreSQL 18. Elle est donc compilée
 * depuis les sources dans la base, à partir de la révision 3.3-r3.
 */
export const BASE_PG_EXTENSIONS = Object.freeze(
  Object.fromEntries([
    ...[
      "adminpack",
      "amcheck",
      "autoinc",
      "bloom",
      "btree_gin",
      "btree_gist",
      "citext",
      "cube",
      "dblink",
      "dict_int",
      "dict_xsyn",
      "earthdistance",
      "file_fdw",
      "fuzzystrmatch",
      "hstore",
      "insert_username",
      "intagg",
      "intarray",
      "isn",
      "lo",
      "ltree",
      "moddatetime",
      "old_snapshot",
      "pageinspect",
      "pg_buffercache",
      "pg_freespacemap",
      "pg_prewarm",
      "pg_stat_statements",
      "pg_surgery",
      "pg_trgm",
      "pg_visibility",
      "pg_walinspect",
      "pgcrypto",
      "pgrowlocks",
      "pgstattuple",
      "plpgsql",
      "postgres_fdw",
      "refint",
      "seg",
      "sslinfo",
      "tablefunc",
      "tcn",
      "tsm_system_rows",
      "tsm_system_time",
      "unaccent",
      "uuid-ossp",
      "xml2",
    ].map((nom) => [nom, "3.3"]),
    ["vector", "3.3-r3"],
  ]),
);

/**
 * Appels qui EXIGENT une extension. Deux écritures coexistent : la migration
 * Rails et le SQL d'un `structure.sql`. Les deux ancrées en début de ligne
 * (espaces admis) pour qu'une mention en commentaire — `# enable_extension` —
 * ou dans une chaîne ne compte pas : ce module refuse une construction, il n'a
 * pas le droit de se tromper sur une occurrence décorative.
 */
const APPELS = Object.freeze([
  /^[ \t]*enable_extension[ \t(]+["']([A-Za-z0-9_-]+)["']/gm,
  /^[ \t]*CREATE[ \t]+EXTENSION[ \t]+(?:IF[ \t]+NOT[ \t]+EXISTS[ \t]+)?["']?([A-Za-z0-9_-]+)["']?/gim,
]);

/**
 * Extensions exigées par un ensemble de fichiers (migrations, schéma).
 * @param {readonly {name?: string, text?: string}[]} fichiers fichiers lus
 * @returns {string[]} noms triés, sans doublon
 */
export function extensionsRequises(fichiers) {
  const trouvees = new Set();
  for (const fichier of Array.isArray(fichiers) ? fichiers : []) {
    const texte = typeof fichier?.text === "string" ? fichier.text : "";
    for (const motif of APPELS) {
      motif.lastIndex = 0;
      for (const [, nom] of texte.matchAll(motif)) trouvees.add(nom);
    }
  }
  return [...trouvees].sort();
}

/**
 * Extensions qu'une révision de base donnée NE fournit pas.
 *
 * Une extension inconnue de la table est déclarée MANQUANTE, jamais supposée
 * présente : c'est la direction sûre. Un refus amont se lit en dix secondes ;
 * un échec de migration se paie en minutes et ne nomme pas le remède.
 * @param {readonly string[]} requises extensions exigées par l'application
 * @param {string} [revision] révision de base épinglée
 * @returns {string[]} extensions manquantes, triées
 */
export function extensionsManquantes(requises, revision) {
  const rang = BASE_REVISIONS.indexOf(revision ?? "");
  const effectif = rang === -1 ? BASE_REVISIONS.length - 1 : rang;
  return [...(Array.isArray(requises) ? requises : [])]
    .filter((nom) => {
      const introduite = BASE_PG_EXTENSIONS[nom];
      if (introduite === undefined) return true;
      return BASE_REVISIONS.indexOf(introduite) > effectif;
    })
    .sort();
}
