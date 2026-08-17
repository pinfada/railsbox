// Relit les scripts shell du dépôt avec shellcheck.
//
// Pourquoi ce script existe plutôt qu'un simple appel à `shellcheck` : les
// scripts de construction portent l'essentiel du pipeline, et rien ne les
// relisait. actionlint ne voit que les blocs `run:` des workflows, et
// `bash -n` accepte un « \n » littéral — c'est un argument valide. Un tel
// « \n », introduit par une fusion, a collé trois options `--build-arg` sur une
// seule ligne : docker a perdu son argument de contexte, et le défaut n'a été
// trouvé qu'à la première construction d'une application tierce, après 519
// tests verts. shellcheck le nomme immédiatement (SC1012).
//
// Il cherche shellcheck là où il peut se trouver, dans cet ordre : le binaire
// du système (le runner GitHub l'a d'origine), puis Docker (le contributeur
// sous Windows a rarement le binaire, mais a Docker dès qu'il touche à la
// construction). Faute des deux, il le DIT et sort en échec plutôt que de
// laisser croire que le contrôle a eu lieu.
import { spawnSync } from "node:child_process";

// SC2012 (« utilisez find plutôt que ls ») : les chemins concernés sont
// produits par le dépôt lui-même, jamais par un tiers. Assumé, pas subi.
const EXCLUSIONS = "SC2012";
const SEVERITE = "warning";

/** @returns {string[]} scripts shell suivis par git */
function scriptsSuivis() {
  const git = spawnSync("git", ["ls-files", "*.sh"], { encoding: "utf8" });
  if (git.status !== 0) {
    process.stderr.write("✗ impossible de lister les scripts (git ls-files)\n");
    process.exit(2);
  }
  return git.stdout.split("\n").filter((ligne) => ligne.trim() !== "");
}

/**
 * @param {string} commande
 * @param {string[]} args
 * @returns {import("node:child_process").SpawnSyncReturns<string>}
 */
function lancer(commande, args) {
  return spawnSync(commande, args, { encoding: "utf8", stdio: "inherit" });
}

const fichiers = scriptsSuivis();
if (fichiers.length === 0) {
  process.stdout.write("Aucun script shell suivi — rien à relire.\n");
  process.exit(0);
}

const options = [`--severity=${SEVERITE}`, `--exclude=${EXCLUSIONS}`];

// 1. shellcheck du système.
const direct = spawnSync("shellcheck", ["--version"], { encoding: "utf8" });
if (direct.status === 0) {
  process.exit(lancer("shellcheck", [...options, ...fichiers]).status ?? 1);
}

// 2. Docker, avec le dépôt monté en lecture. `-w /mnt` : shellcheck reçoit des
// chemins relatifs, donc ses messages restent cliquables dans un éditeur.
const docker = spawnSync("docker", ["version", "--format", "{{.Server.Version}}"], {
  encoding: "utf8",
});
if (docker.status === 0) {
  process.stdout.write("shellcheck absent du système — passage par Docker.\n");
  const resultat = lancer("docker", [
    "run",
    "--rm",
    "-v",
    `${process.cwd()}:/mnt`,
    "-w",
    "/mnt",
    "koalaman/shellcheck:stable",
    ...options,
    ...fichiers,
  ]);
  process.exit(resultat.status ?? 1);
}

process.stderr.write(
  "✗ shellcheck introuvable, et Docker non plus.\n" +
    "  Installez l'un des deux : « apt install shellcheck », « brew install shellcheck »,\n" +
    "  ou Docker Desktop. Le contrôle n'a PAS eu lieu — voir CONTRIBUTING.md.\n",
);
process.exit(2);
