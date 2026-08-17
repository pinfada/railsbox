// Disponibilité du pilote sqlite3 DANS LA VM.
//
// Le piège que ce module ferme. app.Dockerfile installe le bundle avec
// `BUNDLE_WITHOUT="development:test"`. Une application déployée sur PostgreSQL
// range presque toujours `gem "sqlite3"` dans `group :development` — elle ne
// s'en sert qu'en local. Le Gemfile.lock, lui, la mentionne quand même : la
// détection croyait donc le pilote disponible, la clé `database: sqlite3` de
// railsbox.yml paraissait acceptée, et l'application échouait dans la VM sur un
// `LoadError` que rien n'annonçait.
//
// Le verdict dépend de la base FINALEMENT retenue, donc de railsbox.yml : il
// est réévalué après la fusion des manifestes, d'où la séparation entre l'état
// (lu une fois dans le Gemfile) et les diagnostics (émis à chaque évaluation).

import { SEVERITY, createFinding } from "./findings.mjs";
import { isInProductionBundle, parseGemfileGroups } from "./gems.mjs";

/** @typedef {import("./findings.mjs").Finding} Finding */

/**
 * @typedef {object} SqliteDriverState
 * @property {boolean} declared la gem est déclarée dans le Gemfile
 * @property {boolean|null} available présence dans le bundle de la VM, `null` si indécidable
 * @property {readonly string[]} groups groupes Bundler déclarés
 */

/**
 * Relève la disponibilité du pilote sqlite3 dans le bundle de la VM.
 *
 * Le Gemfile est la seule source qui porte les GROUPES ; le Gemfile.lock ne
 * dit que « la gem est résolue », ce qui ne présage pas de son installation.
 * @param {string|null|undefined} gemfileText contenu du Gemfile
 * @param {Map<string, string>} specs gems résolues du Gemfile.lock
 * @param {boolean} hasLock vrai si le Gemfile.lock existe
 * @returns {SqliteDriverState} état gelé
 */
export function sqliteDriverState(gemfileText, specs, hasLock) {
  const groups = parseGemfileGroups(gemfileText);
  if (groups.has("sqlite3")) {
    return Object.freeze({
      declared: true,
      available: isInProductionBundle(groups, "sqlite3"),
      groups: Object.freeze([...groups.get("sqlite3")]),
    });
  }
  // Sans Gemfile.lock, une absence n'est pas une preuve (missing-gemfile-lock
  // le dit déjà) : on ne tranche pas.
  const available = hasLock ? specs.has("sqlite3") : null;
  return Object.freeze({ declared: false, available, groups: Object.freeze([]) });
}

/**
 * Explique pourquoi la gem ne sera pas installée.
 * @param {SqliteDriverState} state état du pilote
 * @returns {string} phrase française
 */
function reason(state) {
  if (!state.declared) return "elle est absente du Gemfile.lock";
  const pluriel = state.groups.length > 1 ? "s" : "";
  return (
    `elle est confinée au${pluriel} groupe${pluriel} ${state.groups.join(", ")}, ` +
    "que le bundle de la VM exclut (BUNDLE_WITHOUT=development:test)"
  );
}

/**
 * Diagnostics tirés de l'état du pilote pour une base retenue donnée.
 * @param {{state: SqliteDriverState, database: string|null|undefined, adapters?: readonly string[]}} input contexte
 * @returns {Finding[]} diagnostics
 */
export function sqliteDriverFindings({ state, database, adapters = [] }) {
  if (!state || state.available !== false) return [];
  if (database === "sqlite3") {
    // Deux situations très différentes, deux sévérités.
    //
    // Gem DÉCLARÉE mais confinée au développement : le verdict est certain, et
    // la panne (LoadError au premier accès à la base) tomberait au boot chez le
    // visiteur. On refuse — une seconde ici, contre la construction entière.
    //
    // Gem ABSENTE du Gemfile : sqlite3 peut n'avoir été retenu que par défaut,
    // faute de config/database.yml exploitable. Refuser sur une supposition
    // rejetterait des applications qui marchent ; on avertit, exactement comme
    // pour la gem pg (missing-pg-gem).
    if (!state.declared) {
      return [
        createFinding(
          SEVERITY.WARNING,
          "missing-sqlite3-gem",
          "SQLite est retenu mais la gem « sqlite3 » est absente du Gemfile.lock.",
        ),
      ];
    }
    return [
      createFinding(
        SEVERITY.BLOCKING,
        "sqlite3-gem-missing-in-production",
        `La base retenue est sqlite3, mais la gem « sqlite3 » ne sera pas installée : ${reason(state)}.`,
        { groups: state.groups },
      ),
    ];
  }
  // Rien n'est cassé — l'application ne demande pas sqlite3 — mais le repli
  // est indisponible. Le dire évite qu'un mainteneur tente « database: sqlite3 »
  // et découvre le refus une construction plus tard.
  if (!state.declared || !adapters.includes("sqlite3")) return [];
  return [
    createFinding(
      SEVERITY.INFO,
      "sqlite3-fallback-unavailable",
      "config/database.yml mentionne sqlite3, mais la gem « sqlite3 » ne sera pas installée : " +
        `${reason(state)}. « database: sqlite3 » dans railsbox.yml serait donc refusé.`,
      { groups: state.groups },
    ),
  ];
}
