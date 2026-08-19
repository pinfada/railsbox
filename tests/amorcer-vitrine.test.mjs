// L'amorçage d'une vitrine est le seul chemin qu'un utilisateur parcourt AVANT
// d'avoir la moindre sandbox : ce que ce script oublie, rien ne le rattrape —
// il n'y a pas encore de construction, pas de journal, pas de page à regarder.
// Ces contrôles portent sur les trois pannes relevées le 20/08/2026, qui ont
// toutes en commun de ne se voir qu'après neuf minutes de construction :
// Pages laissé à activer à la main, un déclencheur `push` facturé à chaque
// poussée, et une clé privée qui traînerait dans une sortie.
//
// shellcheck relit la syntaxe en CI ; ce fichier relit les DÉCISIONS, que
// shellcheck ne connaît pas.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const SCRIPT = readFileSync(new URL("../tools/amorcer-vitrine.sh", import.meta.url), "utf8");

/** @param {string} debut @param {string} fin */
function bloc(debut, fin) {
  const i = SCRIPT.indexOf(debut);
  assert.notEqual(i, -1, `bloc « ${debut} » introuvable`);
  const j = SCRIPT.indexOf(fin, i);
  assert.notEqual(j, -1, `fin de bloc « ${fin} » introuvable`);
  return SCRIPT.slice(i, j);
}

const YAML = bloc("cat <<YAML", "\nYAML");
const PAGE = bloc("<<'HTML'", "\nHTML");
const VERIFIER = bloc("verifier() {", "\n}\n");

test("le workflow proposé met workflow_dispatch en avant", () => {
  // `push: branches: [main]` en premier, c'est ~9 minutes de construction à
  // chaque poussée — facturées, sur un dépôt privé.
  assert.ok(
    YAML.indexOf("workflow_dispatch") < YAML.indexOf("push:"),
    "workflow_dispatch doit précéder push",
  );
  assert.match(YAML, /^\s*#\s*push:/m, "push reste proposé, mais commenté");
  assert.match(YAML, /FACTUR/, "le coût d'une construction est dit");
});

test("la mise en garde sur « branches: » survit tant que push est proposé", () => {
  assert.match(YAML, /branches: \[main\]/, "l'exemple nomme encore une branche");
  assert.match(SCRIPT, /vérifiez la ligne « branches: »/);
});

test("Pages est activé par le script, pas renvoyé à l'utilisateur", () => {
  // La version précédente imprimait la commande « après la première
  // construction » — soit le geste manuel, à l'endroit exact où l'en-tête
  // écrit que l'échec est silencieux.
  assert.doesNotMatch(SCRIPT, /Après la première construction/);
  assert.match(SCRIPT, /gh api -X "\$methode" "repos\/\$VITRINE\/pages"/);
});

test("la page d'attente n'est poussée que si gh-pages n'existe pas", () => {
  // L'écraser remplacerait une démonstration en ligne par « en construction ».
  const depuisLaGarde = SCRIPT.slice(
    SCRIPT.indexOf('if gh api "repos/$VITRINE/branches/gh-pages"'),
  );
  const intacte = depuisLaGarde.indexOf("laissée intacte");
  const appel = depuisLaGarde.indexOf("if pousser_page_attente");
  assert.ok(intacte !== -1 && appel !== -1, "la garde et la poussée sont toutes deux là");
  assert.ok(intacte < appel, "la branche existante est traitée AVANT toute poussée");
});

test("la page d'attente ne nomme aucun dépôt", () => {
  // Elle est publique ; le dépôt source, lui, est privé — c'est tout l'objet
  // de ce script.
  assert.doesNotMatch(PAGE, /\$SOURCE|\$VITRINE/);
  assert.match(PAGE, /construction/i);
});

test("le mode --verifier ne modifie rien", () => {
  assert.match(SCRIPT, /--verifier\)/, "l'option est implémentée");
  assert.match(SCRIPT, /--verifier <proprietaire\/source>/, "et documentée dans l'usage");

  // La vérification ne lance AUCUNE commande en propre : elle passe par les
  // fonctions de lecture. Les `gh api -X PATCH …` qu'on lit dans son corps
  // sont des gestes IMPRIMÉS à l'utilisateur, entre guillemets — la nuance
  // tient à la place du texte sur la ligne, d'où ce contrôle-ci.
  const executees = VERIFIER.split("\n").filter((ligne) => /^\s*(gh|git|curl) /.test(ligne));
  assert.deepEqual(executees, [], "aucune commande exécutée directement en vérification");

  // Et le mode sort avant la première création, quoi qu'il arrive ensuite.
  assert.ok(
    SCRIPT.indexOf('if [ "$MODE" = "verifier" ]') < SCRIPT.indexOf("gh repo create"),
    "la sortie du mode vérification précède toute création",
  );
});

test("chaque point manquant est nommé avec le geste qui le répare", () => {
  const manques = VERIFIER.match(/point_manque /g) ?? [];
  assert.ok(manques.length >= 5, "les points contrôlés sont tous réparables");
  // point_manque prend deux arguments : le constat, puis le geste.
  assert.match(SCRIPT, /point_manque\(\) \{[\s\S]*?printf ' {4}→ %s\\n' "\$2"/);
});

test("la clé privée ne sort jamais du script", () => {
  const lignes = SCRIPT.split("\n").filter(
    (ligne) => ligne.includes('"$CLE"') && !ligne.includes("$CLE.pub"),
  );
  assert.ok(lignes.length > 0, "la clé est bien manipulée quelque part");
  for (const ligne of lignes) {
    assert.match(
      ligne,
      /ssh-keygen|gh secret set/,
      `la clé privée ne doit ni s'afficher ni se copier : ${ligne.trim()}`,
    );
  }
  assert.ok(
    SCRIPT.includes("trap 'rm -rf \"$TRAVAIL\"' EXIT INT TERM"),
    "le répertoire de travail disparaît quoi qu'il arrive",
  );
});

test("le script reste du shell POSIX", () => {
  // La CI passe shellcheck, mais aucune machine de développement de ce dépôt
  // ne l'a : ces quatre pièges-là se voient sans lui.
  for (const bashisme of ["[[", "local ", "echo -e", "function "]) {
    assert.ok(!SCRIPT.includes(bashisme), `bashisme « ${bashisme} » interdit`);
  }
  assert.match(SCRIPT, /^#!\/bin\/sh\n/);
  assert.match(SCRIPT, /^set -eu$/m);
});
