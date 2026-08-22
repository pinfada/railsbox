// La file d'attente devant le pont : ce qu'elle garantit, et ce qu'elle ne
// casse pas.
//
// Elle existe parce que la mesure a montré l'inverse de l'intuition : cinq
// requêtes EN SÉQUENCE réussissent là où cinq en parallèle échouent toutes.
// v86 émule un seul processeur et le pont n'a qu'un écrivain — le parallélisme
// n'y achète rien, il ne coûte que de la contention.
import { test } from "node:test";
import assert from "node:assert/strict";

import { creerLimiteConcurrence } from "../public/shared/limite-concurrence.js";

/** Une tâche qui signale son entrée et attend qu'on la relâche. */
function tacheRetenue() {
  /** @type {() => void} */
  let relacher = () => {};
  let entree = false;
  const attente = new Promise((resolve) => {
    relacher = () => resolve("faite");
  });
  return {
    get entree() {
      return entree;
    },
    relacher,
    executer: () => {
      entree = true;
      return attente;
    },
  };
}

const respirer = () => new Promise((resolve) => setTimeout(resolve, 0));

test("au-delà du plafond, les tâches ATTENDENT", async () => {
  const limite = creerLimiteConcurrence(2);
  const taches = [tacheRetenue(), tacheRetenue(), tacheRetenue(), tacheRetenue(), tacheRetenue()];

  const enVol = taches.map((t) => limite(t.executer));
  await respirer();

  assert.deepEqual(
    taches.map((t) => t.entree),
    [true, true, false, false, false],
    "deux seulement doivent être parties : c'est tout l'objet de la file",
  );

  taches.forEach((t) => t.relacher());
  assert.deepEqual(await Promise.all(enVol), ["faite", "faite", "faite", "faite", "faite"]);
});

test("un jeton libéré fait AVANCER la file, dans l'ordre", async () => {
  const limite = creerLimiteConcurrence(2);
  const taches = [tacheRetenue(), tacheRetenue(), tacheRetenue(), tacheRetenue()];
  const enVol = taches.map((t) => limite(t.executer));
  await respirer();

  taches[0].relacher();
  await respirer();
  await respirer();

  assert.equal(taches[2].entree, true, "la troisième prend la place libérée");
  assert.equal(taches[3].entree, false, "la quatrième attend encore son tour");

  taches.forEach((t) => t.relacher());
  await Promise.all(enVol);
});

test("une tâche qui ÉCHOUE rend quand même son jeton", async () => {
  // Sans cela, une seule erreur réduirait la capacité définitivement — et
  // quelques erreurs suffiraient à figer la sandbox entière, sans rien dans
  // les journaux pour l'expliquer.
  const limite = creerLimiteConcurrence(1);

  await assert.rejects(
    limite(async () => {
      throw new Error("échec de la VM");
    }),
    /échec de la VM/,
  );

  assert.equal(await limite(async () => "après l'échec"), "après l'échec");
});

test("le plafond ne descend jamais sous 1", async () => {
  // Un zéro, un négatif ou un NaN qui arriverait d'une configuration bloquerait
  // TOUT, silencieusement. Mieux vaut dégrader vers la séquence stricte.
  for (const valeur of [0, -3, Number.NaN, undefined]) {
    const limite = creerLimiteConcurrence(/** @type {any} */ (valeur));
    assert.equal(await limite(async () => "passée"), "passée", `plafond ${String(valeur)}`);
  }
});
