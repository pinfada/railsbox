// Le portail des tests VM décide si la suite navigateur qui boote une vraie
// machine peut s'exécuter. Il s'est trompé une fois, et de la pire façon : il
// exigeait les noms d'artefacts de la voie monolithique historique, si bien
// qu'un contributeur ayant construit une variante découpée voyait la suite
// s'ignorer alors que tout était présent. Un test ignoré ressemble à un test
// qui passe — d'où ces gardes.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Charge le portail en le faisant pointer vers un faux public/disks/.
 * Le module lit son chemin depuis import.meta.url : on le copie donc dans un
 * arbre temporaire qui en reproduit la profondeur (tests/e2e/ → ../../public).
 * @param {Record<string, string>} fichiers nom → contenu, dans public/disks/
 * @returns {Promise<{
 *   missing: () => string[],
 *   reason: () => string | null,
 *   nettoyer: () => Promise<void>,
 * }>}
 */
async function portailAvec(fichiers) {
  const racine = await mkdtemp(join(tmpdir(), "railsbox-portail-"));
  const disks = join(racine, "public", "disks");
  await mkdir(disks, { recursive: true });
  await mkdir(join(racine, "tests", "e2e"), { recursive: true });
  for (const [nom, contenu] of Object.entries(fichiers)) {
    await writeFile(join(disks, nom), contenu);
  }
  const source = await import("node:fs/promises").then((fs) =>
    fs.readFile(new URL("./e2e/vm-disks.mjs", import.meta.url), "utf8"),
  );
  const cible = join(racine, "tests", "e2e", "vm-disks.mjs");
  await writeFile(cible, source);
  const module = await import(`file://${cible.replace(/\\/g, "/")}`);
  return {
    missing: module.missingVmDisks,
    reason: module.vmDisksSkipReason,
    nettoyer: () => rm(racine, { recursive: true, force: true }),
  };
}

test("sans configuration, la suite VM s'ignore en le disant", async () => {
  const portail = await portailAvec({});
  assert.deepEqual(portail.missing(), ["v86-config.json"]);
  assert.match(/** @type {string} */ (portail.reason()), /v86-config\.json/);
  await portail.nettoyer();
});

test("une configuration découpée n'exige QUE ses artefacts locaux", async () => {
  // Le rootfs de base est servi par une URL absolue (ADR 0004) : l'exiger sur
  // le disque du contributeur était le défaut. Seuls le disque applicatif et
  // l'instantané sont locaux.
  const config = JSON.stringify({
    name: "demo",
    disk: "https://pinfada.github.io/railsbox-assets/base-3.3-r2/base-3.3-r2.ext2.zst",
    appDisk: "disks/demo-app.ext2.zst",
    state: "disks/demo-split-state.bin.gz",
  });
  const portail = await portailAvec({
    "v86-config.json": config,
    "demo-app.ext2.zst": "x",
    "demo-split-state.bin.gz": "x",
  });
  assert.deepEqual(portail.missing(), [], "tout est là : la suite doit s'exécuter");
  assert.equal(portail.reason(), null);
  await portail.nettoyer();
});

test("un artefact local manquant est nommé, pas deviné", async () => {
  const portail = await portailAvec({
    "v86-config.json": JSON.stringify({ disk: "disks/demo.ext2", state: "disks/demo-state.bin" }),
    "demo.ext2": "x",
  });
  assert.deepEqual(portail.missing(), ["demo-state.bin"]);
  await portail.nettoyer();
});

test("un instantané pré-compressé compte comme présent", async () => {
  // serve.mjs sert le jumeau .gz de façon transparente : exiger le fichier en
  // clair ferait s'ignorer une suite parfaitement exécutable.
  const portail = await portailAvec({
    "v86-config.json": JSON.stringify({ disk: "disks/demo.ext2", state: "disks/demo-state.bin" }),
    "demo.ext2": "x",
    "demo-state.bin.gz": "x",
  });
  assert.deepEqual(portail.missing(), []);
  await portail.nettoyer();
});

test("une configuration illisible ne fait pas planter la suite", async () => {
  const portail = await portailAvec({ "v86-config.json": "{ pas du json" });
  const manquants = portail.missing();
  assert.equal(manquants.length, 1);
  assert.match(manquants[0], /illisible/);
  await portail.nettoyer();
});
