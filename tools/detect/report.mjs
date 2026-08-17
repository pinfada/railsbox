// Rapport d'incompatibilité lisible par un humain. Chaque diagnostic bloquant
// ou d'avertissement porte un remède : un rapport qui constate sans dire quoi
// faire oblige l'utilisateur à lire le code, ce qui est un échec de produit.
import { ASSET_STAGE } from "./assets.mjs";
import { SEVERITY } from "./findings.mjs";
import { satisfiesRubyRequirement } from "./ruby-requirement.mjs";

/** @typedef {import("./findings.mjs").Finding} Finding */
/** @typedef {import("./manifest.mjs").Manifest} Manifest */

/** Libellés français des sévérités, dans l'ordre d'affichage. */
const SEVERITY_LABELS = Object.freeze([
  [SEVERITY.BLOCKING, "Bloquant"],
  [SEVERITY.WARNING, "Avertissement"],
  [SEVERITY.INFO, "Info"],
]);

/** Remède associé à chaque code bloquant ou d'avertissement émis par la détection. */
export const REMEDIES = Object.freeze({
  "not-a-rails-app":
    "Vérifiez le chemin fourni : railsbox attend la racine d'une application Rails " +
    "(Gemfile et Gemfile.lock mentionnant la gem rails).",
  "unsupported-database": "Utilisez PostgreSQL ou SQLite, ou déclarez database: dans railsbox.yml.",
  "missing-ruby-version":
    "Ajoutez un fichier .ruby-version à la racine, ou déclarez ruby: dans railsbox.yml.",
  "unresolvable-ruby-series":
    "Série de Ruby inconnue de railsbox : épinglez une version complète (ruby: X.Y.Z) " +
    "dans railsbox.yml.",
  "ruby-version-incompatible":
    'Relâchez la contrainte du Gemfile (ruby "~> 3.3.10" plutôt que ruby "3.3.10"), ou ' +
    "épinglez une base qui fournit la version exigée (entrée base: du workflow). La clé " +
    "ruby: de railsbox.yml ne change PAS l'interpréteur du guest : il est compilé dans " +
    "l'image de base.",
  "ruby-key-series-mismatch":
    "Alignez ruby: sur la série de la base utilisée, ou choisissez une base de la série " +
    "voulue avec l'entrée base: du workflow — la clé ruby: ne pilote que la série et " +
    "l'image de l'étage amd64.",
  "ruby-key-series-only":
    "Rien à faire : la clé ruby: ne choisit que la série (donc la base) et l'image de " +
    "l'étage amd64 de précompilation. Pour changer le Ruby du guest, changez de base.",
  "base-ruby-unknown":
    "Ajoutez la version de base à BASE_RUBY_VERSIONS (tools/detect/bases.mjs) après " +
    "l'avoir publiée, sinon la contrainte Ruby du Gemfile ne peut pas être vérifiée.",
  "force-ssl-enabled":
    "Rien à faire : railsbox pose un initialiseur qui désactive force_ssl DANS LE GUEST " +
    "(la sandbox n'a pas de terminaison TLS). Pour le conserver malgré tout, déclarez " +
    'RAILSBOX_KEEP_FORCE_SSL: "1" dans le bloc env: de railsbox.yml.',
  "force-ssl-kept":
    "RAILSBOX_KEEP_FORCE_SSL neutralise la parade de railsbox : l'application redirigera " +
    "en 301 vers https et ses cookies seront « secure ». Retirez la variable du bloc env: " +
    "de railsbox.yml si la démonstration ne répond plus.",
  "missing-sqlite3-gem":
    'Ajoutez `gem "sqlite3"` au Gemfile puis relancez `bundle install`, ou déclarez ' +
    "database: postgresql dans railsbox.yml si l'application parle à PostgreSQL.",
  "sqlite3-gem-missing-in-production":
    'Sortez gem "sqlite3" du groupe :development de votre Gemfile (ou ajoutez-la), puis ' +
    "relancez bundle install : le bundle de la VM est installé sans les groupes " +
    "development et test.",
  "sqlite3-fallback-unavailable":
    'Sortez gem "sqlite3" du groupe :development si vous voulez pouvoir déclarer ' +
    "database: sqlite3 dans railsbox.yml ; sinon rien à faire, PostgreSQL est embarqué.",
  "missing-gemfile-lock":
    "Lancez `bundle install` pour produire Gemfile.lock : sans lui, gems natives et services " +
    "restent invisibles.",
  "missing-database-config":
    "Créez config/database.yml, ou déclarez database: dans railsbox.yml (sqlite3 est supposé).",
  "missing-database-adapter":
    "Ajoutez une clé adapter: dans config/database.yml, ou déclarez database: dans railsbox.yml.",
  "missing-pg-gem":
    'Ajoutez `gem "pg"` au Gemfile puis relancez `bundle install`, ou déclarez ' +
    "database: sqlite3 dans railsbox.yml si l'application n'utilise pas PostgreSQL.",
  "heavy-native-gem":
    "Prévoyez une compilation longue, ou excluez la gem du groupe installé dans la VM.",
  "invalid-package-json":
    "Corrigez la syntaxe JSON de package.json, sinon les scripts d'assets ne seront pas exécutés.",
  "npm-lockfile-absent":
    "Versionnez un package-lock.json (`npm install` puis commit) : l'étage amd64 installe " +
    "les dépendances front avec npm, et lui seul rend la construction reproductible.",
  "unknown-manifest-key":
    "Retirez la clé de railsbox.yml : seules ruby, database, seed, env et assets sont reconnues.",
  "invalid-asset-output":
    "assets.output n'accepte que des chemins RELATIFS à la racine de l'application " +
    "(« public/dist », « public/vite »), sans « .. », sans chemin absolu et sans espace.",
  "assets-output-hors-export":
    "Ajoutez ces répertoires à assets.output dans railsbox.yml : sans cela leur contenu " +
    "reste sur l'étage amd64 et n'atteint jamais la sandbox.",
  "malformed-manifest-line":
    "Respectez le format « clé: valeur » avec une indentation de 2 espaces pour les blocs.",
  "invalid-manifest-value": "Corrigez la valeur dans railsbox.yml en suivant le schéma documenté.",
  "invalid-env-name":
    "Un nom de variable commence par une lettre ou _ et ne contient que lettres, chiffres et _ " +
    "(64 caractères maximum).",
});

/**
 * Indique si au moins un diagnostic empêche la construction de l'image.
 * @param {readonly {severity?: string}[]} [findings] diagnostics à examiner
 * @returns {boolean} vrai si un diagnostic est bloquant
 */
export function hasBlocking(findings) {
  if (!Array.isArray(findings)) return false;
  return findings.some((finding) => finding?.severity === SEVERITY.BLOCKING);
}

/**
 * Met en forme le rapport d'analyse complet.
 * @param {{manifest: Manifest, findings?: readonly Finding[]}} result résultat de la détection
 * @returns {string} rapport français multiligne
 * @throws {TypeError} si le résultat n'a pas la forme attendue
 */
export function formatReport(result) {
  if (!result || typeof result !== "object" || !result.manifest) {
    throw new TypeError("formatReport attend { manifest, findings }");
  }
  const findings = Array.isArray(result.findings) ? result.findings : [];
  const lines = [
    "=== railsbox — analyse de l'application ===",
    "",
    ...summaryLines(result.manifest),
  ];
  if (findings.length === 0) {
    lines.push("", "Aucun diagnostic : l'application semble prête.");
    return lines.join("\n");
  }
  for (const [severity, label] of SEVERITY_LABELS) {
    const group = findings.filter((finding) => finding?.severity === severity);
    if (group.length === 0) continue;
    lines.push("", `--- ${label} (${group.length}) ---`);
    for (const finding of group) lines.push(...findingLines(finding));
  }
  return lines.join("\n");
}

/**
 * Construit le résumé de ce qui a été détecté.
 * @param {Manifest} manifest manifeste (détecté ou fusionné)
 * @returns {string[]} lignes du résumé
 */
function summaryLines(manifest) {
  const rubySource = manifest.rubySource ? ` (source : ${manifest.rubySource})` : "";
  const lines = [
    field("Ruby", manifest.ruby ? `${manifest.ruby}${rubySource}` : null),
    // Deux lignes distinctes, et c'est le point : « Ruby » est ce que déclare
    // l'application (et ce qui choisit la série, donc la base et l'image de
    // l'étage amd64) ; « Ruby du guest » est ce que la VM exécutera vraiment.
    field("Ruby du guest", describeGuestRuby(manifest)),
    field("Contrainte Ruby", describeRubyRequirement(manifest)),
    field("Rails", manifest.rails),
    field("Base de données", manifest.database),
    field("force_ssl", describeSsl(manifest.ssl)),
    field("Assets", describeAssets(manifest.assets)),
    field("Gems natives", describeNativeGems(manifest.nativeGems)),
    field("Services", describeServices(manifest.services)),
    field("Bundler", manifest.bundler),
  ];
  if (manifest.seed) {
    lines.push(field("Commande de seed", manifest.seed.command));
    lines.push(field("Auto-login", manifest.seed.autoLogin));
  }
  if (manifest.env) {
    const names = Object.keys(manifest.env);
    lines.push(field("Variables d'env", names.length > 0 ? names.join(", ") : null));
  }
  return lines;
}

/**
 * Décrit le Ruby réellement exécuté par la VM et d'où il vient.
 * @param {Manifest} manifest manifeste (détecté ou fusionné)
 * @returns {string|null} description, ou `null` si la base est inconnue
 */
function describeGuestRuby(manifest) {
  if (!manifest.baseRuby) return null;
  return `${manifest.baseRuby} (fourni par la base ${manifest.base}, non modifiable)`;
}

/**
 * Décrit la contrainte de Ruby que Bundler fera respecter, et son verdict.
 * @param {Manifest} manifest manifeste (détecté ou fusionné)
 * @returns {string|null} description, ou `null` si le Gemfile n'exige rien
 */
function describeRubyRequirement(manifest) {
  const requirement = manifest.rubyRequirement;
  if (!requirement) return "aucune (le Gemfile ne déclare pas de directive ruby)";
  const declared = requirement.requirements.join(", ");
  if (!manifest.baseRuby) return `${declared} (source : ${requirement.source})`;
  const verdict = satisfiesRubyRequirement(manifest.baseRuby, requirement.requirements);
  const mot =
    verdict === false ? "NON satisfaite" : verdict === true ? "satisfaite" : "non vérifiée";
  return `${declared} (source : ${requirement.source}) — ${mot} par ${manifest.baseRuby}`;
}

/** Libellés français des états de `config.force_ssl`. */
const SSL_LABELS = Object.freeze({
  actif: "actif dans production.rb",
  inactif: "désactivé dans production.rb",
  "conditionnel-actif": "conditionnel, actif par défaut",
  "conditionnel-inactif": "conditionnel, inactif par défaut",
  inconnu: "expression non analysée",
});

/**
 * Décrit le réglage `config.force_ssl` et ce que railsbox en fait.
 * @param {Manifest["ssl"]} [ssl] section `ssl` du manifeste
 * @returns {string|null} description, ou `null` si le fichier est absent
 */
function describeSsl(ssl) {
  if (!ssl || !ssl.forceSsl) return null;
  const label = SSL_LABELS[ssl.forceSsl] ?? ssl.forceSsl;
  const suite = ssl.enforced ? " — neutralisé dans le guest par railsbox" : "";
  return `${label}${suite}`;
}

/**
 * Formate une ligne « intitulé : valeur » alignée.
 * @param {string} label intitulé français
 * @param {string|null|undefined} value valeur à afficher
 * @returns {string} ligne formatée
 */
function field(label, value) {
  return `${label.padEnd(18)}: ${value ? value : "non détecté"}`;
}

/**
 * Décrit le pipeline d'assets en une phrase.
 * @param {Manifest["assets"]} [assets] section `assets` du manifeste
 * @returns {string|null} description, ou `null` si absente
 */
function describeAssets(assets) {
  if (!assets) return null;
  const pipeline = assets.npm
    ? `npm — scripts : ${listOr(assets.scripts, "aucun")} — outils : ${listOr(assets.tools, "aucun")}`
    : "importmap/sprockets (pas de package.json)";
  const stage = STAGE_LABELS[assets.stage ?? ""];
  if (!stage) return pipeline;
  const gems = assets.binaryGems?.length ? ` [${assets.binaryGems.join(", ")}]` : "";
  // Ce qui redescend dans le disque est annoncé : un bundle écrit ailleurs
  // partait jusqu'ici à la poubelle sans que rien ne le dise. Seul l'étage
  // amd64 exporte quoi que ce soit — dans le guest, tout est déjà sur place.
  const exported =
    assets.stage === ASSET_STAGE.HOST && assets.output?.length
      ? ` — exporté : ${assets.output.join(", ")}`
      : "";
  return `${pipeline} — précompilation ${stage}${gems}${exported}`;
}

/**
 * Libellés français des étages de précompilation.
 * L'étage amd64 est nommé explicitement : c'est lui qui explique pourquoi une
 * application Tailwind ou npm passe, alors que le guest est un i386.
 */
const STAGE_LABELS = Object.freeze({
  [ASSET_STAGE.NONE]: "aucune",
  [ASSET_STAGE.GUEST]: "dans le guest i386",
  [ASSET_STAGE.HOST]: "sur un étage amd64",
});

/**
 * Joint une liste, avec une valeur de repli quand elle est vide.
 * @param {readonly string[]|undefined} values valeurs à joindre
 * @param {string} fallback texte affiché si la liste est vide
 * @returns {string} texte joint
 */
function listOr(values, fallback) {
  return values?.length ? values.join(", ") : fallback;
}

/**
 * Décrit les gems natives et leurs bibliothèques système.
 * @param {Manifest["nativeGems"]} [nativeGems] section `nativeGems` du manifeste
 * @returns {string|null} description, ou `null` si aucune
 */
function describeNativeGems(nativeGems) {
  if (!nativeGems?.length) return null;
  return nativeGems
    .map((gem) =>
      gem.systemLibs?.length ? `${gem.name} (${gem.systemLibs.join(", ")})` : gem.name,
    )
    .join(", ");
}

/**
 * Décrit les services d'arrière-plan à démarrer.
 * @param {Manifest["services"]} [services] section `services` du manifeste
 * @returns {string|null} description, ou `null` si aucun
 */
function describeServices(services) {
  if (!services) return null;
  const active = Object.keys(services).filter((name) => services[name]);
  return active.length > 0 ? active.join(", ") : null;
}

/**
 * Formate un diagnostic et, le cas échéant, son remède.
 * @param {Finding} finding diagnostic à formater
 * @returns {string[]} lignes correspondantes
 */
function findingLines(finding) {
  const lines = [`- [${finding.code}] ${finding.message}`];
  const remedy = REMEDIES[finding.code];
  if (remedy) lines.push(`  Remède : ${remedy}`);
  return lines;
}
