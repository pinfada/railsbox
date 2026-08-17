// MESURE SOUS BRIDAGE PROCESSEUR — ce que railsbox coûte à un visiteur dont la
// machine n'est pas celle du développeur.
//
// Pourquoi cette recette existe : la suite en ligne (tests/live/) mesure le
// boot sur le processeur du poste qui l'exécute, et l'« émulation mobile » de
// Playwright ne change QUE la fenêtre et l'agent utilisateur. Un téléphone
// n'était donc jamais mesuré — seulement un écran de téléphone. Chrome DevTools
// Protocol sait, lui, ralentir réellement le thread principal
// (`Emulation.setCPUThrottlingRate`) : c'est le seul moyen d'obtenir un chiffre
// honnête sans acheter d'appareils.
//
// Ce qu'elle mesure, à chaque taux :
//   - le temps jusqu'à « application disponible » (badge HTTP au vert),
//     décomposé en phase RÉSEAU (jusqu'au badge VM : artefacts + instantané)
//     et phase ÉMULATION (du badge VM au badge HTTP : restauration + réveil de
//     Puma), parce que le bridage ne touche que la seconde ;
//   - le nombre de sondes HTTP internes brûlées (READY_INTERVAL_MS × N) ;
//   - la latence d'un GET `app/posts` à travers le pont série, une fois l'
//     application disponible.
//
// Un GUETTEUR facultatif (`RAILSBOX_BRIDAGE_GUETTEUR=1`) interroge en plus la
// VM une fois par seconde pour dater l'instant où l'application répond VRAIMENT,
// à comparer à celui où la coquille l'annonce. Il est éteint par défaut, et ce
// n'est pas une précaution de style : ses sondes coûtent au processeur bridé, et
// le coût mesuré grandit avec le bridage — +1 % du temps de boot à 1×, +7 % à
// 4×, +12 % à 6×, et jusqu'à 133 s au lieu de 37 s à 8×. Allumé, il déforme donc
// la mesure qu'il accompagne. Voir le rapport de la mission C3.
//
// Elle dépend du réseau, d'un déploiement et du temps : elle ne tourne donc ni
// dans `npm test`, ni dans `npm run test:e2e`, ni dans `npm run test:live`, ni
// dans la CI. Voir playwright.bridage.config.mjs et `npm run test:bridage`.
//
// Chromium seulement : `Emulation.setCPUThrottlingRate` est une commande CDP,
// que Firefox et WebKit n'exposent pas. C'est une limite assumée — le bridage
// n'est pas un comportement de navigateur, c'est un instrument de mesure.
import { mkdir, writeFile } from "node:fs/promises";

import { expect, test } from "@playwright/test";

import { urlSandbox } from "../live/url-sandbox.mjs";
import { repetitionsDemandees, tauxDemandes } from "./taux.mjs";

const URL_SANDBOX = urlSandbox();
const TAUX = tauxDemandes(process.env.RAILSBOX_BRIDAGE_TAUX);
const REPETITIONS = repetitionsDemandees(process.env.RAILSBOX_BRIDAGE_REPETITIONS);
// Un boot bridé 8× ne se compte plus en dizaines de secondes. La marge doit
// couvrir le pire cas sans jamais devenir infinie : au-delà, ce n'est plus une
// mesure, c'est une panne, et une panne doit se voir.
const BOOT_TIMEOUT_MS = 900_000;
// Une requête traversant le pont série sur un processeur bridé 8× : le pont
// lui-même expire à 120 s (REQUEST_TIMEOUT_MS de public/vm/v86-vm.js).
const REQUETE_TIMEOUT_MS = 180_000;
const MESURES_LATENCE = 3;
// Délai que public/vm/v86-vm.js accorde à UNE sonde interne (PROBE_TIMEOUT_MS).
// La mesure le rappelle ici pour pouvoir dire, chiffres en main, à quel taux de
// bridage la sonde s'en approche — le jour où elle le dépasse, la coquille
// déclare l'application indisponible alors qu'elle répond.
const PROBE_TIMEOUT_MS_COQUILLE = 10_000;
// Délai des sondes du GUETTEUR (celles de la mesure, pas celles de la
// coquille). Volontairement court : tant que le démon du pont n'est pas vivant
// dans l'invité, une sonde n'obtient RIEN — pas un refus, le silence — et
// occupe donc sa durée entière. Court, elle redemande vite ; longue, elle
// masquerait l'instant qu'on cherche à dater. Deux secondes laissent une marge
// de plus d'un ordre de grandeur sur les 42 ms mesurés pour `GET /app/`.
const DELAI_GUET_MS = 2_000;
/** Guetteur allumé ? Éteint par défaut : il fausse la mesure (voir en-tête). */
const GUETTEUR_ACTIF = (process.env.RAILSBOX_BRIDAGE_GUETTEUR ?? "").trim() === "1";
const FICHIER_RESULTATS = "test-results/bridage-cpu.json";

/**
 * @typedef {{
 *   taux: number, essai: number,
 *   coquilleMs: number, swMs: number|null, coiMs: number|null,
 *   vmMs: number|null, httpMs: number, premierePageMs: number|null,
 *   premiereReponseMs: number|null,
 *   rechargements: number, sondes: number, sondesEnErreur: number,
 *   messagesSondes: string[],
 *   latencesMs: number[], statuts: number[], sondeMs: number[],
 * }} Mesure
 */

/** @type {Mesure[]} */
const mesures = [];

test.describe("Boot sous bridage processeur", () => {
  test.describe.configure({ mode: "serial" });

  for (const taux of TAUX) {
    for (let essai = 1; essai <= REPETITIONS; essai += 1) {
      const nom =
        REPETITIONS === 1 ? `bridage ${taux}×` : `bridage ${taux}× (essai ${essai}/${REPETITIONS})`;

      test(nom, async ({ browser, browserName }) => {
        test.skip(
          browserName !== "chromium",
          "Emulation.setCPUThrottlingRate est une commande CDP : Chromium seulement",
        );
        test.setTimeout(BOOT_TIMEOUT_MS + REQUETE_TIMEOUT_MS * MESURES_LATENCE + 60_000);

        // Contexte neuf à chaque mesure : sans cela le Service Worker, le cache
        // d'artefacts et l'instantané en IndexedDB survivraient d'un taux à
        // l'autre, et on ne mesurerait plus une première visite.
        const contexte = await browser.newContext();
        try {
          const mesure = await mesurerUnBoot(contexte, taux, essai);
          mesures.push(mesure);
          journaliser(mesure);
          expect(mesure.httpMs, "l'application doit finir par être disponible").toBeGreaterThan(0);
        } finally {
          await contexte.close();
        }
      });
    }
  }

  test.afterAll(async () => {
    if (mesures.length === 0) return;
    console.log(`\n${tableauMarkdown(mesures)}\n`);
    await mkdir("test-results", { recursive: true }).catch(() => {});
    await writeFile(
      FICHIER_RESULTATS,
      `${JSON.stringify({ sandbox: URL_SANDBOX, mesureLe: new Date().toISOString(), mesures }, null, 2)}\n`,
      "utf8",
    );
    console.log(`[bridage] valeurs brutes écrites dans ${FICHIER_RESULTATS}`);
  });
});

/**
 * Un boot complet, chronométré, sur un contexte neuf et un processeur bridé.
 * @param {import("@playwright/test").BrowserContext} contexte
 * @param {number} taux
 * @param {number} essai
 * @returns {Promise<Mesure>}
 */
async function mesurerUnBoot(contexte, taux, essai) {
  const page = await contexte.newPage();
  const cdp = await contexte.newCDPSession(page);
  const brider = () => cdp.send("Emulation.setCPUThrottlingRate", { rate: taux });

  // Bridé AVANT la première navigation : le coût du démarrage de la coquille
  // fait partie de ce qu'on mesure. Et réappliqué à chaque navigation, parce
  // que la coquille se recharge une ou deux fois de sa propre initiative
  // (prise de contrôle du Service Worker, puis isolation cross-origin).
  await brider();

  const jalons = { sw: null, coi: null, vm: null, http: null };
  let rechargements = 0;
  const debut = Date.now();
  page.on("framenavigated", (cadre) => {
    if (cadre !== page.mainFrame()) return;
    rechargements += 1;
    // Les badges repartent à zéro : les jalons d'une passe abandonnée ne
    // décrivent plus rien. Seule la dernière passe compte.
    jalons.sw = jalons.coi = jalons.vm = jalons.http = null;
    brider().catch(() => {});
  });

  await page.goto(URL_SANDBOX, { waitUntil: "domcontentloaded" });
  const coquilleMs = Date.now() - debut;

  // Deux observateurs en parallèle : celui qui regarde la coquille (quand
  // DIT-ELLE que l'application est prête) et, si on l'a demandé, celui qui
  // interroge la VM directement (quand l'application RÉPOND-ELLE vraiment).
  // Le second est éteint par défaut : il répond à sa question au prix d'un
  // temps de boot faussé — voir l'en-tête du fichier.
  // `arret` est le drapeau commun : si l'attente des badges échoue, le guetteur
  // doit s'arrêter avec elle plutôt que de sonder une page qu'on va fermer.
  const arret = { demande: false };
  const [, premiereReponseMs] = await Promise.all([
    suivreLesBadges(page, jalons, debut).finally(() => {
      arret.demande = true;
    }),
    guetterLaPremiereReponse(page, jalons, debut, arret),
  ]);

  const premierePageMs = await attendrePremierePage(page, debut);
  const journal = await page.locator("#boot-log").innerText();
  const latences = await mesurerLatences(page);
  const sondeMs = await mesurerSondes(page);

  await page.close();
  return {
    taux,
    essai,
    coquilleMs,
    swMs: jalons.sw,
    coiMs: jalons.coi,
    vmMs: jalons.vm,
    httpMs: /** @type {number} */ (jalons.http),
    premierePageMs,
    premiereReponseMs,
    // Le premier `framenavigated` est la navigation initiale, pas un
    // rechargement : on ne compte que les suivants.
    rechargements: Math.max(0, rechargements - 1),
    ...compterSondes(journal),
    latencesMs: latences.map((resultat) => resultat.ms),
    statuts: latences.map((resultat) => resultat.statut),
    sondeMs,
  };
}

/**
 * Attend les quatre badges de la coquille en notant l'instant de chacun.
 * S'arrête immédiatement si l'un d'eux tombe en erreur : la coquille marque en
 * rouge tout badge resté en attente quand le démarrage échoue, et attendre le
 * délai complet n'apprendrait rien.
 * @param {import("@playwright/test").Page} page
 * @param {{ sw: number|null, coi: number|null, vm: number|null, http: number|null }} jalons
 * @param {number} debut horodatage de la navigation initiale
 * @returns {Promise<void>}
 */
async function suivreLesBadges(page, jalons, debut) {
  const identifiants = /** @type {const} */ (["sw", "coi", "vm", "http"]);
  while (Date.now() - debut < BOOT_TIMEOUT_MS) {
    const etat = await page
      .evaluate(() => {
        const doc = /** @type {any} */ (globalThis).document;
        const classes = (id) => doc.getElementById(`badge-${id}`)?.className ?? "";
        return {
          sw: classes("sw"),
          coi: classes("coi"),
          vm: classes("vm"),
          http: classes("http"),
          journal: doc.getElementById("boot-log")?.textContent?.slice(-400) ?? "",
        };
      })
      // Un rechargement détruit le contexte d'exécution en plein vol : ce n'est
      // pas une panne, c'est le démarrage normal de la coquille.
      .catch(() => null);
    if (etat) {
      for (const id of identifiants) {
        if (/\bok\b/.test(etat[id]) && jalons[id] === null) jalons[id] = Date.now() - debut;
        if (/\berror\b/.test(etat[id])) {
          throw new Error(`Le démarrage a échoué (badge ${id}) :\n${etat.journal}`);
        }
      }
      if (jalons.http !== null) return;
    }
    await pause(250);
  }
  const journal = await page
    .locator("#boot-log")
    .innerText()
    .catch(() => "(journal illisible)");
  throw new Error(
    `Application toujours indisponible après ${Math.round(BOOT_TIMEOUT_MS / 1000)} s :\n${dernieresLignes(journal)}`,
  );
}

/**
 * Attend que l'application soit VISIBLE, et pas seulement annoncée : la
 * coquille pose l'adresse de l'iframe dès que le badge HTTP passe au vert, mais
 * c'est encore la VM qui doit rendre cette page-là.
 *
 * C'est la dernière attente du visiteur, et la seule que rien ne signalait :
 * une rangée de badges tout verts au-dessus d'un cadre vide. La mesurer, c'est
 * dire combien de temps dure ce silence — et donc si l'indicateur d'étape de la
 * coquille (public/shared/progression-demarrage.js) sert à quelque chose.
 *
 * Aucune requête supplémentaire n'est émise vers la VM : on n'observe que
 * l'état du document déjà en cours de chargement.
 * @param {import("@playwright/test").Page} page
 * @param {number} debut
 * @returns {Promise<number|null>}
 */
async function attendrePremierePage(page, debut) {
  while (Date.now() - debut < BOOT_TIMEOUT_MS) {
    const cadre = page
      .frames()
      .find((candidat) => candidat !== page.mainFrame() && candidat.url().includes("/app"));
    const affiche = await cadre
      ?.evaluate(() => {
        const doc = /** @type {any} */ (globalThis).document;
        return doc.readyState === "complete" && (doc.body?.innerText ?? "").trim().length > 0;
      })
      // Une navigation en cours détruit le contexte : ce n'est pas une panne.
      .catch(() => false);
    if (affiche) return Date.now() - debut;
    await pause(250);
  }
  return null;
}

/**
 * Interroge la VM en propre, une fois par seconde, à partir du moment où elle
 * existe (badge VM) — en parallèle de l'attente de la coquille, qui sonde, elle,
 * toutes les READY_INTERVAL_MS (5 s). Rend l'instant de la PREMIÈRE réponse de
 * l'application.
 *
 * Ce que cette mesure sert à établir : l'écart entre « l'application répond » et
 * « la coquille l'annonce » est du temps mort imposé par la cadence de sondage,
 * pas du travail de démarrage. C'est la seule façon de chiffrer ce que coûte le
 * réglage sans modifier la sandbox publiée.
 *
 * Effet de bord, et il n'est PAS négligeable : chaque sonde du guetteur fait
 * rendre une page de plus à Rails DANS la VM, et la réponse remonte le canal
 * série à raison d'un appel JavaScript par octet — sur le thread même que le
 * bridage ralentit. Mesuré : boot allongé de 1 % à 1×, 7 % à 4×, 12 % à 6×, et
 * jusqu'à 133 s au lieu de 37 s à 8×. D'où l'interrupteur : le guetteur ne sert
 * qu'à répondre à la question « la coquille annonce-t-elle en retard ? », et sa
 * réponse s'accompagne toujours d'un temps de boot majoré.
 * @param {import("@playwright/test").Page} page
 * @param {{ vm: number|null, http: number|null }} jalons
 * @param {number} debut
 * @param {{ demande: boolean }} arret
 * @returns {Promise<number|null>}
 */
async function guetterLaPremiereReponse(page, jalons, debut, arret) {
  if (!GUETTEUR_ACTIF) return null;
  while (jalons.vm === null && jalons.http === null) {
    if (arret.demande || Date.now() - debut > BOOT_TIMEOUT_MS) return null;
    await pause(200);
  }
  while (!arret.demande && Date.now() - debut < BOOT_TIMEOUT_MS) {
    const repond = await page
      .evaluate(async (delai) => {
        const navigateur = /** @type {any} */ (globalThis);
        const vm = navigateur.__vm;
        if (!vm || typeof vm.handleHttpRequest !== "function") return false;
        try {
          const reponse = await vm.handleHttpRequest(
            { method: "GET", path: "/app/", headers: [], hasBody: false, forwardHost: "localhost" },
            null,
            delai,
          );
          return reponse.status > 0;
        } catch {
          return false;
        }
      }, DELAI_GUET_MS)
      .catch(() => false);
    if (repond) return Date.now() - debut;
    // La coquille a conclu avant nous : on ne revendique aucun temps mort
    // plutôt que d'en inventer un depuis une sonde restée en vol.
    if (jalons.http !== null) return jalons.http;
    await pause(250);
  }
  return null;
}

/**
 * Latence d'un GET `app/posts` à travers le Service Worker puis le pont série,
 * mesurée depuis la page — donc en subissant le même bridage que le visiteur.
 * @param {import("@playwright/test").Page} page
 * @returns {Promise<{ ms: number, statut: number }[]>}
 */
async function mesurerLatences(page) {
  const resultats = [];
  for (let index = 0; index < MESURES_LATENCE; index += 1) {
    const resultat = await page.evaluate(async () => {
      const navigateur = /** @type {any} */ (globalThis);
      const debut = navigateur.performance.now();
      const reponse = await navigateur.fetch("app/posts");
      const texte = await reponse.text();
      return {
        ms: Math.round(navigateur.performance.now() - debut),
        statut: reponse.status,
        octets: texte.length,
      };
    });
    resultats.push(resultat);
  }
  return resultats;
}

/**
 * Sondes HTTP internes émises pendant l'attente de Puma. Chaque sonde vaut un
 * aller-retour dans la VM plus READY_INTERVAL_MS d'attente : le compte dit
 * combien de ce temps est de la latence structurelle plutôt que du travail
 * utile. Celles en erreur se distinguent des réussies par le message que la
 * coquille accole (« — OK » sinon).
 * @param {string} journal
 * @returns {{ sondes: number, sondesEnErreur: number, messagesSondes: string[] }}
 */
function compterSondes(journal) {
  const lignes = [...journal.matchAll(/Sonde HTTP interne n°(\d+)([^\n]*)/g)];
  const numeros = lignes.map((trouve) => Number(trouve[1]));
  return {
    sondes: numeros.length === 0 ? 0 : Math.max(...numeros),
    sondesEnErreur: lignes.filter((trouve) => !trouve[2].includes("OK")).length,
    // Le libellé exact importe : « connexion refusée » signifie que le pont a
    // répondu tout de suite, « Délai dépassé » qu'il n'a rien répondu du tout
    // et que la sonde a brûlé PROBE_TIMEOUT_MS entier. Ce ne sont pas du tout
    // les mêmes secondes perdues.
    messagesSondes: lignes.map((trouve) => `n°${trouve[1]}${trouve[2]}`),
  };
}

/**
 * Aller-retour d'une SONDE, telle que la coquille l'émet pendant le boot :
 * `GET /app/` directement par le pont série, sans Service Worker. C'est la
 * seule mesure qui se compare à PROBE_TIMEOUT_MS — et donc la seule qui dise
 * si le budget de 10 s tient encore sur un processeur lent.
 *
 * Mesurée APRÈS le boot, donc sur une VM au repos : elle minore ce que coûte
 * la même sonde pendant que l'invité démarre PostgreSQL et Puma.
 * @param {import("@playwright/test").Page} page
 * @returns {Promise<number[]>}
 */
function mesurerSondes(page) {
  return page.evaluate(
    async ([repetitions, delai]) => {
      const navigateur = /** @type {any} */ (globalThis);
      const vm = navigateur.__vm;
      if (!vm || typeof vm.handleHttpRequest !== "function") return [];
      const mesures = [];
      for (let index = 0; index < repetitions; index += 1) {
        const debut = navigateur.performance.now();
        await vm.handleHttpRequest(
          { method: "GET", path: "/app/", headers: [], hasBody: false, forwardHost: "localhost" },
          null,
          delai,
        );
        mesures.push(Math.round(navigateur.performance.now() - debut));
      }
      return mesures;
    },
    [MESURES_LATENCE, REQUETE_TIMEOUT_MS],
  );
}

/**
 * @param {Mesure} mesure
 */
function journaliser(mesure) {
  const s = (valeur) => (valeur === null ? "—" : `${(valeur / 1000).toFixed(1)} s`);
  const reseau = mesure.vmMs;
  const emulation = mesure.vmMs === null ? null : mesure.httpMs - mesure.vmMs;
  console.log(
    `[bridage ${mesure.taux}×] application disponible en ${s(mesure.httpMs)} ` +
      `(coquille ${s(mesure.coquilleMs)}, SW ${s(mesure.swMs)}, COI ${s(mesure.coiMs)}, ` +
      `VM ${s(mesure.vmMs)}) → réseau ${s(reseau)} + émulation ${s(emulation)} ; ` +
      `application VISIBLE dans l'iframe à ${s(mesure.premierePageMs)} ` +
      `(soit ${s(silenceApresBadges(mesure))} de plus, badges déjà tous verts) ; ` +
      (mesure.premiereReponseMs === null
        ? ""
        : `première réponse réelle à ${s(mesure.premiereReponseMs)} ` +
          `(temps mort ${s(tempsMort(mesure))}) ; `) +
      `${mesure.rechargements} rechargement(s), ${mesure.sondes} sonde(s) dont ` +
      `${mesure.sondesEnErreur} en erreur ; ` +
      `sonde GET /app/ : ${mesure.sondeMs.map((valeur) => `${valeur} ms`).join(", ")} ; ` +
      `GET app/posts : ${mesure.latencesMs.map((valeur) => `${valeur} ms`).join(", ")}`,
  );
  // Le seul chiffre qui puisse casser le boot plutôt que le ralentir : une
  // sonde plus lente que son propre délai est comptée comme un échec, et la
  // coquille conclut que l'application ne répond pas alors qu'elle répond.
  const pire = Math.max(0, ...mesure.sondeMs);
  if (pire > PROBE_TIMEOUT_MS_COQUILLE / 2) {
    console.log(
      `[bridage ${mesure.taux}×] ATTENTION : la sonde la plus lente (${pire} ms) dépasse la ` +
        `moitié de PROBE_TIMEOUT_MS (${PROBE_TIMEOUT_MS_COQUILLE} ms) — et elle est mesurée sur ` +
        `une VM au repos, donc dans le cas le plus favorable.`,
    );
  }
}

/**
 * Tableau des valeurs brutes, prêt à coller dans un rapport.
 * @param {Mesure[]} lignes
 * @returns {string}
 */
function tableauMarkdown(lignes) {
  const entete = [
    "| Bridage | Essai | Coquille | Badge VM (réseau) | Application dispo. | dont émulation | Application visible | Silence badges verts | 1re réponse réelle | Temps mort | Sondes | Sonde GET /app/ | GET app/posts |",
    "| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |",
  ];
  const corps = lignes.map((mesure) => {
    const s = (valeur) => (valeur === null ? "—" : `${(valeur / 1000).toFixed(1)} s`);
    const emulation = mesure.vmMs === null ? null : mesure.httpMs - mesure.vmMs;
    return (
      `| ${mesure.taux}× | ${mesure.essai} | ${s(mesure.coquilleMs)} | ${s(mesure.vmMs)} | ` +
      `**${s(mesure.httpMs)}** | ${s(emulation)} | **${s(mesure.premierePageMs)}** | ` +
      `${s(silenceApresBadges(mesure))} | ${s(mesure.premiereReponseMs)} | ` +
      `${s(tempsMort(mesure))} | ${mesure.sondes} (${mesure.sondesEnErreur} KO) | ` +
      `${mesure.sondeMs.map((valeur) => `${valeur} ms`).join(" / ")} | ` +
      `${mesure.latencesMs.map((valeur) => `${valeur} ms`).join(" / ")} |`
    );
  });
  return [...entete, ...corps].join("\n");
}

/**
 * Écart entre l'instant où l'application a réellement répondu et l'instant où
 * la coquille l'a annoncé. C'est le prix de la cadence de sondage
 * (READY_INTERVAL_MS), payé par tous les visiteurs, à tous les taux.
 * @param {Mesure} mesure
 * @returns {number|null}
 */
function tempsMort(mesure) {
  if (mesure.premiereReponseMs === null) return null;
  return Math.max(0, mesure.httpMs - mesure.premiereReponseMs);
}

/**
 * Durée pendant laquelle les quatre badges sont au vert et le visiteur ne voit
 * toujours rien : la VM rend encore la première page. C'est ce silence que
 * l'indicateur d'étape de la coquille est chargé de combler.
 * @param {Mesure} mesure
 * @returns {number|null}
 */
function silenceApresBadges(mesure) {
  if (mesure.premierePageMs === null) return null;
  return Math.max(0, mesure.premierePageMs - mesure.httpMs);
}

/**
 * @param {string} journal
 * @returns {string}
 */
function dernieresLignes(journal) {
  return journal.split("\n").slice(-25).join("\n");
}

/**
 * @param {number} millisecondes
 * @returns {Promise<void>}
 */
function pause(millisecondes) {
  return new Promise((resoudre) => setTimeout(resoudre, millisecondes));
}
