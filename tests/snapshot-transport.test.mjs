// Téléchargement de l'instantané mémoire : LES DEUX CHEMINS, exécutés pour de
// vrai.
//
// `loadSnapshot` reçoit son `fetch` en paramètre. Ces tests font donc passer de
// vrais octets — produits par le vrai split-artifact.mjs — dans le vrai chemin
// de la coquille : inventaire, décompression gzip, réassemblage, reprises sur
// bridage. Sans navigateur, sans VM, sans réseau.
//
// tests/snapshot-parts.test.mjs couvre la logique pure (nommage, validation,
// assemblage) ; ici on couvre ce qu'elle vaut une fois branchée.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { gzipSync } from "node:zlib";

import { loadSnapshot } from "../public/shared/snapshot-parts.js";

const run = promisify(execFile);
const TOOLS = fileURLToPath(new URL("../tools/build-v86-image/", import.meta.url));
const MIB = 1024 * 1024;
const RACINE = "https://compte.github.io/depot/disks/";

/**
 * Serveur en mémoire : une table d'URL vers des octets (ou un statut HTTP à
 * rendre), et le journal des requêtes reçues — dont leur FORME, ce qui permet
 * de vérifier qu'aucune ne porte d'en-tête.
 * @param {Record<string, Buffer | number>} routes
 */
function serveur(routes) {
  /** @type {{ url: string, init: unknown }[]} */
  const journal = [];
  const faux = /** @type {any} */ (
    (url, init) => {
      journal.push({ url: String(url), init });
      const contenu = routes[String(url)];
      if (contenu === undefined) return Promise.resolve(new Response(null, { status: 404 }));
      if (typeof contenu === "number") {
        return Promise.resolve(new Response(null, { status: contenu }));
      }
      return Promise.resolve(new Response(contenu, { status: 200 }));
    }
  );
  return { fetch: faux, journal };
}

/**
 * Instantané de test : des pages nulles et des données denses, comme une
 * mémoire réelle — un contenu uniquement nul ne prouverait rien de la
 * compression.
 * @param {number} [size]
 * @returns {Buffer}
 */
function instantaneSynthetique(size = 10 * MIB) {
  const buffer = Buffer.alloc(size);
  for (let offset = 0; offset < size; offset += 4096) {
    if ((offset / 4096) % 4 === 0) continue;
    for (let i = 0; i < 4096 && offset + i < size; i += 1) {
      buffer[offset + i] = (offset * 7 + i * 13) % 251;
    }
  }
  return buffer;
}

/**
 * Publie un instantané comme le fait le workflow, et rend de quoi le servir.
 * @param {"gzip"|null} compression
 */
async function publier(compression) {
  const dir = await mkdtemp(join(tmpdir(), "railsbox-transport-"));
  try {
    const source = join(dir, "demo-split-state.bin");
    const original = instantaneSynthetique();
    await writeFile(source, original);
    const out = join(dir, "publication");
    const args = [join(TOOLS, "split-artifact.mjs"), source, "--out", out];
    if (compression) args.push(`--${compression}`);
    await run(process.execPath, args);

    /** @type {Record<string, Buffer | number>} */
    const routes = {};
    for (const nom of await readdir(out)) {
      routes[`${RACINE}${nom}`] = await readFile(join(out, nom));
    }
    return {
      routes,
      url: `${RACINE}demo-split-state.bin${compression === "gzip" ? ".gz" : ""}`,
      original,
    };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/**
 * @param {Uint8Array | Buffer} bytes
 * @returns {string}
 */
const empreinte = (bytes) => createHash("sha256").update(bytes).digest("hex");

test("loadSnapshot réassemble un instantané découpé en morceaux gzip", async () => {
  const { routes, url, original } = await publier("gzip");
  const { fetch, journal } = serveur(routes);
  const state = await loadSnapshot({ url, fetch });

  assert.equal(empreinte(new Uint8Array(state)), empreinte(original));
  // Un GET par morceau, plus l'inventaire — et rien d'autre.
  assert.equal(journal.length, 4);
  assert.equal(journal[0].url, `${RACINE}demo-split-state.bin-parts.json`);
  // Aucun second argument : ni en-tête, ni Range, ni directive de cache. C'est
  // la condition pour que le dépôt d'artefacts cross-origin réponde (ADR 0001).
  for (const appel of journal) assert.equal(appel.init, undefined);
});

test("loadSnapshot retombe sur l'instantané d'un seul tenant sans inventaire", async () => {
  // Le format des sandboxes publiées avant le découpage, dont la démonstration
  // de référence : un seul fichier et aucun `-parts.json`. La coquille doit
  // continuer de les charger sans qu'elles soient reconstruites.
  const original = instantaneSynthetique(1024);
  const url = `${RACINE}demo-split-state.bin`;
  const { fetch, journal } = serveur({ [url]: original });

  const state = await loadSnapshot({ url, fetch });
  assert.equal(empreinte(new Uint8Array(state)), empreinte(original));
  // L'inventaire a bien été tenté, et son 404 n'a rien cassé.
  assert.equal(journal[0].url, `${url}-parts.json`);
  assert.equal(journal.length, 2);
});

test("loadSnapshot lit un instantané d'un seul tenant gzippé", async () => {
  // Le format publié aujourd'hui par la démonstration de référence : un
  // `.bin.gz` livré tel quel par GitHub Pages, que la coquille décompresse.
  const original = instantaneSynthetique(64 * 1024);
  const url = `${RACINE}demo-split-state.bin.gz`;
  const { fetch } = serveur({ [url]: gzipSync(original) });
  assert.equal(empreinte(new Uint8Array(await loadSnapshot({ url, fetch }))), empreinte(original));
});

test("loadSnapshot réessaie un morceau bridé, puis aboutit", async () => {
  // GitHub Pages répond 503 sur une rafale de requêtes (mesuré au douzième
  // morceau sur 363, depuis un runner). Sans reprise, un seul morceau manqué
  // renverrait le visiteur à un boot à froid de treize minutes.
  const { routes, url, original } = await publier("gzip");
  const { fetch: base } = serveur(routes);
  let restants = 2;
  /** @type {number[]} */
  const dormis = [];
  const fetch = /** @type {any} */ (
    (cible) => {
      if (/-4194304-8388608\.gz$/.test(String(cible)) && restants-- > 0) {
        return Promise.resolve(new Response(null, { status: 503 }));
      }
      return base(cible);
    }
  );

  const state = await loadSnapshot({
    url,
    fetch,
    sleep: (ms) => {
      dormis.push(ms);
      return Promise.resolve();
    },
  });
  assert.equal(empreinte(new Uint8Array(state)), empreinte(original));
  // Attente doublée à chaque échec, comme assemble-artifact.mjs côté CI.
  assert.deepEqual(dormis, [500, 1000]);
});

test("loadSnapshot abandonne sur un morceau définitivement absent", async () => {
  // Un 404 ne changera pas d'avis : réessayer ne ferait que retarder le repli
  // en boot à froid, que l'appelant déclenche sur l'exception.
  const { routes, url } = await publier("gzip");
  delete routes[`${RACINE}demo-split-state.bin-4194304-8388608.gz`];
  const { fetch, journal } = serveur(routes);
  await assert.rejects(() => loadSnapshot({ url, fetch }), /HTTP 404/);
  assert.equal(
    journal.filter((appel) => /-4194304-8388608\.gz$/.test(appel.url)).length,
    1,
    "un 404 ne doit pas être réessayé",
  );
});

test("loadSnapshot refuse un instantané réassemblé incomplet", async () => {
  // Un morceau tronqué en cours de route donnerait un instantané qui se
  // restaure en apparence, puis plante la VM très loin de la cause.
  const { routes, url } = await publier("gzip");
  routes[`${RACINE}demo-split-state.bin-0-4194304.gz`] = gzipSync(Buffer.alloc(1024));
  const { fetch } = serveur(routes);
  await assert.rejects(() => loadSnapshot({ url, fetch }), /tronqué/);
});
