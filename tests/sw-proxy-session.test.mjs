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
 * Les notifications reçues sur le canal privé, débarrassées de l'accusé de
 * réception et des demandes que le worker adresse à toute coquille qui vient
 * d'établir le canal (« redonne-moi la configuration, redonne-moi le pont »).
 * Ce sont deux conversations différentes sur le même fil.
 * @param {{ messagesAuCanal: any[] }} worker
 */
const notifications = (worker) =>
  worker.messagesAuCanal.filter(
    (message) => !String(message.type).endsWith("-request") && message.type !== "coquille-canal-ok",
  );

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
  worker.poserClients([{ url: `${SCOPE}index.html`, id: "coquille-1" }]);
  await worker.etablirCanal();
  await worker.declarerConfig(configFactice(SCOPE));
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
      notifications(worker),
      [{ type: "session-expiree" }],
      "la coquille est prévenue une fois, par son canal privé",
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
    await worker.commander({ type: "session-restauree" });

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
    assert.equal(notifications(worker).length, 1, "une seule notification pour l'épisode");
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
    await worker.commander({ type: "session-restauree" });
    const statuts = (await Promise.all(promesses)).map((r) => r.status);
    assert.deepEqual(statuts, [200, 200]);
  } finally {
    worker.fermer();
  }
});

test("le canal PUBLIC ne libère aucune lecture, même sous l'URL de la coquille", async () => {
  // L'ATTAQUE RÉELLE, réduite à ce qui la caractérise. Un XSS de l'application
  // n'émet pas depuis l'iframe : il ajoute un `<script src="/app/…">` au DOM du
  // parent, et ce script s'exécute DANS la coquille. Son message porte donc
  // l'URL de la coquille, et `isShellClient` ne peut pas l'en distinguer.
  //
  // Les deux émetteurs sont éprouvés ensemble : celui que le filtre d'URL
  // écartait déjà, et celui qu'il ne pouvait pas écarter.
  for (const emetteur of [`${SCOPE}app/panneau`, `${SCOPE}index.html`]) {
    const worker = await banc(() => refus());
    try {
      const promesse = worker.requeter(MORCEAU);
      let resolue = false;
      promesse.then(() => (resolue = true));
      await new Promise((r) => setTimeout(r, 20));
      worker.envoyerMessage({ type: "session-restauree" }, emetteur);
      await new Promise((r) => setTimeout(r, 20));
      assert.equal(resolue, false, `lecture toujours retenue — émetteur ${emetteur}`);
    } finally {
      worker.fermer();
    }
  }
});

test("un second canal est refusé tant que la coquille qui le tient est ouverte", async () => {
  // Sans cette règle, la capacité s'annulerait d'un « qui parle en dernier » :
  // le script injecté proposerait son propre canal et prendrait la place. Il
  // s'exécute dans la coquille VIVANTE — la condition qu'il lui faudrait
  // (porteur disparu) est précisément celle qu'il ne peut pas produire.
  const worker = await banc(() => refus());
  try {
    const intrus = await worker.etablirCanal({ url: `${SCOPE}index.html`, id: "coquille-1" });
    assert.equal(intrus, null, "aucun second canal n'est adopté");
  } finally {
    worker.fermer();
  }
});

test("un canal est ré-adopté quand la coquille qui le tenait a disparu", async () => {
  // Le pendant nécessaire : une page rechargée doit pouvoir reprendre la main,
  // sans quoi le proxy resterait muet jusqu'à la mort du worker.
  const worker = await banc(() => refus());
  try {
    worker.poserClients([{ url: `${SCOPE}index.html`, id: "coquille-2" }]);
    const repris = await worker.etablirCanal({ url: `${SCOPE}index.html`, id: "coquille-2" });
    assert.notEqual(repris, null, "la nouvelle coquille reprend le canal");
  } finally {
    worker.fermer();
  }
});

test("aucune notification ne part sur le canal public", async () => {
  // Ce qui garde la session ne dépend plus de l'URL des clients : les
  // notifications ne quittent le worker que par le canal privé. Le canal
  // public ne porte plus qu'une chose, et elle n'accorde aucun droit : la
  // demande de rétablir le canal.
  const worker = await banc(() => refus());
  worker.poserClients([
    { url: `${SCOPE}index.html`, id: "coquille-1" },
    { url: `${SCOPE}app/tableau`, id: "app-1" },
  ]);
  try {
    worker.requeter(MORCEAU);
    await new Promise((r) => setTimeout(r, 20));
    const publics = worker.messagesAuxClients.filter(
      (envoi) => envoi.message?.type !== "coquille-canal-request",
    );
    assert.deepEqual(publics, [], "aucune notification ne part en clair");
    assert.deepEqual(notifications(worker), [{ type: "session-expiree" }]);
  } finally {
    worker.fermer();
  }
});

test("un canal PROPOSÉ sans nonce est refusé, même quand le worker n'en a aucun", async () => {
  // LE FOND DE LA CORRECTION. Un worker redémarré n'a plus de canal : il
  // adoptait alors le premier proposé, et un script injecté n'avait qu'à le
  // réveiller et parler avant la coquille. Il n'y a plus de proposition — il y
  // a des RÉPONSES à un tour que le worker seul ouvre.
  const worker = await chargerWorker({ scope: SCOPE, repondre: () => refus() });
  worker.poserClients([{ url: `${SCOPE}index.html`, id: "coquille-1" }]);
  try {
    const spontane = await worker.repondreAuTour({ nonce: undefined });
    assert.equal(spontane, null, "aucune adoption sans nonce");
    const invente = await worker.repondreAuTour({ nonce: "nonce-invente-par-l-intrus" });
    assert.equal(invente, null, "aucune adoption sur un nonce inconnu");
  } finally {
    worker.fermer();
  }
});

test("un nonce ne sert qu'UNE fois — celui qui répond le second perd", async () => {
  // La course entre la coquille et un script injecté DANS la coquille : tous
  // deux voient le même nonce, puisqu'ils vivent dans le même client. Ce qui
  // les départage est l'ordre — la coquille a inscrit son écouteur à
  // l'évaluation de son module, avant que l'intrus n'existe. Ici, on éprouve
  // la seule chose qui dépende du worker : le second arrivé est refusé.
  const worker = await chargerWorker({ scope: SCOPE, repondre: () => refus() });
  worker.poserClients([{ url: `${SCOPE}index.html`, id: "coquille-1" }]);
  try {
    const tour = await worker.ouvrirTour();
    assert.equal(tour.length, 1, "un nonce, pour le seul client coquille");
    const premier = await worker.repondreAuTour({ nonce: tour[0].nonce });
    assert.notEqual(premier, null, "le premier arrivé obtient le canal");
    const second = await worker.repondreAuTour({ nonce: tour[0].nonce });
    assert.equal(second, null, "le nonce est consommé : le second n'obtient rien");
  } finally {
    worker.fermer();
  }
});

test("un nonce ne vaut que pour le client auquel il a été adressé", async () => {
  const worker = await chargerWorker({ scope: SCOPE, repondre: () => refus() });
  worker.poserClients([
    { url: `${SCOPE}index.html`, id: "coquille-1" },
    { url: `${SCOPE}index.html`, id: "coquille-2" },
  ]);
  try {
    const tour = await worker.ouvrirTour();
    assert.equal(tour.length, 2, "un nonce par coquille, chacun le sien");
    const detourne = await worker.repondreAuTour({ nonce: tour[0].nonce, id: "coquille-2" });
    assert.equal(detourne, null, "le nonce d'un autre client ne vaut rien");
  } finally {
    worker.fermer();
  }
});

test("aucun tour n'est ouvert tant que la coquille qui commande est vivante", async () => {
  // Sans cette règle, un script injecté obtiendrait un tour à volonté et
  // pourrait retenter sa chance indéfiniment.
  const worker = await banc(() => refus());
  try {
    const tour = await worker.ouvrirTour();
    assert.deepEqual(tour, [], "le worker n'émet aucun nonce : il a déjà son canal");
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
    assert.deepEqual(notifications(worker), [], "aucune coquille dérangée");
  } finally {
    worker.fermer();
  }
});

test("un artefact HORS configuration est retenu lui aussi", async () => {
  // La rétention ne dépend pas du cache : un morceau que le cache ne couvre
  // pas (SW redémarré, configuration pas encore déclarée) doit être retenu de
  // la même façon — c'est v86 qui gèle, pas le cache.
  const worker = await chargerWorker({ scope: SCOPE, repondre: () => refus() });
  worker.poserClients([{ url: `${SCOPE}index.html`, id: "coquille-1" }]);
  await worker.etablirCanal();
  try {
    const promesse = worker.requeter(MORCEAU);
    let resolue = false;
    promesse.then(() => (resolue = true));
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(resolue, false, "retenue sans qu'aucune configuration ne soit connue");
    // Le worker redemande AUSSI la configuration qui lui manque : les deux
    // messages coexistent, et c'est bien celui de la session qu'on veut voir.
    const sessions = notifications(worker).filter((message) => message.type === "session-expiree");
    assert.equal(sessions.length, 1);
  } finally {
    worker.fermer();
  }
});
