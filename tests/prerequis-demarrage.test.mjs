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
  MAX_REPRISES_CONTROLE,
  compterTentatives,
  decisionReprise,
  diagnostiquer,
  releverCapacites,
  repriseControle,
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

// --- Contrôle du Service Worker : un défaut récupérable ---------------------
//
// Mesuré sur une sandbox publiée le 18/08/2026 : le rechargement automatique du
// premier passage est reparti trop tôt, la page est revenue de nouveau non
// contrôlée, la garde était déjà posée — et la coquille a affiché « ERREUR
// FATALE » sous quatre badges rouges. Un simple rechargement manuel a tout
// réglé. Le mot « fatale » était faux : l'état est récupérable, et le remède
// tient en un clic. Ces tests fixent ce que la coquille doit dire, et quand.

test("le contrôle obtenu laisse le démarrage continuer, quel que soit le compteur", () => {
  assert.equal(repriseControle({ controle: true, tentatives: 0 }).suite, "poursuivre");
  assert.equal(repriseControle({ controle: true, tentatives: 9 }).suite, "poursuivre");
});

test("le premier passage recharge tout seul : c'est le démarrage normal", () => {
  const plan = repriseControle({ controle: false, tentatives: 0 });
  assert.equal(plan.suite, "recharger");
  assert.ok(plan.journal.length > 0, "le rechargement doit se dire dans le journal");
});

test("un rechargement automatique insuffisant PROPOSE, il n'annonce pas une panne", () => {
  const plan = repriseControle({ controle: false, tentatives: 1 });
  assert.equal(plan.suite, "proposer");
  assert.match(plan.libelleAction, /recharger/i);
  const ecrit = `${plan.titre} ${plan.detail}`;
  assert.doesNotMatch(ecrit, /fatal/i, "rien de fatal : le rechargement règle le cas");
  assert.doesNotMatch(ecrit, /a échoué/i, "le démarrage n'a pas échoué, il attend une navigation");
  assert.ok(plan.detail.length > 120, "le panneau doit expliquer, pas étiqueter");
});

test("après deux rechargements, le message devient terminal et nomme les remèdes", () => {
  const plan = repriseControle({ controle: false, tentatives: MAX_REPRISES_CONTROLE });
  assert.equal(plan.suite, "renoncer");
  // Les trois causes qui couvrent la quasi-totalité des cas : ce sont elles que
  // le visiteur peut vérifier lui-même, et aucune ne se devine.
  assert.match(plan.detail, /privée/i);
  assert.match(plan.detail, /extension/i);
  assert.match(plan.detail, /navigateur/i);
  assert.match(plan.lien.href, /^https:\/\//, "un lien vers les prérequis doit être offert");
  assert.ok(plan.lien.libelle.length > 0);
});

test("au-delà du plafond on ne repropose pas un rechargement de plus", () => {
  const plan = repriseControle({ controle: false, tentatives: MAX_REPRISES_CONTROLE + 7 });
  assert.equal(plan.suite, "renoncer");
});

test("le plafond vaut DEUX rechargements : un automatique, un demandé au visiteur", () => {
  // N=2 n'est pas un chiffre rond choisi au hasard : c'est exactement le
  // nombre de navigations que la course d'activation peut coûter — celle que
  // la coquille déclenche seule, puis celle que le visiteur déclenche. Un
  // troisième rechargement ne corrigerait plus une course mais un blocage
  // durable (navigation privée, extension, moteur non supporté), que recharger
  // ne règle jamais.
  assert.equal(MAX_REPRISES_CONTROLE, 2);
  assert.equal(repriseControle({ controle: false, tentatives: 0 }).suite, "recharger");
  assert.equal(repriseControle({ controle: false, tentatives: 1 }).suite, "proposer");
  assert.equal(repriseControle({ controle: false, tentatives: 2 }).suite, "renoncer");
});

test("la clémence ne vaut QUE pour le contrôle : les autres conditions restent fatales", () => {
  // L'isolation cross-origin absente après son rechargement n'est pas une
  // course perdue : la page est servie sans COOP/COEP, et aucun clic n'y peut
  // rien. Elle continue donc d'abandonner, donc de remonter en échec.
  assert.equal(decisionReprise({ satisfait: false, dejaRecharge: true }), "abandonner");
});

test("le compteur de tentatives relit ce que sessionStorage rend, y compris rien", () => {
  assert.equal(compterTentatives(null), 0);
  assert.equal(compterTentatives(""), 0);
  assert.equal(compterTentatives("bruit"), 0);
  // Compatibilité avec la garde booléenne d'avant : elle écrivait « 1 ».
  assert.equal(compterTentatives("1"), 1);
  assert.equal(compterTentatives("2"), 2);
  assert.equal(compterTentatives("-3"), 0);
});
