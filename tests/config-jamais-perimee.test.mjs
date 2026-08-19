// Un `v86-config.json` servi depuis le cache HTTP fait restaurer un instantané
// mémoire d'une construction avec le disque d'une autre : état incohérent,
// Puma ne répond jamais, et rien ne le dit au visiteur.
//
// Mesuré en réel le 19/08/2026 sur une sandbox republiée :
//   depuis le cache : builtAt 2026-08-19T06:47:19Z  (construction précédente)
//   forcé réseau    : builtAt 2026-08-19T08:09:20Z  (construction réelle)
// Dix-huit sondes HTTP en échec, aucun diagnostic. Conséquence : republier une
// démonstration la casse pour tout visiteur déjà venu.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const lire = (chemin) => readFileSync(fileURLToPath(new URL(chemin, import.meta.url)), "utf8");

test("la configuration v86 est lue en contournant le cache HTTP", () => {
  const source = lire("../public/main.js");
  const appel = source.match(/fetch\(\s*V86_CONFIG_URL\s*(,[^)]*)?\)/);
  assert.ok(appel, "l'appel à V86_CONFIG_URL doit exister");
  assert.match(
    appel[0],
    /cache:\s*"(reload|no-store)"/,
    "v86-config.json décide du NOM du cache d'artefacts : périmée, elle fait " +
      "mélanger les artefacts de deux constructions",
  );
});

test("l'inventaire des morceaux d'instantané reste un GET nu", () => {
  // CONTRE-PARTIE ASSUMÉE. On aimerait le protéger de la même façon, mais
  // `cache:` fait injecter Pragma et Cache-Control par le navigateur, donc
  // préflighter — et le dépôt d'artefacts répond 405 à OPTIONS (ADR 0001,
  // verrouillé par artefacts-requetes-simples.test.mjs). L'inventaire reste
  // donc un GET nu.
  //
  // Ce qui protège quand même : le nom du cache d'artefacts dérive du
  // `builtAt` de la configuration, désormais lue fraîche. Une configuration à
  // jour ouvre un cache neuf, et les morceaux y sont retéléchargés.
  //
  // Le risque résiduel — un cache HTTP resservant un morceau périmé sous la
  // même URL — a depuis été traité à la racine : les morceaux du disque
  // applicatif et de l'instantané portent l'empreinte de leur contenu
  // (ADR 0007), donc une URL ne désigne plus jamais deux contenus. Ce n'était
  // effectivement pas un problème de préflight.
  const source = lire("../public/shared/snapshot-parts.js");
  const appel = source.match(/fetch\(\s*manifestUrlFor\([^)]*\)\s*(,[^)]*)?\)/);
  assert.ok(appel, "l'appel à manifestUrlFor doit exister");
  assert.doesNotMatch(appel[0], /cache:|headers/, "un GET nu, sans quoi 405 au préflight");
});
