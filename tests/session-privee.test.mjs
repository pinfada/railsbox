// Décision de rétention sur session expirée (risque n°1 de la distribution
// privée). Aucun navigateur requis : c'est tout l'intérêt d'avoir extrait la
// décision de sw-proxy.js vers public/shared/session-privee.js.
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  ABANDON,
  AUTH_EXPIREE,
  EN_TETE_AUTH,
  PLAFOND_RETENTION_MS,
  RESTAUREE,
  creerRetentionSession,
  estRefusDeSession,
} from "../public/shared/session-privee.js";

/** Horloge factice : les minuteries ne tirent que sur ordre. */
function fakeTimers() {
  let next = 1;
  const armed = new Map();
  return {
    setTimer: (fn, ms) => {
      const id = next++;
      armed.set(id, { fn, ms });
      return id;
    },
    clearTimer: (id) => armed.delete(id),
    fire: () => {
      for (const [id, { fn }] of [...armed]) {
        armed.delete(id);
        fn();
      }
    },
    armedCount: () => armed.size,
    armedDelay: () => [...armed.values()][0]?.ms,
  };
}

function retention(overrides = {}) {
  const timers = fakeTimers();
  const controleur = creerRetentionSession({
    setTimer: timers.setTimer,
    clearTimer: timers.clearTimer,
    ...overrides,
  });
  return { controleur, timers };
}

// --- estRefusDeSession : le contrat du bord, rien de plus ------------------

test("un 401 porteur de l'en-tête convenu est un refus de session", () => {
  assert.equal(estRefusDeSession(401, new Headers({ [EN_TETE_AUTH]: AUTH_EXPIREE })), true);
});

test("un 401 NU n'est pas un refus de session", () => {
  // Une ressource tierce protégée, un bord mal configuré : réveiller l'écran
  // de reconnexion de la sandbox serait un message mensonger.
  assert.equal(estRefusDeSession(401, new Headers()), false);
});

test("un 403 n'est jamais un refus de session, même avec l'en-tête", () => {
  // Révocation : irrécupérable, écran différent. Proposer « reconnectez-vous »
  // à un client révoqué le ferait tourner en rond.
  assert.equal(estRefusDeSession(403, new Headers({ [EN_TETE_AUTH]: AUTH_EXPIREE })), false);
});

test("un 5xx n'est jamais retenu : v86 le réessaie déjà tout seul", () => {
  for (const status of [500, 502, 503]) {
    assert.equal(estRefusDeSession(status, new Headers({ [EN_TETE_AUTH]: AUTH_EXPIREE })), false);
  }
});

test("un 200 et un 206 traversent le prédicat sans le déclencher", () => {
  assert.equal(estRefusDeSession(200, new Headers({ [EN_TETE_AUTH]: AUTH_EXPIREE })), false);
  assert.equal(estRefusDeSession(206, new Headers()), false);
});

test("l'en-tête est lu quelle que soit la casse et quel que soit le porteur", () => {
  // Headers normalise ; une Map ou un objet nu, non — et les tests des
  // appelants ne doivent pas être obligés de fabriquer un Headers.
  assert.equal(estRefusDeSession(401, new Map([[EN_TETE_AUTH, AUTH_EXPIREE]])), true);
  assert.equal(estRefusDeSession(401, { "X-Railsbox-Auth": AUTH_EXPIREE }), true);
  assert.equal(estRefusDeSession(401, { "X-Railsbox-Auth": "revoked" }), false);
});

test("des en-têtes absents ou illisibles ne déclenchent rien", () => {
  assert.equal(estRefusDeSession(401, null), false);
  assert.equal(estRefusDeSession(401, undefined), false);
  assert.equal(estRefusDeSession(401, { [EN_TETE_AUTH]: 42 }), false);
});

// --- L'épisode de rétention : notifier une fois, libérer toutes ------------

test("la première rétention notifie, les suivantes se contentent d'attendre", () => {
  // v86 demande ses morceaux par rafales : sans cet étranglement, une session
  // expirée produirait une pause de VM et un panneau PAR MORCEAU en vol.
  const { controleur } = retention();
  assert.equal(controleur.retenir().notifier, true, "première rétention de l'épisode");
  assert.equal(controleur.retenir().notifier, false);
  assert.equal(controleur.retenir().notifier, false);
  assert.equal(controleur.retenues(), 3);
  assert.equal(controleur.enCours(), true);
});

test("la restauration libère TOUTES les requêtes retenues, d'un coup", async () => {
  const { controleur } = retention();
  const attentes = [controleur.retenir(), controleur.retenir(), controleur.retenir()].map(
    (r) => r.attendre,
  );
  assert.equal(controleur.restaurer(), 3);
  assert.deepEqual(await Promise.all(attentes), [RESTAUREE, RESTAUREE, RESTAUREE]);
  assert.equal(controleur.retenues(), 0);
  assert.equal(controleur.enCours(), false);
});

test("un épisode refermé en laisse repartir un autre, notification comprise", async () => {
  // Une session peut expirer deux fois dans une même vie de worker : la
  // seconde fois doit prévenir la coquille comme la première.
  const { controleur } = retention();
  controleur.retenir();
  controleur.restaurer();
  assert.equal(controleur.retenir().notifier, true);
});

test("le plafond est armé à l'ouverture de l'épisode et vaut dix minutes", () => {
  const { controleur, timers } = retention();
  controleur.retenir();
  assert.equal(timers.armedCount(), 1);
  assert.equal(timers.armedDelay(), PLAFOND_RETENTION_MS);
});

test("le plafond ne se réarme PAS à chaque morceau retenu", () => {
  // Sinon une rafale continue de v86 repousserait l'échéance sans fin, et la
  // table des requêtes en vol du worker enflerait indéfiniment.
  const { controleur, timers } = retention();
  controleur.retenir();
  controleur.retenir();
  controleur.retenir();
  assert.equal(timers.armedCount(), 1, "une seule minuterie pour tout l'épisode");
});

test("le plafond atteint résout les requêtes en ABANDON, pas en attente éternelle", async () => {
  const { controleur, timers } = retention();
  const { attendre } = controleur.retenir();
  const autre = controleur.retenir().attendre;
  timers.fire();
  assert.equal(await attendre, ABANDON);
  assert.equal(await autre, ABANDON);
  assert.equal(controleur.enCours(), false, "l'épisode est clos : l'écran devient terminal");
});

test("une restauration désarme le plafond", () => {
  const { controleur, timers } = retention();
  controleur.retenir();
  controleur.restaurer();
  assert.equal(timers.armedCount(), 0, "aucune minuterie ne survit à l'épisode");
});

test("le plafond est paramétrable, et l'abandon manuel a le même effet", async () => {
  const { controleur, timers } = retention({ plafondMs: 42 });
  const { attendre } = controleur.retenir();
  assert.equal(timers.armedDelay(), 42);
  assert.equal(controleur.abandonner(), 1);
  assert.equal(await attendre, ABANDON);
  assert.equal(timers.armedCount(), 0);
});

test("restaurer ou abandonner hors épisode ne fait rien", () => {
  // Le worker peut recevoir « session-restauree » d'une coquille alors qu'il
  // vient de redémarrer et n'a rien retenu : cas normal, pas une erreur.
  const { controleur } = retention();
  assert.equal(controleur.restaurer(), 0);
  assert.equal(controleur.abandonner(), 0);
  assert.equal(controleur.enCours(), false);
});
