// Le bilan de démarrage : les chiffres que la coquille met en avant.
//
// Ce que ces tests protègent. La sandbox jiyufit met ~50 s à devenir
// utilisable, et le mainteneur met spontanément cette minute au compte de
// railsbox. Mesuré, le partage était de 42 % pour railsbox et 58 % pour
// l'application — dont 152 requêtes SQL sans aucun cache sur la première page.
// C'est le seul chiffre que le mainteneur peut corriger, et c'est celui que le
// bilan affiche.
//
// D'où l'exigence particulière ici : une part FAUSSE est plus nuisible qu'une
// part absente, parce qu'elle envoie optimiser au mauvais endroit. Les tests
// qui comptent le plus sont donc ceux du refus — pas de partage sans jalon de
// VM, pas de « 0 requête » quand la ligne n'a pas été lue.
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  formatSecondes,
  lireRequetesSql,
  mesuresDemarrage,
  partPourcent,
} from "../public/shared/bilan-demarrage.js";

/** Ligne réelle, relevée sur jiyufit le 19/08/2026. */
const LIGNE_REELLE =
  '{"message":"Completed 200 OK in 24292ms (Views: 7335.6ms | ActiveRecord: 8026.6ms (152 queries, 0 cached)) | GC: 2617.0ms)"}';

/**
 * Retrouve la valeur d'une ligne du bilan.
 * @param {{libelle: string, valeur: string}[]} mesures lignes produites
 * @param {string} debutLibelle début du libellé cherché
 * @returns {string|undefined} valeur associée
 */
function valeur(mesures, debutLibelle) {
  return mesures.find((m) => m.libelle.startsWith(debutLibelle))?.valeur;
}

// --- Lecture du compte de requêtes -----------------------------------------

test("lit le compte de requêtes sur une vraie ligne de Rails", () => {
  assert.deepEqual(lireRequetesSql(LIGNE_REELLE), { requetes: 152, cachees: 0 });
});

test("accepte le singulier et l'absence de compte de cache", () => {
  assert.deepEqual(lireRequetesSql("Completed 200 OK (1 query)"), {
    requetes: 1,
    cachees: null,
  });
  assert.deepEqual(lireRequetesSql("(7 queries)"), { requetes: 7, cachees: null });
});

test("une ligne sans le motif ne fabrique rien", () => {
  // Le format autour de ce fragment a bougé plusieurs fois d'une version de
  // Rails à l'autre. S'il bouge encore, la ligne du bilan doit DISPARAÎTRE,
  // jamais se remplir d'une valeur devinée.
  assert.equal(lireRequetesSql("Completed 200 OK in 24292ms"), null);
  assert.equal(lireRequetesSql(""), null);
  assert.equal(lireRequetesSql(/** @type {any} */ (undefined)), null);
  assert.equal(lireRequetesSql(/** @type {any} */ (42)), null);
});

// --- Mise en forme ---------------------------------------------------------

test("les durées s'écrivent au dixième, à la française", () => {
  assert.equal(formatSecondes(24292), "24,3 s");
  assert.equal(formatSecondes(0), "0,0 s");
  assert.equal(formatSecondes(1000), "1,0 s");
});

test("une durée négative ou absurde ne produit pas un nombre négatif", () => {
  // Les jalons viennent de Date.now() : un ajustement d'horloge système peut
  // rendre une différence négative. « -3,0 s » dans un bilan ne veut rien dire.
  assert.equal(formatSecondes(-5000), "0,0 s");
  assert.equal(formatSecondes(Number.NaN), "0,0 s");
});

test("la part ne s'affiche pas quand le total ne veut rien dire", () => {
  assert.equal(partPourcent(10, 0), "");
  assert.equal(partPourcent(10, -1), "");
  assert.equal(partPourcent(25900, 44300), " (58 %)");
});

// --- Composition du bilan --------------------------------------------------

test("le partage reproduit la mesure réelle de jiyufit", () => {
  const mesures = mesuresDemarrage({
    jalons: { debut: 0, vmRepond: 18_400, premierRendu: 44_300 },
    requetesSql: { requetes: 152, cachees: 0 },
  });
  assert.equal(valeur(mesures, "Démarrage total"), "44,3 s");
  assert.equal(valeur(mesures, "Part railsbox"), "18,4 s (42 %)");
  assert.equal(valeur(mesures, "Part application"), "25,9 s (58 %)");
  assert.equal(valeur(mesures, "Requêtes SQL"), "152 (0 en cache)");
});

test("sans jalon de VM, le partage n'est pas fabriqué", () => {
  // C'est le refus qui compte : inventer une répartition enverrait le
  // mainteneur optimiser la mauvaise moitié de l'attente.
  const mesures = mesuresDemarrage({
    jalons: { debut: 0, vmRepond: null, premierRendu: 44_300 },
  });
  assert.equal(mesures.length, 1);
  assert.equal(valeur(mesures, "Démarrage total"), "44,3 s");
  assert.equal(valeur(mesures, "Part railsbox"), undefined);
  assert.equal(valeur(mesures, "Part application"), undefined);
});

test("sans compte de requêtes, la ligne disparaît au lieu d'afficher zéro", () => {
  const mesures = mesuresDemarrage({
    jalons: { debut: 0, vmRepond: 18_400, premierRendu: 44_300 },
    requetesSql: null,
  });
  assert.equal(valeur(mesures, "Requêtes SQL"), undefined);
});

test("un compte de cache absent ne s'invente pas non plus", () => {
  const mesures = mesuresDemarrage({
    jalons: { debut: 0, vmRepond: 1_000, premierRendu: 2_000 },
    requetesSql: { requetes: 7, cachees: null },
  });
  assert.equal(valeur(mesures, "Requêtes SQL"), "7");
});

test("bilan demandé avant le premier rendu : le total court jusqu'à maintenant", () => {
  const mesures = mesuresDemarrage({
    jalons: { debut: 0, vmRepond: 5_000, premierRendu: null },
    maintenant: 30_000,
  });
  assert.equal(valeur(mesures, "Démarrage total"), "30,0 s");
  assert.equal(valeur(mesures, "Part application"), "25,0 s (83 %)");
});
