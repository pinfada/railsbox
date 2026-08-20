// LE PASSAGE DE RÔLE, AVEC LA VRAIE COQUILLE — et un intrus dans l'onglet qui
// reprend.
//
// L'épreuve voisine (`relais-onglets.e2e.spec.mjs`) couvre le PROTOCOLE du
// worker, mais elle rejoue le côté page à la main : elle ne prouve donc rien
// sur `main.js`, ni sur l'élection Web Locks, ni sur le rechargement réel de
// l'onglet qui rend la sandbox. Celle-ci ne rejoue rien : deux onglets sur `/`,
// le vrai chargeur, la vraie élection, un vrai « Reprendre la sandbox ».
//
// Ce qu'elle met à l'épreuve en plus, et qui est le fond du sujet :
//
//   MessagePort.prototype.start = function () { vole(this); … }
//
// Un XSS applicatif n'a pas besoin d'attendre un envoi pour capter le port
// privé — il lui suffit de piéger UNE opération que la coquille fera
// elle-même en le construisant : `start`, le setter `onmessage`, les
// accesseurs `port1`/`port2`. Les pièges sont posés ici APRÈS le chargement de
// la page, comme le ferait une injection réelle, puis le tour de
// rétablissement a lieu pour de bon.
//
// Deux boots de VM : c'est cher, et c'est le prix d'une épreuve qui ne triche
// pas. Elle s'ignore là où les artefacts manquent, comme la suite VM.
import { expect, test } from "@playwright/test";

import { vmDisksSkipReason } from "./vm-disks.mjs";

const BOOT_MS = 300_000;
const REPRISE_MS = 300_000;
const LIBELLE_REPRISE = "Reprendre la sandbox dans cet onglet";

const skipReason = vmDisksSkipReason();

/**
 * Attend que la coquille ait fini de démarrer (badge HTTP au vert), ou qu'elle
 * annonce un échec.
 * @param {import("@playwright/test").Page} page
 */
async function attendreApplication(page) {
  const issue = await page.waitForFunction(
    () => {
      const dom = /** @type {any} */ (globalThis).document;
      const classes = (id) => dom.getElementById(`badge-${id}`)?.classList ?? null;
      if (classes("http")?.contains("ok")) return "prête";
      const casse = ["sw", "coi", "vm", "http"].find((id) => classes(id)?.contains("error"));
      return casse ? `échec:${casse}` : null;
    },
    undefined,
    { timeout: BOOT_MS, polling: 1_000 },
  );
  const verdict = String(await issue.jsonValue());
  if (verdict !== "prête") throw new Error(`démarrage en échec (${verdict})`);
}

/**
 * Pose dans la page les pièges d'un XSS applicatif — APRÈS le chargement, donc
 * après que `main.js` a capturé ses intrinsèques, ce qui est exactement la
 * fenêtre d'une injection réelle.
 *
 * Les surfaces qui touchent directement un port, plus le getter `data` des
 * événements qui arrivent dessus et le repli dynamique du contrôleur.
 * @param {import("@playwright/test").Page} page
 */
function poserPieges(page) {
  return page.evaluate(() => {
    const vue = /** @type {any} */ (globalThis);
    // Les ports CAPTÉS, c'est-à-dire tout ce que la coquille aura touché par
    // une opération remplacée. S'il y en a un seul, la capacité a fui.
    vue.__piege = {
      start: [],
      onmessage: [],
      postMessage: [],
      port1: [],
      port2: [],
      data: [],
      workerPostMessage: [],
    };

    // L'intrus se sert lui-même de `MessageChannel` : sans ce drapeau, ses
    // propres ports gonflent ses compteurs et l'épreuve mesure son ombre. Le
    // premier jet le faisait — la pile d'appel l'a montré.
    let interne = false;
    const sien = () => interne;

    const startOriginal = MessagePort.prototype.start;
    MessagePort.prototype.start = function () {
      if (!sien()) vue.__piege.start.push(this);
      return Reflect.apply(startOriginal, this, []);
    };

    const posterOriginal = MessagePort.prototype.postMessage;
    MessagePort.prototype.postMessage = function (donnees, transfert) {
      if (!sien()) vue.__piege.postMessage.push(this);
      return Reflect.apply(posterOriginal, this, [donnees, transfert]);
    };

    const onmessageOriginal = Object.getOwnPropertyDescriptor(MessagePort.prototype, "onmessage");
    Object.defineProperty(MessagePort.prototype, "onmessage", {
      configurable: true,
      get: onmessageOriginal.get,
      set(valeur) {
        if (!sien()) vue.__piege.onmessage.push(this);
        Reflect.apply(onmessageOriginal.set, this, [valeur]);
      },
    });

    // Lire `event.data` est aussi une opération remplaçable. Sur un événement
    // de MessagePort, le getter s'exécute pendant la distribution :
    // `event.currentTarget` est alors le port privé lui-même.
    const dataOriginal = Object.getOwnPropertyDescriptor(MessageEvent.prototype, "data");
    Object.defineProperty(MessageEvent.prototype, "data", {
      configurable: true,
      get() {
        const cible = this.currentTarget;
        if (!sien() && (cible === vue.navigator.serviceWorker || cible instanceof MessagePort)) {
          vue.__piege.data.push(cible);
        }
        return Reflect.apply(dataOriginal.get, this, []);
      },
    });

    for (const nom of ["port1", "port2"]) {
      const original = Object.getOwnPropertyDescriptor(MessageChannel.prototype, nom);
      Object.defineProperty(MessageChannel.prototype, nom, {
        configurable: true,
        get() {
          const port = Reflect.apply(original.get, this, []);
          if (!sien()) vue.__piege[nom].push(port);
          return port;
        },
      });
    }

    // Les anciennes branches `instanceof EventTarget/ServiceWorker` relisaient
    // ces globales au moment du tour. En les remplaçant, l'intrus forçait le
    // repli vers `controller.postMessage`, piégé ici, qui voit `port2` dans la
    // liste de transfert. Les vraies globales sont restaurées dans notre
    // écouteur, APRÈS le passage de l'écouteur légitime.
    const EventTargetOriginal = vue.EventTarget;
    const ServiceWorkerOriginal = vue.ServiceWorker;
    const controleur = vue.navigator.serviceWorker.controller;
    const prototypeControleur = Object.getPrototypeOf(controleur);
    const posterWorkerOriginal = prototypeControleur.postMessage;
    prototypeControleur.postMessage = function (donnees, transfert) {
      if (!sien() && Array.isArray(transfert)) {
        vue.__piege.workerPostMessage.push(...transfert);
      }
      return Reflect.apply(posterWorkerOriginal, this, [donnees, transfert]);
    };
    vue.EventTarget = function EventTargetFalsifie() {};
    vue.ServiceWorker = function ServiceWorkerFalsifie() {};

    // Et l'écoute des tours, pour tenter de répondre au nonce à la place de la
    // coquille.
    vue.__intrus = { nonces: [], recu: [] };
    vue.navigator.serviceWorker.addEventListener("message", (evenement) => {
      interne = true;
      try {
        // Getter ORIGINAL : l'intrus ne déclenche pas son propre piège. Cet
        // écouteur vient après celui de main.js, donc les globales sont restées
        // falsifiées pendant toute la réponse légitime.
        const donnees = Reflect.apply(dataOriginal.get, evenement, []);
        if (donnees?.type !== "coquille-canal-request") return;
        vue.EventTarget = EventTargetOriginal;
        vue.ServiceWorker = ServiceWorkerOriginal;
        vue.__intrus.nonces.push(donnees.nonce);
        const vole = new MessageChannel();
        vole.port1.onmessage = (recu) => vue.__intrus.recu.push(recu.data?.type ?? "sans-type");
        vole.port1.start();
        vue.navigator.serviceWorker.controller.postMessage(
          { type: "coquille-canal", nonce: donnees.nonce },
          [vole.port2],
        );
      } finally {
        interne = false;
      }
    });
    vue.navigator.serviceWorker.startMessages?.();

    /**
     * Tente les commandes privilégiées SUR CHAQUE PORT CAPTÉ. C'est la question
     * qui compte : pas « un port a-t-il été touché », mais « l'intrus a-t-il
     * récupéré la capacité ». Rend ce que ses propres canaux ont reçu.
     */
    vue.__exploiter = async () => {
      const captes = [
        ...vue.__piege.start,
        ...vue.__piege.onmessage,
        ...vue.__piege.postMessage,
        ...vue.__piege.port1,
        ...vue.__piege.port2,
        ...vue.__piege.data,
        ...vue.__piege.workerPostMessage,
      ];
      /** @type {string[]} */
      const recu = [];
      interne = true;
      try {
        for (const port of captes) {
          const rogue = new MessageChannel();
          rogue.port1.onmessage = (evenement) => recu.push(evenement.data?.type ?? "sans-type");
          rogue.port1.start();
          try {
            port.postMessage({ type: "bridge-port" }, [rogue.port2]);
            port.postMessage({ type: "artifact-config", config: { name: "pirate" } });
          } catch {
            // Port neutralisé par le transfert : rien à en tirer non plus.
          }
        }
      } finally {
        interne = false;
      }
      await new Promise((resoudre) => setTimeout(resoudre, 600));
      return { captes: captes.length, recu };
    };
  });
}

test.describe("Passage de rôle entre onglets — vraie coquille", () => {
  test.describe.configure({ mode: "serial" });
  test.skip(skipReason !== null, skipReason ?? "");

  /** @type {import("@playwright/test").BrowserContext} */
  let contexte;
  /** @type {import("@playwright/test").Page} */
  let premier;
  /** @type {import("@playwright/test").Page} */
  let second;

  test.beforeAll(async ({ browser }) => {
    if (skipReason !== null) return;
    test.setTimeout(BOOT_MS + REPRISE_MS);
    // Un seul contexte : deux onglets du même visiteur, donc un seul worker et
    // une seule élection Web Locks.
    contexte = await browser.newContext();
    premier = await contexte.newPage();
    await premier.goto("/");
    await attendreApplication(premier);

    second = await contexte.newPage();
    await second.goto("/");
    // L'élection doit l'avoir rangé en secondaire : c'est elle qui décide, pas
    // le test.
    await expect(
      second.getByRole("button", { name: LIBELLE_REPRISE }),
      "le second onglet doit être secondaire",
    ).toBeVisible({ timeout: BOOT_MS });
  });

  test.afterAll(async () => {
    await contexte?.close();
  });

  test("l'intrus arme ses pièges, puis le visiteur reprend la sandbox", async () => {
    test.setTimeout(REPRISE_MS);
    await poserPieges(second);
    // Le vrai geste : le verrou est arraché, le premier onglet RECHARGE (donc
    // son client disparaît), le second boote sa propre VM.
    await second.getByRole("button", { name: LIBELLE_REPRISE }).click();
    await attendreApplication(second);
    // Le premier s'est rechargé et se présente désormais en secondaire.
    await expect(
      premier.getByRole("button", { name: LIBELLE_REPRISE }),
      "l'ancien onglet a rendu la sandbox",
    ).toBeVisible({ timeout: REPRISE_MS });
  });

  test("un tour de rétablissement a bien eu lieu dans l'onglet qui reprend", async () => {
    // Sans cette vérification, les trois suivantes seraient creuses : elles
    // constateraient qu'aucun port n'a fuité d'un canal qui n'a jamais été
    // construit.
    const intrus = await second.evaluate(() => /** @type {any} */ (globalThis).__intrus);
    expect(intrus.nonces.length, "l'intrus a vu passer au moins un nonce").toBeGreaterThan(0);
  });

  test("aucune des surfaces piégées ne livre un port de la coquille", async () => {
    const piege = await second.evaluate(() => {
      const vue = /** @type {any} */ (globalThis).__piege;
      return {
        start: vue.start.length,
        onmessage: vue.onmessage.length,
        postMessage: vue.postMessage.length,
        port1: vue.port1.length,
        port2: vue.port2.length,
        data: vue.data.length,
        workerPostMessage: vue.workerPostMessage.length,
      };
    });
    expect(piege.start, "`start` remplacé n'est jamais appelé sur nos ports").toBe(0);
    expect(piege.onmessage, "le setter `onmessage` remplacé non plus").toBe(0);
    expect(piege.postMessage, "ni `postMessage`").toBe(0);
    expect(piege.port1, "ni l'accesseur `port1`").toBe(0);
    expect(piege.port2, "ni l'accesseur `port2`").toBe(0);
    expect(piege.data, "ni le getter `MessageEvent.data`").toBe(0);
    expect(piege.workerPostMessage, "ni le `postMessage` du contrôleur en repli").toBe(0);
  });

  test("et rien de ce qu'il a pu capter ne commande le proxy", async () => {
    // La question de fond, posée directement : l'intrus rejoue les commandes
    // privilégiées sur CHAQUE port qu'il a touché. Si l'un d'eux était le
    // canal privé, son propre pont recevrait aussitôt des descripteurs HTTP.
    const exploit = await second.evaluate(() => /** @type {any} */ (globalThis).__exploiter());
    expect(exploit.recu, "aucun descripteur ne lui parvient").toEqual([]);
    const caches = await second.evaluate(() => /** @type {any} */ (globalThis).caches.keys());
    expect(
      caches.some((nom) => String(nom).includes("pirate")),
      "et aucune configuration d'artefacts n'a été détournée",
    ).toBe(false);
  });

  test("les pièges étaient bien armés — sinon zéro ne prouverait rien", async () => {
    // TÉMOIN POSITIF. Les trois épreuves ci-dessus concluent d'un COMPTEUR À
    // ZÉRO. Un piège mal posé donnerait le même zéro. On refait donc ici, dans
    // la page, ce que la coquille ferait NAÏVEMENT — sans référence capturée —
    // et les compteurs doivent bouger.
    const bouge = await second.evaluate(async () => {
      const vue = /** @type {any} */ (globalThis);
      const avant = {
        start: vue.__piege.start.length,
        onmessage: vue.__piege.onmessage.length,
        port1: vue.__piege.port1.length,
        data: vue.__piege.data.length,
      };
      const naif = new MessageChannel();
      const messageLu = new Promise((resoudre) => {
        naif.port1.onmessage = (evenement) => resoudre(evenement.data);
      });
      naif.port1.start();
      naif.port2.postMessage("temoin");
      await messageLu;
      return {
        start: vue.__piege.start.length - avant.start,
        onmessage: vue.__piege.onmessage.length - avant.onmessage,
        port1: vue.__piege.port1.length - avant.port1,
        data: vue.__piege.data.length - avant.data,
      };
    });
    expect(bouge.start, "le piège sur `start` fonctionne").toBeGreaterThan(0);
    expect(bouge.onmessage, "celui sur le setter `onmessage` aussi").toBeGreaterThan(0);
    expect(bouge.port1, "et celui sur l'accesseur `port1`").toBeGreaterThan(0);
    expect(bouge.data, "et celui sur le getter `MessageEvent.data`").toBeGreaterThan(0);
  });

  test("l'intrus ne gagne pas le tour, et la sandbox sert normalement", async () => {
    const intrus = await second.evaluate(() => /** @type {any} */ (globalThis).__intrus);
    expect(intrus.recu, "le canal usurpé ne reçoit rien").toEqual([]);
    // Et la preuve que le canal légitime, lui, a bien été repris : l'iframe
    // applicative est servie par le pont du second onglet.
    await expect(second.locator("#app-frame")).toHaveAttribute("src", "/app/", {
      timeout: REPRISE_MS,
    });
  });
});
