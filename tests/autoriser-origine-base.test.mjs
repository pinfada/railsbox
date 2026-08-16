// La coquille publiée chez un mainteneur tiers doit autoriser l'origine du
// dépôt d'artefacts dans sa CSP : `connect-src 'self'` bloquerait les XHR de
// v86 vers la base cross-origin — avant même toute question de CORS, et
// uniquement une fois en ligne. Le défaut appartient à la même famille que
// les quatre défauts de portabilité de chemin trouvés à la mise en ligne.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  ajouterOrigineConnectSrc,
  coquilleAutorisantBase,
  origineDe,
} from "../tools/build-v86-image/autoriser-origine-base.mjs";

const RACINE = fileURLToPath(new URL("../", import.meta.url));
const COQUILLE = readFileSync(join(RACINE, "public/index.html"), "utf8");
const BASE = "https://pinfada.github.io/railsbox-assets/base-3.3";

test("origineDe réduit une URL d'artefacts à son origine", () => {
  assert.equal(origineDe(BASE), "https://pinfada.github.io");
  assert.equal(origineDe("https://autre.github.io/depot/"), "https://autre.github.io");
});

test("une base cross-origin entre dans connect-src, et n'y entre qu'une fois", () => {
  const { html, modifie } = coquilleAutorisantBase(COQUILLE, BASE, "https://autre.github.io");
  assert.equal(modifie, true);
  assert.match(html, /connect-src 'self' https:\/\/pinfada\.github\.io;/);

  // Idempotence : réécrire la coquille déjà réécrite ne change plus rien.
  const encore = coquilleAutorisantBase(html, BASE, "https://autre.github.io");
  assert.equal(encore.modifie, false);
  assert.equal(encore.html, html);
});

test("une base same-origin laisse la coquille strictement intacte", () => {
  const { html, modifie } = coquilleAutorisantBase(COQUILLE, BASE, "https://pinfada.github.io");
  assert.equal(modifie, false);
  assert.equal(html, COQUILLE);
});

test("seule connect-src s'ouvre : les autres directives restent fermées", () => {
  const { html } = coquilleAutorisantBase(COQUILLE, BASE, "https://autre.github.io");
  for (const directive of ["default-src", "script-src", "frame-src", "form-action"]) {
    const avant = COQUILLE.match(new RegExp(`${directive}[^;"]*`))?.[0];
    const apres = html.match(new RegExp(`${directive}[^;"]*`))?.[0];
    assert.equal(apres, avant, `${directive} ne doit pas changer`);
  }
});

test("une CSP sans connect-src est un défaut, pas un cas silencieux", () => {
  assert.throws(
    () => ajouterOrigineConnectSrc("default-src 'self'", "https://pinfada.github.io"),
    /connect-src introuvable/,
  );
});
