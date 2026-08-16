// Choix des moteurs sur lesquels une suite Playwright s'exécute.
//
// La règle qui compte est le DÉFAUT : la CI n'installe que Chromium, et une
// configuration qui déclarerait Firefox et WebKit sans qu'on les ait demandés
// ferait échouer la recette sur un moteur absent du poste.
import { test } from "node:test";
import assert from "node:assert/strict";

import { MOTEURS_CONNUS, moteursDemandes, projetsMoteurs } from "./moteurs.mjs";

test("sans demande explicite, seul Chromium est déclaré", () => {
  assert.deepEqual(moteursDemandes(undefined), ["chromium"]);
  assert.deepEqual(moteursDemandes(""), ["chromium"]);
  assert.deepEqual(moteursDemandes("   "), ["chromium"]);
});

test("« tous » déclare les trois moteurs", () => {
  assert.deepEqual(moteursDemandes("tous"), MOTEURS_CONNUS);
  assert.deepEqual(moteursDemandes("all"), MOTEURS_CONNUS);
});

test("une liste est acceptée, dédoublonnée et remise dans l'ordre canonique", () => {
  assert.deepEqual(moteursDemandes("webkit, firefox"), ["firefox", "webkit"]);
  assert.deepEqual(moteursDemandes("firefox,firefox"), ["firefox"]);
  assert.deepEqual(moteursDemandes("WebKit"), ["webkit"]);
});

test("un moteur inconnu est refusé bruyamment, pas ignoré en silence", () => {
  // Une faute de frappe qui se solderait par « aucun test à jouer » passerait
  // pour un succès : c'est le pire résultat possible pour une recette.
  assert.throws(() => moteursDemandes("chrome"), /moteur inconnu chrome/);
});

test("les projets Playwright portent le nom du moteur", () => {
  assert.deepEqual(projetsMoteurs("firefox"), [
    { name: "firefox", use: { browserName: "firefox" } },
  ]);
});
