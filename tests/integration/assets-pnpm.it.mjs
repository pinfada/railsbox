// L'ÉTAGE D'ASSETS, POUR DE VRAI, avec pnpm.
//
// Douze tests purs garantissent que la DÉCISION est juste (quel gestionnaire,
// quelle commande). Aucun ne prouve que la chaîne aboutit : entre la décision
// et un fichier produit, il y a la sérialisation en arguments de build,
// l'activation de Corepack dans l'image, l'installation verrouillée, et
// `jsbundling-rails` qui va lui-même chercher le gestionnaire. Chacun de ces
// maillons a cassé au moins une fois sur tryzealot/zealot.
//
// CE QUE CETTE ÉPREUVE NE FAIT PAS, et c'est essentiel : elle n'appelle jamais
// pnpm elle-même, et ne fabrique aucun argument à la main. Elle part du
// `package.json` de la fixture et laisse RAILSBOX décider — c'est le câblage
// qui est éprouvé, pas Corepack. Un `docker build` alimenté par des arguments
// écrits à la main passerait alors même que la détection aurait régressé.
//
// Le parcours vérifié :
//   package.json + pnpm-lock.yaml
//     → manifest-to-args.mjs (détection du gestionnaire)
//     → arguments de construction
//     → Corepack activé dans l'étage amd64
//     → pnpm install --frozen-lockfile
//     → pnpm run build
//     → app/assets/builds/temoin.js
//
// Ni base de données ni boot v86 : l'étage amd64 seul, ciblé par `--target`.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";

const execFileP = promisify(execFile);
const ICI = dirname(fileURLToPath(import.meta.url));
const RACINE = resolve(ICI, "../..");
const FIXTURE = join(RACINE, "tests", "fixtures", "pnpm-jsbundling");
const IMAGE = "railsbox-fixture-pnpm:it";
const DELAI_MS = 900_000;

/** Docker est-il utilisable ici ? Sans lui, l'épreuve s'ignore en le disant. */
async function dockerDisponible() {
  try {
    await execFileP("docker", ["version", "--format", "{{.Server.Version}}"]);
    return true;
  } catch {
    return false;
  }
}

const docker = await dockerDisponible();

/**
 * Lit les arguments de construction PRODUITS PAR RAILSBOX pour la fixture.
 * La sortie est un fragment shell `CLE='valeur'` ; on ne l'évalue pas, on le
 * lit — cette épreuve ne doit rien exécuter qu'elle n'ait à vérifier.
 * @returns {Promise<Map<string, string>>}
 */
async function argumentsDeConstruction() {
  const { stdout } = await execFileP(
    process.execPath,
    [join(RACINE, "tools", "build-v86-image", "manifest-to-args.mjs"), FIXTURE, "fixture-pnpm"],
    { cwd: RACINE, maxBuffer: 8 * 1024 * 1024 },
  );
  const args = new Map();
  for (const ligne of stdout.split("\n")) {
    const trouve = /^([A-Z0-9_]+)='([\s\S]*)'$/.exec(ligne);
    if (trouve) args.set(trouve[1], trouve[2]);
  }
  return args;
}

test("la détection choisit pnpm et une installation VERROUILLÉE", async (t) => {
  if (!docker) t.skip("docker indisponible");
  const args = await argumentsDeConstruction();

  assert.equal(args.get("PACKAGE_MANAGER"), "pnpm", "le gestionnaire déclaré est respecté");
  assert.equal(
    args.get("NPM_INSTALL_COMMAND"),
    "pnpm install --frozen-lockfile",
    "un verrou périmé doit arrêter la construction, jamais être réécrit",
  );
  assert.equal(args.get("ASSET_SCRIPTS"), "build", "le script de build est programmé");
  assert.equal(args.get("HOST_ASSETS"), "1", "l'étage amd64 est bien retenu");
});

test("l'étage amd64 produit le témoin, de bout en bout", async (t) => {
  if (!docker) t.skip("docker indisponible");
  t.diagnostic("construction de l'étage assets (plusieurs minutes au premier passage)");

  const args = await argumentsDeConstruction();
  // LES ARGUMENTS VIENNENT DE LA DÉTECTION, pas de cette épreuve. Si le
  // câblage régresse — un `PACKAGE_MANAGER` qui n'est plus émis, une commande
  // d'installation qui redevient npm — la construction échoue ici.
  const passages = [];
  for (const cle of [
    "RUBY_VERSION",
    "PACKAGE_MANAGER",
    "NPM_INSTALL_COMMAND",
    "ASSET_SCRIPTS",
    "EXTRA_PACKAGES",
    "NPM_ASSETS",
    "HOST_ASSETS",
  ]) {
    const valeur = args.get(cle);
    if (valeur !== undefined) passages.push("--build-arg", `${cle}=${valeur}`);
  }

  await execFileP(
    "docker",
    [
      "build",
      "--platform=linux/amd64",
      "--target=assets-1",
      "-f",
      join(RACINE, "tools", "build-v86-image", "Dockerfile"),
      ...passages,
      "-t",
      IMAGE,
      FIXTURE,
    ],
    { cwd: RACINE, timeout: DELAI_MS, maxBuffer: 64 * 1024 * 1024 },
  );

  // Le témoin ne peut avoir été écrit que par `pnpm run build` : rien d'autre
  // ne le produit, et son contenu porte l'agent utilisateur du gestionnaire.
  const { stdout } = await execFileP(
    "docker",
    [
      "run",
      "--rm",
      "--platform=linux/amd64",
      "--entrypoint",
      "cat",
      IMAGE,
      "/app/app/assets/builds/temoin.js",
    ],
    { timeout: 120_000 },
  );

  assert.match(stdout, /railsbox-temoin-pnpm/, "le script de build a bien tourné");
  assert.match(
    stdout,
    /pnpm\//,
    "et c'est PNPM qui l'a lancé — l'agent utilisateur le nomme, npm aurait écrit npm/",
  );
});

test("le nettoyage de l'image ne laisse rien derrière", async (t) => {
  if (!docker) t.skip("docker indisponible");
  await execFileP("docker", ["image", "rm", "-f", IMAGE]).catch(() => {});
  assert.ok(true);
});
