// Logique de décision du cache d'artefacts (critère C3) : quelles URL sont
// cacheables, sous quel nom de cache, et quels caches deviennent périmés.
// Aucun navigateur requis — c'est tout l'intérêt d'avoir extrait la décision
// de sw-proxy.js vers public/shared/artifact-cache.js.
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  CACHE_PREFIX,
  artifactSignature,
  artifactUrlOfPart,
  cacheNameFor,
  fnv1a,
  immutableArtifacts,
  isCacheableArtifactUrl,
  isCacheableRequestShape,
  looksLikeImmutableArtifact,
  obsoleteCacheNames,
  splitArtifactName,
  staleFormatCacheNames,
} from "../public/shared/artifact-cache.js";
import { DEFAULT_CHUNK_BYTES, partName } from "../tools/build-v86-image/artifact-parts.mjs";
import { buildSplitConfig } from "../tools/build-v86-image/split-config.mjs";

const BASE_HREF = "https://compte.github.io/depot/";

/** Configuration de production type : base cross-origin, application locale. */
function productionConfig(overrides = {}) {
  return {
    ...buildSplitConfig({
      name: "demo",
      baseName: "base-3.3",
      baseDiskBytes: 1_524_629_504,
      baseUrl: "https://pinfada.github.io/railsbox-assets/base",
      baseChunkBytes: DEFAULT_CHUNK_BYTES,
      appChunkBytes: DEFAULT_CHUNK_BYTES,
      builtAt: "2026-08-16T09:00:00Z",
      statePath: "disks/demo-state.bin.gz",
    }),
    ...overrides,
  };
}

// --- Convention de nommage : l'inverse exact de la construction ------------

test("artifactUrlOfPart est l'inverse de partName, sur toutes les formes", () => {
  const artefacts = [
    "/disks/demo-app.ext2",
    "/disks/demo-app.ext2.zst",
    "https://pinfada.github.io/railsbox-assets/base/base-3.3.ext2.zst",
  ];
  for (const artefact of artefacts) {
    for (const start of [0, DEFAULT_CHUNK_BYTES, 363 * DEFAULT_CHUNK_BYTES]) {
      const part = partName(artefact, start, DEFAULT_CHUNK_BYTES);
      assert.equal(artifactUrlOfPart(part), artefact, `aller-retour cassé sur ${part}`);
    }
  }
});

test("artifactUrlOfPart rejette ce qui n'est pas un fichier-partie", () => {
  assert.equal(artifactUrlOfPart("/disks/demo-app.ext2"), null);
  assert.equal(artifactUrlOfPart("/disks/base-3.3-vmlinuz"), null);
  assert.equal(artifactUrlOfPart("/disks/v86-config.json"), null);
  assert.equal(artifactUrlOfPart("/disks/demo-state.bin.gz"), null);
  // Un seul nombre ne suffit pas : il en faut deux, bornes du morceau.
  assert.equal(artifactUrlOfPart("/disks/demo-app-4194304.ext2"), null);
});

test("splitArtifactName ne laisse pas l'extension enjamber une barre oblique", () => {
  // La règle brute de v86 attraperait « .io/base-initrd » ici : sans cette
  // divergence, un initrd serait pris pour un artefact extensionné.
  assert.deepEqual(splitArtifactName("https://compte.github.io/base-initrd"), {
    base: "https://compte.github.io/base-initrd",
    extension: "",
  });
});

// --- Pré-filtre synchrone --------------------------------------------------

test("looksLikeImmutableArtifact accepte morceaux, noyau et initrd", () => {
  assert.equal(looksLikeImmutableArtifact("/disks/demo-app-0-4194304.ext2.zst"), true);
  assert.equal(looksLikeImmutableArtifact("https://x.io/a/base-3.3-vmlinuz"), true);
  assert.equal(looksLikeImmutableArtifact("https://x.io/a/base-3.3-initrd"), true);
});

test("looksLikeImmutableArtifact écarte le trafic ordinaire", () => {
  assert.equal(looksLikeImmutableArtifact("/disks/v86-config.json"), false);
  assert.equal(looksLikeImmutableArtifact("/disks/demo-state.bin.gz"), false);
  assert.equal(looksLikeImmutableArtifact("/app/posts/1"), false);
  assert.equal(looksLikeImmutableArtifact("/index.html"), false);
});

test("isCacheableRequestShape exige un GET sans Range", () => {
  assert.equal(isCacheableRequestShape({ method: "GET", rangeHeader: null }), true);
  // Une lecture Range renvoie un 206, que Cache Storage refuse de stocker :
  // ces requêtes doivent rester intégralement à la charge du navigateur.
  assert.equal(isCacheableRequestShape({ method: "GET", rangeHeader: "bytes=0-4095" }), false);
  assert.equal(isCacheableRequestShape({ method: "POST", rangeHeader: null }), false);
  assert.equal(isCacheableRequestShape({ method: "HEAD", rangeHeader: null }), false);
});

// --- Inventaire des artefacts d'une configuration --------------------------

test("immutableArtifacts résout la base cross-origin et l'application relative", () => {
  const artefacts = immutableArtifacts(productionConfig(), BASE_HREF);
  assert.equal(artefacts.kernel, "https://pinfada.github.io/railsbox-assets/base/base-3.3-vmlinuz");
  assert.equal(artefacts.initrd, "https://pinfada.github.io/railsbox-assets/base/base-3.3-initrd");
  assert.deepEqual(artefacts.disks, [
    "https://pinfada.github.io/railsbox-assets/base/base-3.3.ext2.zst",
    "https://compte.github.io/depot/disks/demo-app.ext2.zst",
  ]);
});

test("immutableArtifacts ignore un disque servi d'un seul tenant", () => {
  // Sans chunkSize, le disque est lu par requêtes Range : hors périmètre.
  const artefacts = immutableArtifacts(
    { disk: "/disks/jiyufit.ext2", kernel: "/disks/vmlinuz", initrd: "/disks/initrd" },
    BASE_HREF,
  );
  assert.deepEqual(artefacts.disks, []);
});

test("isCacheableArtifactUrl n'accepte que les artefacts déclarés", () => {
  const artefacts = immutableArtifacts(productionConfig(), BASE_HREF);
  const cacheable = (url) => isCacheableArtifactUrl(url, artefacts);

  assert.equal(
    cacheable("https://pinfada.github.io/railsbox-assets/base/base-3.3-0-4194304.ext2.zst"),
    true,
  );
  assert.equal(cacheable("https://compte.github.io/depot/disks/demo-app-0-4194304.ext2.zst"), true);
  assert.equal(cacheable("https://pinfada.github.io/railsbox-assets/base/base-3.3-vmlinuz"), true);

  // Même forme, artefact inconnu : le pré-filtre l'aurait laissé passer, la
  // vérification qui fait foi le refuse.
  assert.equal(cacheable("https://ailleurs.example/pirate-0-4194304.ext2.zst"), false);
  // Le disque complet n'est pas un morceau.
  assert.equal(cacheable("https://compte.github.io/depot/disks/demo-app.ext2.zst"), false);
  // L'instantané COMPLET non plus : il est téléchargé d'un bloc et mis en
  // cache par la page dans IndexedDB. Seuls ses morceaux passent ici.
  assert.equal(cacheable("https://compte.github.io/depot/disks/demo-state.bin.gz"), false);
});

test("isCacheableArtifactUrl est faux sans inventaire", () => {
  assert.equal(isCacheableArtifactUrl("/disks/demo-app-0-4194304.ext2", null), false);
});

// --- Morceaux de l'instantané (ADR 0003, extension de 2026-08-17) ----------

test("les morceaux de l'instantané sont mis en cache comme ceux des disques", () => {
  // Sans cela, le visiteur qui revient retéléchargerait l'instantané entier
  // dès que son cache IndexedDB a été évincé — le plus gros transfert de la
  // sandbox, et celui que GitHub Pages plafonne à max-age=600.
  const config = productionConfig({ state: "disks/demo-split-state.bin.gz" });
  const artefacts = immutableArtifacts(config, BASE_HREF);
  assert.equal(artefacts.state, "https://compte.github.io/depot/disks/demo-split-state.bin.gz");

  const morceau = partName(
    "https://compte.github.io/depot/disks/demo-split-state.bin.gz",
    8 * DEFAULT_CHUNK_BYTES,
    DEFAULT_CHUNK_BYTES,
  );
  assert.equal(looksLikeImmutableArtifact(morceau), true);
  assert.equal(isCacheableArtifactUrl(morceau, artefacts), true);
});

test("l'instantané est retenu même quand la configuration ne dit pas qu'il est découpé", () => {
  // La configuration ne porte AUCUN « stateChunkSize » : c'est la présence de
  // l'inventaire `-parts.json` qui tranche, côté coquille, pour que les
  // sandboxes déjà publiées continuent de se charger sans être reconstruites.
  // Le retenir ici est sans risque — un instantané d'un seul tenant n'engendre
  // aucune URL de la forme « fichier-partie », donc aucune requête à mettre en
  // cache — et évite un champ de configuration qui pourrait mentir.
  const config = productionConfig({ state: "disks/demo-split-state.bin.gz" });
  assert.equal("stateChunkSize" in config, false);
  assert.notEqual(immutableArtifacts(config, BASE_HREF).state, null);
});

test("un morceau d'instantané étranger à la configuration reste au réseau", () => {
  const artefacts = immutableArtifacts(
    productionConfig({ state: "disks/demo-split-state.bin.gz" }),
    BASE_HREF,
  );
  assert.equal(
    isCacheableArtifactUrl(
      "https://compte.github.io/depot/disks/autre-app-state.bin-0-4194304.gz",
      artefacts,
    ),
    false,
  );
});

test("changer d'instantané change le nom du cache", () => {
  // L'instantané est désormais un artefact mis en cache : son identité doit
  // entrer dans celle du cache, sans quoi une reconstruction resservirait les
  // morceaux de la précédente — un instantané panaché, donc une VM corrompue.
  assert.notEqual(
    cacheNameFor(productionConfig({ state: "disks/demo-split-state.bin.gz" })),
    cacheNameFor(productionConfig({ state: "disks/demo-autre-state.bin.gz" })),
  );
});

// --- Nom de cache et invalidation ------------------------------------------

test("cacheNameFor est stable pour une même configuration", () => {
  assert.equal(cacheNameFor(productionConfig()), cacheNameFor(productionConfig()));
  assert.match(cacheNameFor(productionConfig()), /^railsbox-artefacts-v1-demo-[0-9a-f]{8}$/);
});

test("cacheNameFor change dès qu'un champ d'identité change", () => {
  const reference = cacheNameFor(productionConfig());
  const variantes = [
    { builtAt: "2026-08-17T09:00:00Z" }, // reconstruction, MÊME URL de disque
    { disk: "https://pinfada.github.io/railsbox-assets/base/base-3.4.ext2.zst" },
    { appDiskChunkSize: 8 * 1024 * 1024 },
    { name: "autre-demo" },
  ];
  for (const overrides of variantes) {
    assert.notEqual(
      cacheNameFor(productionConfig(overrides)),
      reference,
      `${JSON.stringify(overrides)} devrait invalider le cache`,
    );
  }
});

test("cacheNameFor refuse une configuration sans disque", () => {
  assert.equal(cacheNameFor(null), null);
  assert.equal(cacheNameFor({}), null);
  assert.equal(artifactSignature({ kernel: "/disks/vmlinuz" }), null);
});

test("cacheNameFor reste lisible même sans nom exploitable", () => {
  const name = cacheNameFor({ disk: "/disks/x.ext2", name: "  ***  " });
  assert.match(name, /^railsbox-artefacts-v1-sandbox-[0-9a-f]{8}$/);
});

test("fnv1a produit huit chiffres hexadécimaux stables", () => {
  assert.equal(fnv1a(""), "811c9dc5");
  assert.match(fnv1a("railsbox"), /^[0-9a-f]{8}$/);
  assert.notEqual(fnv1a("a"), fnv1a("b"));
});

test("obsoleteCacheNames ne cible que nos caches, et jamais le courant", () => {
  const courant = cacheNameFor(productionConfig());
  const names = [courant, `${CACHE_PREFIX}-v1-demo-deadbeef`, "rib-v86-snapshots", "workbox-x"];
  assert.deepEqual(obsoleteCacheNames(names, courant), [`${CACHE_PREFIX}-v1-demo-deadbeef`]);
});

test("staleFormatCacheNames ne vise que les formats antérieurs", () => {
  const names = [
    `${CACHE_PREFIX}-v0-demo-deadbeef`,
    `${CACHE_PREFIX}-v1-demo-deadbeef`,
    "rib-v86-snapshots",
  ];
  assert.deepEqual(staleFormatCacheNames(names), [`${CACHE_PREFIX}-v0-demo-deadbeef`]);
});
