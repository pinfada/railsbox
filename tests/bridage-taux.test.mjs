// Choix des taux de bridage processeur de la mesure `npm run test:bridage`.
//
// La mesure elle-même dépend du réseau et dure des dizaines de minutes : elle
// ne tourne pas ici. Son paramétrage, lui, est de la logique pure — et c'est
// exactement là que se cache la faute coûteuse : une valeur mal lue produirait
// une mesure sur un taux qu'on n'a pas demandé, donc un chiffre faux publié
// dans le README.
import { test } from "node:test";
import assert from "node:assert/strict";

import { TAUX_PAR_DEFAUT, repetitionsDemandees, tauxDemandes } from "./bridage/taux.mjs";

test("sans demande explicite, les quatre taux de référence sont mesurés", () => {
  assert.deepEqual(tauxDemandes(undefined), TAUX_PAR_DEFAUT);
  assert.deepEqual(tauxDemandes(""), TAUX_PAR_DEFAUT);
  assert.deepEqual(tauxDemandes("   "), TAUX_PAR_DEFAUT);
});

test("une liste est acceptée, dédoublonnée et triée", () => {
  assert.deepEqual(tauxDemandes("8, 1"), [1, 8]);
  assert.deepEqual(tauxDemandes("4,4,4"), [4]);
});

test("un taux hors bornes est refusé bruyamment", () => {
  // 0 ou une valeur négative accélérerait le temps plutôt que de le ralentir,
  // et un taux démesuré transformerait la mesure en attente sans fin.
  assert.throws(() => tauxDemandes("0"), /taux invalide/);
  assert.throws(() => tauxDemandes("-2"), /taux invalide/);
  assert.throws(() => tauxDemandes("100"), /taux invalide/);
  assert.throws(() => tauxDemandes("rapide"), /taux invalide/);
});

test("le défaut rendu est une copie : le modifier ne contamine pas l'appel suivant", () => {
  const premier = tauxDemandes("");
  premier.push(99);
  assert.deepEqual(tauxDemandes(""), TAUX_PAR_DEFAUT);
});

test("une seule répétition par défaut, chaque boot coûtant une trentaine de mégaoctets", () => {
  assert.equal(repetitionsDemandees(undefined), 1);
  assert.equal(repetitionsDemandees(""), 1);
  assert.equal(repetitionsDemandees("3"), 3);
});

test("un nombre de répétitions absurde est refusé", () => {
  assert.throws(() => repetitionsDemandees("0"), /valeur invalide/);
  assert.throws(() => repetitionsDemandees("2.5"), /valeur invalide/);
  assert.throws(() => repetitionsDemandees("50"), /valeur invalide/);
});
