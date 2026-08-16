// La veille d'arrière-plan doit suspendre la VM d'un onglet masqué — mais
// jamais au premier battement de cils : un délai de grâce absorbe les
// changements d'onglet furtifs, et la reprise recale tout.
import { test } from "node:test";
import assert from "node:assert/strict";

import { createVeilleController, DELAI_VEILLE_MS } from "../public/shared/veille.js";

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

function make(overrides = {}) {
  const timers = fakeTimers();
  const calls = { pause: 0, resume: 0 };
  const controller = createVeilleController({
    pause: () => (calls.pause += 1),
    resume: () => (calls.resume += 1),
    setTimer: timers.setTimer,
    clearTimer: timers.clearTimer,
    ...overrides,
  });
  return { controller, timers, calls };
}

test("un masquage suivi du délai de grâce suspend la VM, une seule fois", () => {
  const { controller, timers, calls } = make();
  controller.hidden();
  assert.equal(calls.pause, 0, "rien avant le délai de grâce");
  assert.equal(timers.armedDelay(), DELAI_VEILLE_MS);
  timers.fire();
  assert.equal(calls.pause, 1);
  assert.equal(controller.isPaused(), true);

  controller.hidden(); // évènements dupliqués : pas de seconde suspension
  timers.fire();
  assert.equal(calls.pause, 1);
});

test("un aller-retour furtif entre onglets ne coûte rien", () => {
  const { controller, timers, calls } = make();
  controller.hidden();
  controller.visible(); // revenu avant le délai
  timers.fire();
  assert.equal(calls.pause, 0);
  assert.equal(calls.resume, 0, "rien à reprendre : rien n'a été suspendu");
  assert.equal(timers.armedCount(), 0, "la minuterie doit être désarmée");
});

test("le retour sur un onglet suspendu reprend la VM, une seule fois", () => {
  const { controller, timers, calls } = make();
  controller.hidden();
  timers.fire();
  controller.visible();
  assert.equal(calls.resume, 1);
  assert.equal(controller.isPaused(), false);

  controller.visible(); // évènements dupliqués
  assert.equal(calls.resume, 1);

  // Le cycle complet reste rejouable.
  controller.hidden();
  timers.fire();
  assert.equal(calls.pause, 2);
  controller.visible();
  assert.equal(calls.resume, 2);
});

test("le délai de grâce est paramétrable", () => {
  const { timers, controller } = make({ delayMs: 5 });
  controller.hidden();
  assert.equal(timers.armedDelay(), 5);
});
