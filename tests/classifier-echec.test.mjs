// Un cas par code de la taxonomie, sur des extraits de journaux RÉALISTES
// (sortie BuildKit préfixée, messages de bundler, de Rails, de git), plus les
// cas limites : journal vide, bruit pur, causes multiples, secrets.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  CATEGORIES,
  REMEDES,
  caviarder,
  classifierEchec,
  formaterEchec,
} from "../tools/build-v86-image/classifier-echec.mjs";

/**
 * Classe un journal et vérifie l'invariant commun : tout diagnostic porte un
 * remède non vide, quelle que soit la catégorie.
 * @param {string} journal journal de l'étape
 * @param {string} [etape] nom de l'étape
 * @returns {import("../tools/build-v86-image/classifier-echec.mjs").Diagnostic} diagnostic
 */
function classer(journal, etape = "Construction du disque applicatif") {
  const diagnostic = classifierEchec(journal, etape);
  assert.ok(diagnostic.remede.length > 20, `remède absent pour ${diagnostic.code}`);
  assert.equal(diagnostic.remede, REMEDES[diagnostic.code]);
  return diagnostic;
}

// --- Analyse amont ---------------------------------------------------------

test("un refus de l'analyse amont renvoie au rapport de détection", () => {
  const diagnostic = classer(
    [
      "--- Bloquant (1) ---",
      "- [missing-gemfile-lock] Gemfile.lock absent : les gems natives restent invisibles.",
      "✗ Construction refusée : voir le rapport ci-dessus.",
    ].join("\n"),
  );
  assert.equal(diagnostic.code, "refus-amont");
  assert.equal(diagnostic.categorie, CATEGORIES.ANALYSE);
  assert.match(diagnostic.extrait, /missing-gemfile-lock/);
});

// --- Dépendances système de la base ---------------------------------------

test("un paquet absent de la base est nommé tel quel", () => {
  const diagnostic = classer(
    [
      "→ Analyse de l'application (/home/runner/work/demo/application)…",
      "✗ La base ne fournit pas les bibliothèques système : libvips-dev",
      "  Ajoutez ces paquets à tools/build-v86-image/base/Dockerfile puis reconstruisez",
    ].join("\n"),
  );
  assert.equal(diagnostic.code, "base-paquet-manquant");
  assert.equal(diagnostic.categorie, CATEGORIES.DEPENDANCE_SYSTEME);
  assert.match(diagnostic.message, /libvips-dev/);
});

test("un paquet inexistant en i386 est nommé, avec le seul remède possible", () => {
  // Arrange : la surcouche installe ce qu'on lui nomme, elle ne traduit pas.
  // Un nom absent de l'archive i386 ne peut être fourni d'aucune façon —
  // c'est le refus qui reste après l'ADR 0006.
  const diagnostic = classer(
    [
      "#12 3.104 [build] surcouche système demandée : libtruc-machin",
      "#12 4.201 E: Unable to locate package libtruc-machin",
    ].join("\n"),
  );

  assert.equal(diagnostic.code, "surcouche-paquet-inconnu");
  assert.equal(diagnostic.categorie, CATEGORIES.DEPENDANCE_SYSTEME);
  assert.match(diagnostic.message, /libtruc-machin/);
  assert.match(diagnostic.remede, /packages\.debian\.org/);
});

test("une surcouche qui déborde du disque applicatif est chiffrée", () => {
  // ffmpeg pèse 623 Mo relocalisés (mesuré) : le disque applicatif en fait 512,
  // application et bundle compris. Le diagnostic porte le chiffre.
  const diagnostic = classer(
    [
      "#17 4.607 [build] surcouche relocalisée : 623 Mo dans /app/opt/systeme",
      "#17 4.607 ✗ La surcouche système pèse 623 Mo, au-delà des 307 Mo qu'un",
    ].join("\n"),
  );

  assert.equal(diagnostic.code, "surcouche-trop-lourde");
  assert.equal(diagnostic.categorie, CATEGORIES.DEPENDANCE_SYSTEME);
  assert.match(diagnostic.message, /623 Mo/);
  assert.match(diagnostic.remede, /system_packages/);
});

test("une extension native nomme la gem ET le paquet Debian à ajouter", () => {
  const diagnostic = classer(
    [
      "#12 12.42 Fetching pg 1.5.9",
      "#12 18.01 Installing pg 1.5.9 with native extensions",
      "#12 21.55 Gem::Ext::BuildError: ERROR: Failed to build gem native extension.",
      "#12 21.55     current directory: /app/vendor/bundle/ruby/3.3.0/gems/pg-1.5.9/ext",
      "#12 21.55 checking for pg_config... no",
      "#12 21.55 Can't find the 'libpq-fe.h header",
      "#12 21.55 *** extconf.rb failed ***",
      "#12 21.60 An error occurred while installing pg (1.5.9), and Bundler cannot continue.",
      '#12 ERROR: process "/bin/sh -c bundle install" did not complete successfully: exit code: 5',
    ].join("\n"),
  );
  assert.equal(diagnostic.code, "gem-native-entete-manquante");
  assert.match(diagnostic.message, /« pg »/);
  assert.match(diagnostic.message, /libpq-dev/);
  // L'extrait doit PROUVER le diagnostic, préfixes BuildKit retirés.
  assert.match(diagnostic.extrait, /Can't find the 'libpq-fe\.h/);
  assert.doesNotMatch(diagnostic.extrait, /^#12/m);
});

test("une extension native sans en-tête nommé retombe sur le paquet de la gem", () => {
  const diagnostic = classer(
    [
      "Gem::Ext::BuildError: ERROR: Failed to build gem native extension.",
      "make: *** [Makefile:245: nokogiri.o] Error 1",
      "An error occurred while installing nokogiri (1.16.5), and Bundler cannot continue.",
    ].join("\n"),
  );
  assert.equal(diagnostic.code, "gem-native-entete-manquante");
  assert.match(diagnostic.message, /nokogiri/);
  assert.match(diagnostic.message, /libxml2-dev/);
});

// --- Image de base ---------------------------------------------------------

test("une base antérieure à 3.3-r2 est signalée comme dépourvue de PostgreSQL", () => {
  const diagnostic = classer(
    "✗ L'image de base ghcr.io/pinfada/railsbox-base:3.3 ne fournit pas PostgreSQL 15.",
  );
  assert.equal(diagnostic.code, "base-sans-postgres");
  assert.equal(diagnostic.categorie, CATEGORIES.IMAGE_DE_BASE);
});

test("un tag de base inexistant est distingué d'un échec de construction", () => {
  const diagnostic = classer(
    'Error response from daemon: manifest unknown: manifest tagged by "9.9" is not found',
  );
  assert.equal(diagnostic.code, "base-image-introuvable");
});

// --- Installation des gems -------------------------------------------------

test("un lockfile sans plateforme i386 est reconnu", () => {
  const diagnostic = classer(
    [
      '#12 4.10 Your bundle only supports platforms ["x86_64-linux"] but your local platform',
      "#12 4.10 is x86-linux. Add the current platform to the lockfile with",
      "#12 4.10 `bundle lock --add-platform x86-linux` and try again.",
    ].join("\n"),
  );
  assert.equal(diagnostic.code, "bundle-plateforme");
  assert.equal(diagnostic.categorie, CATEGORIES.BUNDLE);
});

test("un désaccord de version de Ruby cite les deux versions", () => {
  const diagnostic = classer("Your Ruby version is 3.3.12, but your Gemfile specified 3.2.2");
  assert.equal(diagnostic.code, "bundle-version-ruby");
  assert.match(diagnostic.message, /3\.3\.12/);
  assert.match(diagnostic.message, /3\.2\.2/);
});

test("une panne réseau de rubygems invite à relancer", () => {
  const diagnostic = classer(
    [
      "#12 8.03 Retrying download gem from https://rubygems.org/ due to error (2/4):",
      "#12 8.03 Gem::RemoteFetcher::FetchError Errno::ECONNRESET: Connection reset by peer",
    ].join("\n"),
  );
  assert.equal(diagnostic.code, "bundle-reseau");
  assert.match(diagnostic.remede, /Relancez/);
});

test("une gem absente de la résolution est distinguée d'une compilation ratée", () => {
  const diagnostic = classer("Could not find gem 'rails (~> 7.2.0)' in locally installed gems.");
  assert.equal(diagnostic.code, "bundle-gem-introuvable");
});

test("un échec de bundle sans cause reconnue nomme au moins la gem", () => {
  const diagnostic = classer(
    [
      "An error occurred while installing bcrypt (3.1.20), and Bundler cannot continue.",
      '#12 ERROR: process "/bin/sh -c bundle install" did not complete successfully: exit code: 5',
    ].join("\n"),
  );
  assert.equal(diagnostic.code, "bundle-echec");
  assert.match(diagnostic.message, /« bcrypt »/);
});

// --- Credentials -----------------------------------------------------------

test("une clé de credentials absente n'est pas mise sur le dos des assets", () => {
  // Journal RÉEL d'une application tierce : Rails n'imprime que le message, et
  // la seule autre ligne utile — celle de l'échec BuildKit — contient
  // « assets:precompile ». Le constat générique gagnait, et envoyait le
  // mainteneur déboguer une chaîne d'assets qui n'a rien fait de mal.
  const diagnostic = classer(
    [
      "#16 2.004 Missing encryption key to decrypt file with. Ask your team for your master key" +
        " and write it to /app/config/master.key or put it in the ENV['RAILS_MASTER_KEY'].",
      '#16 ERROR: process "/bin/sh -c bundle exec rails assets:precompile" did not complete' +
        " successfully: exit code: 1",
    ].join("\n"),
  );
  assert.equal(diagnostic.code, "credentials-cle-absente");
  assert.equal(diagnostic.categorie, CATEGORIES.RAILS);
  assert.match(diagnostic.remede, /JETABLE/);
});

test("une clé qui ne déchiffre pas ses propres credentials est distinguée d'une clé absente", () => {
  const diagnostic = classer(
    "#16 1.9 ActiveSupport::MessageEncryptor::InvalidMessage (ActiveSupport::MessageEncryptor::InvalidMessage)",
  );
  assert.equal(diagnostic.code, "credentials-cle-invalide");
  assert.match(diagnostic.remede, /credentials:show/);
});

// --- Précompilation des assets --------------------------------------------

test("un étage amd64 muet est un échec explicite", () => {
  const diagnostic = classer("✗ L'étage amd64 n'a produit aucun asset dans public/assets.");
  assert.equal(diagnostic.code, "assets-vides");
  assert.equal(diagnostic.categorie, CATEGORIES.ASSETS);
});

test("un binaire amd64 exécuté dans le guest i386 est nommé pour ce qu'il est", () => {
  const diagnostic = classer(
    [
      "#15 3.20 sh: 1: /app/vendor/bundle/ruby/3.3.0/gems/tailwindcss-ruby-4.0.0/exe/tailwindcss:",
      "#15 3.20 cannot execute binary file: Exec format error",
    ].join("\n"),
  );
  assert.equal(diagnostic.code, "assets-format-binaire");
  assert.match(diagnostic.remede, /amd64/);
});

test("un outil d'assets absent de l'étage est distingué d'une erreur d'architecture", () => {
  const diagnostic = classer("sh: 1: esbuild: not found");
  assert.equal(diagnostic.code, "assets-binaire-absent");
});

test("un assets:precompile en échec extrait l'erreur Ruby", () => {
  const diagnostic = classer(
    [
      "rake aborted!",
      "Sprockets::Rails::Helper::AssetNotPrecompiled: Asset `application.css` is not present",
      "/app/app/views/layouts/application.html.erb:9",
    ].join("\n"),
  );
  assert.equal(diagnostic.code, "assets-precompile-echec");
  assert.match(diagnostic.message, /AssetNotPrecompiled/);
});

// --- Base de données -------------------------------------------------------

test("un cluster PostgreSQL injoignable est distingué d'une migration fautive", () => {
  const diagnostic = classer(
    [
      "rails aborted!",
      'PG::ConnectionBad: connection to server on socket "/var/run/postgresql/.s.PGSQL.5432"',
      "failed: No such file or directory",
    ].join("\n"),
  );
  assert.equal(diagnostic.code, "db-connexion");
  assert.equal(diagnostic.categorie, CATEGORIES.BASE_DE_DONNEES);
});

test("une migration en échec porte l'erreur SQL exacte", () => {
  const diagnostic = classer(
    [
      "== 20240612093000 AddUniqueIndexToUsers: migrating ====",
      "-- add_index(:users, :email, {:unique=>true})",
      "rails aborted!",
      "StandardError: An error has occurred, all later migrations canceled:",
      'PG::UniqueViolation: ERROR:  could not create unique index "index_users_on_email"',
    ].join("\n"),
  );
  assert.equal(diagnostic.code, "db-migration");
  assert.match(diagnostic.message, /PG::UniqueViolation/);
});

test("un seed en échec renvoie à l'idempotence sur base vierge", () => {
  const diagnostic = classer(
    [
      "rails aborted!",
      "ActiveRecord::RecordInvalid: Validation failed: Email has already been taken",
      "/app/db/seeds.rb:14:in `block in <main>'",
    ].join("\n"),
  );
  assert.equal(diagnostic.code, "db-seed");
  assert.match(diagnostic.message, /RecordInvalid/);
  assert.match(diagnostic.remede, /vierge|idempotent/);
});

test("une validation en échec après un avertissement de migration porteuse désigne la vraie cause", () => {
  const diagnostic = classer(
    [
      "- [data-bearing-migration] 1 migration écrit des données (execute d'un INSERT SQL) :",
      "  db/migrate/20260514210000_create_currencies.rb.",
      "+ bundle exec rails db:prepare",
      "+ bin/rails runner db/seeds_api.rb",
      "rails aborted!",
      "ActiveRecord::RecordInvalid: Validation failed: Currency XAF non supporté (attendu : )",
      "/app/db/seeds_api.rb:131:in `block in <main>'",
    ].join("\n"),
  );
  assert.equal(diagnostic.code, "db-donnees-de-migration-absentes");
  assert.equal(diagnostic.categorie, CATEGORIES.BASE_DE_DONNEES);
  assert.match(diagnostic.message, /table de référence restée VIDE/);
  assert.match(diagnostic.remede, /db\/seeds\.rb|database_prepare/);
});

test("sans l'avertissement amont, la même validation reste un simple échec de seed", () => {
  // La garde est ce qui sépare les deux : « Validation failed » tout seul est
  // le symptôme le plus banal du monde, il ne prouve rien.
  const diagnostic = classer(
    [
      "+ bin/rails db:seed",
      "rails aborted!",
      "ActiveRecord::RecordInvalid: Validation failed: Email has already been taken",
      "/app/db/seeds.rb:14:in `block in <main>'",
    ].join("\n"),
  );
  assert.equal(diagnostic.code, "db-seed");
});

test("une préparation de base sans erreur reconnue reste dans la famille base de données", () => {
  const diagnostic = classer(
    [
      "+ bundle exec rails db:prepare",
      "ActiveRecord::ConnectionNotEstablished",
      '#16 ERROR: process "/bin/sh -c set -eu" did not complete successfully: exit code: 1',
    ].join("\n"),
  );
  assert.equal(diagnostic.code, "db-echec");
});

test("une tâche Rails quelconque est classée sans être confondue avec la base", () => {
  const diagnostic = classer(
    [
      "rake aborted!",
      "NoMethodError: undefined method `call' for nil",
      "/app/config/initializers/telemetrie.rb:3:in `<main>'",
    ].join("\n"),
  );
  assert.equal(diagnostic.code, "rails-echec");
  assert.equal(diagnostic.categorie, CATEGORIES.RAILS);
});

// --- Volumétrie ------------------------------------------------------------

test("un débordement de la géométrie fixe rappelle qu'elle ne peut pas changer", () => {
  const diagnostic = classer(
    [
      "  Contenu /app : 631 Mo (cible 512 Mo)",
      "✗ Le contenu applicatif (631 Mo) dépasse la géométrie fixe (512 Mo).",
    ].join("\n"),
  );
  assert.equal(diagnostic.code, "disque-app-trop-gros");
  assert.equal(diagnostic.categorie, CATEGORIES.VOLUMETRIE);
});

test("la limite de GitHub Pages déjà gardée par le workflow est intégrée", () => {
  const diagnostic = classer(
    [
      "::error::Fichiers au-delà de la limite de GitHub Pages :",
      "demo-split-state.bin.gz (104857600 octets)",
    ].join("\n"),
    "Assemblage de la coquille",
  );
  assert.equal(diagnostic.code, "limite-pages");
  assert.match(diagnostic.extrait, /104857600/);
});

// --- Instantané ------------------------------------------------------------

test("une capture d'instantané qui expire pointe l'environnement manquant", () => {
  const diagnostic = classer(
    [
      "[delta-snapshot] attente de la sonde applicative (/app/)…",
      "[delta-snapshot] sonde n°6 : délai dépassé en attendant la VM",
      "[delta-snapshot] ÉCHEC : l'application n'a jamais répondu dans la VM",
    ].join("\n"),
    "Capture du delta d'instantané",
  );
  assert.equal(diagnostic.code, "instantane-timeout");
  assert.equal(diagnostic.categorie, CATEGORIES.INSTANTANE);
  assert.match(diagnostic.remede, /env:/);
});

test("une capture interrompue avant le gel reste dans la famille instantané", () => {
  const diagnostic = classer(
    "[delta-snapshot] ÉCHEC : disque applicatif introuvable (/repo/public/disks/demo-app.ext2)",
    "Capture du delta d'instantané",
  );
  assert.equal(diagnostic.code, "instantane-echec");
});

// --- Publication -----------------------------------------------------------

test("une publication vers un autre dépôt sans clé est nommée", () => {
  const diagnostic = classer(
    "::error::target-repo exige le secret publish-key (clé de déploiement en écriture).",
    "Publication sur gh-pages",
  );
  assert.equal(diagnostic.code, "publication-cle-absente");
  assert.equal(diagnostic.categorie, CATEGORIES.PUBLICATION);
});

test("un refus d'écriture est classé, et le jeton du journal est caviardé", () => {
  const diagnostic = classer(
    [
      "remote: Permission to pinfada/demo.git denied to github-actions[bot].",
      "fatal: unable to access " +
        "'https://x-access-token:ghs_AbCdEf0123456789XyZwVuTsRq@github.com/pinfada/demo.git/':" +
        " The requested URL returned error: 403",
    ].join("\n"),
    "Publication sur gh-pages",
  );
  assert.equal(diagnostic.code, "publication-droits");
  assert.doesNotMatch(diagnostic.extrait, /ghs_AbCdEf/);
  assert.match(diagnostic.extrait, /https:\/\/\*\*\*:\*\*\*@github\.com/);
});

test("une poussée rejetée sans cause de droits reste dans la famille publication", () => {
  const diagnostic = classer(
    [
      " ! [remote rejected] gh-pages -> gh-pages (protected branch hook declined)",
      "error: failed to push some refs to 'https://github.com/pinfada/demo.git'",
    ].join("\n"),
    "Publication sur gh-pages",
  );
  assert.equal(diagnostic.code, "publication-echec");
});

// --- Infrastructure --------------------------------------------------------

test("l'exigence de root ne vaut que pour les étapes de fabrication du disque", () => {
  const journal = "build-app-disk.sh doit tourner en root (préservation des uid à l'extraction).";
  assert.equal(classer(journal, "Construction du disque applicatif").code, "droits-root");
  // Hors de ces étapes, la règle ne s'applique pas : le même texte ne prouve rien.
  assert.equal(classer(journal, "Publication sur gh-pages").code, "inconnu");
});

test("un runner plein est distingué d'un échec de build Docker", () => {
  const diagnostic = classer(
    "failed to solve: write /var/lib/docker/overlay2/deadbeef: no space left on device",
  );
  assert.equal(diagnostic.code, "docker-espace-disque");
});

test("un outil absent du runner est nommé", () => {
  const diagnostic = classer(
    "Cannot connect to the Docker daemon at unix:///var/run/docker.sock. Is the daemon running?",
  );
  assert.equal(diagnostic.code, "docker-indisponible");
});

test("un échec Docker sans cause reconnue reste un constat honnête", () => {
  const diagnostic = classer(
    '#14 ERROR: process "/bin/sh -c set -eu; ./bin/rails runner Bootstrap.call" ' +
      "did not complete successfully: exit code: 137",
  );
  assert.equal(diagnostic.code, "docker-etape-echouee");
  assert.equal(diagnostic.categorie, CATEGORIES.INFRASTRUCTURE);
});

// --- Cas limites -----------------------------------------------------------

test("un journal vide ne prétend pas diagnostiquer", () => {
  for (const vide of ["", "   ", "\n\n\t\n"]) {
    const diagnostic = classer(vide);
    assert.equal(diagnostic.code, "journal-vide");
    assert.equal(diagnostic.extrait, "");
  }
});

test("une entrée non textuelle est traitée comme un journal vide, sans lever", () => {
  for (const entree of [null, undefined, 42, {}]) {
    // @ts-expect-error entrée volontairement invalide : le classifieur tourne
    // sur le chemin d'erreur, lever y masquerait la panne à expliquer.
    const diagnostic = classifierEchec(entree, "Capture du delta d'instantané");
    assert.equal(diagnostic.code, "journal-vide");
  }
});

test("du bruit Docker pur ne produit ni faux diagnostic ni faux extrait", () => {
  const diagnostic = classer(
    [
      "#5 DONE 0.1s",
      "#6 CACHED",
      "#7 sha256:0d1f2e3a4b5c6d7e8f90",
      "#8 [ 2/12] COPY Gemfile* ./",
      "Fetching gem metadata from https://rubygems.org/",
      "Using rake 13.0.6",
      "Digest: sha256:aaaabbbbcccc",
      "",
    ].join("\n"),
  );
  assert.equal(diagnostic.code, "inconnu");
  assert.equal(diagnostic.categorie, CATEGORIES.INCONNU);
  assert.equal(diagnostic.extrait, "");
});

test("un échec inconnu livre les dernières lignes utiles, bruit retiré", () => {
  const lignes = [];
  for (let i = 0; i < 60; i += 1) lignes.push(`#9 1.${i} ligne utile numéro ${i}`);
  lignes.push("#9 DONE 12.3s");
  const diagnostic = classer(lignes.join("\n"), "Découpage des artefacts de l'application");
  assert.equal(diagnostic.code, "inconnu");
  const retenues = diagnostic.extrait.split("\n");
  assert.equal(retenues.length, 30);
  assert.equal(retenues.at(-1), "ligne utile numéro 59");
  assert.doesNotMatch(diagnostic.extrait, /DONE/);
});

test("entre deux causes de même rang, la PREMIÈRE du journal l'emporte", () => {
  const diagnostic = classer(
    [
      "#12 8.03 Gem::RemoteFetcher::FetchError: Could not reach host rubygems.org",
      "#12 9.10 An error occurred while installing sqlite3 (2.0.2), and Bundler cannot continue.",
      "#15 3.20 sh: 1: esbuild: not found",
    ].join("\n"),
  );
  assert.equal(diagnostic.code, "bundle-reseau");
});

test("une cause nommée l'emporte sur un constat générique qui la précède", () => {
  const diagnostic = classer(
    [
      "rake aborted!",
      "quelque chose s'est mal passé pendant la préparation",
      "PG::ConnectionBad: could not connect to server",
    ].join("\n"),
  );
  assert.equal(diagnostic.code, "db-connexion");
});

test("une ligne démesurée est tronquée dans l'extrait", () => {
  const diagnostic = classer(
    ["✗ La base ne fournit pas les bibliothèques système : libvips-dev", "x".repeat(500)].join(
      "\n",
    ),
  );
  const longue = diagnostic.extrait.split("\n").at(-1);
  assert.equal(longue.length, 201);
  assert.ok(longue.endsWith("…"));
});

test("un jeton au-delà de la troncature est caviardé quand même", () => {
  // Le défaut : la ligne était tronquée à 200 caractères AVANT le caviardage.
  // Un jeton qui commençait au 190e caractère se retrouvait coupé en deux, le
  // motif ne le reconnaissait plus, et sa moitié gauche partait telle quelle
  // dans un résumé PUBLIC. On caviarde donc d'abord, on tronque ensuite.
  // Le jeton commence au 185e caractère : tronquer d'abord n'en laissait que
  // quinze, trop peu pour que le motif (16 caractères au minimum) le
  // reconnaisse — « ghp_0123456789a » atterrissait donc en clair.
  const jeton = "ghp_0123456789abcdefghijklmnop";
  const diagnostic = classer(
    [
      "✗ La base ne fournit pas les bibliothèques système : libvips-dev",
      `${"x".repeat(162)} Authorization: Bearer ${jeton} suite`,
    ].join("\n"),
  );
  assert.doesNotMatch(diagnostic.extrait, /ghp_/, "pas même un fragment de jeton");
});

test("caviarder retire clés privées et jetons, y compris hors URL", () => {
  const assaini = caviarder(
    [
      "-----BEGIN OPENSSH PRIVATE KEY-----",
      "b3BlbnNzaC1rZXktdjEAAAAABG5vbmU=",
      "-----END OPENSSH PRIVATE KEY-----",
      "Authorization: Bearer ghp_0123456789abcdefghijklmnop",
      "token=github_pat_11ABCDEFG0123456789_abcdefghij",
    ].join("\n"),
  );
  assert.doesNotMatch(assaini, /b3BlbnNzaC/);
  assert.doesNotMatch(assaini, /ghp_0123456789/);
  assert.doesNotMatch(assaini, /github_pat_11ABC/);
  assert.match(assaini, /\[clé privée retirée\]/);
});

// --- Mise en forme du résumé ----------------------------------------------

test("le bloc Markdown porte étape, catégorie, extrait et remède", () => {
  const diagnostic = classifierEchec(
    "✗ La base ne fournit pas les bibliothèques système : libvips-dev",
    "Construction du disque applicatif",
  );
  const bloc = formaterEchec(diagnostic, "Construction du disque applicatif");
  assert.match(bloc, /^### Pourquoi la construction a échoué/);
  assert.match(bloc, /\*\*Étape\*\* : Construction du disque applicatif/);
  assert.match(bloc, /\*\*Catégorie\*\* : .+ \(`base-paquet-manquant`\)/);
  assert.match(bloc, /```text\n/);
  // Le remède ne redit pas « ajoutez ces paquets » : le refus imprimé plus haut
  // dans le journal nomme déjà la révision de base à épingler, ou l'issue à
  // ouvrir. Il y renvoie, et le vérifier ici empêche les deux de diverger.
  assert.match(bloc, /\*\*Remède\*\* : Le refus, juste au-dessus/);
  assert.match(bloc, /épinglez-la/);
  assert.match(bloc, /Ma stack n'est pas prise en charge/);
  assert.ok(bloc.endsWith("\n"));
});

test("la clôture du bloc de code s'allonge quand l'extrait contient des accents graves", () => {
  const diagnostic = classifierEchec(
    ["rake aborted!", "NoMethodError: undefined method ```call``` for nil"].join("\n"),
    "Construction du disque applicatif",
  );
  const bloc = formaterEchec(diagnostic, "Construction du disque applicatif");
  assert.match(bloc, /````text\n/);
});

test("un journal vide produit un bloc sans section extrait", () => {
  const bloc = formaterEchec(
    classifierEchec("", "Publication sur gh-pages"),
    "Publication sur gh-pages",
  );
  assert.doesNotMatch(bloc, /Extrait du journal/);
  assert.match(bloc, /\*\*Remède\*\* : /);
});
