// La RÉCUPÉRATION DU PONT EST PARTAGÉE, et elle s'annule proprement.
//
// Ces épreuves couvrent ce que la première version du correctif de #12 laissait
// passer — deux défauts de concurrence trouvés en relecture, pas par la mesure :
//
//  1. UNE BOUCLE PAR REQUÊTE. Cinq turbo-frames armaient cinq minuteries et
//     produisaient cinq sollicitations toutes les dix secondes — une rafale de
//     messages au fil principal PRÉCISÉMENT quand il est saturé. Le remède
//     aggravait donc en partie le mal qu'il traitait.
//
//  2. UNE COURSE DANS L'ÉCHÉANCE. `clearTimeout` ne peut rien contre une
//     échéance DÉJÀ ENGAGÉE dans son `await`. Si le pont arrivait pendant
//     `coquilleVivante()`, l'échéance reprenait ensuite et armait une minuterie
//     que plus personne ne tenait — laquelle pouvait resolliciter la coquille,
//     puis appeler `abandonnerCanal()` alors que le pont était rétabli.
//
// Ce qui est gardé ici est donc l'ÉTAT PARTAGÉ et son annulation, pas le
// comportement « réessayer » lui-même : celui-là vit dans sw-proxy-pont-occupe.
import { test } from "node:test";
import assert from "node:assert/strict";

import { chargerWorker, reponseFactice } from "./sw-proxy-harness.mjs";

const SCOPE = "http://localhost/";
const COQUILLE = `${SCOPE}index.html`;

const demandesDePont = (worker) =>
  worker.messagesAuCanal.filter((message) => message?.type === "bridge-port-request").length;

/** Laisse tourner la boucle d'événements le temps de quelques échéances. */
const respirer = (tours = 40) =>
  new Promise((resolve) => {
    let reste = tours;
    const tour = () => (reste-- > 0 ? setTimeout(tour, 2) : resolve(undefined));
    tour();
  });

/**
 * Un worker prêt, canal établi, coquille vivante, sans pont.
 * @param {{ clients?: Array<{ url: string, id?: string }> }} [options]
 */
async function workerPret({ clients = [{ url: COQUILLE, id: "coquille-1" }] } = {}) {
  const worker = await chargerWorker({
    scope: SCOPE,
    minuteriesAccelerees: true,
    repondre: async () => reponseFactice({ status: 404 }),
  });
  worker.poserClients(clients);
  await worker.etablirCanal();
  return worker;
}

/**
 * Fournit le pont comme le fait main.js : un MessagePort sur le canal privé.
 * Le bout distant répond à toute requête HTTP, pour que la requête aboutisse.
 * @param {any} worker
 */
async function donnerLePont(worker) {
  const canal = new MessageChannel();
  canal.port2.onmessage = (event) => {
    const data = event.data;
    if (data?.type !== "http-request") return;
    canal.port2.postMessage({
      type: "http-response",
      id: data.descriptor?.id ?? data.id,
      status: 200,
      headers: [["content-type", "text/plain"]],
      body: "servi par la VM",
    });
  };
  await worker.commander({ type: "bridge-port" }, [canal.port1]);
  // Les ports gardent la boucle d'evenements de Node eveillee : un test qui
  // les laisse ouverts fait pendre la suite entiere, sans jamais echouer.
  return {
    fermer() {
      canal.port2.onmessage = null;
      canal.port1.close();
      canal.port2.close();
    },
  };
}

/**
 * Sollicitations émises pendant qu'un nombre donné de requêtes attend le pont.
 * @param {number} combien
 */
async function solliciterAvec(combien) {
  const worker = await workerPret();
  const avant = demandesDePont(worker);
  const enVol = Array.from({ length: combien }, (_, i) =>
    Promise.resolve(worker.requeter(`${SCOPE}app/accounts/1/stages/${i + 1}`)).catch(() => null),
  );
  await respirer(12);
  const pendant = demandesDePont(worker) - avant;
  await Promise.all(enVol);
  worker.fermer();
  return pendant;
}

test("CINQ requêtes concurrentes ne sollicitent pas plus qu'UNE SEULE", async () => {
  // Le défaut n° 1. Le seuil n'est PAS absolu — il dépendrait de la vitesse des
  // minuteries, donc de la machine. L'invariant est comparatif : cinq requêtes
  // partagent une boucle, elles doivent donc solliciter la coquille autant
  // qu'une seule. Mesuré avant le partage : 35 contre 7.
  const uneSeule = await solliciterAvec(1);
  const cinq = await solliciterAvec(5);

  assert.ok(
    cinq <= uneSeule + 1,
    `cinq requêtes ont sollicité ${cinq} fois contre ${uneSeule} pour une seule : les boucles ne sont pas partagées`,
  );
});

test("le pont arrivé PENDANT une échéance ne laisse aucune minuterie orpheline", async () => {
  // Le défaut n° 2, et le plus grave : la minuterie orpheline pouvait appeler
  // `abandonnerCanal()` APRÈS le rétablissement, cassant le canal d'une
  // coquille parfaitement saine.
  //
  // L'instant est rendu DÉTERMINISTE : on retient le worker dans son
  // `clients.matchAll`, on lui donne le pont pendant qu'il y est, puis on le
  // libère. Sans cette barrière, l'épreuve dépendrait de tomber au bon
  // millième de seconde — intermittente, donc sans valeur sur une course.
  const worker = await workerPret();
  const barriere = worker.retenirClients();

  const enVol = Promise.resolve(worker.requeter(`${SCOPE}app/accounts/1/pipelines/1`)).catch(
    () => null,
  );
  await barriere.engagee(); // le worker est ARRÊTÉ au milieu de son échéance
  const pont = await donnerLePont(worker);
  barriere.liberer(); // l'échéance reprend, le pont est déjà là

  const reponse = await enVol;
  assert.ok(reponse, "la requête doit aboutir une fois le pont fourni");
  assert.equal(reponse.status, 200, "et être servie par la VM, pas par une page d'erreur");

  // Après rétablissement, plus AUCUNE sollicitation ne doit partir : une
  // minuterie survivante se trahirait ici.
  const apres = demandesDePont(worker);
  await respirer(40);
  assert.equal(
    demandesDePont(worker),
    apres,
    "une minuterie orpheline continuerait de réclamer le pont",
  );

  // Et le canal doit être INTACT : c'est ce que la minuterie orpheline cassait.
  const seconde = await Promise.resolve(worker.requeter(`${SCOPE}app/accounts/1/contacts`)).catch(
    () => null,
  );
  assert.equal(seconde?.status, 200, "le canal a été abandonné alors que le pont vivait");

  pont.fermer();
  worker.fermer();
});

test("une requête ABOUTIT après plusieurs échéances", async () => {
  // Le cas nominal de woofed-crm : la coquille finit par rendre la main. Sans
  // cette épreuve, « réessayer » pourrait très bien ne jamais réussir.
  const worker = await workerPret();

  const enVol = Promise.resolve(worker.requeter(`${SCOPE}app/accounts/1/pipelines/1`)).catch(
    () => null,
  );
  // Deux échéances, PAS PLUS : au-delà du plafond la récupération a déjà
  // renoncé, et l'épreuve ne mesurerait plus le rétablissement.
  await respirer(6);
  const pont = await donnerLePont(worker);

  const reponse = await enVol;
  assert.equal(reponse?.status, 200);

  pont.fermer();
  worker.fermer();
});
