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
  "env-secret-published":
    "Remplacez la valeur par une valeur FACTICE : une sandbox est faite pour être essayée, " +
    "pas pour opérer un service (SECURITY.md). Le bloc env: est écrit tel quel dans " +
    "/app/.railsbox/app-env.sh, sur un disque que chaque visiteur télécharge et peut monter — " +
    "le chmod 600 n'y change rien, il est root dans sa propre VM. Si la valeur est DÉJÀ " +
    "factice, nommez la clé : env_assume_public: [MA_CLE] dans railsbox.yml, une entrée par " +
    "clé. Si un vrai secret a déjà été publié par une construction antérieure, faites-le " +
    "tourner : le retirer d'ici ne le retire pas des artefacts déjà en ligne.",
  "invalid-env-assume-public":
    "Chaque entrée de env_assume_public: doit être un nom de variable, écrit comme dans le " +
    "bloc env: (lettres, chiffres et « _ », ne commençant pas par un chiffre). Il n'y a ni " +
    "joker ni dérogation globale : une clé assumée publique se nomme.",
  "data-bearing-migration":
    "Déplacez l'amorçage de ces données dans db/seeds.rb : c'est ce que Rails prévoit pour " +
    "les données de référence, et une migration ne les fournit qu'aux bases construites " +
    "migration par migration — jamais à celles recréées depuis db/schema.rb, ce que font " +
    "rails db:setup, une base de CI, une review app et railsbox. Dépannage immédiat sans " +
    "toucher à l'application : database_prepare: migrate dans railsbox.yml (voir son propre " +
    "diagnostic — il ne corrige que la sandbox).",
  "database-prepare-migrate":
    "Rien à faire si le dépannage vous suffit. Mais la correction durable reste de déplacer " +
    "ces données dans db/seeds.rb : railsbox rejouera alors l'historique pour rien, et " +
    "l'application fonctionnera aussi hors de la sandbox.",
  "sandbox-sans-donnees":
    "Déclarez un jeu de démonstration dans railsbox.yml : un bloc seed: avec une clé " +
    "command:, exécutée à la CONSTRUCTION, avant la capture de l'instantané. Écrire ce jeu " +
    "dans un fichier séparé évite de polluer le db/seeds.rb de l'application — le bloc " +
    'devient « seed: » puis, indenté de 2 espaces, « command: "bin/rails runner ' +
    "db/seeds/demo.rb\" ». N'y mettez AUCUNE donnée " +
    "réelle — ni client, ni adresse, ni contenu privé : le disque applicatif est public et " +
    "téléchargeable par chaque visiteur (SECURITY.md). Si l'application n'a réellement rien " +
    "à montrer (vitrine, documentation), il n'y a rien à faire.",
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
    "Retirez la clé de railsbox.yml : seules ruby, database, database_prepare, seed, " +
    "env, assets, system_packages, exclude et env_assume_public sont reconnues.",
  "service-externe-au-demarrage":
    "Rendez le service configurable pour pouvoir le neutraliser dans la sandbox : lisez-le dans " +
    'une variable (config.active_storage.service = ENV.fetch("ACTIVE_STORAGE_SERVICE", ' +
    '"amazon").to_sym) et déclarez la valeur de repli dans le bloc env: de railsbox.yml. ' +
    "Le gain dépasse la sandbox : une review app et une base de CI n'ont pas plus de réseau " +
    "vers votre bucket. Si la gem n'est pas sollicitée au démarrage, il n'y a rien à faire.",
  "chemin-absolu-javascript":
    "Faites dire le préfixe par Rails, lisez-le une fois en JavaScript, préfixez les appels — " +
    "et rien ne change hors de la sandbox, où le préfixe est vide. Dans le layout : " +
    '<%= tag.meta(name: "app-base", content: ' +
    'Rails.application.config.relative_url_root.to_s.chomp("/")) %>. Puis, à UN SEUL endroit : ' +
    'export const BASE = document.querySelector(\'meta[name="app-base"]\')?.content ?? ""; ' +
    'export const chemin = (suite) => `${BASE}${suite}`. Enfin fetch(chemin("/api/likes")) au ' +
    'lieu de fetch("/api/likes"), et axios.create({ baseURL: chemin("/api/v1") }). Voir « Votre ' +
    "application embarque un SPA ? » dans le README, même recette pour le routeur.",
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
  "invalid-system-package":
    "Un nom de paquet Debian s'écrit en minuscules, chiffres et « + - . », et commence par un " +
    "caractère alphanumérique : ni option (-o, --force-yes), ni chemin, ni épingle de version. " +
    "Ces noms partent dans un apt-get, la grammaire n'est pas négociable.",
  "too-many-system-packages":
    "Réduisez system_packages: à ce que l'application utilise réellement — la surcouche est " +
    "copiée sur le disque applicatif, dont la géométrie de 512 Mo est figée (ADR 0002).",
  "invalid-exclude-path":
    "exclude: n'accepte que des chemins RELATIFS à la racine de l'application (« doc », " +
    "« db/fixtures »), sans « .. », sans chemin absolu et sans espace : ces valeurs partent " +
    "dans un tar --exclude= sur le runner de construction.",
  "protected-exclude-path":
    "Ce chemin porte l'application elle-même : l'exclure produirait un disque qui ne démarre " +
    "pas. Visez un sous-chemin (« vendor/bundle » plutôt que « vendor », « public/uploads » " +
    "plutôt que « public »).",
  "too-many-excludes":
    "Regroupez les exclusions sur des répertoires parents : au-delà de quelques dizaines " +
    "d'entrées, la liste ne se relit plus et le gain est ailleurs.",
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
    field("Préparation base", describeDatabasePrepare(manifest)),
    field("force_ssl", describeSsl(manifest.ssl)),
    field("Assets", describeAssets(manifest.assets)),
    field("Gems natives", describeNativeGems(manifest.nativeGems)),
    field("Services", describeServices(manifest.services)),
    field(
      "Paquets déclarés",
      manifest.systemPackages?.length ? manifest.systemPackages.join(", ") : null,
    ),
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

/**
 * Décrit COMMENT la base sera préparée, et pourquoi.
 *
 * Deux lignes distinctes dans le résumé, et c'est le point : « Base de
 * données » dit avec quoi l'application parle, « Préparation base » dit si
 * railsbox charge db/schema.rb ou rejoue les migrations — ce qui décide de la
 * présence des données amorcées par une migration.
 * @param {Manifest} manifest manifeste (détecté ou fusionné)
 * @returns {string|null} description, ou `null` si rien n'est connu
 */
function describeDatabasePrepare(manifest) {
  const migrations = manifest.dataMigrations ?? [];
  if (manifest.databasePrepare === "migrate") {
    return "rejeu des migrations, db:create db:migrate (demandé par railsbox.yml)";
  }
  const pluriel = migrations.length > 1;
  const reserve =
    migrations.length > 0
      ? ` — ATTENTION : ${migrations.length} migration${pluriel ? "s" : ""} ` +
        `y amorce${pluriel ? "nt" : ""} des données qui ne seront donc pas insérées`
      : "";
  return `chargement de db/schema.rb, db:prepare${reserve}`;
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
