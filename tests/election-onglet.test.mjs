// Élection de l'onglet qui fait tourner la sandbox : une seule VM par
// navigateur. Le défaut corrigé se mesurait dans un vrai navigateur — deux
// onglets, deux émulations x86, et les écritures de l'un qui partaient dans la
// VM de l'autre parce que le Service Worker ne retient qu'un pont.
//
// Le gestionnaire de verrous est simulé : ces tests décrivent le contrat de
// Web Locks tel qu'il a été VÉRIFIÉ sur Chromium 151, Firefox 153 et WebKit 26
// — `ifAvailable` rend `null` quand le verrou est tenu, `steal` l'arrache et le
// tenant précédent voit sa requête rejetée en `AbortError`.
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  PREFIXE_VERROU,
  ROLE_PRINCIPAL,
  ROLE_SECONDAIRE,
  creerElection,
  nomVerrou,
  verrousDisponibles,
} from "../public/shared/election-onglet.js";

/** Laisse filer les microtâches : les notifications d'éviction en dépendent. */
const battement = () => new Promise((resolve) => setTimeout(resolve, 0));

/** Gestionnaire de verrous factice, aux règles de `navigator.locks`. */
function gestionnaireVerrous() {
  const tenus = new Map();
  return {
    tenus: () => [...tenus.keys()],
    async request(nom, options, callback) {
      if (options.steal) {
        tenus.get(nom)?.rompre();
      } else if (tenus.has(nom)) {
        if (options.ifAvailable) return callback(null);
        throw new Error("mise en file d'attente non simulée : la coquille n'en demande jamais");
      }
      let rompre;
      const rupture = new Promise((_, rejeter) => {
        rompre = () => rejeter(Object.assign(new Error("verrou arraché"), { name: "AbortError" }));
      });
      const jeton = { rompre };
      tenus.set(nom, jeton);
      const tenue = (async () => callback({ name: nom, mode: options.mode ?? "exclusive" }))();
      try {
        return await Promise.race([tenue, rupture]);
      } finally {
        // Un vol a déjà remplacé l'inscription : ne pas effacer celle du voleur.
        if (tenus.get(nom) === jeton) tenus.delete(nom);
      }
    },
  };
}

function onglet(verrous, nom = "sandbox") {
  const evictions = [];
  const election = creerElection({
    verrous,
    nom,
    onEviction: () => evictions.push(Date.now()),
  });
  return { election, evictions };
}

test("le premier onglet prend le verrou et devient principal", async () => {
  const verrous = gestionnaireVerrous();
  const a = onglet(verrous);

  assert.equal(a.election.role(), null, "aucun rôle avant candidature");
  assert.equal(await a.election.candidater(), ROLE_PRINCIPAL);
  assert.deepEqual(verrous.tenus(), ["sandbox"], "le verrou doit rester tenu");
});

test("le second onglet devient secondaire sans déloger le premier", async () => {
  const verrous = gestionnaireVerrous();
  const a = onglet(verrous);
  const b = onglet(verrous);

  await a.election.candidater();
  assert.equal(await b.election.candidater(), ROLE_SECONDAIRE);

  await battement();
  assert.equal(a.election.role(), ROLE_PRINCIPAL, "le premier onglet garde la main");
  assert.equal(a.evictions.length, 0, "une candidature n'évince personne");
});

test("la reprise explicite arrache le verrou et notifie l'onglet évincé", async () => {
  const verrous = gestionnaireVerrous();
  const a = onglet(verrous);
  const b = onglet(verrous);

  await a.election.candidater();
  await b.election.candidater();
  assert.equal(await b.election.reprendre(), ROLE_PRINCIPAL);

  await battement();
  assert.equal(a.evictions.length, 1, "l'onglet évincé doit être prévenu une fois");
  assert.equal(a.election.role(), ROLE_SECONDAIRE);
  assert.deepEqual(
    verrous.tenus(),
    ["sandbox"],
    "le verrou passe au repreneur, il ne disparaît pas",
  );
});

test("un onglet évincé peut reprendre la main à son tour", async () => {
  const verrous = gestionnaireVerrous();
  const a = onglet(verrous);
  const b = onglet(verrous);

  await a.election.candidater();
  await b.election.candidater();
  await b.election.reprendre();
  await battement();

  assert.equal(await a.election.reprendre(), ROLE_PRINCIPAL);
  await battement();
  assert.equal(b.election.role(), ROLE_SECONDAIRE);
  assert.equal(b.evictions.length, 1);
  assert.equal(a.evictions.length, 1, "l'ancienne éviction ne se rejoue pas");
});

test("reprendre depuis l'onglet principal ne s'évince pas soi-même", async () => {
  const verrous = gestionnaireVerrous();
  const a = onglet(verrous);

  await a.election.candidater();
  assert.equal(await a.election.reprendre(), ROLE_PRINCIPAL);
  assert.equal(await a.election.candidater(), ROLE_PRINCIPAL);

  await battement();
  assert.equal(a.evictions.length, 0);
  assert.deepEqual(verrous.tenus(), ["sandbox"]);
});

test("relâcher rend le verrou au candidat suivant, sans éviction", async () => {
  const verrous = gestionnaireVerrous();
  const a = onglet(verrous);
  const b = onglet(verrous);

  await a.election.candidater();
  a.election.relacher();
  await battement();

  assert.deepEqual(verrous.tenus(), [], "le verrou doit être libre");
  assert.equal(a.evictions.length, 0, "une libération volontaire n'est pas une éviction");
  assert.equal(await b.election.candidater(), ROLE_PRINCIPAL);
});

test("deux sandboxes d'une même origine ne se bloquent pas", async () => {
  const verrous = gestionnaireVerrous();
  const demo = onglet(verrous, nomVerrou("/railsbox-demo/"));
  const autre = onglet(verrous, nomVerrou("/autre-demo/"));

  assert.equal(await demo.election.candidater(), ROLE_PRINCIPAL);
  assert.equal(await autre.election.candidater(), ROLE_PRINCIPAL);
});

test("le nom du verrou est normalisé et porte le chemin de la coquille", () => {
  assert.equal(nomVerrou("/railsbox-demo/"), `${PREFIXE_VERROU}:/railsbox-demo/`);
  assert.equal(nomVerrou("railsbox-demo"), `${PREFIXE_VERROU}:/railsbox-demo/`);
  assert.equal(nomVerrou("/"), `${PREFIXE_VERROU}:/`);
  assert.equal(
    nomVerrou(""),
    `${PREFIXE_VERROU}:/`,
    "racine : chemin vide et « / » sont un seul lieu",
  );
  assert.equal(nomVerrou(undefined), `${PREFIXE_VERROU}:/`);
});

test("l'absence de Web Locks est détectée, jamais supposée", () => {
  assert.equal(verrousDisponibles({ navigator: { locks: { request: () => {} } } }), true);
  assert.equal(verrousDisponibles({ navigator: {} }), false);
  assert.equal(verrousDisponibles({ navigator: { locks: {} } }), false);
  assert.equal(verrousDisponibles(undefined), false);
});
