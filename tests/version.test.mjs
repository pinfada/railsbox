// La version de railsbox : une seule, visible, et qui ne dérive pas.
//
// POURQUOI CE TEST. Une sandbox est construite ailleurs et à un autre moment
// que le dépôt qui l'a produite : le mainteneur épingle un tag, la
// démonstration vit ensuite des semaines. Quand elle se comporte mal, la
// première question est « quelle version l'a fabriquée ? ». La coquille
// l'affichait dans son en-tête ; la refonte du 19/08/2026 l'a retirée sans le
// vouloir, en faisant de l'application le sujet du titre. Bon pour le visiteur,
// mauvais pour le diagnostic — et personne ne s'en est aperçu avant qu'on
// cherche à poser un tag.
//
// Deux versions qui se contredisent valent moins que pas de version du tout :
// c'est la dérive que ce test interdit, pas l'absence.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { VERSION_RAILSBOX } from "../public/shared/version.js";

const RACINE = join(dirname(fileURLToPath(import.meta.url)), "..");

/**
 * Lit un JSON du dépôt.
 * @param {string} nom nom de fichier à la racine
 * @returns {Record<string, any>} contenu analysé
 */
function lireJson(nom) {
  return JSON.parse(readFileSync(join(RACINE, nom), "utf8"));
}

test("la version de la coquille est celle du paquet", () => {
  assert.equal(
    VERSION_RAILSBOX,
    lireJson("package.json").version,
    "public/shared/version.js et package.json doivent dire la même chose",
  );
});

test("le verrou de dépendances ne contredit pas le paquet", () => {
  // `npm ci` régénère le verrou depuis package.json : une divergence ici finit
  // par produire un diff parasite dans une PR sans rapport.
  const verrou = lireJson("package-lock.json");
  assert.equal(verrou.version, VERSION_RAILSBOX);
  assert.equal(verrou.packages?.[""]?.version, VERSION_RAILSBOX);
});

test("la version a la forme d'un numéro sémantique", () => {
  // Elle sert à poser un tag `vX.Y.Z` que des dépôts tiers épinglent : une
  // forme libre y deviendrait vite ingérable.
  assert.match(VERSION_RAILSBOX, /^\d+\.\d+\.\d+$/);
});

test("la coquille annonce la version dans son journal", () => {
  // Dans le JOURNAL, pas dans l'en-tête : le journal est la surface de
  // diagnostic, et il est replié par défaut sur une sandbox publiée — le
  // visiteur venu essayer l'application ne le voit pas.
  const source = readFileSync(join(RACINE, "public", "main.js"), "utf8");
  assert.match(
    source,
    /logLine\(`railsbox \$\{VERSION_RAILSBOX\}`\)/,
    "main.js doit journaliser la version",
  );
});
