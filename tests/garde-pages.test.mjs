// Ce que le workflow a le droit de PROMETTRE.
//
// Le 19/08/2026, un dépôt privé a construit sa sandbox pendant neuf minutes
// facturées, poussé sa branche `gh-pages`, et affiché « ## Sandbox publiée »
// suivi d'une adresse. Cette adresse répondait 404 : GitHub Pages n'est pas
// disponible pour un dépôt privé d'un plan gratuit. Rien n'avait échoué, rien
// ne le disait, et le mainteneur croyait avoir fini.
//
// Deux verrous en découlent, et ce fichier les tient :
//   1. l'avertissement tombe AVANT les neuf minutes, et il n'est QU'un
//      avertissement — Pages depuis un dépôt privé marche sur un plan payant,
//      un refus sec casserait ces mainteneurs-là ;
//   2. le récapitulatif sépare le fait (la branche est poussée) de
//      l'hypothèse (l'adresse répondra), et n'appelle jamais « succès » une
//      vérification qui n'a pas pu avoir lieu.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const RACINE = fileURLToPath(new URL("../", import.meta.url));
const WORKFLOW = readFileSync(join(RACINE, ".github/workflows/construire-sandbox.yml"), "utf8");

/**
 * Texte d'une étape du job, de son `- name:` jusqu'à l'étape suivante.
 * @param {string} nom intitulé exact de l'étape
 * @returns {string}
 */
function etape(nom) {
  const debut = WORKFLOW.indexOf(`      - name: ${nom}\n`);
  assert.notEqual(debut, -1, `l'étape « ${nom} » doit exister`);
  const suivante = WORKFLOW.indexOf("\n      - name: ", debut + 1);
  return WORKFLOW.slice(debut, suivante === -1 ? undefined : suivante);
}

/**
 * @param {string} nom intitulé exact de l'étape
 * @returns {number} position de l'étape dans le fichier
 */
function position(nom) {
  const debut = WORKFLOW.indexOf(`      - name: ${nom}\n`);
  assert.notEqual(debut, -1, `l'étape « ${nom} » doit exister`);
  return debut;
}

test("la garde du dépôt privé tombe avant la première étape coûteuse", () => {
  // Avertir après coup ne sert à rien : le mainteneur d'un dépôt privé a déjà
  // payé les minutes du réassemblage du rootfs et de la construction du
  // disque. La garde n'a de valeur que placée avant elles.
  assert.ok(
    position("Destination de la publication") < position("Réassemblage du rootfs de base"),
    "la garde doit précéder le réassemblage du rootfs",
  );
  assert.ok(
    position("Destination de la publication") < position("Construction du disque applicatif"),
    "la garde doit précéder la construction du disque applicatif",
  );
});

test("la garde avertit, elle ne refuse pas", () => {
  // Sur un plan Pro, Team ou Enterprise, Pages fonctionne depuis un dépôt
  // privé. Un `exit 1` ici casserait des utilisateurs parfaitement légitimes
  // pour protéger les autres.
  const garde = etape("Destination de la publication");
  assert.match(garde, /::warning title=/, "le cas doit être signalé par une annotation");
  assert.doesNotMatch(garde, /::error/, "un dépôt privé n'est pas une erreur");
  assert.doesNotMatch(garde, /\bexit 1\b/, "la construction ne doit pas être refusée");
  assert.match(garde, /target-repo/, "le chemin de sortie — la vitrine — doit être nommé");
  assert.match(garde, /amorcer-vitrine\.sh/, "l'outil d'amorçage de la vitrine doit être nommé");
});

test("la garde ne prend pas une visibilité inconnue pour une visibilité publique", () => {
  // `github.event.repository.private` n'est renseigné que si la charge utile
  // du déclencheur porte le dépôt. Vide, elle ne vaut PAS « public » : sans
  // repli, la garde se tairait exactement là où elle est utile.
  const garde = etape("Destination de la publication");
  assert.match(garde, /github\.event\.repository\.private/, "la source gratuite doit être lue");
  assert.match(
    garde,
    /gh api "repos\/\$\{GITHUB_REPOSITORY\}"/,
    "une visibilité absente doit être demandée au dépôt lui-même",
  );
});

test("le récapitulatif n'affirme plus qu'une sandbox est publiée", () => {
  // Le titre exact du défaut d'origine. Il ne doit pas revenir.
  const recap = etape("Récapitulatif");
  assert.doesNotMatch(recap, /## Sandbox publiée/, "le push n'est pas une publication");
  assert.match(recap, /## Branche .*poussée sur/, "le fait établi est le push, et lui seul");
});

test("le récapitulatif ne présente jamais une vérification manquée comme un succès", () => {
  // Le piège : `permissions: contents: write` met tous les autres scopes à
  // `none`, donc l'appel à l'API Pages répond 403 chez TOUS les mainteneurs
  // déjà installés. Ce 403 ne dit rien de l'état de Pages.
  const recap = etape("Récapitulatif");
  assert.match(recap, /HTTP 404/, "l'absence de site doit être distinguée");
  assert.match(recap, /HTTP \(401\|403\)/, "le refus de l'API doit être distingué");
  assert.match(recap, /pages: read/, "le remède au 403 doit être donné");
  const nonVerifie = recap.match(/État de GitHub Pages\s*:?\s*non vérifié/g) ?? [];
  assert.ok(nonVerifie.length >= 2, "403 et erreur inattendue avouent tous deux l'ignorance");
});

test("le récapitulatif ne fait jamais échouer la construction", () => {
  // La sandbox est poussée : quoi qu'il arrive à la vérification, le travail
  // du job est fait. Un `exit 1` ici transformerait un renseignement en
  // échec de build.
  const recap = etape("Récapitulatif");
  assert.doesNotMatch(recap, /\bexit 1\b/, "la vérification doit dégrader, pas échouer");
  assert.doesNotMatch(recap, /::error/, "aucune erreur ne doit être émise par le récapitulatif");
});

test("le récapitulatif ne tente rien sur une vitrine, et le dit", () => {
  // Le jeton du workflow ne vaut que pour le dépôt courant : sur target-repo,
  // l'appel répondrait 403 et on présenterait ce 403 comme un renseignement.
  const recap = etape("Récapitulatif");
  assert.match(recap, /if \[ -n "\$IN_TARGET_REPO" \]/, "le cas vitrine doit être traité à part");
  assert.match(
    recap,
    /gh api -X POST repos\/\$\{cible\}\/pages/,
    "la commande d'activation doit viser le dépôt réellement publié",
  );
});

test("le récapitulatif conserve ce qu'il faisait déjà de bien", () => {
  const recap = etape("Récapitulatif");
  assert.match(recap, /Try with railsbox/, "le badge prêt à coller doit rester");
  assert.match(recap, /rootfs mutualisé/, "l'origine du rootfs mutualisé doit rester dite");
});
