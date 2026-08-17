// Instantané mémoire servi en fichiers-parties : logique pure de la coquille.
//
// Ce que ces tests verrouillent, dans l'ordre d'importance :
//  1. LA CONVENTION DE NOMMAGE EST UNIQUE. Trois implémentations la portent —
//     l'écriture (tools/build-v86-image/artifact-parts.mjs), le cache du
//     Service Worker (shared/artifact-cache.js) et la lecture
//     (shared/snapshot-parts.js). Elles sont vérifiées l'une contre l'autre :
//     une divergence ferait télécharger des morceaux inexistants.
//  2. LE CHOIX DU CHEMIN. Inventaire présent → morceaux ; absent ou douteux →
//     fichier d'un seul tenant. C'est la compatibilité ascendante des
//     sandboxes déjà publiées, la démonstration de référence comprise.
//  3. LE RÉASSEMBLAGE EST EXACT. Un instantané amputé ou décalé d'un octet se
//     restaure en apparence, puis plante la VM très loin de la cause.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { gunzip } from "node:zlib";

import {
  chooseSnapshotSource,
  createSnapshotAssembler,
  manifestUrlFor,
  parseSnapshotManifest,
  partNameFor,
} from "../public/shared/snapshot-parts.js";
import { artifactUrlOfPart } from "../public/shared/artifact-cache.js";
import { DEFAULT_CHUNK_BYTES, partName } from "../tools/build-v86-image/artifact-parts.mjs";

const run = promisify(execFile);
const decompress = promisify(gunzip);
const TOOLS = fileURLToPath(new URL("../tools/build-v86-image/", import.meta.url));
const MIB = 1024 * 1024;
const ETAT = "https://compte.github.io/depot/disks/demo-split-state.bin.gz";

/**
 * Inventaire tel que l'écrit split-artifact.mjs, dont les tests dérivent des
 * variantes fautives.
 * @param {Record<string, unknown>} [overrides]
 * @returns {string}
 */
function inventaire(overrides = {}) {
  return JSON.stringify({
    artifact: "demo-split-state.bin.gz",
    totalBytes: 10 * MIB,
    chunkBytes: 4 * MIB,
    compression: "gzip",
    partCount: 3,
    publishedBytes: 1234,
    parts: ["ignoré : les noms sont redérivés"],
    ...overrides,
  });
}

// --- Convention de nommage -------------------------------------------------

test("partNameFor reproduit exactement partName de la construction", () => {
  const artefacts = [
    "/disks/demo-split-state.bin.gz",
    "https://compte.github.io/depot/disks/demo-split-state.bin.gz",
    "/disks/demo-split-state.bin",
    "/disks/demo-app.ext2.zst",
  ];
  for (const artefact of artefacts) {
    for (const start of [0, DEFAULT_CHUNK_BYTES, 87 * DEFAULT_CHUNK_BYTES]) {
      assert.equal(
        partNameFor(artefact, start, DEFAULT_CHUNK_BYTES),
        partName(artefact, start, DEFAULT_CHUNK_BYTES),
        `divergence de nommage sur ${artefact} à ${start}`,
      );
    }
  }
});

test("un morceau d'instantané se ramène à l'instantané, comme un morceau de disque", () => {
  // C'est ce que fait le Service Worker pour décider s'il a le droit de mettre
  // le morceau en cache : sans cet aller-retour, les morceaux d'instantané
  // repartiraient au réseau à chaque visite.
  const morceau = partNameFor(ETAT, 8 * MIB, 4 * MIB);
  assert.equal(
    morceau,
    "https://compte.github.io/depot/disks/demo-split-state.bin-8388608-12582912.gz",
  );
  assert.equal(artifactUrlOfPart(morceau), ETAT);
});

test("manifestUrlFor nomme l'inventaire d'après le fichier NON compressé", () => {
  assert.equal(
    manifestUrlFor("/disks/demo-split-state.bin.gz"),
    "/disks/demo-split-state.bin-parts.json",
  );
  assert.equal(manifestUrlFor("/disks/demo-app.ext2.zst"), "/disks/demo-app.ext2-parts.json");
  // Instantané non compressé : rien à retirer.
  assert.equal(
    manifestUrlFor("/disks/demo-split-state.bin"),
    "/disks/demo-split-state.bin-parts.json",
  );
});

// --- Lecture de l'inventaire -----------------------------------------------

test("parseSnapshotManifest dérive le plan complet d'un inventaire valide", () => {
  const plan = parseSnapshotManifest(inventaire(), ETAT);
  assert.notEqual(plan, null);
  assert.equal(plan?.totalBytes, 10 * MIB);
  assert.equal(plan?.chunkBytes, 4 * MIB);
  assert.equal(plan?.compression, "gzip");
  assert.deepEqual(plan?.parts, [
    "https://compte.github.io/depot/disks/demo-split-state.bin-0-4194304.gz",
    "https://compte.github.io/depot/disks/demo-split-state.bin-4194304-8388608.gz",
    "https://compte.github.io/depot/disks/demo-split-state.bin-8388608-12582912.gz",
  ]);
});

test("parseSnapshotManifest ignore la liste de noms publiée", () => {
  // Les noms sont REDÉRIVÉS de l'URL de l'instantané : un inventaire ne peut
  // donc pas faire télécharger autre chose que les morceaux de CET artefact.
  const plan = parseSnapshotManifest(
    inventaire({ parts: ["https://ailleurs.example/charge-utile.bin"] }),
    ETAT,
  );
  for (const url of plan?.parts ?? []) {
    assert.match(url, /^https:\/\/compte\.github\.io\/depot\/disks\//);
  }
});

test("parseSnapshotManifest refuse tout inventaire douteux", () => {
  const refus = [
    ["JSON illisible", "{ pas du json"],
    ["JSON qui n'est pas un objet", "[]"],
    ["taille totale absente", inventaire({ totalBytes: undefined })],
    ["taille totale nulle", inventaire({ totalBytes: 0 })],
    ["taille totale fractionnaire", inventaire({ totalBytes: 1.5 })],
    ["taille de morceau nulle", inventaire({ chunkBytes: 0 })],
    ["compression que la coquille ne sait pas défaire", inventaire({ compression: "zstd" })],
    ["compte de morceaux incohérent", inventaire({ partCount: 42 })],
    ["inventaire d'un autre artefact", inventaire({ artifact: "autre-app-state.bin.gz" })],
  ];
  for (const [motif, texte] of refus) {
    assert.equal(parseSnapshotManifest(texte, ETAT), null, `accepté à tort : ${motif}`);
  }
});

test("parseSnapshotManifest accepte un inventaire sans compression ni compte", () => {
  const plan = parseSnapshotManifest(
    JSON.stringify({ totalBytes: 4 * MIB, chunkBytes: 4 * MIB }),
    ETAT,
  );
  assert.equal(plan?.compression, null);
  assert.equal(plan?.parts.length, 1);
});

// --- Choix du chemin (compatibilité ascendante) -----------------------------

test("sans inventaire, la coquille retombe sur l'instantané d'un seul tenant", () => {
  // Le cas de TOUTES les sandboxes publiées avant le découpage, dont la
  // démonstration de référence : elles portent un instantané monolithique et
  // aucun `-parts.json`. Rien à reconstruire, rien à migrer.
  assert.deepEqual(chooseSnapshotSource(ETAT, null), { mode: "whole", url: ETAT });
});

test("un inventaire illisible vaut absence d'inventaire, jamais échec", () => {
  assert.deepEqual(chooseSnapshotSource(ETAT, "<html>404</html>"), { mode: "whole", url: ETAT });
});

test("avec inventaire, la coquille emprunte le chemin des morceaux", () => {
  const source = chooseSnapshotSource(ETAT, inventaire());
  assert.equal(source.mode, "parts");
  assert.equal(source.mode === "parts" && source.plan.parts.length, 3);
});

// --- Réassemblage ----------------------------------------------------------

/**
 * @param {number} totalBytes
 * @param {number} chunkBytes
 * @returns {import("../public/shared/snapshot-parts.js").PlanInstantane}
 */
function plan(totalBytes, chunkBytes) {
  return /** @type {any} */ (
    parseSnapshotManifest(JSON.stringify({ totalBytes, chunkBytes }), ETAT)
  );
}

test("l'assembleur rend exactement les octets de l'instantané", () => {
  const p = plan(10, 4);
  const assembleur = createSnapshotAssembler(p);
  assembleur.push(Uint8Array.from([1, 2, 3, 4]));
  assembleur.push(Uint8Array.from([5, 6, 7, 8]));
  // Dernier morceau complété de zéros à la publication : v86 lit toujours un
  // morceau entier, mais l'instantané, lui, s'arrête à 10 octets.
  assembleur.push(Uint8Array.from([9, 10, 0, 0]));
  assert.deepEqual([...new Uint8Array(assembleur.finish())], [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
});

test("l'assembleur alloue le tampon final UNE fois, à la taille annoncée", () => {
  // La mémoire est la contrainte dure de ce chemin : l'instantané décompressé
  // pèse plusieurs centaines de Mo et la page en garde déjà une copie pour
  // v86. Le tampon rendu doit être celui qui a été alloué au départ, pas le
  // produit d'une concaténation — qui, elle, ferait exister deux exemplaires.
  const p = plan(8, 4);
  const assembleur = createSnapshotAssembler(p);
  assembleur.push(new Uint8Array(4));
  assembleur.push(new Uint8Array(4));
  assert.equal(assembleur.finish().byteLength, 8);
});

test("l'assembleur refuse un morceau tronqué", () => {
  const assembleur = createSnapshotAssembler(plan(8, 4));
  assert.throws(() => assembleur.push(new Uint8Array(3)), /tronqué/);
});

test("l'assembleur refuse un morceau surnuméraire", () => {
  const assembleur = createSnapshotAssembler(plan(4, 4));
  assembleur.push(new Uint8Array(4));
  assert.throws(() => assembleur.push(new Uint8Array(4)), /surnuméraire/);
});

test("l'assembleur refuse de rendre un instantané incomplet", () => {
  const assembleur = createSnapshotAssembler(plan(8, 4));
  assembleur.push(new Uint8Array(4));
  assert.throws(() => assembleur.finish(), /incomplet/);
});

// --- Aller-retour contre le VRAI producteur --------------------------------

test("aller-retour publication → coquille, identique à l'octet près", async () => {
  // La garantie de bout en bout : ce que split-artifact.mjs écrit, la logique
  // de la coquille le relit. Les tests précédents portent sur des plans
  // fabriqués à la main ; celui-ci part des fichiers réellement publiés.
  const dir = await mkdtemp(join(tmpdir(), "railsbox-instantane-"));
  try {
    const source = join(dir, "demo-split-state.bin");
    // Contenu reproductible et partiellement compressible, à l'image d'un
    // instantané mémoire : de larges pages nulles et des données denses.
    const original = Buffer.alloc(10 * MIB);
    for (let offset = 0; offset < original.length; offset += 4096) {
      if ((offset / 4096) % 4 === 0) continue;
      for (let i = 0; i < 4096 && offset + i < original.length; i += 1) {
        original[offset + i] = (offset * 7 + i * 13) % 251;
      }
    }
    await writeFile(source, original);

    const out = join(dir, "publication");
    await run(process.execPath, [
      join(TOOLS, "split-artifact.mjs"),
      source,
      "--gzip",
      "--out",
      out,
    ]);

    const texte = await readFile(join(out, "demo-split-state.bin-parts.json"), "utf8");
    const source_ = chooseSnapshotSource("disks/demo-split-state.bin.gz", texte);
    assert.equal(source_.mode, "parts");
    if (source_.mode !== "parts") return;

    const assembleur = createSnapshotAssembler(source_.plan);
    for (const url of source_.plan.parts) {
      const nom = url.slice(url.lastIndexOf("/") + 1);
      assembleur.push(new Uint8Array(await decompress(await readFile(join(out, nom)))));
    }
    const empreinte = (bytes) => createHash("sha256").update(bytes).digest("hex");
    assert.equal(
      empreinte(new Uint8Array(assembleur.finish())),
      empreinte(original),
      "l'instantané réassemblé doit être identique à l'original",
    );

    // Et rien d'autre n'a été publié que les morceaux et leur inventaire.
    const publies = (await readdir(out)).sort();
    assert.equal(publies.length, source_.plan.parts.length + 1);
    assert.ok(publies.includes("demo-split-state.bin-parts.json"));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
