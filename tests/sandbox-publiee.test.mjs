// Un dépôt PRIVÉ ne doit jamais être nommé dans une page publiée. L'erreur a
// été commise le 19/08/2026 : deux dépôts privés se sont retrouvés listés dans
// docs/adoption.md, sous un titre affirmant qu'ils étaient publics.
import test from "node:test";
import assert from "node:assert/strict";
import { cibleDePublication, nommable } from "../tools/sandbox-publiee.mjs";

const WORKFLOW = `name: Sandbox railsbox
jobs:
  sandbox:
    uses: pinfada/railsbox/.github/workflows/construire-sandbox.yml@main
    with:
      target-repo: pinfada/fractal-demo
`;

test("un dépôt privé n'est JAMAIS nommé", () => {
  assert.equal(nommable({ visibilite: "private", workflow: null }, "acme/secret"), null);
});

test("un dépôt privé fait nommer sa vitrine, pas lui-même", () => {
  const nom = nommable({ visibilite: "private", workflow: WORKFLOW }, "pinfada/fractal");
  assert.equal(nom, "pinfada/fractal-demo");
  assert.notEqual(nom, "pinfada/fractal", "la source privée ne doit pas fuiter");
});

test("un dépôt public sans vitrine se nomme lui-même", () => {
  assert.equal(nommable({ visibilite: "public", workflow: null }, "acme/vitrine"), "acme/vitrine");
});

test("une visibilité inconnue ne publie rien", () => {
  // Dépôt illisible, jeton insuffisant, API en erreur : le silence vaut mieux
  // qu'une fuite.
  assert.equal(nommable({ visibilite: null, workflow: null }, "acme/inconnu"), null);
});

test("une ligne commentée ne déclare pas de cible", () => {
  const yaml = "jobs:\n  sandbox:\n    with:\n      # target-repo: acme/exemple\n";
  assert.equal(cibleDePublication(yaml), null);
});

test("la cible est lue avec ou sans guillemets, et malgré un commentaire en fin de ligne", () => {
  assert.equal(cibleDePublication('      target-repo: "a/b"'), "a/b");
  assert.equal(cibleDePublication("      target-repo: 'a/b'"), "a/b");
  assert.equal(cibleDePublication("      target-repo: a/b # la vitrine"), "a/b");
});

test("un workflow absent ou illisible ne fabrique pas de cible", () => {
  for (const entree of [null, undefined, "", "name: rien"]) {
    assert.equal(cibleDePublication(entree), null);
  }
});
