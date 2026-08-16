// Verrou du point de vigilance de l'ADR 0001 : les artefacts doivent être lus
// par des « requêtes simples » au sens CORS.
//
// Le raisonnement, de bout en bout :
//   GitHub Pages répond **405 à OPTIONS** (mesuré, ADR 0001). Toute requête
//   cross-origin qui déclenche un préflight échoue donc — et elle n'échoue
//   qu'une fois publiée, jamais en développement où tout est same-origin.
//   Un préflight se déclenche dès qu'un en-tête non « CORS-safelisted » est
//   posé. Or le chargeur v86 en pose un — `X-Accept-Encoding: identity` — mais
//   UNIQUEMENT sur son chemin « requête Range ». Son chemin « fichiers-parties »
//   (ADR 0003) télécharge chaque morceau par un GET nu, sans aucun en-tête.
//
// La chaîne à verrouiller est donc :
//   workflow de publication → `--base-chunk-size`
//   → `diskChunkSize` dans v86-config.json
//   → `use_parts` dans buildDiskImages()
//   → chargeur « fichiers-parties » de v86
//   → aucun en-tête, donc aucun préflight.
//
// Ce test statique en vérifie chaque maillon. Le pendant dynamique — les
// en-têtes réellement émis par la sandbox publiée — vit dans
// tests/live/sandbox-publiee.live.spec.mjs.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { buildDiskImages } from "../public/shared/v86-config.js";
import { buildSplitConfig } from "../tools/build-v86-image/split-config.mjs";
import { enTetesNonSafelistes } from "./live/observateur-reseau.mjs";

const RACINE = fileURLToPath(new URL("../", import.meta.url));
const MIO = 1024 * 1024;

/** @param {string} chemin relatif à la racine du dépôt */
function lire(chemin) {
  return readFileSync(join(RACINE, chemin), "utf8");
}

/**
 * Texte intégral des appels `fetch(...)` d'un source, parenthèses appariées.
 * L'appariement est naïf (il ignore les parenthèses contenues dans des
 * chaînes) : au pire il retient TROP de texte, ce qui rend l'assertion plus
 * stricte, jamais plus permissive.
 * @param {string} source
 * @returns {string[]}
 */
function appelsFetch(source) {
  const appels = [];
  for (const trouve of source.matchAll(/\bfetch\s*\(/g)) {
    const debut = /** @type {number} */ (trouve.index);
    let profondeur = 0;
    let i = debut + trouve[0].length - 1;
    for (; i < source.length; i += 1) {
      if (source[i] === "(") profondeur += 1;
      else if (source[i] === ")") {
        profondeur -= 1;
        if (profondeur === 0) break;
      }
    }
    appels.push(source.slice(debut, i + 1));
  }
  return appels;
}

/**
 * Corps d'une fonction minifiée, repéré par son préfixe d'affectation et
 * délimité par appariement d'accolades.
 * @param {string} source
 * @param {string} prefixe par exemple « Aa.prototype.get= »
 * @returns {string}
 */
function corpsFonction(source, prefixe) {
  const debut = source.indexOf(prefixe);
  assert.notEqual(debut, -1, `motif introuvable dans le code vendorisé : ${prefixe}`);
  const ouvrante = source.indexOf("{", debut);
  let profondeur = 0;
  for (let i = ouvrante; i < source.length; i += 1) {
    if (source[i] === "{") profondeur += 1;
    else if (source[i] === "}") {
      profondeur -= 1;
      if (profondeur === 0) return source.slice(ouvrante, i + 1);
    }
  }
  throw new Error(`accolade fermante introuvable pour ${prefixe}`);
}

test("aucun fetch de la coquille n'ajoute d'en-tête à ses requêtes", () => {
  // main.js (v86-config.json) et v86-vm.js (instantané pré-calculé) sont les
  // deux seuls endroits où NOTRE code télécharge un artefact. Un `headers:`
  // y suffirait à préflighter la requête une fois la base cross-origin.
  for (const fichier of ["public/main.js", "public/vm/v86-vm.js", "public/env-drawer.js"]) {
    for (const appel of appelsFetch(lire(fichier))) {
      assert.doesNotMatch(
        appel,
        /headers/,
        `${fichier} : ce fetch pose des en-têtes, il risque un préflight — ${appel}`,
      );
    }
  }
});

test("le code du navigateur n'écrit jamais d'en-tête de requête non safelisté", () => {
  // setRequestHeader est la porte d'entrée côté XHR ; « X-Accept-Encoding » est
  // l'en-tête que v86 pose sur son chemin Range et que rien chez nous ne doit
  // reproduire.
  for (const fichier of [
    "public/main.js",
    "public/vm/v86-vm.js",
    "public/sw-proxy.js",
    "public/shared/v86-config.js",
  ]) {
    const source = lire(fichier);
    assert.doesNotMatch(source, /setRequestHeader/, `${fichier} pose un en-tête de requête`);
    assert.doesNotMatch(source, /X-Accept-Encoding/i, `${fichier} pose X-Accept-Encoding`);
    assert.doesNotMatch(source, /Authorization/i, `${fichier} pose Authorization`);
  }
});

test("le Service Worker réémet les requêtes d'artefacts telles quelles", () => {
  // Le SW intercepte désormais les artefacts immuables pour les mettre en
  // Cache Storage (cache-first, GitHub Pages plafonnant à max-age=600). C'est
  // compatible avec l'ADR 0001 à trois conditions, verrouillées ici :
  //   1. la requête d'origine est réémise TELLE QUELLE — `fetch(request)`,
  //      jamais un Request reconstruit ni un init qui poserait des en-têtes
  //      (`cache: "no-store"` suffirait à injecter Pragma/Cache-Control) ;
  //   2. aucun `new Request(` dans le SW ;
  //   3. les requêtes portant Range restent hors du chemin de cache : seuls
  //      les GET nus du chargeur « fichiers-parties » sont resservis.
  const source = lire("public/sw-proxy.js");
  for (const appel of appelsFetch(source)) {
    assert.doesNotMatch(
      appel,
      /[{,]\s*headers|cache\s*:/,
      `sw-proxy.js : ce fetch modifie la requête, il risque un préflight — ${appel}`,
    );
  }
  assert.doesNotMatch(
    source,
    /new Request\(/,
    "sw-proxy.js ne doit jamais reconstruire un Request",
  );
  assert.match(
    source,
    /await fetch\(request\)/,
    "le chemin des artefacts doit réémettre la requête d'origine telle quelle",
  );
  assert.match(
    source,
    /rangeHeader/,
    "le chemin des artefacts doit écarter les requêtes Range du cache",
  );
});

test("le chargeur « fichiers-parties » de v86 n'émet ni Range ni en-tête", () => {
  const vendor = lire("public/vendor/v86/libv86.js");
  // Les noms sont minifiés et changent d'une version à l'autre : on les dérive
  // du branchement `use_parts` lui-même plutôt que de les écrire en dur.
  const branchement = /use_parts\s*\?\s*new\s+(\w+)\([^)]*\)\s*:\s*new\s+(\w+)\(/.exec(vendor);
  assert.notEqual(branchement, null, "branchement use_parts introuvable dans libv86.js");
  const [, chargeurParties, chargeurRange] = /** @type {RegExpExecArray} */ (branchement);

  const parties = corpsFonction(vendor, `${chargeurParties}.prototype.get=`);
  assert.doesNotMatch(
    parties,
    /\brange\s*:/,
    "le chargeur de parties ne doit pas demander de Range",
  );
  assert.doesNotMatch(parties, /headers/, "le chargeur de parties ne doit poser aucun en-tête");

  // Le chemin Range, lui, est bien celui qui préflighterait : c'est la raison
  // d'être de toute la chaîne « fichiers-parties ». Si cette assertion tombe un
  // jour (v86 ayant retiré l'en-tête), la contrainte pourra être réexaminée —
  // pas avant.
  const range = corpsFonction(vendor, `${chargeurRange}.prototype.get=`);
  assert.match(range, /\brange\s*:/, "le chargeur mono-fichier lit bien par Range");
  assert.match(
    vendor,
    /setRequestHeader\("X-Accept-Encoding"/,
    "v86 pose X-Accept-Encoding sur ses requêtes Range : le chemin Range reste interdit cross-origin",
  );
});

test("une base publiée est déclarée en fichiers-parties, donc lue sans Range", () => {
  const config = buildSplitConfig({
    name: "demo",
    baseName: "base-3.3",
    baseDiskBytes: 1519386624,
    baseUrl: "https://pinfada.github.io/railsbox-assets/base-3.3/",
    baseChunkBytes: 4 * MIO,
    appChunkBytes: 4 * MIO,
    statePath: "disks/demo-split-state.bin.gz",
  });
  const images = /** @type {Record<string, any>} */ (buildDiskImages(/** @type {any} */ (config)));

  for (const [nom, cle] of [
    ["hda (base)", "hda"],
    ["hdb (application)", "hdb"],
  ]) {
    const image = images[cle];
    assert.equal(image?.use_parts, true, `${nom} doit être lu en fichiers-parties`);
    // Sans `size`, v86 sonde la taille par un « Range: bytes=0-0 » — préflighté
    // lui aussi. La taille doit donc toujours être connue d'avance.
    assert.ok(typeof image?.size === "number" && image.size > 0, `${nom} doit annoncer sa taille`);
    assert.equal("headers" in image, false, `${nom} ne porte aucun en-tête`);
  }
});

test("le classement des en-têtes de la recette en ligne a bien des dents", () => {
  // La vérification dynamique (tests/live) ne vaut que par ce classement : on
  // vérifie donc ici qu'il laisse passer ce que le navigateur pose de lui-même
  // et qu'il attrape ce qui provoquerait un préflight.
  const observes = {
    ":method": "GET",
    accept: "*/*",
    "accept-encoding": "gzip",
    range: "bytes=0-1023",
    referer: "https://exemple.test/",
    "sec-fetch-mode": "cors",
    "user-agent": "Chromium",
  };
  assert.deepEqual(enTetesNonSafelistes(observes), []);
  assert.deepEqual(
    enTetesNonSafelistes({
      ...observes,
      "X-Accept-Encoding": "identity",
      Authorization: "Bearer x",
    }),
    ["authorization", "x-accept-encoding"],
  );
});

test("le workflow de publication découpe toujours la base et l'application", () => {
  // Le maillon amont : sans ces deux options, la configuration publiée
  // n'aurait pas de chunkSize, v86 retomberait sur son chemin Range, et la
  // sandbox ne casserait qu'une fois en ligne.
  const workflow = lire(".github/workflows/construire-sandbox.yml");
  assert.match(workflow, /--base-chunk-size/, "la base publiée doit être découpée");
  assert.match(workflow, /--app-chunk-size/, "le disque applicatif publié doit être découpé");
});
