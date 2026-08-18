// Ce que le VRAI sw-proxy.js fait d'un refus de session, et ce qu'il met en
// cache. Deux sujets, une seule raison de les tenir ensemble : ils se jouent
// tous les deux dans les quelques lignes de câblage de `serveArtifact`, et
// aucun test de module pur ne peut les voir.
//
// Les tests marqués T2 tranchent l'hypothèse T2 de la note d'architecture :
// « un 401 ne passe pas le test de mise en cache ; une redirection suivie y
// passe ». Ils sont écrits sur le code ACTUEL, sans le corriger — la
// correction (prédicat `estArtefactCacheable`) est le sujet d'une autre
// branche, et ces tests existent pour dire précisément ce qu'elle doit changer.
import { test } from "node:test";
import assert from "node:assert/strict";

import { chargerWorker, configFactice, reponseFactice, urlMorceau } from "./sw-proxy-harness.mjs";
import { AUTH_EXPIREE, EN_TETE_AUTH } from "../public/shared/session-privee.js";

const SCOPE = "http://localhost/";
const MORCEAU = urlMorceau(SCOPE);

/**
 * Charge un worker qui répond ce qu'on lui dit, morceau par morceau.
 * @param {Array<any> | ((request: Request) => any)} reponses
 */
async function banc(reponses) {
  const file = Array.isArray(reponses) ? [...reponses] : null;
  const worker = await chargerWorker({
    scope: SCOPE,
    repondre: file ? () => file.shift() : /** @type {any} */ (reponses),
  });
  await worker.declarerConfig(configFactice(SCOPE));
  worker.poserClients([{ url: `${SCOPE}index.html` }]);
  return worker;
}

// --- T2 : ce que le cache accepte aujourd'hui -----------------------------

test("T2 — un 401 nu ne passe PAS le test de mise en cache", async () => {
  const worker = await banc([reponseFactice({ status: 401 })]);
  try {
    const reponse = await worker.requeter(MORCEAU);
    await worker.viderDifferes();
    assert.equal(reponse.status, 401, "le refus est rendu tel quel");
    assert.deepEqual(worker.misEnCache, [], "aucune écriture en cache");
  } finally {
    worker.fermer();
  }
});

test("T2 — une REDIRECTION SUIVIE ne passe plus le test de mise en cache", async () => {
  // Le cas exact décrit par la note : `fetch` en `redirect:"follow"` suit la
  // 302 du bord, la réponse finale est un 200 `basic` porteur du HTML de la
  // page de connexion. La condition en ligne de serveArtifact la jugeait
  // cacheable, et la page de connexion était écrite en Cache Storage SOUS
  // L'URL DU MORCEAU DE DISQUE, en « cache d'abord » sans revalidation.
  //
  // Ce test a d'abord CHIFFRÉ ce défaut (il exigeait l'écriture en cache) ;
  // il est inversé depuis que `estArtefactCacheable` refuse toute réponse
  // `redirected` — c'est lui, désormais, qui verrouille la fermeture du trou.
  const worker = await banc([
    reponseFactice({
      status: 200,
      type: "basic",
      redirected: true,
      headers: { "Content-Type": "text/html" },
      body: "<html>connexion</html>",
    }),
  ]);
  try {
    await worker.requeter(MORCEAU);
    await worker.viderDifferes();
    assert.deepEqual(
      worker.misEnCache,
      [],
      "une page de connexion redirigée ne doit JAMAIS être mise en cache",
    );
  } finally {
    worker.fermer();
  }
});

test("T2 — un 200 direct est mis en cache, un opaque ne l'est pas", async () => {
  // Les deux bornes du prédicat actuel, pour que la correction à venir ne les
  // déplace pas par mégarde.
  const direct = await banc([reponseFactice({ status: 200 })]);
  try {
    await direct.requeter(MORCEAU);
    await direct.viderDifferes();
    assert.equal(direct.misEnCache.length, 1);
  } finally {
    direct.fermer();
  }

  const opaque = await banc([reponseFactice({ status: 200, type: "opaque" })]);
  try {
    await opaque.requeter(MORCEAU);
    await opaque.viderDifferes();
    assert.deepEqual(opaque.misEnCache, []);
  } finally {
    opaque.fermer();
  }
});

// --- La rétention : suspendre, pas échouer --------------------------------

/** Un refus de session conforme au contrat du bord. */
function refus() {
  return reponseFactice({
    status: 401,
    headers: { [EN_TETE_AUTH]: AUTH_EXPIREE },
    body: '{"erreur":"session_expiree"}',
  });
}

test("un refus de session ne rend RIEN à v86 et prévient la coquille", async () => {
  const worker = await banc([refus()]);
  try {
    const promesse = worker.requeter(MORCEAU);
    let resolue = false;
    promesse.then(() => (resolue = true));
    await new Promise((r) => setTimeout(r, 20));

    assert.equal(resolue, false, "la lecture est RETENUE, pas rendue : v86 la croit lente");
    assert.deepEqual(
      worker.messagesAuxClients.map((envoi) => envoi.message),
      [{ type: "session-expiree" }],
      "la coquille est prévenue une fois",
    );
    assert.deepEqual(worker.misEnCache, [], "un refus n'entre jamais dans le cache");
  } finally {
    worker.fermer();
  }
});

test("« session-restauree » rejoue la lecture, qui aboutit en 200 mis en cache", async () => {
  // Le scénario complet du risque n°1, de bout en bout dans le worker réel.
  const worker = await banc([refus(), reponseFactice({ status: 200, body: "vrais octets" })]);
  try {
    const promesse = worker.requeter(MORCEAU);
    await new Promise((r) => setTimeout(r, 20));
    worker.envoyerMessage({ type: "session-restauree" });

    const reponse = await promesse;
    assert.equal(reponse.status, 200, "la lecture aboutit après rétablissement");
    assert.equal(await reponse.text(), "vrais octets");
    assert.equal(worker.requetesReseau.length, 2, "la requête a été REJOUÉE, pas devinée");

    await worker.viderDifferes();
    assert.equal(worker.misEnCache.length, 1, "seule la réponse valide est mise en cache");
    assert.equal(worker.misEnCache[0].url, MORCEAU);
  } finally {
    worker.fermer();
  }
});

test("une rafale de morceaux ne produit qu'UNE notification", async () => {
  // v86 demande ses morceaux par rafales : sans étranglement, chaque morceau
  // vaudrait une pause de VM et un panneau.
  const worker = await banc(() => refus());
  try {
    worker.requeter(MORCEAU);
    worker.requeter(`${SCOPE}disks/essai-4194304-8388608.ext2.zst`);
    worker.requeter(`${SCOPE}disks/essai-8388608-12582912.ext2.zst`);
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(worker.messagesAuxClients.length, 1, "une seule notification pour l'épisode");
  } finally {
    worker.fermer();
  }
});

test("toutes les lectures retenues repartent ensemble au rétablissement", async () => {
  let refuser = true;
  const worker = await banc(() =>
    refuser ? refus() : reponseFactice({ status: 200, body: "ok" }),
  );
  try {
    const promesses = [
      worker.requeter(MORCEAU),
      worker.requeter(`${SCOPE}disks/essai-4194304-8388608.ext2.zst`),
    ];
    await new Promise((r) => setTimeout(r, 20));
    refuser = false;
    worker.envoyerMessage({ type: "session-restauree" });
    const statuts = (await Promise.all(promesses)).map((r) => r.status);
    assert.deepEqual(statuts, [200, 200]);
  } finally {
    worker.fermer();
  }
});

test("l'iframe applicative ne peut pas libérer les lectures retenues", async () => {
  // `session-restauree` est filtré par `isShellClient` comme le pont et la
  // configuration : un XSS de l'application relancerait sinon des lectures de
  // disque sous une session qu'il n'a pas.
  const worker = await banc(() => refus());
  try {
    const promesse = worker.requeter(MORCEAU);
    let resolue = false;
    promesse.then(() => (resolue = true));
    await new Promise((r) => setTimeout(r, 20));
    worker.envoyerMessage({ type: "session-restauree" }, `${SCOPE}app/panneau`);
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(resolue, false, "la lecture reste retenue : le message a été refusé");
  } finally {
    worker.fermer();
  }
});

test("seule la coquille est prévenue, jamais l'iframe applicative", async () => {
  const worker = await banc(() => refus());
  worker.poserClients([{ url: `${SCOPE}index.html` }, { url: `${SCOPE}app/tableau` }]);
  try {
    worker.requeter(MORCEAU);
    await new Promise((r) => setTimeout(r, 20));
    assert.deepEqual(
      worker.messagesAuxClients.map((envoi) => envoi.url),
      [`${SCOPE}index.html`],
    );
  } finally {
    worker.fermer();
  }
});

test("un 401 SANS l'en-tête convenu n'est pas retenu : il est rendu", async () => {
  // Une ressource tierce protégée, un bord mal configuré : geler la lecture
  // dans l'espoir d'une reconnexion qui n'a pas lieu d'être serait pire que
  // de rendre le refus.
  const worker = await banc([reponseFactice({ status: 401 })]);
  try {
    const reponse = await worker.requeter(MORCEAU);
    assert.equal(reponse.status, 401);
    assert.deepEqual(worker.messagesAuxClients, [], "aucune coquille dérangée");
  } finally {
    worker.fermer();
  }
});

test("un artefact HORS configuration est retenu lui aussi", async () => {
  // La rétention ne dépend pas du cache : un morceau que le cache ne couvre
  // pas (SW redémarré, configuration pas encore déclarée) doit être retenu de
  // la même façon — c'est v86 qui gèle, pas le cache.
  const worker = await chargerWorker({ scope: SCOPE, repondre: () => refus() });
  worker.poserClients([{ url: `${SCOPE}index.html` }]);
  try {
    const promesse = worker.requeter(MORCEAU);
    let resolue = false;
    promesse.then(() => (resolue = true));
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(resolue, false, "retenue sans qu'aucune configuration ne soit connue");
    // Le worker redemande AUSSI la configuration qui lui manque : les deux
    // messages coexistent, et c'est bien celui de la session qu'on veut voir.
    const sessions = worker.messagesAuxClients.filter(
      (envoi) => envoi.message.type === "session-expiree",
    );
    assert.equal(sessions.length, 1);
  } finally {
    worker.fermer();
  }
});
