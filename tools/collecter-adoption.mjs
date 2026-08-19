// Collecte les mesures d'adoption et écrit docs/adoption.md.
//
// UN SEUL COLLECTEUR, DEUX USAGES. Le workflow hebdomadaire l'appelle avec le
// jeton d'Actions ; le mainteneur l'appelle depuis sa machine avec son `gh`.
// Deux implémentations divergeraient, et celle qui tourne le moins serait
// fausse la première.
//
// EN NODE, PAS EN SHELL. La collecte ne demande que des appels `gh` et de
// l'assemblage JSON. En shell, cela imposerait `jq` — absent d'un poste
// Windows ordinaire — et des questions d'échappement à chaque champ. Node est
// déjà exigé par le dépôt.
//
// CE QUE CHAQUE JETON PEUT VOIR — la différence est structurelle :
//
//   · trafic (vues, clones) ......... les deux
//   · tirages de l'image de base .... si la portée read:packages est présente
//                                     (`gh auth refresh -s read:packages`)
//   · recherche de code ............. le jeton d'Actions NE la porte pas sur
//                                     l'ensemble de GitHub ; celui d'un poste,
//                                     oui. C'est pourquoi la vision complète
//                                     s'obtient en local, sans déposer un
//                                     jeton personnel à portée large dans les
//                                     secrets d'un dépôt public.
//
// Usage :
//   node tools/collecter-adoption.mjs      →  docs/adoption.md
//   npm run adoption
//
// Une mesure qui échoue vaut `null` et s'écrira « — » : une collecte partielle
// vaut mieux qu'un échec, et « — » ne se confond pas avec zéro.

import { execFile } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { promisify } from "node:util";
import { pageAdoption } from "./mesurer-adoption.mjs";

const executer = promisify(execFile);

/**
 * Sortie de `gh`, ou null si l'appel échoue. JAMAIS bloquant : une mesure
 * manquante est une information, pas une raison d'abandonner les autres.
 * @param {string[]} args
 * @returns {Promise<string | null>}
 */
async function gh(args) {
  try {
    const { stdout } = await executer("gh", args, { maxBuffer: 8 * 1024 * 1024 });
    return stdout;
  } catch {
    return null;
  }
}

/**
 * Un entier d'une réponse d'API, ou null.
 * @param {string} chemin
 * @param {(donnees: any) => unknown} extraire
 * @returns {Promise<number | null>}
 */
async function entier(chemin, extraire) {
  const brut = await gh(["api", chemin]);
  if (brut === null) return null;
  try {
    const valeur = extraire(JSON.parse(brut));
    return typeof valeur === "number" && Number.isFinite(valeur) ? valeur : null;
  } catch {
    return null;
  }
}

async function main() {
  const depot = process.env.GITHUB_REPOSITORY ?? "pinfada/railsbox";
  const proprietaire = depot.split("/")[0];

  process.stderr.write(`→ Trafic de ${depot}…\n`);
  const [vues, vuesUniques, clones, clonesUniques] = await Promise.all([
    entier(`repos/${depot}/traffic/views`, (d) => d.count),
    entier(`repos/${depot}/traffic/views`, (d) => d.uniques),
    entier(`repos/${depot}/traffic/clones`, (d) => d.count),
    entier(`repos/${depot}/traffic/clones`, (d) => d.uniques),
  ]);

  // Le seul compteur qui voit AUSSI les constructions privées : toute
  // construction tire cette image, quelle que soit la visibilité du dépôt.
  process.stderr.write("→ Image de base sur ghcr…\n");
  const tiragesBase = await entier(
    `users/${proprietaire}/packages/container/railsbox-base`,
    (d) => d.version_count,
  );
  if (tiragesBase === null) {
    process.stderr.write("  indisponible — portée manquante : gh auth refresh -s read:packages\n");
  }

  process.stderr.write("→ Sandboxes publiques…\n");
  const recherche = await gh([
    "search",
    "code",
    `${depot}/.github/workflows/construire-sandbox.yml`,
    "--limit",
    "100",
    "--json",
    "repository",
  ]);
  let depotsPublics = [];
  try {
    depotsPublics = [
      ...new Set(JSON.parse(recherche ?? "[]").map((r) => r.repository.nameWithOwner)),
    ];
  } catch {
    process.stderr.write("  recherche indisponible avec ce jeton\n");
  }
  process.stderr.write(`  ${depotsPublics.length} dépôt(s) détecté(s)\n`);

  // Chaque construction de sandbox clone ce dépôt : sans ce chiffre, on lirait
  // une adoption là où on mesure sa propre intégration continue.
  process.stderr.write("→ Constructions internes…\n");
  const constructionsInternes = await entier(
    `repos/${depot}/actions/runs?per_page=100`,
    (d) => d.workflow_runs?.length,
  );

  const date = new Date().toISOString().slice(0, 10).split("-").reverse().join("/");
  await mkdir("docs", { recursive: true });
  await writeFile(
    "docs/adoption.md",
    pageAdoption({
      date,
      trafic: { vues, vuesUniques, clones, clonesUniques },
      tiragesBase,
      depotsPublics,
      constructionsInternes,
    }),
    "utf8",
  );
  process.stderr.write("\ndocs/adoption.md écrit.\n");
}

await main();
