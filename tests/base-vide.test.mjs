// Des seeds qui tournent n'insèrent pas forcément quoi que ce soit.
//
// CE QUE CE CONTRÔLE AJOUTE. L'analyse amont sait déjà refuser le cas facile :
// db/seeds.rb absent, vide, ou réduit à des commentaires — c'est le diagnostic
// [sandbox-sans-donnees]. Mais elle lit un FICHIER, elle n'exécute rien. Un
// seeds.rb de trente lignes bien réelles peut ne rien créer :
//
//   if admin_email && admin_password
//     User.create!(...)
//   else
//     puts "ADMIN_EMAIL and ADMIN_PASSWORD are not set; skipping."
//   end
//
// C'est un patron courant sur une application déployable, et il passe sous le
// radar : construction verte de bout en bout, seeds « exécutés », base vide.
// Mesuré le 20/08/2026 sur une application tierce — la sandbox ouvrait sur
// « Create your account · This is the first account on this server ».
//
// La panne est SILENCIEUSE, et c'est ce qui la rend chère : personne ne la voit
// avant le premier visiteur. On compte donc réellement, dans le conteneur de
// construction où la base existe encore, et le résultat remonte par un marqueur
// que build-app-disk.sh relit après l'export.
//
// DEUX INVARIANTS PROTÈGENT LE MÉCANISME, et pas seulement sa présence : le
// comptage ne doit JAMAIS faire échouer une construction (c'est un confort de
// diagnostic, pas un refus), et le marqueur ne doit JAMAIS voyager dans le
// disque livré — un fichier de diagnostic publié à chaque visiteur serait une
// régression en soi.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const RACINE = join(dirname(fileURLToPath(import.meta.url)), "..");
const OUTILS = join(RACINE, "tools", "build-v86-image");

const APP_DOCKERFILE = readFileSync(join(OUTILS, "base", "app.Dockerfile"), "utf8");
const BUILD_SCRIPT = readFileSync(join(OUTILS, "build-app-disk.sh"), "utf8");

/** Chemin du marqueur, partagé par les deux fichiers. */
const MARQUEUR = ".railsbox/base-vide";

test("le comptage n'a lieu qu'après des seeds réellement demandés", () => {
  // Sans commande de seed, le cas est déjà couvert en amont par
  // [sandbox-sans-donnees] : compter ici ne dirait rien de neuf et coûterait un
  // démarrage complet de Rails.
  const bloc = APP_DOCKERFILE.slice(APP_DOCKERFILE.indexOf('if [ -n "${SEED_COMMAND}" ]'));
  const jusquAuFi = bloc.slice(0, bloc.indexOf("\nfi\n"));
  assert.match(jusquAuFi, /rails runner/, "le comptage doit vivre dans le garde SEED_COMMAND");
});

test("le comptage écarte les tables internes de Rails", () => {
  // schema_migrations et ar_internal_metadata sont peuplées par db:prepare sur
  // TOUTE application : les compter rendrait le contrôle toujours vert, donc
  // inutile.
  assert.match(APP_DOCKERFILE, /internes\s*=\s*%w\[schema_migrations ar_internal_metadata\]/);
});

test("le comptage ne peut pas faire échouer la construction", () => {
  // Un confort de diagnostic qui casse un build est pire que pas de diagnostic.
  // Deux filets : le rescue Ruby, et le `||` shell qui couvre l'échec du
  // démarrage de Rails lui-même.
  assert.match(APP_DOCKERFILE, /rescue StandardError/, "erreur Ruby avalée, en le disant");
  assert.match(
    APP_DOCKERFILE,
    /rails runner \/tmp\/rib-compter\.rb \|\| echo/,
    "un runner qui ne démarre pas ne doit pas arrêter la construction",
  );
});

test("le marqueur n'est posé QUE sur une base vide", () => {
  assert.match(
    APP_DOCKERFILE,
    new RegExp(`File\\.write\\("/app/${MARQUEUR}", ""\\) if total\\.zero\\?`),
    "poser le marqueur sans condition avertirait toutes les sandboxes",
  );
});

test("le script de construction relit le marqueur et avertit", () => {
  assert.match(BUILD_SCRIPT, /base-vide/, "build-app-disk.sh doit relire le marqueur");
  const bloc = BUILD_SCRIPT.slice(BUILD_SCRIPT.indexOf('if [ -f "$BASE_VIDE" ]'));
  const jusquAuFi = bloc.slice(0, bloc.indexOf("\nfi\n"));
  assert.match(jusquAuFi, /⚠/, "l'avertissement doit être visible dans le journal");
  assert.match(jusquAuFi, /railsbox\.yml/, "il doit nommer le geste qui répare");
});

test("le marqueur ne voyage pas dans le disque livré", () => {
  // Il est lu sur l'arbre exporté, AVANT la fabrication de l'ext2 : un fichier
  // de diagnostic publié à chaque visiteur serait une régression.
  const bloc = BUILD_SCRIPT.slice(BUILD_SCRIPT.indexOf('if [ -f "$BASE_VIDE" ]'));
  const jusquAuFi = bloc.slice(0, bloc.indexOf("\nfi\n"));
  assert.match(jusquAuFi, /rm -f "\$BASE_VIDE"/, "le marqueur doit être effacé après lecture");

  const positionLecture = BUILD_SCRIPT.indexOf('if [ -f "$BASE_VIDE" ]');
  const positionExport = BUILD_SCRIPT.indexOf("docker export");
  // La FABRICATION, pas le contrôle de prérequis en tête de fichier : `mke2fs`
  // y apparaît d'abord dans un `command -v`, bien avant l'export.
  const positionExt2 = BUILD_SCRIPT.indexOf('mke2fs -q -t ext2 -b 4096 -d "$WORK_DIR/app"');
  assert.ok(positionExport !== -1 && positionExt2 !== -1, "les deux jalons doivent exister");
  assert.ok(
    positionExport < positionLecture && positionLecture < positionExt2,
    "la lecture doit tomber entre l'export du conteneur et la fabrication de l'ext2",
  );
});

test("l'avertissement ne prétend pas être un refus", () => {
  // Une base vide reste une sandbox légitime : une vitrine, une documentation,
  // une application qui se remplit à l'usage. On avertit, on ne bloque pas.
  const bloc = BUILD_SCRIPT.slice(BUILD_SCRIPT.indexOf('if [ -f "$BASE_VIDE" ]'));
  const jusquAuFi = bloc.slice(0, bloc.indexOf("\nfi\n"));
  assert.doesNotMatch(jusquAuFi, /exit 1/, "une base vide ne doit pas arrêter la construction");
});
