// Versionnement des artefacts publiés par EMPREINTE DE CONTENU (ADR 0007).
//
// L'incident du 19/08/2026 : une sandbox republiée ne bootait plus, dix-huit
// sondes HTTP en échec, aucun message. Le navigateur avait servi un
// `v86-config.json` périmé, qui nomme le cache d'artefacts et désigne
// l'instantané — la VM restaurait donc l'instantané mémoire d'une construction
// sur le disque d'une autre. Le correctif immédiat (lecture `cache: "reload"`,
// commit 730f22a) fonctionne, mais il repose sur un comportement de CDN que
// nous ne contrôlons pas.
//
// LA CAUSE RACINE EST UN NOM. `genealogyapp-app-0-4194304.ext2.zst` désignait
// un contenu DIFFÉRENT d'une construction à l'autre : tout cache — HTTP, CDN,
// Cache Storage — pouvait donc resservir légitimement le morceau d'une autre
// construction sous la même URL. Ce fichier verrouille la propriété qui rend la
// situation impossible : deux contenus différents ne portent jamais le même
// nom, et deux contenus identiques en portent toujours un seul.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import {
  DIGEST_HEX_LENGTH,
  partName,
  versionedArtifactName,
} from "../tools/build-v86-image/artifact-parts.mjs";
import { replacePublishedArtifact } from "../tools/build-v86-image/split-config.mjs";
import { scellerInstantane } from "../tools/build-v86-image/snapshot-cibles.mjs";
import { verifierInstantane } from "../public/shared/instantane-lien.js";
import { artifactUrlOfPart } from "../public/shared/artifact-cache.js";
import {
  manifestUrlFor,
  parseSnapshotManifest,
  partNameFor,
} from "../public/shared/snapshot-parts.js";

const run = promisify(execFile);
const TOOLS = fileURLToPath(new URL("../tools/build-v86-image/", import.meta.url));
const RACINE = fileURLToPath(new URL("../", import.meta.url));
const MIB = 1024 * 1024;

// --- La convention de nommage ------------------------------------------------

test("versionedArtifactName insère l'empreinte avant l'extension", () => {
  assert.equal(
    versionedArtifactName("demo-app.ext2", "0123456789ab"),
    "demo-app-0123456789ab.ext2",
  );
  assert.equal(
    versionedArtifactName("demo-split-state.bin", "0123456789ab"),
    "demo-split-state-0123456789ab.bin",
  );
  // Chemin conservé : seul le nom de fichier porte l'empreinte.
  assert.equal(
    versionedArtifactName("publication/disks/demo-app.ext2", "abcdef012345"),
    "publication/disks/demo-app-abcdef012345.ext2",
  );
});

test("versionedArtifactName refuse un nom déjà compressé", () => {
  // Le suffixe de compression est ajouté APRÈS le versionnement : l'accepter
  // ici produirait « demo-app.ext2-<empreinte>.zst », dont v86 dériverait des
  // morceaux introuvables.
  assert.throws(() => versionedArtifactName("demo-app.ext2.zst", "0123456789ab"), /compress/i);
  assert.throws(() => versionedArtifactName("demo-state.bin.gz", "0123456789ab"), /compress/i);
});

test("versionedArtifactName refuse une empreinte qui n'en est pas une", () => {
  assert.throws(() => versionedArtifactName("demo-app.ext2", ""), /Empreinte/);
  assert.throws(() => versionedArtifactName("demo-app.ext2", "pas-de-l-hexa"), /Empreinte/);
});

test("versionner la BASE de l'URL versionne les 128 morceaux", () => {
  // Le levier de tout le chantier : v86 dérive lui-même les noms de morceaux de
  // l'URL de l'artefact. Aucune ligne du chargeur n'a donc à changer.
  const versionne = `${versionedArtifactName("demo-app.ext2", "0123456789ab")}.zst`;
  assert.equal(partName(versionne, 0, 4 * MIB), "demo-app-0123456789ab-0-4194304.ext2.zst");
  assert.equal(
    partName(versionne, 4 * MIB, 4 * MIB),
    "demo-app-0123456789ab-4194304-8388608.ext2.zst",
  );
});

test("le cache d'artefacts retrouve l'artefact versionné depuis un morceau", () => {
  // artifact-cache.js remonte du morceau à l'artefact pour décider s'il est
  // cacheable. L'empreinte s'intercale entre le nom et les bornes : la borne de
  // fin reste le dernier groupe de chiffres, donc la règle tient.
  assert.equal(
    artifactUrlOfPart("/disks/demo-app-0123456789ab-4194304-8388608.ext2.zst"),
    "/disks/demo-app-0123456789ab.ext2.zst",
  );
  // Cas limite : une empreinte entièrement numérique (≈ 0,7 % des tirages) ne
  // doit pas être confondue avec une borne de morceau.
  assert.equal(
    artifactUrlOfPart("/disks/demo-app-123456789012-0-4194304.ext2.zst"),
    "/disks/demo-app-123456789012.ext2.zst",
  );
  // L'artefact versionné lui-même n'est PAS un morceau.
  assert.equal(artifactUrlOfPart("/disks/demo-app-123456789012.ext2.zst"), null);
});

test("la coquille suit l'instantané versionné sans une ligne de plus", () => {
  // snapshot-parts.js dérive l'inventaire et les morceaux de `config.state`.
  // Versionner `state` suffit donc à versionner tout ce que la coquille
  // télécharge — c'est ce que cette assertion prouve.
  const etat = "disks/demo-split-state-0123456789ab.bin.gz";
  assert.equal(manifestUrlFor(etat), "disks/demo-split-state-0123456789ab.bin-parts.json");
  assert.equal(
    partNameFor(etat, 4 * MIB, 4 * MIB),
    "disks/demo-split-state-0123456789ab.bin-4194304-8388608.gz",
  );
});

// --- L'accord entre la configuration et les fichiers publiés -----------------

test("replacePublishedArtifact substitue le nom sans toucher au chemin", () => {
  const config = {
    name: "demo",
    appDisk: "disks/demo-app.ext2.zst",
    state: "disks/demo-split-state.bin.gz",
  };
  const { config: patched, fields } = replacePublishedArtifact(
    config,
    "demo-app.ext2.zst",
    "demo-app-0123456789ab.ext2.zst",
  );
  assert.deepEqual(fields, ["appDisk"]);
  assert.equal(patched.appDisk, "disks/demo-app-0123456789ab.ext2.zst");
  assert.equal(patched.state, "disks/demo-split-state.bin.gz");
});

test("replacePublishedArtifact ne mute pas la configuration reçue", () => {
  // Règle du dépôt : on rend une copie, on ne modifie jamais l'original.
  const config = { appDisk: "disks/demo-app.ext2.zst" };
  replacePublishedArtifact(config, "demo-app.ext2.zst", "demo-app-0123456789ab.ext2.zst");
  assert.equal(config.appDisk, "disks/demo-app.ext2.zst");
});

test("replacePublishedArtifact signale qu'aucun champ ne nomme l'artefact", () => {
  // Un remplacement silencieusement sans effet REPRODUIRAIT l'incident : des
  // morceaux versionnés publiés, et une configuration qui nomme les anciens.
  const { fields } = replacePublishedArtifact(
    { appDisk: "disks/autre-app.ext2.zst" },
    "demo-app.ext2.zst",
    "demo-app-0123456789ab.ext2.zst",
  );
  assert.deepEqual(fields, []);
});

// --- La propriété visée, bout en bout ---------------------------------------

/**
 * Contenu déterministe et partiellement compressible, comme
 * tests/artifact-roundtrip.test.mjs : des creux et du bruit reproductible.
 * @param {number} size
 * @param {number} graine fait varier le contenu sans en changer la nature
 * @returns {Buffer}
 */
function syntheticDisk(size, graine = 0) {
  const buffer = Buffer.alloc(size);
  for (let offset = 0; offset < size; offset += 8192) {
    if ((offset / 8192) % 3 === 0) continue;
    for (let i = 0; i < 512 && offset + i < size; i += 1) {
      buffer[offset + i] = (offset + i * 31 + graine) % 251;
    }
  }
  return buffer;
}

/**
 * Découpe un artefact synthétique avec versionnement et rend l'inventaire ainsi
 * que la liste des fichiers publiés.
 * @param {Buffer} contenu
 * @returns {Promise<{ manifest: any, publies: string[] }>}
 */
async function decouperVersionne(contenu) {
  const dir = await mkdtemp(join(tmpdir(), "railsbox-empreinte-"));
  try {
    const source = join(dir, "demo-app.ext2");
    await writeFile(source, contenu);
    const out = join(dir, "publication");
    await run(process.execPath, [
      join(TOOLS, "split-artifact.mjs"),
      source,
      "--zstd",
      "--fingerprint",
      "--out",
      out,
    ]);
    const publies = (await readdir(out)).sort();
    const inventaire = publies.find((nom) => nom.endsWith("-parts.json"));
    assert.ok(inventaire, `aucun inventaire publié parmi ${publies.join(", ")}`);
    return { manifest: JSON.parse(await readFile(join(out, inventaire), "utf8")), publies };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test("deux constructions au contenu IDENTIQUE produisent les mêmes noms", async () => {
  // C'est l'avantage décisif de l'empreinte de contenu sur un horodatage : une
  // reconstruction qui ne change rien garde ses noms, donc le visiteur garde
  // son cache. Un `builtAt` aurait invalidé les 128 morceaux pour rien.
  const contenu = syntheticDisk(6 * MIB);
  const premier = await decouperVersionne(contenu);
  const second = await decouperVersionne(Buffer.from(contenu));
  assert.deepEqual(second.publies, premier.publies);
  assert.equal(second.manifest.artifact, premier.manifest.artifact);
  assert.equal(second.manifest.digest, premier.manifest.digest);
});

test("deux constructions au contenu DIFFÉRENT produisent des noms différents", async () => {
  // La propriété qui rend l'incident du 19/08 impossible : plus aucune URL ne
  // peut désigner deux contenus, donc plus aucun cache ne peut panacher deux
  // constructions.
  const premier = await decouperVersionne(syntheticDisk(6 * MIB, 0));
  const second = await decouperVersionne(syntheticDisk(6 * MIB, 7));
  assert.notEqual(second.manifest.digest, premier.manifest.digest);
  assert.notEqual(second.manifest.artifact, premier.manifest.artifact);
  for (const morceau of second.manifest.parts) {
    assert.ok(
      !premier.manifest.parts.includes(morceau),
      `le morceau ${morceau} est publié par les deux constructions`,
    );
  }
});

test("l'empreinte publiée fait douze caractères hexadécimaux", async () => {
  const { manifest } = await decouperVersionne(syntheticDisk(4 * MIB));
  assert.match(manifest.digest, new RegExp(`^[0-9a-f]{${DIGEST_HEX_LENGTH}}$`));
  assert.ok(manifest.artifact.includes(manifest.digest));
  for (const morceau of manifest.parts) assert.ok(morceau.includes(manifest.digest));
});

test("le découpeur accorde la configuration aux morceaux qu'il vient de publier", async () => {
  // Le point dur du chantier : la configuration est écrite AVANT le découpage,
  // et c'est le découpage qui connaît l'empreinte. Le découpeur, seul à la
  // tenir, réécrit le champ qui nomme l'artefact — sans relire les 512 Mo.
  const dir = await mkdtemp(join(tmpdir(), "railsbox-empreinte-config-"));
  try {
    const source = join(dir, "demo-app.ext2");
    await writeFile(source, syntheticDisk(4 * MIB));
    const configPath = join(dir, "demo-split-config.json");
    await writeFile(
      configPath,
      `${JSON.stringify(
        {
          name: "demo",
          appDisk: "disks/demo-app.ext2.zst",
          state: "disks/demo-split-state.bin.gz",
        },
        null,
        2,
      )}\n`,
    );
    const out = join(dir, "publication");
    await run(process.execPath, [
      join(TOOLS, "split-artifact.mjs"),
      source,
      "--zstd",
      "--fingerprint",
      "--config",
      configPath,
      "--out",
      out,
    ]);

    const config = JSON.parse(await readFile(configPath, "utf8"));
    const manifest = JSON.parse(
      await readFile(
        join(out, `${config.appDisk.replace(/^disks\//, "").replace(/\.zst$/, "")}-parts.json`),
        "utf8",
      ),
    );
    assert.equal(config.appDisk, `disks/${manifest.artifact}`);
    assert.equal(config.state, "disks/demo-split-state.bin.gz", "les autres champs sont intacts");
    // Et les morceaux que la configuration fait dériver existent bel et bien.
    const publies = await readdir(out);
    for (const morceau of manifest.parts) assert.ok(publies.includes(morceau));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("le découpeur refuse d'accorder une configuration qui ne le nomme pas", async () => {
  // Publier des morceaux versionnés en laissant la configuration nommer les
  // anciens, c'est exactement l'incident. Le découpeur échoue plutôt.
  const dir = await mkdtemp(join(tmpdir(), "railsbox-empreinte-muette-"));
  try {
    const source = join(dir, "demo-app.ext2");
    await writeFile(source, syntheticDisk(4 * MIB));
    const configPath = join(dir, "config.json");
    await writeFile(configPath, `${JSON.stringify({ appDisk: "disks/autre-app.ext2.zst" })}\n`);
    await assert.rejects(
      run(process.execPath, [
        join(TOOLS, "split-artifact.mjs"),
        source,
        "--zstd",
        "--fingerprint",
        "--config",
        configPath,
        "--out",
        join(dir, "publication"),
      ]),
      /Aucun champ/,
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("sans --fingerprint, le découpage reste celui d'avant", async () => {
  // Compatibilité : le chemin non versionné est encore celui du développement
  // local et des variantes, et rien ne doit y changer.
  const dir = await mkdtemp(join(tmpdir(), "railsbox-sans-empreinte-"));
  try {
    const source = join(dir, "demo-app.ext2");
    await writeFile(source, syntheticDisk(4 * MIB));
    const out = join(dir, "publication");
    await run(process.execPath, [
      join(TOOLS, "split-artifact.mjs"),
      source,
      "--zstd",
      "--out",
      out,
    ]);
    const manifest = JSON.parse(await readFile(join(out, "demo-app.ext2-parts.json"), "utf8"));
    assert.equal(manifest.artifact, "demo-app.ext2.zst");
    assert.equal(manifest.digest, undefined);
    assert.deepEqual(manifest.parts, ["demo-app-0-4194304.ext2.zst"]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("l'instantané versionné est bien celui que la coquille ira chercher", async () => {
  // Le chemin réellement publié pour l'instantané : gzip, et une configuration
  // dont le champ `state` est le SEUL point d'entrée de la coquille. On boucle
  // ici la chaîne complète — découpage → configuration → snapshot-parts.js —
  // sans qu'aucune des trois étapes ne connaisse les noms des autres.
  const dir = await mkdtemp(join(tmpdir(), "railsbox-empreinte-etat-"));
  try {
    const source = join(dir, "demo-split-state.bin");
    await writeFile(source, syntheticDisk(6 * MIB));
    const configPath = join(dir, "demo-split-config.json");
    await writeFile(
      configPath,
      `${JSON.stringify({ appDisk: "disks/demo-app.ext2.zst", state: "disks/demo-split-state.bin.gz" }, null, 2)}\n`,
    );
    const out = join(dir, "publication");
    await run(process.execPath, [
      join(TOOLS, "split-artifact.mjs"),
      source,
      "--gzip",
      "--fingerprint",
      "--config",
      configPath,
      "--out",
      out,
    ]);

    const config = JSON.parse(await readFile(configPath, "utf8"));
    assert.match(config.state, /^disks\/demo-split-state-[0-9a-f]{12}\.bin\.gz$/);
    assert.equal(config.appDisk, "disks/demo-app.ext2.zst", "les autres champs sont intacts");

    // La coquille dérive l'inventaire de `state`, sans rien savoir du découpage.
    const inventaire = manifestUrlFor(config.state).replace(/^disks\//, "");
    const plan = parseSnapshotManifest(await readFile(join(out, inventaire), "utf8"), config.state);
    assert.notEqual(plan, null, "l'inventaire publié doit être accepté tel quel");
    const publies = await readdir(out);
    for (const morceau of /** @type {any} */ (plan).parts) {
      assert.ok(
        publies.includes(morceau.replace(/^disks\//, "")),
        `la coquille demanderait ${morceau}, qui n'est pas publié`,
      );
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("un artefact versionné se réassemble comme les autres", async () => {
  // Le chemin inverse : la CI d'un mainteneur réassemble un artefact publié
  // pour capturer son delta. Il dérive l'inventaire et les morceaux de l'URL de
  // l'artefact — l'empreinte le suit sans qu'il ait à la connaître.
  const dir = await mkdtemp(join(tmpdir(), "railsbox-empreinte-retour-"));
  try {
    const original = syntheticDisk(6 * MIB);
    const source = join(dir, "demo-app.ext2");
    await writeFile(source, original);
    const out = join(dir, "publication");
    await run(process.execPath, [
      join(TOOLS, "split-artifact.mjs"),
      source,
      "--zstd",
      "--fingerprint",
      "--out",
      out,
    ]);
    const inventaire = (await readdir(out)).find((nom) => nom.endsWith("-parts.json"));
    const manifest = JSON.parse(await readFile(join(out, String(inventaire)), "utf8"));

    const cible = join(dir, "reassemble.ext2");
    await run(process.execPath, [
      join(TOOLS, "assemble-artifact.mjs"),
      join(out, manifest.artifact),
      "--out",
      cible,
    ]);
    assert.deepEqual(await readFile(cible), original);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// --- Le maillon amont : le workflow -----------------------------------------

test("le workflow publie des artefacts versionnés et accorde la configuration", () => {
  const workflow = readFileSync(join(RACINE, ".github/workflows/construire-sandbox.yml"), "utf8");
  const decoupages = workflow.match(/split-artifact\.mjs[\s\S]*?--out publication\/disks/g) ?? [];
  assert.equal(decoupages.length, 2, "le disque applicatif ET l'instantané sont découpés");
  for (const decoupage of decoupages) {
    assert.match(decoupage, /--fingerprint/, "les noms publiés doivent porter l'empreinte");
    assert.match(decoupage, /--config/, "la configuration doit être accordée aux morceaux publiés");
  }
});

// --- L'empreinte que le découpage rend à la configuration (ADR 0009) --------

/**
 * Découpe un artefact en accordant une configuration, et rend les deux.
 * @param {{ contenu: Buffer, nomSource: string, config: Record<string, unknown> }} scene
 * @returns {Promise<{ config: any, manifest: any }>}
 */
async function decouperAvecConfig({ contenu, nomSource, config }) {
  const dir = await mkdtemp(join(tmpdir(), "railsbox-empreinte-0009-"));
  try {
    const source = join(dir, nomSource);
    await writeFile(source, contenu);
    const configPath = join(dir, "demo-split-config.json");
    await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`);
    const out = join(dir, "publication");
    await run(process.execPath, [
      join(TOOLS, "split-artifact.mjs"),
      source,
      "--zstd",
      "--fingerprint",
      "--config",
      configPath,
      "--out",
      out,
    ]);
    const publies = await readdir(out);
    const inventaire = publies.find((nom) => nom.endsWith("-parts.json"));
    assert.ok(inventaire, `aucun inventaire parmi ${publies.join(", ")}`);
    return {
      config: JSON.parse(await readFile(configPath, "utf8")),
      manifest: JSON.parse(await readFile(join(out, inventaire), "utf8")),
    };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test("le découpage du DISQUE APPLICATIF inscrit son empreinte dans la configuration", async () => {
  // La seconde des deux lectures indépendantes. Le découpeur hache déjà les
  // octets pendant la lecture qui les découpe — il ne relit rien, il cesse
  // seulement de jeter ce qu'il sait.
  const contenu = syntheticDisk(4 * MIB);
  const { config, manifest } = await decouperAvecConfig({
    contenu,
    nomSource: "demo-app.ext2",
    config: { name: "demo", appDisk: "disks/demo-app.ext2.zst" },
  });

  const attendu = createHash("sha256").update(contenu).digest("hex");
  assert.equal(config.appDiskSha256, attendu, "l'empreinte porte sur les octets du fichier");
  assert.equal(config.appDiskSha256.length, 64, "SHA-256 complet, pas tronqué");
  // Le nom publié en garde les douze premiers : une seule et même empreinte.
  assert.equal(manifest.digest, attendu.slice(0, DIGEST_HEX_LENGTH));
  assert.equal(manifest.sha256, attendu, "l'inventaire porte l'empreinte complète");
});

test("le découpage de l'INSTANTANÉ n'inscrit aucune empreinte de disque", async () => {
  // Le même outil découpe les deux artefacts, l'un après l'autre, avec la même
  // ligne de commande à un nom près. Écrire `appDiskSha256` sur le second
  // remplacerait l'empreinte du disque par celle de l'instantané : les deux
  // valeurs cesseraient d'être comparables, et le garde prononcerait un
  // désaccord sur une sandbox parfaitement saine.
  const { config } = await decouperAvecConfig({
    contenu: syntheticDisk(4 * MIB, 7),
    nomSource: "demo-split-state.bin",
    config: { name: "demo", state: "disks/demo-split-state.bin.zst" },
  });

  assert.equal("appDiskSha256" in config, false);
});

test("découper l'instantané ne PIÉTINE pas l'empreinte que le disque a posée", async () => {
  // L'ordre réel de construire-sandbox.yml : disque d'abord, instantané
  // ensuite, sur LA MÊME configuration. La valeur du premier passage doit
  // survivre au second.
  const disque = "d".repeat(64);
  const { config } = await decouperAvecConfig({
    contenu: syntheticDisk(4 * MIB, 9),
    nomSource: "demo-split-state.bin",
    config: {
      name: "demo",
      state: "disks/demo-split-state.bin.zst",
      appDiskSha256: disque,
    },
  });

  assert.equal(config.appDiskSha256, disque);
});

test("capture puis découpage s'accordent — et un disque échangé entre eux non", async () => {
  // LA PROPRIÉTÉ VISÉE PAR L'ADR 0009, en miniature : deux lectures
  // indépendantes du même disque produisent la même empreinte, donc un
  // instantané ACCORDÉ ; deux lectures de disques différents divergent, donc un
  // DÉSACCORD — là où la date, elle, n'aurait rien vu.
  const contenu = syntheticDisk(4 * MIB, 3);
  const empreinteCapture = createHash("sha256").update(contenu).digest("hex");

  // Ce que la capture écrit, avec le disque qu'elle vient d'attacher.
  const scellee = scellerInstantane(
    {
      name: "demo",
      appDisk: "disks/demo-app.ext2.zst",
      builtAt: "2026-08-21T10:34:15Z",
    },
    "disks/demo-split-state.bin.gz",
    { appDiskSha256: empreinteCapture },
  );

  // Ce que le découpage écrit, sur le disque qu'il publie réellement.
  const accord = await decouperAvecConfig({
    contenu,
    nomSource: "demo-app.ext2",
    config: scellee,
  });
  assert.equal(verifierInstantane(accord.config).verdict, "accorde");

  // Le même scellement, mais un disque REMPLACÉ avant la publication. Les dates
  // sont intactes et parfaitement cohérentes : seule l'empreinte le voit.
  const panachage = await decouperAvecConfig({
    contenu: syntheticDisk(4 * MIB, 4),
    nomSource: "demo-app.ext2",
    config: scellee,
  });
  assert.equal(panachage.config.stateFor, panachage.config.builtAt, "la date ne voit rien");
  assert.equal(verifierInstantane(panachage.config).verdict, "desaccorde");
});
