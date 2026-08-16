// Conditions de démarrage de la coquille.
//
// Ces tests ont été écrits après avoir mesuré la sandbox publiée sur Firefox et
// WebKit : les deux moteurs affichaient « ERREUR FATALE » et quatre badges
// rouges à chaque première visite, avant de se recharger et de fonctionner
// parfaitement. Le défaut n'était pas dans les moteurs mais dans la coquille :
// une garde de rechargement UNIQUE partagée par deux étapes distinctes, et un
// rechargement volontaire signalé comme une erreur fatale.
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  GARDE_CONTROLE,
  GARDE_ISOLATION,
  decisionReprise,
  diagnostiquer,
  releverCapacites,
  resumerManques,
} from "../public/shared/prerequis-demarrage.js";

/** Navigateur pleinement capable, dont on dérive les cas dégradés. */
function porteeComplete(surcharges = {}) {
  return {
    isSecureContext: true,
    navigator: { serviceWorker: {} },
    WebAssembly: {},
    caches: {},
    indexedDB: {},
    DecompressionStream: function DecompressionStream() {},
    ...surcharges,
  };
}

test("un navigateur complet est déclaré démarrable, sans dégradation", () => {
  const rapport = diagnostiquer(releverCapacites(porteeComplete()));
  assert.equal(rapport.demarrable, true);
  assert.deepEqual(rapport.bloquants, []);
  assert.deepEqual(rapport.degradations, []);
});

test("l'absence de Service Worker interdit le démarrage et nomme le cas des webviews", () => {
  const rapport = diagnostiquer(releverCapacites(porteeComplete({ navigator: {} })));
  assert.equal(rapport.demarrable, false);
  assert.deepEqual(
    rapport.bloquants.map((manque) => manque.cle),
    ["serviceWorker"],
  );
  assert.match(resumerManques(rapport.bloquants), /webview/i);
});

test("une page servie hors contexte sécurisé est refusée", () => {
  const rapport = diagnostiquer(releverCapacites(porteeComplete({ isSecureContext: false })));
  assert.equal(rapport.demarrable, false);
  assert.deepEqual(
    rapport.bloquants.map((manque) => manque.cle),
    ["contexteSecurise"],
  );
});

test("l'absence de WebAssembly interdit le démarrage", () => {
  const rapport = diagnostiquer(releverCapacites(porteeComplete({ WebAssembly: undefined })));
  assert.equal(rapport.demarrable, false);
  assert.deepEqual(
    rapport.bloquants.map((manque) => manque.cle),
    ["webAssembly"],
  );
});

test("un navigateur sans SharedArrayBuffer reste démarrable : l'isolation vient plus tard", () => {
  // SharedArrayBuffer n'apparaît qu'une fois la page cross-origin isolée, donc
  // APRÈS l'installation du Service Worker. Le tester au préalable accuserait
  // à tort tous les navigateurs, y compris ceux qui fonctionnent.
  const rapport = diagnostiquer(releverCapacites(porteeComplete({ SharedArrayBuffer: undefined })));
  assert.equal(rapport.demarrable, true);
});

test("cache, IndexedDB et décompression manquants dégradent sans bloquer", () => {
  const portee = porteeComplete({
    caches: undefined,
    indexedDB: undefined,
    DecompressionStream: undefined,
  });
  const rapport = diagnostiquer(releverCapacites(portee));
  assert.equal(rapport.demarrable, true);
  assert.deepEqual(
    rapport.degradations.map((manque) => manque.cle),
    ["cacheStorage", "indexedDb", "decompression"],
  );
});

test("chaque manque est résumé avec sa conséquence, pas seulement son nom", () => {
  const rapport = diagnostiquer(releverCapacites(porteeComplete({ navigator: {} })));
  const resume = resumerManques(rapport.bloquants);
  assert.match(resume, /Service Worker indisponible —/);
  assert.ok(resume.length > 80, "le message doit expliquer, pas étiqueter");
});

test("une condition satisfaite laisse le démarrage continuer", () => {
  assert.equal(decisionReprise({ satisfait: true, dejaRecharge: false }), "poursuivre");
  assert.equal(decisionReprise({ satisfait: true, dejaRecharge: true }), "poursuivre");
});

test("une condition non satisfaite provoque UN rechargement, puis abandonne", () => {
  assert.equal(decisionReprise({ satisfait: false, dejaRecharge: false }), "recharger");
  assert.equal(decisionReprise({ satisfait: false, dejaRecharge: true }), "abandonner");
});

test("le contrôle et l'isolation ont des gardes distinctes", () => {
  // Le cœur du défaut Firefox/WebKit : là où Chromium n'a besoin que du
  // rechargement d'isolation, ces moteurs prennent le contrôle dès la première
  // page puis réclament une navigation de plus pour COOP/COEP. Une garde
  // commune, consommée par la première étape, interdisait la seconde.
  assert.notEqual(GARDE_CONTROLE, GARDE_ISOLATION);
});
