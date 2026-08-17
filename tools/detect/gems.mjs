// Lecture du Gemfile.lock : c'est la seule source fiable de la liste réelle des
// gems résolues. Les extensions natives sont le principal facteur d'échec d'un
// build i386 (bibliothèques système manquantes), d'où la table explicite.
import { SEVERITY, createFinding } from "./findings.mjs";

/** @typedef {import("./findings.mjs").Finding} Finding */

/**
 * @typedef {object} NativeGem
 * @property {string} name nom de la gem
 * @property {readonly string[]} systemLibs bibliothèques système requises
 */

/**
 * Gems réclamant une bibliothèque (ou un exécutable) système, et ce qu'elles
 * réclament. Table volontairement fixe : une détection heuristique produirait
 * des faux positifs, et l'image de base ne peut embarquer qu'un jeu de libs
 * maîtrisé.
 *
 * « Native » est ici à prendre au sens large : la table recense aussi des gems
 * en Ruby pur dont la dépendance système est réelle mais différée. `ruby-vips`
 * est une liaison FFI — elle ne compile rien, elle `dlopen` libvips au premier
 * appel, et son absence ne se voit qu'à l'exécution, dans le navigateur.
 * `mini_magick` se contente d'appeler l'exécutable d'ImageMagick. Les traiter
 * comme les autres est le seul moyen de refuser AVANT de construire.
 */
export const NATIVE_GEMS = Object.freeze({
  bcrypt: Object.freeze([]),
  charlock_holmes: Object.freeze(["libicu"]),
  curb: Object.freeze(["libcurl"]),
  ffi: Object.freeze(["libffi"]),
  grpc: Object.freeze([]),
  // mini_magick n'a pas d'extension native : elle appelle `convert`/`magick`.
  // Sans le paquet imagemagick, l'échec est un ENOENT à l'exécution.
  mini_magick: Object.freeze(["imagemagick"]),
  mysql2: Object.freeze(["libmysqlclient"]),
  nokogiri: Object.freeze(["libxml2", "libxslt"]),
  pg: Object.freeze(["libpq"]),
  rbnacl: Object.freeze(["libsodium"]),
  rmagick: Object.freeze(["libmagickwand"]),
  "ruby-filemagic": Object.freeze(["libmagic"]),
  "ruby-vips": Object.freeze(["libvips"]),
  sassc: Object.freeze(["libsass"]),
  sqlite3: Object.freeze(["libsqlite3"]),
  vips: Object.freeze(["libvips"]),
});

/** Gems dont la compilation i386 est si longue qu'elle mérite un avertissement. */
const HEAVY_NATIVE_GEMS = Object.freeze(["grpc"]);

// Une spec de gem résolue est indentée de 4 espaces exactement ; ses
// dépendances le sont de 6, et la section DEPENDENCIES de 2. Cette contrainte
// d'indentation suffit à isoler les gems réellement installées.
const SPEC_LINE = /^ {4}([A-Za-z0-9_.-]+) \(([^()]+)\)\r?$/gm;
const BUNDLED_WITH = /^BUNDLED WITH\s+([\d.]+)/m;

/**
 * Extrait les gems résolues d'un Gemfile.lock.
 * @param {string|null} lockText contenu du Gemfile.lock, `null` s'il est absent
 * @returns {Map<string, string>} nom de gem vers version résolue
 */
export function parseLockSpecs(lockText) {
  /** @type {Map<string, string>} */
  const specs = new Map();
  if (typeof lockText !== "string") return specs;
  for (const match of lockText.matchAll(SPEC_LINE)) {
    // Une gem peut apparaître dans plusieurs sections (GEM, PATH, GIT) :
    // la première occurrence fait foi.
    if (!specs.has(match[1])) specs.set(match[1], match[2]);
  }
  return specs;
}

/**
 * Lit la version de Bundler ayant produit le lock (information de build).
 * @param {string|null} lockText contenu du Gemfile.lock
 * @returns {string|null} version, ou `null` si la section est absente
 */
export function parseBundlerVersion(lockText) {
  if (typeof lockText !== "string") return null;
  const match = BUNDLED_WITH.exec(lockText);
  return match ? match[1] : null;
}

/**
 * Relève les gems natives présentes et les bibliothèques système à embarquer.
 * @param {Map<string, string>} specs gems résolues, issues de {@link parseLockSpecs}
 * @returns {{nativeGems: readonly NativeGem[], findings: Finding[]}} inventaire et diagnostics
 */
export function collectNativeGems(specs) {
  /** @type {NativeGem[]} */
  const nativeGems = [];
  /** @type {Finding[]} */
  const findings = [];
  for (const name of Object.keys(NATIVE_GEMS).sort()) {
    if (!specs.has(name)) continue;
    nativeGems.push(Object.freeze({ name, systemLibs: NATIVE_GEMS[name] }));
    if (!HEAVY_NATIVE_GEMS.includes(name)) continue;
    findings.push(
      createFinding(
        SEVERITY.WARNING,
        "heavy-native-gem",
        `La gem « ${name} » a une compilation i386 très longue (plusieurs dizaines de minutes).`,
        { gem: name },
      ),
    );
  }
  return { nativeGems: Object.freeze(nativeGems), findings };
}

/**
 * Déduit les services d'arrière-plan nécessaires à partir des gems résolues.
 * @param {Map<string, string>} specs gems résolues
 * @returns {{redis: boolean, sidekiq: boolean}} services à démarrer dans la VM
 */
export function detectServices(specs) {
  const sidekiq = specs.has("sidekiq");
  // Sidekiq impose Redis même si la gem `redis` n'est pas déclarée en direct.
  const redis = sidekiq || specs.has("redis");
  return Object.freeze({ redis, sidekiq });
}
