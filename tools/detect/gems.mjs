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
  // webp-ffi porte bien son nom à moitié : c'est une liaison FFI, mais elle
  // COMPILE une extension (jpegdec.c, pngdec.c, tiffdec.c) qui inclut
  // `webp/encode.h` et `webp/decode.h`. Sans les en-têtes, `bundle install`
  // échoue en « fatal error: webp/encode.h: No such file or directory ».
  // Manque trouvé à la première construction de tryzealot/zealot, dont
  // l'Aptfile déclarait `libwebp-dev` — que rien ici ne lisait.
  "webp-ffi": Object.freeze(["libwebp"]),
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
 * Groupes exclus du bundle installé dans la VM.
 *
 * app.Dockerfile pose `BUNDLE_WITHOUT="development:test"` : une gem confinée à
 * ces groupes n'est PAS installée. Le Gemfile.lock, lui, la mentionne quand
 * même — d'où l'illusion, très coûteuse, qu'elle sera disponible.
 */
export const EXCLUDED_GROUPS = Object.freeze(["development", "test"]);

// Ouvertures de bloc à suivre pour que les `end` se referment sur le bon
// niveau : sans cela, le `end` d'un `platforms … do` fermerait le `group … do`
// englobant et toutes les gems suivantes changeraient de groupe.
const BLOCK_OPENER = /(?:^|\s)do(?:\s*\|[^|]*\|)?\s*$/;
const KEYWORD_OPENER = /^(?:if|unless|case|begin|while|until|def|class|module)\b/;
const GROUP_LINE = /^group\s+(.+?)\s+do\b/;
const GEM_LINE = /^gem\s+["']([^"']+)["']\s*(.*)$/;
const GROUP_OPTION = /\bgroups?:\s*(\[[^\]]*\]|:[A-Za-z_][A-Za-z0-9_]*)/;
const SYMBOL = /[:"']([A-Za-z_][A-Za-z0-9_]*)["']?/g;

/**
 * Extrait les noms de groupes d'une liste Ruby (`:development, :test`).
 * @param {string} text fragment déclarant les groupes
 * @returns {string[]} noms de groupes
 */
function parseGroupNames(text) {
  return [...String(text).matchAll(SYMBOL)].map((match) => match[1]);
}

/**
 * Associe chaque gem déclarée dans un Gemfile à ses groupes Bundler.
 *
 * Une gem hors de tout `group` a une liste VIDE : c'est le groupe `default`,
 * toujours installé.
 * @param {string|null|undefined} gemfileText contenu du Gemfile
 * @returns {Map<string, string[]>} nom de gem vers groupes déclarés
 */
export function parseGemfileGroups(gemfileText) {
  /** @type {Map<string, string[]>} */
  const groups = new Map();
  if (typeof gemfileText !== "string") return groups;
  /** @type {string[][]} */
  const stack = [];
  for (const rawLine of gemfileText.split(/\r?\n/)) {
    const line = rawLine.split("#")[0].trim();
    if (line === "") continue;
    if (/^end\b/.test(line)) {
      stack.pop();
      continue;
    }
    const gem = GEM_LINE.exec(line);
    if (gem) {
      const inherited = stack.flat();
      const option = GROUP_OPTION.exec(gem[2]);
      const declared = option ? parseGroupNames(option[1]) : [];
      const merged = [...new Set([...inherited, ...declared])];
      // Une gem déclarée deux fois (plateformes distinctes, condition) cumule
      // ses groupes : elle est dans le bundle de production dès qu'UNE de ses
      // déclarations l'y met.
      groups.set(gem[1], groups.has(gem[1]) ? union(groups.get(gem[1]), merged) : merged);
      continue;
    }
    const group = GROUP_LINE.exec(line);
    if (group) {
      stack.push(parseGroupNames(group[1]));
      continue;
    }
    if (BLOCK_OPENER.test(line) || KEYWORD_OPENER.test(line)) stack.push([]);
  }
  return groups;
}

/**
 * Fusionne deux listes de groupes sans doublon.
 *
 * Une liste vide signifie « groupe default » : la fusionner avec une liste
 * nommée doit garder le default, sinon une gem déclarée à la fois hors groupe
 * et dans `:development` paraîtrait confinée au développement.
 * @param {string[]} left première déclaration
 * @param {string[]} right seconde déclaration
 * @returns {string[]} groupes cumulés
 */
function union(left, right) {
  const merged = new Set([...left, ...right]);
  if (left.length === 0 || right.length === 0) merged.add("default");
  return [...merged];
}

/**
 * Indique si une gem fait partie du bundle installé dans la VM.
 *
 * Bundler n'exclut une gem que si TOUS ses groupes sont exclus : une gem
 * déclarée `group: [:development, :production]` reste installée.
 * @param {Map<string, string[]>} groups table issue de {@link parseGemfileGroups}
 * @param {string} name nom de la gem
 * @returns {boolean} vrai si la gem est installée en production
 */
export function isInProductionBundle(groups, name) {
  const declared = groups.get(name);
  if (declared === undefined) return false;
  if (declared.length === 0) return true;
  return !declared.every((group) => EXCLUDED_GROUPS.includes(group));
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
