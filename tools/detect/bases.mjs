// Ce que chaque image de base PUBLIÉE fournit réellement comme Ruby.
//
// Pourquoi cette table existe. La base est mutualisée et immuable (ADR 0004) :
// son interpréteur Ruby est compilé une fois pour toutes à sa construction, et
// le disque applicatif ne peut pas en changer. La clé `ruby:` de railsbox.yml
// ne choisit donc PAS le Ruby du guest — elle ne sert qu'à désigner la série
// (donc la base) et l'image de l'étage amd64 de précompilation.
//
// Sans cette table, la détection connaissait la contrainte du Gemfile mais pas
// la version en face : le désaccord n'apparaissait qu'au `bundle install` de
// app.Dockerfile, plusieurs minutes après le début de la construction, sous la
// forme d'un `Bundler::RubyVersionMismatch`. Elle est ici pour que le refus
// tombe AVANT.
//
// Chaque entrée reflète le couple (`tag`, `ruby`) passé à publier-base.yml.
// Publier une nouvelle base sans l'ajouter ici ne casse rien : une base
// inconnue neutralise simplement la vérification (voir baseRubyVersion).

/** Ruby fourni par chaque version de base publiée sur GHCR. */
export const BASE_RUBY_VERSIONS = Object.freeze({
  3.3: "3.3.12",
  "3.3-r2": "3.3.12",
});

/** Version de base utilisée par défaut (défaut de construire-sandbox.yml). */
export const DEFAULT_BASE = "3.3-r2";

/**
 * Extrait la version de base d'une référence, quelle que soit sa forme.
 *
 * Trois écritures circulent dans le projet : l'entrée `base:` du workflow
 * (« 3.3-r2 »), la référence d'image complète que reçoit build-app-disk.sh
 * (« ghcr.io/pinfada/railsbox-base:3.3-r2 ») et le nom local de la voie
 * manuelle (« railsbox-base-3.3 »).
 * @param {string|null|undefined} reference référence de base
 * @returns {string|null} version de base, ou `null` si illisible
 */
export function parseBaseVersion(reference) {
  if (typeof reference !== "string") return null;
  const trimmed = reference.trim();
  if (trimmed === "") return null;
  // Le tag est ce qui suit le DERNIER « : », à condition qu'aucun « / » ne le
  // suive — sinon « registry:5000/image » prendrait le port pour un tag.
  const colon = trimmed.lastIndexOf(":");
  if (colon !== -1 && !trimmed.slice(colon + 1).includes("/")) {
    const tag = trimmed.slice(colon + 1).trim();
    return tag === "" ? null : tag;
  }
  const local = /(?:^|\/)railsbox-base-(.+)$/.exec(trimmed);
  if (local) return local[1];
  return trimmed;
}

/**
 * Ruby fourni par une version de base.
 * @param {string|null|undefined} baseVersion version de base (« 3.3-r2 »)
 * @returns {string|null} version de Ruby, ou `null` si la base est inconnue
 */
export function baseRubyVersion(baseVersion) {
  if (typeof baseVersion !== "string") return null;
  return BASE_RUBY_VERSIONS[baseVersion] ?? null;
}

/**
 * Résout une référence de base en couple (version, Ruby fourni).
 *
 * Une référence VIDE rend `{null, null}` et n'est pas remplacée par le défaut :
 * c'est la façon dont un appelant dit « je ne sais pas encore quelle base sera
 * utilisée » (build-app-disk.sh, tant que l'analyse n'a pas donné la série).
 * Supposer 3.3-r2 dans ce cas ferait refuser à tort une application d'une autre
 * série, ce qui est exactement le contraire du but.
 * @param {string|null|undefined} reference référence de base, sous n'importe quelle forme
 * @returns {{version: string|null, ruby: string|null}} version de base et Ruby du guest
 */
export function resolveBase(reference) {
  const version = parseBaseVersion(reference);
  return { version, ruby: baseRubyVersion(version) };
}
