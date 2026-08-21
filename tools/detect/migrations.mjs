// Reconnaissance des migrations PORTEUSES DE DONNÉES : celles qui, en plus de
// modifier le schéma, écrivent des lignes (devises, rôles, catégories, pays,
// réglages).
//
// Pourquoi ce module existe : railsbox prépare la base d'une application en
// CHARGEANT SON SCHÉMA VERSIONNÉ. Sur une base vierge — le cas de toute
// construction — `db:schema:load` pose la STRUCTURE puis marque les migrations
// correspondantes comme appliquées, sans en jouer une seule. Un INSERT écrit
// dans une migration n'est donc jamais exécuté, la table de référence reste
// vide, et la panne n'éclate que bien plus loin — dans les seeds, sous la forme
// d'une validation absurde (« attendu : » suivi du vide).
//
// Le constat ne tient pas au NOM de la tâche : il tient au chargement d'un
// schéma, quelle que soit la commande qui le déclenche.
//
// Module PUR : il reçoit des textes, il rend des noms de fichiers et des
// raisons. La lecture du disque appartient à detect.mjs.
import { SEVERITY, createFinding } from "./findings.mjs";

/** @typedef {import("./findings.mjs").Finding} Finding */

/**
 * Une migration reconnue comme porteuse de données.
 * @typedef {object} DataMigration
 * @property {string} file nom du fichier, tel qu'il apparaît dans db/migrate
 * @property {readonly string[]} reasons raisons françaises, dans l'ordre des règles
 */

/** Nombre de fichiers nommés dans le message avant de résumer par un compte. */
const MAX_NAMED_FILES = 3;

/**
 * `INSERT INTO …` dans une chaîne SQL. Le mot-clé est cherché tel quel : un
 * identifiant comme `index_inserts_on_id` ne le contient pas isolément.
 */
const SQL_INSERT = /\bINSERT\s+INTO\b/i;

/**
 * `UPDATE <table> SET …`. Le `SET` est EXIGÉ : sans lui, `updated_at`,
 * `index_updates_on_x` ou un simple commentaire suffiraient à déclencher un
 * faux positif. La distance est bornée pour ne pas apparier un `UPDATE` d'une
 * requête avec le `SET` d'une autre, plusieurs dizaines de lignes plus bas.
 */
const SQL_UPDATE = /\bUPDATE\b[\s\S]{1,200}?\bSET\b/i;

/** Appel à `execute` (méthode de migration ou de la connexion). */
const EXECUTE_CALL = /(?:^|[^\w.])execute\b|\.execute\b/;

/**
 * Écriture par un modèle : `Currency.create!`, `Role.find_or_create_by`,
 * `Setting.insert_all`. Le récepteur doit être une CONSTANTE (donc une classe),
 * ce qui écarte `t.create…`, et le lookahead écarte `create_table` /
 * `create_join_table`, qui sont du DDL et non de la donnée.
 */
const MODEL_WRITE =
  /\b[A-Z][A-Za-z0-9_]*(?:::[A-Z][A-Za-z0-9_]*)*\s*\.\s*(create|create_or_find_by|find_or_create_by|first_or_create|insert_all|upsert_all)(?![A-Za-z0-9_])!?/;

/**
 * Retire les commentaires Ruby d'un source, en laissant intact ce qui vit dans
 * une chaîne (`"# 1"`) — un `#` entre guillemets n'ouvre pas un commentaire.
 *
 * LIMITE ASSUMÉE : le corps d'un heredoc est traité comme du code ordinaire.
 * C'est délibéré — c'est justement là que vit le SQL qu'on cherche — mais un
 * `#` dans ce corps tronque la ligne. Une clause `INSERT` placée après un `#`
 * de la même ligne d'un heredoc échapperait donc à la détection.
 * @param {string} source contenu Ruby
 * @returns {string} même source, commentaires ôtés
 */
export function stripRubyComments(source) {
  if (typeof source !== "string") return "";
  const out = [];
  for (const line of source.split("\n")) {
    let quote = null;
    let cut = -1;
    for (let index = 0; index < line.length; index += 1) {
      const char = line[index];
      if (char === "\\") {
        index += 1;
        continue;
      }
      if (quote) {
        if (char === quote) quote = null;
        continue;
      }
      if (char === '"' || char === "'") {
        quote = char;
        continue;
      }
      if (char === "#") {
        cut = index;
        break;
      }
    }
    out.push(cut === -1 ? line : line.slice(0, cut));
  }
  return out.join("\n");
}

/**
 * Dit si un source de migration écrit des lignes, et pourquoi.
 * @param {string} source contenu Ruby de la migration
 * @returns {string[]} raisons françaises, vide si la migration est du pur DDL
 */
export function dataWriteReasons(source) {
  const code = stripRubyComments(source);
  const reasons = [];
  if (EXECUTE_CALL.test(code)) {
    if (SQL_INSERT.test(code)) reasons.push("execute d'un INSERT SQL");
    if (SQL_UPDATE.test(code)) reasons.push("execute d'un UPDATE SQL");
  }
  const write = MODEL_WRITE.exec(code);
  if (write) reasons.push(`appel à ${write[1]}${write[0].endsWith("!") ? "!" : ""} sur un modèle`);
  return reasons;
}

/**
 * Balaye les migrations d'une application et retient celles qui écrivent.
 * @param {readonly {name: string, text: string}[]} files migrations lues
 * @returns {DataMigration[]} migrations porteuses de données, dans l'ordre reçu
 */
export function scanDataMigrations(files) {
  if (!Array.isArray(files)) return [];
  const found = [];
  for (const file of files) {
    if (!file || typeof file.name !== "string" || typeof file.text !== "string") continue;
    const reasons = dataWriteReasons(file.text);
    if (reasons.length > 0) found.push({ file: file.name, reasons: Object.freeze(reasons) });
  }
  return found;
}

/**
 * Nomme les migrations concernées, sans laisser un message s'étirer sur
 * cinquante fichiers.
 * @param {readonly DataMigration[]} migrations migrations porteuses de données
 * @returns {string} énumération française
 */
function nameFiles(migrations) {
  const names = migrations.map((entry) => `db/migrate/${entry.file}`);
  if (names.length <= MAX_NAMED_FILES) return names.join(", ");
  const reste = names.length - MAX_NAMED_FILES;
  return `${names.slice(0, MAX_NAMED_FILES).join(", ")} (et ${reste} autre${reste > 1 ? "s" : ""})`;
}

/**
 * Produit l'avertissement des migrations porteuses de données.
 *
 * AVERTISSEMENT, et railsbox ne répare RIEN : contrairement à `force_ssl` — une
 * contrainte que la sandbox impose et qu'elle doit donc lever elle-même — ceci
 * est un défaut que l'application porte déjà. `db/schema.rb` ne contient que la
 * structure : toute base recréée depuis le schéma (un `rails db:setup` sur un
 * poste neuf, une base de CI, une review app) obtient la même table vide.
 * railsbox n'a pas créé la panne, il la révèle, parce qu'il part toujours d'une
 * base vierge. Basculer en douce sur `db:migrate` masquerait le défaut, ferait
 * rejouer tout l'historique à chaque construction, et laisserait le mainteneur
 * repartir avec une application cassée partout ailleurs.
 *
 * Ce que railsbox doit, c'est le DIAGNOSTIC qui manquait : nommer les fichiers,
 * expliquer le mécanisme, et rappeler ce que Rails recommande.
 * @param {readonly DataMigration[]} migrations migrations porteuses de données
 * @returns {Finding[]} diagnostics, vide si aucune migration n'écrit
 */
export function dataMigrationFindings(migrations) {
  if (!Array.isArray(migrations) || migrations.length === 0) return [];
  const raisons = [...new Set(migrations.flatMap((entry) => entry.reasons))].join(", ");
  return [
    createFinding(
      SEVERITY.WARNING,
      "data-bearing-migration",
      `${migrations.length} migration${migrations.length > 1 ? "s écrivent" : " écrit"} des ` +
        `données (${raisons}) : ${nameFiles(migrations)}. railsbox prépare la base avec ` +
        "le chargement du schéma versionné, qui sur une base VIERGE pose db/schema.rb — la structure, " +
        "pas les données — et marque toutes les migrations comme appliquées sans en jouer " +
        "aucune : ces lignes ne seront jamais insérées, et une validation qui s'y réfère " +
        "échouera plus loin, dans les seeds, sur une table de référence vide.",
      { files: migrations.map((entry) => entry.file) },
    ),
  ];
}
