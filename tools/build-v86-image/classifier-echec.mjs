// Classification structurée des échecs de CONSTRUCTION (critère C10) : le
// pendant AVAL du vocabulaire de diagnostics de tools/detect.
//
// L'analyse amont refuse proprement (code + remède, cf. detect/report.mjs).
// L'aval, lui, échoue au milieu de plusieurs centaines de lignes de journal
// Docker : bundle install qui casse, assets:precompile qui trébuche sur un
// binaire amd64, migration qui plante, capture d'instantané qui expire,
// publication refusée. Ce module rend à ces pannes la même forme que les
// diagnostics amont — catégorie, code stable, message, remède actionnable —
// plus l'EXTRAIT du journal qui prouve le diagnostic.
//
// Module PUR : aucune entrée/sortie, aucune dépendance à Docker ni à la VM.
// Une petite interface en ligne de commande est greffée à la fin pour le
// workflow, sur le modèle de split-config.mjs.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

/**
 * @typedef {object} Diagnostic
 * @property {string} categorie famille française de la panne
 * @property {string} code identifiant stable, clé du remède
 * @property {string} message phrase française décrivant la cause
 * @property {string} remede une ou deux phrases ACTIONNABLES
 * @property {string} extrait lignes du journal qui prouvent le diagnostic
 */

/** Familles de pannes. Elles regroupent les codes dans le résumé. */
export const CATEGORIES = Object.freeze({
  ANALYSE: "analyse de l'application",
  DEPENDANCE_SYSTEME: "dépendance système de la base",
  IMAGE_DE_BASE: "image de base",
  BUNDLE: "installation des gems",
  ASSETS: "précompilation des assets",
  BASE_DE_DONNEES: "base de données",
  RAILS: "tâche Rails",
  VOLUMETRIE: "volumétrie des artefacts",
  INSTANTANE: "capture d'instantané",
  PUBLICATION: "publication",
  INFRASTRUCTURE: "infrastructure de construction",
  INCONNU: "inexpliqué",
});

/**
 * Remède associé à chaque code. Une ou deux phrases, toujours à l'impératif :
 * un diagnostic qui constate sans dire quoi faire renvoie le mainteneur au
 * journal, c'est-à-dire au point de départ.
 */
export const REMEDES = Object.freeze({
  "refus-amont":
    "Le rapport d'analyse figure juste au-dessus dans l'extrait, avec son code et son remède : " +
    "corrigez-le dans l'application (ou dans railsbox.yml) avant de relancer.",
  "base-paquet-manquant":
    "Le refus, juste au-dessus dans l'extrait, dit quoi faire : si les paquets existent dans une " +
    "base plus récente, épinglez-la (entrée « base: » du workflow) ; si aucune ne les fournit, " +
    "ouvrez une issue « Ma stack n'est pas prise en charge » — le jeu de bibliothèques de la base " +
    "mutualisée est figé, le disque applicatif ne peut rien y ajouter.",
  "gem-native-entete-manquante":
    "Ajoutez le paquet nommé ci-dessus à tools/build-v86-image/base/Dockerfile puis republiez la " +
    "base (base-build.sh), ou retirez la gem du groupe installé dans la sandbox.",
  "surcouche-paquet-inconnu":
    "Vérifiez le nom sur packages.debian.org, série bookworm, architecture i386 : railsbox " +
    "installe ce que vous nommez, il ne traduit pas. Un paquet absent de i386 ne peut être fourni " +
    "d'aucune façon — retirez-le de system_packages: ou changez de gem.",
  "surcouche-trop-lourde":
    "Le disque applicatif fait 512 Mo, application, bundle et base seedée compris (ADR 0002). " +
    "Retirez des paquets de system_packages:, ou demandez leur entrée dans la base mutualisée " +
    "avec le gabarit « Ma stack n'est pas prise en charge » — c'est le seul cas où la base doit " +
    "grossir malgré le coût imposé à toutes les sandboxes.",
  "base-sans-postgres":
    "Épinglez une base au moins aussi récente que 3.3-r2 (entrée « base: » du workflow) : " +
    "PostgreSQL n'existe pas dans les bases antérieures.",
  "base-image-introuvable":
    "Vérifiez que l'entrée « base » du workflow désigne un tag publié de " +
    "ghcr.io/pinfada/railsbox-base, ou construisez la base localement avec base-build.sh.",
  "bundle-plateforme":
    "Lancez `bundle lock --add-platform x86-linux` dans l'application et versionnez le " +
    "Gemfile.lock : le guest est un i386, une gem livrée seulement en binaire x86_64 doit " +
    "être épinglée sur une version compilable.",
  // Ce cas est normalement REFUSÉ EN AMONT depuis que la détection confronte la
  // directive `ruby` du Gemfile au Ruby de la base (diagnostic
  // ruby-version-incompatible). Le motif reste, comme filet, pour les
  // contraintes qu'aucune analyse statique ne voit — une directive calculée,
  // ou une gem qui impose sa propre exigence de Ruby.
  //
  // Le remède ne dit plus « alignez .ruby-version » : ce fichier seul n'engage
  // pas Bundler, et la clé ruby: de railsbox.yml ne choisit que la série.
  "bundle-version-ruby":
    'Relâchez la directive `ruby` de votre Gemfile (ruby "~> 3.3.10" plutôt qu\'une égalité ' +
    "stricte), ou épinglez une base qui fournit la version exigée (entrée base: du workflow) : " +
    "la base fournit un Ruby figé que le disque applicatif ne peut pas remplacer.",
  "bundle-reseau":
    "Relancez la construction : l'incident est presque toujours transitoire. S'il persiste, " +
    "vérifiez les sources du Gemfile — une source git ou privée n'est pas joignable depuis le runner.",
  "bundle-gem-introuvable":
    "Lancez `bundle install` dans l'application et versionnez un Gemfile.lock à jour : la " +
    "construction résout les gems telles quelles, elle n'en ajoute jamais.",
  "bundle-echec":
    "Rejouez `bundle install` hors railsbox avec la même série de Ruby : l'extrait ci-dessous " +
    "porte la gem fautive et le message exact de Bundler.",
  "assets-vides":
    "Vérifiez que `rails assets:precompile` aboutit hors railsbox, et que les scripts npm de " +
    "build écrivent bien dans app/assets/builds — un étage muet livrerait une application sans CSS.",
  "assets-format-binaire":
    "Laissez la détection choisir l'étage de précompilation (clé assets: de railsbox.yml) : un " +
    "outil sans binaire i386 doit tourner sur l'étage amd64, jamais dans le guest.",
  "assets-binaire-absent":
    "Déclarez l'outil manquant dans package.json (ou la gem correspondante dans le Gemfile) pour " +
    "que l'étage de précompilation l'installe, et versionnez le package-lock.json.",
  "assets-precompile-echec":
    "Reproduisez `RAILS_ENV=production bin/rails assets:precompile` dans l'application : " +
    "railsbox exécute la commande standard, sans adaptation.",
  "credentials-cle-absente":
    "railsbox substitue normalement une paire de credentials JETABLE quand la clé n'est pas " +
    "versionnée : si ce refus tombe quand même, ou bien la substitution a été désarmée " +
    "(RAILSBOX_KEEP_CREDENTIALS=1), ou bien votre application VERSIONNE sa clé mais son " +
    ".dockerignore l'écarte — retirez-y la ligne, ou cessez de versionner la clé et laissez " +
    "railsbox en fabriquer une (le disque applicatif est public, n'y mettez pas la vraie).",
  "credentials-cle-invalide":
    "La clé versionnée par l'application ne déchiffre pas son propre fichier de credentials " +
    "(clé tournée sans réécrire le .enc, ou paire d'environnement dépareillée). Rejouez " +
    "`RAILS_ENV=production bin/rails credentials:show` hors railsbox : l'erreur y est identique.",
  "db-connexion":
    "Vérifiez la base déclarée (clé database: de railsbox.yml) et que la base railsbox utilisée " +
    "fournit PostgreSQL (3.3-r2 au minimum) : le cluster est initialisé pendant la construction.",
  "db-migration":
    "Rejouez `bin/rails db:prepare` sur une base VIERGE hors railsbox : la construction part " +
    "toujours d'une base vide, une migration qui suppose des données existantes échoue ici.",
  "db-donnees-de-migration-absentes":
    "Vos données de référence (devises, rôles, catégories…) sont amorcées par une MIGRATION : " +
    "le rapport d'analyse, plus haut dans le journal, nomme le fichier. Une base recréée " +
    "depuis db/schema.rb ne joue aucune migration — c'est vrai ici comme sur un rails " +
    "db:setup ou une base de CI. Déplacez cet amorçage dans db/seeds.rb ; pour un dépannage " +
    "immédiat, déclarez database_prepare: migrate dans railsbox.yml.",
  "db-seed":
    'Rendez les seeds idempotents sur une base vierge, ou passez `seed: ""` dans railsbox.yml ' +
    "pour ne rien amorcer (l'option --seed-optional rend un seed partiel non bloquant).",
  "db-echec":
    "Rejouez la préparation de la base sur une base vierge hors railsbox : l'extrait porte " +
    "l'erreur ActiveRecord exacte et le fichier fautif.",
  "rails-echec":
    "Rejouez la même tâche en RAILS_ENV=production hors railsbox : la trace de l'extrait est " +
    "celle de l'application, pas celle de railsbox.",
  "disque-app-trop-gros":
    "Allégez l'arbre livré (fixtures, dumps, médias — un .dockerignore suffit) : la géométrie " +
    "de 512 Mo est figée par la restauration d'instantané et ne peut pas changer (ADR 0002).",
  "limite-pages":
    "Réduisez la taille des artefacts publiés, ou baissez le calibre de découpage CHUNK_BYTES : " +
    "GitHub Pages refuse tout fichier au-delà de 95 Mo.",
  "instantane-timeout":
    "Vérifiez que l'application démarre en production sans service externe (la sandbox n'a aucun " +
    "réseau sortant) et déclarez dans le bloc env: de railsbox.yml les variables qu'un " +
    "initialiseur exige au démarrage.",
  "instantane-echec":
    "Relisez l'extrait : la capture échoue avant le gel (disque ou instantané de base absent, " +
    "boot interrompu). Relancez une fois pour écarter un aléa du runner.",
  "publication-cle-absente":
    "Fournissez le secret publish-key (clé de déploiement en écriture sur target-repo) : le " +
    "jeton du workflow ne vaut que pour le dépôt appelant.",
  "publication-droits":
    "Donnez au job `permissions: contents: write` pour publier sur le dépôt appelant, ou " +
    "vérifiez que la clé publish-key est enregistrée EN ÉCRITURE sur le dépôt cible.",
  "publication-echec":
    "La branche gh-pages est réécrite de force à chaque construction : un refus vient presque " +
    "toujours d'une protection de branche ou d'un dépôt cible inexistant.",
  "droits-root":
    "La fabrication du disque exige root (uid préservés à l'extraction, mke2fs) : le workflow " +
    'passe par `sudo -E env "PATH=$PATH" bash …`, vérifiez que le runner autorise sudo sans mot de passe.',
  "docker-espace-disque":
    "Libérez de l'espace sur le runner (docker system prune, suppression des images inutilisées) " +
    "ou allégez le contenu du disque applicatif.",
  "docker-indisponible":
    "Le runner doit fournir docker, node et e2fsprogs : sur un runner auto-hébergé, installez-les ; " +
    "sur ubuntu-latest, relancez le job.",
  "docker-etape-echouee":
    "Rejouez la même construction hors CI avec `--progress=plain` pour dérouler la sortie " +
    "complète de l'étape : l'extrait ne porte que les dernières lignes avant l'abandon.",
  inconnu:
    "Aucun motif connu ne correspond : lisez les dernières lignes utiles ci-dessous, puis " +
    "ouvrez une issue avec cet extrait pour que le motif rejoigne la taxonomie.",
  "journal-vide":
    "L'étape n'a rien écrit : relancez avec le journal complet (les commandes de construction " +
    "doivent être redirigées vers le fichier lu par le classifieur).",
});

/**
 * Paquet Debian à ajouter à la base selon l'en-tête ou l'outil réclamé par une
 * extension native. C'est le renseignement qui manque le plus au mainteneur :
 * le journal donne un `libpq-fe.h`, pas un `libpq-dev`.
 * @type {readonly (readonly [RegExp, string])[]}
 */
const PAQUET_PAR_INDICE = Object.freeze([
  [/libpq-fe\.h|pg_config/i, "libpq-dev"],
  [/sqlite3\.h|sqlite3ext\.h/i, "libsqlite3-dev"],
  [/libxml\/|xml2-config|libxml2 is missing/i, "libxml2-dev"],
  [/libxslt|xslt-config/i, "libxslt1-dev"],
  // ruby-vips ne compile rien : elle dlopen libvips.so.42. C'est donc le
  // paquet RUNTIME qu'il faut nommer, pas les en-têtes.
  [/vips\/vips\.h|libvips|Could not open library 'vips'/i, "libvips42 libvips-tools"],
  [/Could not open library 'sodium'|libsodium/i, "libsodium-dev"],
  [/mysql\.h|mysql_config|mysqlclient/i, "libmysqlclient-dev"],
  [/MagickWand|wand\/MagickWand\.h|ImageMagick/i, "libmagickwand-dev"],
  [/ffi\.h|libffi/i, "libffi-dev"],
  [/openssl\/ssl\.h|openssl is missing/i, "libssl-dev"],
  [/zlib\.h|zlib is missing/i, "zlib1g-dev"],
  [/yaml\.h|libyaml/i, "libyaml-dev"],
  [/curl\/curl\.h|libcurl/i, "libcurl4-openssl-dev"],
  [/unicode\/|libicu/i, "libicu-dev"],
]);

/** Paquet déduit du seul nom de la gem, quand le journal ne nomme pas l'en-tête. */
const PAQUET_PAR_GEM = Object.freeze({
  pg: "libpq-dev",
  sqlite3: "libsqlite3-dev",
  nokogiri: "libxml2-dev libxslt1-dev",
  mysql2: "libmysqlclient-dev",
  "ruby-vips": "libvips42 libvips-tools",
  vips: "libvips42 libvips-tools",
  mini_magick: "imagemagick",
  rmagick: "libmagickwand-dev",
  charlock_holmes: "libicu-dev",
  curb: "libcurl4-openssl-dev",
  rbnacl: "libsodium-dev",
  "ruby-filemagic": "libmagic-dev",
  ffi: "libffi-dev",
});

// ---------------------------------------------------------------------------
// Nettoyage du journal
// ---------------------------------------------------------------------------

/** Préfixe que BuildKit colle devant CHAQUE ligne de sortie : « #12 34.5 ». */
const PREFIXE_BUILDKIT = /^#\d+\s+(?:\d+\.\d+\s+)?/;

/**
 * Progression de BuildKit, reconnue AVANT retrait du préfixe. L'en-tête d'une
 * étape (« #12 [ 4/12] RUN bundle lock --add-platform x86-linux… ») en fait
 * partie : il rappelle la COMMANDE, pas son résultat, et confondrait un motif
 * de diagnostic avec le texte de la commande qui l'a produit.
 */
const BRUIT_BUILDKIT = Object.freeze([
  /^#\d+\s+(?:DONE|CACHED|sha256:|resolve |extracting |transferring |exporting |preparing |unpacking |naming to |writing image|pulling |download )/i,
  /^#\d+\s+\[[^\]]*\]/,
]);

/**
 * Lignes de progression sans valeur de diagnostic, reconnues APRÈS retrait du
 * préfixe. Écartées de l'extrait ET de la recherche de motifs. Le `ERROR:` de
 * BuildKit, lui, n'est volontairement pas listé : il porte la commande fautive.
 */
const BRUIT_CONTENU = Object.freeze([
  /^(?:Fetching|Downloading|Installing) [\w.-]+ [\d.][\w.-]*$/,
  /^(?:Fetching (?:gem metadata|source index)|Resolving dependencies|Bundle complete|Using [\w.-]+ [\d.])/,
  /^(?:Pulling fs layer|Waiting|Verifying Checksum|Download complete|Pull complete|Already exists|Extracting|Digest: sha256|Status: )/,
  /^(?:Sending build context|Step \d+\/\d+ :|---> [0-9a-f]{8,}|---> Running in |Removing intermediate container)/,
  /^(?:Get|Hit|Ign):\d+\s+https?:/,
  /^(?:Reading package lists|Building dependency tree|Reading state information)/,
  /^[\s=~*-]*$/,
]);

/**
 * Découpe le journal en lignes exploitables.
 * @param {string} journal texte brut de l'étape
 * @returns {{texte: string, bruit: boolean}[]} lignes nettoyées de leur préfixe BuildKit
 */
function decouper(journal) {
  return journal.split(/\r?\n/).map((brute) => {
    const ligne = brute.replace(/\r/g, "").trimEnd();
    const texte = ligne.replace(PREFIXE_BUILDKIT, "");
    const bruit =
      BRUIT_BUILDKIT.some((motif) => motif.test(ligne)) ||
      BRUIT_CONTENU.some((motif) => motif.test(texte));
    return { texte, bruit };
  });
}

/**
 * Masque ce qui ne doit JAMAIS atterrir dans un résumé public. Le journal est
 * capturé par `tee` dans un fichier : contrairement à la sortie du runner, il
 * n'est pas passé au masquage des secrets de GitHub. Une URL de push en erreur
 * y porte le jeton en clair.
 * @param {string} texte texte à assainir
 * @returns {string} texte caviardé
 */
export function caviarder(texte) {
  return texte
    .replace(
      /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
      "[clé privée retirée]",
    )
    .replace(/([a-z][a-z0-9+.-]*:\/\/)[^\s/:@]+:[^\s/@]+@/gi, "$1***:***@")
    .replace(/gh[pousr]_[A-Za-z0-9]{16,}/g, "gh*_[jeton retiré]")
    .replace(/github_pat_[A-Za-z0-9_]{20,}/g, "github_pat_[jeton retiré]");
}

/** Longueur maximale d'une ligne d'extrait : au-delà, le résumé devient illisible. */
const LARGEUR_EXTRAIT = 200;
/** Nombre de lignes retenues autour du motif qui prouve le diagnostic. */
const AVANT = 4;
const APRES = 8;
/** Lignes retenues quand aucun motif ne correspond (repli « inconnu »). */
const DERNIERES_LIGNES = 30;

/**
 * Construit l'extrait autour d'une ligne, débarrassé du bruit et caviardé.
 * @param {{texte: string, bruit: boolean}[]} lignes lignes découpées
 * @param {number} index position de la ligne qui prouve le diagnostic
 * @returns {string} extrait multiligne, éventuellement vide
 */
function extraireAutour(lignes, index) {
  const debut = Math.max(0, index - AVANT);
  const fin = Math.min(lignes.length, index + APRES + 1);
  return assembler(lignes.slice(debut, fin));
}

/**
 * Construit l'extrait de repli : les dernières lignes utiles du journal.
 * @param {{texte: string, bruit: boolean}[]} lignes lignes découpées
 * @returns {string} extrait multiligne, éventuellement vide
 */
function extraireFin(lignes) {
  const utiles = lignes.filter((ligne) => !ligne.bruit && ligne.texte.trim() !== "");
  return assembler(utiles.slice(-DERNIERES_LIGNES));
}

/**
 * Met en forme une tranche de lignes : bruit retiré, secrets masqués, PUIS
 * largeur bornée.
 *
 * L'ORDRE EST LE CORRECTIF. Tronquer d'abord coupait un jeton en deux au 200e
 * caractère : le motif de caviardage ne reconnaissait plus rien, et la moitié
 * gauche du secret partait telle quelle dans un résumé public. Le caviardage
 * s'applique donc au texte entier — il le faut de toute façon pour les blocs
 * multilignes (clés privées) — et la troncature ne voit plus que du texte déjà
 * assaini.
 * @param {{texte: string, bruit: boolean}[]} tranche lignes à assembler
 * @returns {string} extrait prêt à afficher
 */
function assembler(tranche) {
  const retenues = tranche
    .filter((ligne) => !ligne.bruit && ligne.texte.trim() !== "")
    .map((ligne) => ligne.texte);
  return caviarder(retenues.join("\n"))
    .split("\n")
    .map((texte) =>
      texte.length > LARGEUR_EXTRAIT ? `${texte.slice(0, LARGEUR_EXTRAIT)}…` : texte,
    )
    .join("\n");
}

// ---------------------------------------------------------------------------
// Taxonomie
// ---------------------------------------------------------------------------

/**
 * @typedef {object} Contexte
 * @property {string} texte journal nettoyé, lignes utiles jointes
 * @property {string} etape nom de l'étape qui a échoué
 */

/**
 * @typedef {object} Regle
 * @property {string} code identifiant stable
 * @property {string} categorie famille de {@link CATEGORIES}
 * @property {number} rang 1 = cause nommée, 2 = famille, 3 = constat générique
 * @property {RegExp} motif détecteur, appliqué ligne à ligne (jamais global)
 * @property {RegExp} [etapes] restreint la règle à certaines étapes
 * @property {(c: Contexte) => boolean} [garde] condition portant sur TOUT le
 *   journal, évaluée avant le motif. Sert aux pannes dont le symptôme est banal
 *   mais dont la cause est prouvée par une trace apparue bien plus haut.
 * @property {(m: RegExpExecArray, c: Contexte) => string} message phrase française
 */

/**
 * Règles ordonnées de la plus spécifique à la plus générale. À rang égal, c'est
 * la PREMIÈRE cause apparue dans le journal qui l'emporte : dans une sortie
 * Docker, la panne d'origine précède toujours ses conséquences.
 * @type {readonly Regle[]}
 */
const REGLES = Object.freeze([
  {
    code: "refus-amont",
    categorie: CATEGORIES.ANALYSE,
    rang: 1,
    motif: /Construction refus[ée]e/,
    message: () => "L'analyse amont a refusé l'application avant toute construction.",
  },
  {
    code: "base-paquet-manquant",
    categorie: CATEGORIES.DEPENDANCE_SYSTEME,
    rang: 1,
    motif: /La base ne fournit pas les biblioth[èe]ques syst[èe]me\s*:\s*(.+)/,
    message: (m) => `La base ne fournit pas ces paquets système : ${m[1].trim()}.`,
  },
  {
    code: "gem-native-entete-manquante",
    categorie: CATEGORIES.DEPENDANCE_SYSTEME,
    rang: 1,
    motif:
      /Failed to build gem native extension|Can't find the '?[\w.+-]+'? header|Can't find (?:mysql_config|pg_config)|is missing\.\s*(?:Please|Try)|(?:^|[\s'"])[\w+/-]+\.h: No such file or directory/,
    message: (_m, contexte) => decrireGemNative(contexte.texte),
  },
  {
    code: "surcouche-paquet-inconnu",
    categorie: CATEGORIES.DEPENDANCE_SYSTEME,
    rang: 1,
    motif:
      /E: Unable to locate package ([\w+.-]+)|E: Package '([\w+.-]+)' has no installation candidate/,
    message: (m) =>
      `Le paquet « ${(m[1] ?? m[2]).trim()} » n'existe pas dans Debian bookworm i386.`,
  },
  {
    code: "surcouche-trop-lourde",
    categorie: CATEGORIES.DEPENDANCE_SYSTEME,
    rang: 1,
    motif: /La surcouche syst[èe]me p[èe]se (\d+) Mo/,
    message: (m) =>
      `La surcouche système pèse ${m[1]} Mo : le disque applicatif ne peut pas l'absorber.`,
  },
  {
    code: "base-sans-postgres",
    categorie: CATEGORIES.IMAGE_DE_BASE,
    rang: 1,
    motif: /ne fournit pas PostgreSQL/,
    message: () =>
      "L'image de base utilisée est antérieure à 3.3-r2 : elle ne contient pas PostgreSQL.",
  },
  {
    code: "base-image-introuvable",
    categorie: CATEGORIES.IMAGE_DE_BASE,
    rang: 1,
    motif:
      /Image de base introuvable|manifest unknown|manifest for .* not found|pull access denied|repository does not exist/,
    message: () => "L'image de base demandée n'existe pas (tag inconnu ou registre inaccessible).",
  },
  {
    code: "bundle-plateforme",
    categorie: CATEGORIES.BUNDLE,
    rang: 1,
    // « --add-platform x86-linux » n'est PAS un détecteur : c'est le texte de
    // la commande que app.Dockerfile exécute, présent dans tous les journaux.
    motif:
      /Your bundle only supports platforms|does not include the current platform|valid for all resolution platforms|Add the current platform to the lockfile/,
    message: () =>
      "Le Gemfile.lock ne couvre pas la plateforme i386 (x86-linux) exigée par le guest.",
  },
  {
    code: "bundle-version-ruby",
    categorie: CATEGORIES.BUNDLE,
    rang: 1,
    motif: /Your Ruby version is ([\d.]+), but your Gemfile (?:specified|requires) ([\d.]+)/,
    message: (m) => `La base fournit Ruby ${m[1]} alors que l'application exige Ruby ${m[2]}.`,
  },
  {
    code: "bundle-reseau",
    categorie: CATEGORIES.BUNDLE,
    rang: 1,
    motif:
      /Gem::RemoteFetcher::FetchError|Could not reach host|Net::OpenTimeout|Retrying (?:download gem|fetcher)|Could not fetch specs from|Temporary failure in name resolution|Errno::ECONNREFUSED|SocketError/,
    message: () => "Le téléchargement des gems a échoué (réseau du runner ou miroir rubygems).",
  },
  {
    code: "bundle-gem-introuvable",
    categorie: CATEGORIES.BUNDLE,
    rang: 1,
    motif:
      /Bundler::GemNotFound|Could not find gem |Could not find compatible versions|Could not find [\w.-]+ in (?:any of the sources|locally installed gems)|The Gemfile's dependencies could not be satisfied/,
    message: () => "Bundler n'a pas pu résoudre les gems déclarées par l'application.",
  },
  {
    code: "bundle-echec",
    categorie: CATEGORIES.BUNDLE,
    rang: 2,
    motif: /An error occurred while installing ([\w.-]+)|Bundler cannot continue/,
    message: (m) =>
      m[1]
        ? `L'installation de la gem « ${m[1]} » a échoué.`
        : "bundle install s'est interrompu sans que la gem fautive soit nommée.",
  },
  // Avant les règles d'assets, et à rang 1 : la panne éclate presque toujours
  // pendant assets:precompile, dont la ligne d'échec BuildKit contient le mot
  // « assets:precompile ». Sans ces deux règles, le constat générique gagnait et
  // annonçait un problème d'assets là où la cause est une clé de chiffrement.
  {
    code: "credentials-cle-absente",
    categorie: CATEGORIES.RAILS,
    rang: 1,
    motif: /Missing encryption key to decrypt file with|EncryptedFile::MissingKeyError/,
    message: () =>
      "L'application exige sa clé de credentials (config.require_master_key) et ne l'a pas trouvée.",
  },
  {
    code: "credentials-cle-invalide",
    categorie: CATEGORIES.RAILS,
    rang: 1,
    motif: /MessageEncryptor::InvalidMessage|ActiveSupport::MessageVerifier::InvalidSignature/,
    message: () => "Les credentials de l'application n'ont pas pu être déchiffrés avec sa clé.",
  },
  {
    code: "assets-vides",
    categorie: CATEGORIES.ASSETS,
    rang: 1,
    motif: /n'a produit aucun asset|AUCUN asset re[çc]u de l'[ée]tage amd64/,
    message: () =>
      "L'étage de précompilation n'a produit aucun fichier dans public/assets : " +
      "l'application serait livrée sans CSS.",
  },
  {
    code: "assets-format-binaire",
    categorie: CATEGORIES.ASSETS,
    rang: 1,
    motif: /[Ee]xec format error|cannot execute binary file/,
    message: () =>
      "Un binaire d'une autre architecture a été exécuté : le guest est un i386, " +
      "les outils d'assets sans variante i386 appartiennent à l'étage amd64.",
  },
  {
    code: "assets-binaire-absent",
    categorie: CATEGORIES.ASSETS,
    rang: 1,
    motif:
      /(?:tailwindcss|dartsass|sassc?|esbuild|rollup|webpack|vite|postcss|node|npm|yarn|bun)['"]?:?\s*(?:command\s+)?not found|No such file or directory[^\n]*(?:tailwindcss|dartsass|sass|esbuild|node)/i,
    message: () =>
      "Un binaire de la chaîne d'assets est introuvable dans l'étage de précompilation.",
  },
  {
    code: "assets-precompile-echec",
    categorie: CATEGORIES.ASSETS,
    rang: 2,
    motif: /assets:precompile|Sprockets::|Propshaft::|app\/assets\/builds/,
    message: (_m, contexte) =>
      `La précompilation des assets a échoué${detailErreurRuby(contexte.texte)}.`,
  },
  {
    code: "db-connexion",
    categorie: CATEGORIES.BASE_DE_DONNEES,
    rang: 1,
    motif:
      /PG::ConnectionBad|could not connect to server|connection to server .* failed|ActiveRecord::NoDatabaseError|initdb: error|FATAL:\s+role .* does not exist/,
    message: () => "L'application n'a pas pu joindre sa base de données pendant la construction.",
  },
  {
    code: "db-migration",
    categorie: CATEGORIES.BASE_DE_DONNEES,
    rang: 1,
    motif:
      /An error has occurred, all later migrations canceled|ActiveRecord::(?:StatementInvalid|PendingMigrationError|IrreversibleMigration)|PG::\w+|SQLite3::\w+Exception|Mysql2::Error/,
    message: (_m, contexte) => `Une migration a échoué${detailErreurRuby(contexte.texte)}.`,
  },
  {
    // Le piège des migrations porteuses de données, vu depuis l'AVAL : la
    // validation qui échoue ne parle jamais de migration, elle parle d'une
    // valeur « non supportée » et énumère une liste VIDE — celle d'une table de
    // référence que le chargement de db/schema.rb n'a jamais peuplée. Sans ce
    // code, le classifieur rendait « l'amorçage a échoué », ce qui envoie
    // corriger les seeds, c'est-à-dire le seul endroit qui n'a rien à se
    // reprocher.
    //
    // La garde est ce qui rend la règle sûre : le symptôme (une validation en
    // échec) est trop banal pour trancher seul. Elle exige la trace, apparue
    // bien plus haut dans le même journal, que l'analyse amont a relevé des
    // migrations porteuses de données — le rapport d'analyse précède toujours
    // la construction dans le journal.
    code: "db-donnees-de-migration-absentes",
    categorie: CATEGORIES.BASE_DE_DONNEES,
    rang: 1,
    garde: (contexte) => /\[data-bearing-migration\]/.test(contexte.texte),
    // Volontairement borné à la validation : `RecordNotFound` rejoindrait ici
    // trop de pannes qui n'ont rien à voir (une auto-connexion qui ne trouve
    // pas son compte, par exemple).
    motif: /Validation failed:|ActiveRecord::RecordInvalid/,
    message: (_m, contexte) =>
      "Une validation a échoué sur une table de référence restée VIDE : le schéma a été " +
      `chargé sans rejouer les migrations qui l'amorcent${detailErreurRuby(contexte.texte)}.`,
  },
  {
    code: "db-seed",
    categorie: CATEGORIES.BASE_DE_DONNEES,
    rang: 1,
    motif:
      /ActiveRecord::Record(?:Invalid|NotUnique|NotFound)|Validation failed:|db\/seeds\.rb|db:seed/,
    message: (_m, contexte) => `L'amorçage (seed) a échoué${detailErreurRuby(contexte.texte)}.`,
  },
  {
    code: "db-echec",
    categorie: CATEGORIES.BASE_DE_DONNEES,
    rang: 2,
    motif: /db:prepare|db:migrate|db:schema|ActiveRecord::/,
    message: (_m, contexte) =>
      `La préparation de la base a échoué${detailErreurRuby(contexte.texte)}.`,
  },
  {
    code: "disque-app-trop-gros",
    categorie: CATEGORIES.VOLUMETRIE,
    rang: 1,
    motif: /d[ée]passe la g[ée]om[ée]trie fixe/,
    message: () =>
      "Le contenu applicatif déborde la géométrie fixe de 512 Mo du disque applicatif.",
  },
  {
    code: "limite-pages",
    categorie: CATEGORIES.VOLUMETRIE,
    rang: 1,
    motif:
      /au-del[àa] de la limite de GitHub Pages|this exceeds GitHub's file size limit|GH001: Large files detected/,
    message: () => "Un artefact publié dépasse la limite de 95 Mo par fichier de GitHub Pages.",
  },
  {
    code: "instantane-timeout",
    categorie: CATEGORIES.INSTANTANE,
    rang: 1,
    motif:
      /l'application n'a jamais r[ée]pondu dans la VM|d[ée]lai d[ée]pass[ée]? en attendant la VM|tranche non acquitt[ée]e par la VM/,
    message: () =>
      "L'application n'a jamais répondu dans la VM : la capture d'instantané a expiré.",
  },
  {
    code: "instantane-echec",
    categorie: CATEGORIES.INSTANTANE,
    rang: 2,
    motif: /\[delta-snapshot\] [ÉE]CHEC|\[snapshot\] [ÉE]CHEC|introuvable \([^)]*\.(?:ext2|bin)\)/,
    message: () => "La capture du delta d'instantané s'est interrompue avant le gel de la mémoire.",
  },
  {
    code: "publication-cle-absente",
    categorie: CATEGORIES.PUBLICATION,
    rang: 1,
    motif: /target-repo exige le secret publish-key/,
    message: () => "Une publication vers un autre dépôt a été demandée sans clé de déploiement.",
  },
  {
    code: "publication-droits",
    categorie: CATEGORIES.PUBLICATION,
    rang: 1,
    motif:
      /Permission to [^\s]+ denied|Permission denied \(publickey\)|Write access to repository not granted|remote: Invalid username or password|could not read Username|403 Forbidden/,
    message: () => "Le dépôt cible a refusé l'écriture : droits insuffisants sur gh-pages.",
  },
  {
    code: "publication-echec",
    categorie: CATEGORIES.PUBLICATION,
    rang: 2,
    motif:
      /failed to push some refs|! \[remote rejected\]|fatal: (?:unable to access|could not read|repository)|error: src refspec/,
    message: () => "La poussée de la branche gh-pages a été rejetée.",
  },
  {
    code: "droits-root",
    categorie: CATEGORIES.INFRASTRUCTURE,
    rang: 1,
    etapes: /disque|rootfs|artefact/i,
    motif:
      /doit tourner en root|must be run as root|mke2fs: Permission denied|Operation not permitted/,
    message: () =>
      "La fabrication du disque a été lancée sans les droits root exigés par mke2fs et " +
      "l'extraction de l'arbre applicatif.",
  },
  {
    code: "docker-espace-disque",
    categorie: CATEGORIES.INFRASTRUCTURE,
    rang: 1,
    motif: /[Nn]o space left on device|write .*: no space/,
    message: () => "Le disque du runner est plein.",
  },
  {
    code: "docker-indisponible",
    categorie: CATEGORIES.INFRASTRUCTURE,
    rang: 1,
    motif:
      /Cannot connect to the Docker daemon|docker: command not found|docker introuvable|mke2fs introuvable|node introuvable/,
    message: () => "Un outil indispensable manque sur le runner (docker, node ou e2fsprogs).",
  },
  {
    code: "rails-echec",
    categorie: CATEGORIES.RAILS,
    rang: 3,
    motif: /(?:rails|rake) aborted!/,
    message: (_m, contexte) =>
      `Une tâche Rails lancée pendant la construction a échoué${detailErreurRuby(contexte.texte)}.`,
  },
  {
    code: "docker-etape-echouee",
    categorie: CATEGORIES.INFRASTRUCTURE,
    rang: 3,
    motif: /did not complete successfully: exit code|failed to solve|ERROR: failed to build/,
    message: () => "Une étape du build Docker s'est terminée en erreur.",
  },
]);

/**
 * Nomme la gem native fautive et le paquet système à ajouter à la base.
 * @param {string} texte journal nettoyé
 * @returns {string} message français
 */
function decrireGemNative(texte) {
  const gem =
    /An error occurred while installing ([\w.-]+)|Installing ([\w.-]+) [\d.]+ with native/.exec(
      texte,
    );
  const nom = gem?.[1] ?? gem?.[2] ?? null;
  const indice = PAQUET_PAR_INDICE.find(([motif]) => motif.test(texte));
  const paquet = indice?.[1] ?? (nom ? PAQUET_PAR_GEM[nom] : undefined);
  const sujet = nom ? `La gem native « ${nom} »` : "Une extension native";
  if (paquet) {
    return `${sujet} n'a pas pu compiler : la base ne fournit pas ${paquet}.`;
  }
  return `${sujet} n'a pas pu compiler : une bibliothèque système manque dans la base.`;
}

/**
 * Isole l'erreur Ruby la plus parlante du journal (classe qualifiée + message).
 * @param {string} texte journal nettoyé
 * @returns {string} fragment de phrase, vide si rien n'est reconnu
 */
function detailErreurRuby(texte) {
  const erreur = /^\s*([A-Z]\w*(?:::[A-Z]\w*)+):\s*(.+)$/m.exec(texte);
  if (!erreur) return "";
  const detail = erreur[2].trim().slice(0, 160);
  return ` — ${erreur[1]} : ${detail}`;
}

// ---------------------------------------------------------------------------
// Classification
// ---------------------------------------------------------------------------

/**
 * Classe l'échec d'une étape de construction.
 *
 * Une entrée non textuelle est traitée comme un journal vide : ce classifieur
 * s'exécute sur le chemin d'erreur, où lever une exception masquerait la panne
 * qu'on cherche justement à expliquer.
 * @param {string} journal texte du journal de l'étape échouée
 * @param {string} [etape] nom de l'étape (« Construction du disque applicatif »…)
 * @returns {Diagnostic} diagnostic immuable
 */
export function classifierEchec(journal, etape = "") {
  const brut = typeof journal === "string" ? journal : "";
  const nomEtape = typeof etape === "string" ? etape : "";
  if (brut.trim() === "") {
    return diagnostic("journal-vide", CATEGORIES.INCONNU, messageVide(nomEtape), "");
  }

  const lignes = decouper(brut);
  const texte = lignes
    .filter((ligne) => !ligne.bruit)
    .map((ligne) => ligne.texte)
    .join("\n");
  const contexte = { texte, etape: nomEtape };

  const candidats = [];
  for (const [ordre, regle] of REGLES.entries()) {
    if (regle.etapes && !regle.etapes.test(nomEtape)) continue;
    if (regle.garde && !regle.garde(contexte)) continue;
    for (let index = 0; index < lignes.length; index += 1) {
      if (lignes[index].bruit) continue;
      const correspondance = regle.motif.exec(lignes[index].texte);
      if (!correspondance) continue;
      candidats.push({ regle, ordre, index, correspondance });
      break;
    }
  }
  if (candidats.length === 0) {
    return diagnostic("inconnu", CATEGORIES.INCONNU, messageInconnu(nomEtape), extraireFin(lignes));
  }

  // Rang d'abord (une cause nommée prime un constat générique), puis position :
  // à spécificité égale, la première cause du journal est la cause d'origine.
  candidats.sort((a, b) => a.regle.rang - b.regle.rang || a.index - b.index || a.ordre - b.ordre);
  const gagnant = candidats[0];
  return diagnostic(
    gagnant.regle.code,
    gagnant.regle.categorie,
    gagnant.regle.message(gagnant.correspondance, contexte),
    extraireAutour(lignes, gagnant.index),
  );
}

/**
 * Assemble un diagnostic gelé, remède compris.
 * @param {string} code identifiant stable
 * @param {string} categorie famille
 * @param {string} message phrase française
 * @param {string} extrait lignes du journal
 * @returns {Diagnostic} diagnostic immuable
 */
function diagnostic(code, categorie, message, extrait) {
  return Object.freeze({
    categorie,
    code,
    message: caviarder(message),
    remede: REMEDES[code] ?? REMEDES.inconnu,
    extrait,
  });
}

/**
 * @param {string} etape nom de l'étape
 * @returns {string} message du journal vide
 */
function messageVide(etape) {
  return etape
    ? `L'étape « ${etape} » a échoué sans laisser de journal exploitable.`
    : "L'étape a échoué sans laisser de journal exploitable.";
}

/**
 * @param {string} etape nom de l'étape
 * @returns {string} message du repli inconnu
 */
function messageInconnu(etape) {
  return etape
    ? `Échec non classé de l'étape « ${etape} » : aucun motif connu ne correspond.`
    : "Échec non classé : aucun motif connu ne correspond.";
}

// ---------------------------------------------------------------------------
// Mise en forme pour le résumé GitHub
// ---------------------------------------------------------------------------

/**
 * Met le diagnostic en Markdown, prêt pour GITHUB_STEP_SUMMARY.
 * @param {Diagnostic} diag diagnostic issu de {@link classifierEchec}
 * @param {string} [etape] nom de l'étape échouée
 * @returns {string} bloc Markdown terminé par un saut de ligne
 */
export function formaterEchec(diag, etape = "") {
  const lignes = [
    "### Pourquoi la construction a échoué",
    "",
    `**Étape** : ${etape || "inconnue"}`,
    "",
    `**Catégorie** : ${diag.categorie} (\`${diag.code}\`)`,
    "",
    diag.message,
    "",
  ];
  if (diag.extrait) {
    const cloture = "`".repeat(Math.max(3, plusLongueSuiteDApostrophes(diag.extrait) + 1));
    lignes.push("**Extrait du journal**", "", `${cloture}text`, diag.extrait, cloture, "");
  }
  lignes.push(`**Remède** : ${diag.remede}`, "");
  return `${lignes.join("\n")}\n`;
}

/**
 * Longueur de la plus longue suite d'accents graves du texte : la clôture du
 * bloc de code doit être plus longue, sinon un extrait qui en contient casse
 * la mise en forme du résumé.
 * @param {string} texte extrait à encadrer
 * @returns {number} longueur de la plus longue suite
 */
function plusLongueSuiteDApostrophes(texte) {
  let record = 0;
  for (const suite of texte.match(/`+/g) ?? []) record = Math.max(record, suite.length);
  return record;
}

// ---------------------------------------------------------------------------
// Interface en ligne de commande (appelée par le workflow)
//   node classifier-echec.mjs --etape "<nom>" --journal <fichier>
// Écrit le bloc Markdown sur la sortie standard. Ne sort JAMAIS en erreur : le
// diagnostic ne doit pas masquer la panne qu'il explique.
// ---------------------------------------------------------------------------
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const argv = process.argv.slice(2);
  const option = (nom) => {
    const position = argv.indexOf(nom);
    return position === -1 ? null : (argv[position + 1] ?? null);
  };
  const etape = option("--etape") ?? "";
  const chemin = option("--journal");
  let journal;
  try {
    journal = readFileSync(chemin ?? 0, "utf8");
  } catch (erreur) {
    journal = "";
    process.stderr.write(`[classifier-echec] journal illisible : ${erreur.message}\n`);
  }
  process.stdout.write(formaterEchec(classifierEchec(journal, etape), etape));
}
