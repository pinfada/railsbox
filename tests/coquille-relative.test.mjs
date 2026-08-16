// Garde de régression sur la portabilité de la coquille.
//
// Chaque démonstration est publiée sur un Pages de PROJET, donc sous
// « https://compte.github.io/<depot>/ ». Toute référence absolue depuis la
// racine y pointe hors du site. Le piège est sournois : à la racine — en
// développement, dans les tests de bout en bout locaux — tout fonctionne, et
// la panne n'apparaît qu'une fois publié.
//
// Ce test a été écrit après avoir laissé passer exactement cela : index.html
// référençait encore /main.js et /env-drawer.css, ce que seul un chargement
// depuis la vraie URL a révélé.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { extname, join } from "node:path";
import { fileURLToPath } from "node:url";

const PUBLIC_DIR = fileURLToPath(new URL("../public/", import.meta.url));

/** Ressources servies au navigateur, hors artefacts et code tiers vendorisé. */
const IGNORES = new Set(["disks", "vendor"]);
const EXTENSIONS = new Set([".html", ".css", ".js"]);

/**
 * @param {string} dir
 * @returns {string[]} chemins relatifs à public/
 */
function collectResources(dir = PUBLIC_DIR, prefix = "") {
  const results = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (IGNORES.has(entry.name)) continue;
    const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) results.push(...collectResources(join(dir, entry.name), relative));
    else if (EXTENSIONS.has(extname(entry.name))) results.push(relative);
  }
  return results;
}

/** Références HTML/CSS partant de la racine du domaine. */
const ABSOLUTE_MARKUP = /(?:\b(?:src|href)\s*=\s*"\/(?!\/)|url\(\s*['"]?\/(?!\/))/g;

/**
 * Chaînes JS qui ressemblent à un chemin de ressource absolu. On ne retient
 * que celles portant une extension de fichier servi : les chemins internes à
 * la VM (« /app/config… ») ou au guest (« /opt/rib/… ») n'ont rien à voir avec
 * l'URL de publication.
 */
const ABSOLUTE_ASSET = /["'`]\/(?:[\w.-]+\/)*[\w.-]+\.(?:js|css|wasm|bin|json|png|svg|ico)["'`]/g;

test("aucune ressource de la coquille n'est référencée depuis la racine du domaine", () => {
  const coupables = [];
  for (const resource of collectResources()) {
    const contents = readFileSync(join(PUBLIC_DIR, resource), "utf8");
    const motif = extname(resource) === ".js" ? ABSOLUTE_ASSET : ABSOLUTE_MARKUP;
    for (const match of contents.matchAll(motif)) {
      // Une occurrence en commentaire n'a aucun effet à l'exécution.
      const ligne = contents.slice(0, match.index).split("\n").pop() ?? "";
      if (ligne.trimStart().startsWith("//") || ligne.trimStart().startsWith("*")) continue;
      coupables.push(`${resource} : ${match[0]}`);
    }
  }
  assert.deepEqual(
    coupables,
    [],
    `Références absolues détectées — elles casseront sous /<depot>/ :\n${coupables.join("\n")}`,
  );
});

test("index.html charge ses ressources relativement", () => {
  const html = readFileSync(join(PUBLIC_DIR, "index.html"), "utf8");
  assert.match(html, /href="env-drawer\.css"/);
  assert.match(html, /src="main\.js"/);
});

test("la coquille ne dépend d'aucune origine externe", () => {
  // Le moteur CheerpX historique téléchargeait son runtime depuis un CDN
  // tiers, contraire à la contrainte « GitHub seule dépendance » — et il avait
  // silencieusement repris la main sur une sandbox publiée. Il est retiré ;
  // cette garde empêche toute réintroduction d'une origine externe.
  for (const resource of collectResources()) {
    const contents = readFileSync(join(PUBLIC_DIR, resource), "utf8");
    assert.doesNotMatch(
      contents,
      /https?:\/\/(?!localhost|127\.0\.0\.1)[a-z0-9-]+\.[a-z]/i,
      `${resource} référence une origine externe`,
    );
  }
});
