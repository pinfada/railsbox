// Ce que le worker fait quand la coquille NE RÉPOND PAS : distinguer une page
// occupée d'une page fermée.
//
// LE DÉFAUT (issue #12), trouvé sur la démonstration publiée de woofed-crm.
// v86 tourne sur le FIL PRINCIPAL de la page hôte. Un rendu lourd le monopolise
// plusieurs dizaines de secondes ; pendant ce temps la coquille est VIVANTE
// mais muette. Le worker réclamait le pont, attendait dix secondes, abandonnait
// le canal et rendait « La page hôte n'a pas fourni le pont VM (est-elle
// ouverte ?) ». Le message était faux — la page n'était pas fermée — et
// l'abandon du canal propageait l'échec aux requêtes suivantes, qui devaient
// toutes refaire la poignée de main.
//
// Mesuré dans un vrai navigateur : deux requêtes concurrentes passent (200),
// quatre tombent toutes en 502, cinq figent l'onglet. Les frames paresseuses
// d'une application partent par cinq — d'où cinq « Content missing ».
//
// CE QUI EST GARDÉ ICI, et rien d'autre : la DÉCISION prise à l'échéance. Une
// coquille vivante mérite qu'on réessaie ; une coquille disparue non. Les
// durées elles-mêmes ne sont pas éprouvées (l'attelage les comprime) : ce sont
// des réglages, pas un contrat.
import { test } from "node:test";
import assert from "node:assert/strict";

import { chargerWorker, reponseFactice } from "./sw-proxy-harness.mjs";

const SCOPE = "http://localhost/";
const COQUILLE = `${SCOPE}index.html`;

// Une demande de pont part DÉJÀ quand le canal s'établit (« redonne-moi la
// configuration, redonne-moi le pont »). Ce qui nous intéresse est ce que le
// worker fait APRÈS avoir buté sur le délai : on compte donc à partir de là.
const demandesDePont = (worker) =>
  worker.messagesAuCanal.filter((message) => message?.type === "bridge-port-request").length;

/**
 * Prépare un worker dont le canal privé est établi, sans jamais lui donner de
 * pont : c'est exactement l'état d'une coquille occupée à émuler.
 * @param {{ clients: Array<{ url: string, id?: string }> }} options
 */
async function workerSansPont({ clients }) {
  const worker = await chargerWorker({
    scope: SCOPE,
    minuteriesAccelerees: true,
    repondre: async () => reponseFactice({ status: 404 }),
  });
  // Les clients AVANT le canal : c'est la coquille elle-même qui l'établit.
  worker.poserClients(clients);
  await worker.etablirCanal();
  return worker;
}

test("une coquille VIVANTE mais muette fait RÉESSAYER, pas abandonner", async () => {
  // Le cas de woofed-crm : la page est là, elle émule, elle ne peut pas
  // répondre tout de suite. Abandonner au premier délai rendait un 502 à
  // chacune des cinq frames du pipeline.
  const worker = await workerSansPont({ clients: [{ url: COQUILLE, id: "coquille-1" }] });

  const avant = demandesDePont(worker);
  const rendue = await worker.requeter(`${SCOPE}app/accounts/1/pipelines/1`);

  assert.ok(
    demandesDePont(worker) - avant > 1,
    "le worker doit REDEMANDER le pont tant que la coquille vit, au lieu de conclure au premier délai",
  );

  const corps = await rendue.text();
  assert.doesNotMatch(
    corps,
    /est-elle ouverte/,
    "une page occupée n'est pas une page fermée : le message ne doit pas orienter vers un onglet fermé",
  );
  assert.match(corps, /occupée/, "il doit dire ce qui se passe RÉELLEMENT");

  worker.fermer();
});

test("sans aucune coquille, le worker conclut TOUT DE SUITE", async () => {
  // La contrepartie, et elle compte autant : un onglet réellement disparu ne
  // doit pas tenir le proxy en otage. C'est la raison d'être de l'abandon du
  // canal, et elle ne change pas.
  const worker = await workerSansPont({ clients: [] });

  const corps = await (await worker.requeter(`${SCOPE}app/accounts/1/pipelines/1`)).text();

  assert.match(corps, /est-elle ouverte/, "le message d'origine reste juste dans ce cas");
  assert.doesNotMatch(
    corps,
    /occupée/,
    "personne n'écoute : la page n'est pas « occupée », elle est partie",
  );

  worker.fermer();
});
