// Rend une page d'adoption à partir de mesures brutes.
//
// POURQUOI CE FICHIER EXISTE. L'API de trafic de GitHub ne garde que
// QUATORZE JOURS : chaque semaine non capturée est définitivement perdue. En
// écrivant la mesure dans le dépôt, l'historique git devient la série
// temporelle — sans base de données, sans service, et publiable puisque le
// dépôt est public.
//
// CE QUE CETTE PAGE NE PEUT PAS DIRE, et le dit. Un dépôt PRIVÉ qui utilise
// railsbox est invisible : aucune recherche ne le voit, aucun compteur ne le
// distingue. C'est la conséquence directe du modèle — pas de serveur, pas de
// compte, pas de télémétrie — et non un manque d'outillage. La page l'écrit
// noir sur blanc plutôt que de laisser croire à un recensement complet.
//
// Module PUR : il ne lit ni le réseau ni le disque. Les mesures lui sont
// données, ce qui le rend testable et garde la collecte dans le workflow.

import { pathToFileURL } from "node:url";

/** @typedef {{ vues?: number, vuesUniques?: number, clones?: number, clonesUniques?: number }} Trafic */

/**
 * Un nombre, ou « — » quand la mesure n'a pas pu être prise. Ne JAMAIS écrire
 * zéro à la place : zéro est une mesure, l'absence n'en est pas une.
 * @param {number | null | undefined} valeur
 * @returns {string}
 */
function nombre(valeur) {
  return typeof valeur === "number" && Number.isFinite(valeur) ? String(valeur) : "—";
}

/**
 * « 28 uniques », « 1 unique », « — unique ». Un accord fautif dans un tableau
 * relu chaque semaine finit par se voir.
 * @param {number | null | undefined} valeur
 * @returns {string}
 */
function uniques(valeur) {
  return `${nombre(valeur)} unique${valeur === 1 ? "" : "s"}`;
}

/**
 * Page d'adoption complète, en Markdown.
 * @param {{
 *   date: string,
 *   trafic?: Trafic,
 *   versionsBase?: number | null,
 *   depotsPublics?: string[],
 *   depotsPrives?: number | null,
 *   constructionsInternes?: number | null,
 * }} mesures
 * @returns {string} Markdown terminé par un saut de ligne
 */
export function pageAdoption({
  date,
  trafic = {},
  versionsBase = null,
  depotsPublics = [],
  depotsPrives = null,
  constructionsInternes = null,
}) {
  const publics = [...depotsPublics].sort();
  const liste =
    publics.length === 0
      ? "_Aucun dépôt public détecté à cette date._"
      : publics.map((d) => `- [\`${d}\`](https://github.com/${d})`).join("\n");

  // Les clones sont le chiffre le plus trompeur du tableau de bord GitHub :
  // chaque construction de sandbox fait un `actions/checkout` de ce dépôt.
  // Sans cette mise en garde, on lit une adoption là où on mesure sa propre CI.
  const misesEnGarde = [
    constructionsInternes !== null
      ? `**Les clones ne mesurent pas l'adoption.** Chaque construction de sandbox clone ce dépôt (\`actions/checkout\`) : ${constructionsInternes} construction(s) sur la période y contribuent, sans compter la CI de railsbox elle-même. Les « uniques » sont des runners éphémères, pas des personnes.`
      : "**Les clones ne mesurent pas l'adoption** : chaque construction de sandbox clone ce dépôt, et les « uniques » sont des runners éphémères.",
    "**Les dépôts privés sont invisibles.** Aucune recherche ne les voit, aucun compteur ne les distingue. C'est le modèle — pas de serveur, pas de compte, pas de télémétrie — et non un défaut d'outillage.",
    "**La recherche de code dépend du jeton employé** : elle voit les dépôts publics, plus les dépôts privés auxquels ce jeton a accès. La liste ci-dessus peut donc contenir des dépôts privés du mainteneur.",
  ];

  return `# Adoption

*Mesuré le ${date}. Cette page est régénérée chaque semaine ; l'historique vit
dans les commits de ce fichier — l'API de trafic de GitHub, elle, n'expose que
les quatorze derniers jours.*

## Mesures

| Indicateur | Valeur | Fenêtre |
| --- | --- | --- |
| Vues du dépôt | ${nombre(trafic.vues)} (${uniques(trafic.vuesUniques)}) | 14 jours |
| Clones | ${nombre(trafic.clones)} (${uniques(trafic.clonesUniques)}) | 14 jours |
| Versions publiées de l'image de base | ${nombre(versionsBase)} | cumulé |
| Dépôts publics détectés | ${publics.length} | instantané |
| Dépôts privés | ${depotsPrives === null ? "**non mesurable**" : nombre(depotsPrives)} | — |

**Aucune ligne de ce tableau ne mesure l'usage privé, et il n'en existe pas.**
On a pu croire que le compteur de l'image de base y suppléerait — toute
construction la tire, quelle que soit la visibilité du dépôt. Vérification
faite, l'API de GitHub n'expose **aucun compteur de téléchargements** pour une
image de conteneur : seulement le nombre de versions que *nous* avons publiées,
c'est-à-dire notre propre activité. Le chiffre reste ici pour dater les
révisions de base, jamais comme signal d'adoption.

## Sandboxes publiques détectées

${liste}

Détection automatique, par recherche du workflow réutilisable dans le code
public. Cette liste est une observation, pas une liste de références : un dépôt
y figure parce qu'il déclare publiquement utiliser railsbox.

## À lire avec les chiffres

${misesEnGarde.map((m) => `- ${m}`).join("\n")}

---

*Page générée par \`.github/workflows/mesurer-adoption.yml\`. Pour figurer
comme utilisateur — y compris depuis un dépôt privé — voir « Qui l'utilise »
dans le [README](../README.md).*
`;
}

/**
 * Point d'entrée : lit les mesures sur l'entrée standard (JSON) et écrit la
 * page sur la sortie standard. La collecte reste dans le workflow, qui a les
 * jetons ; ce module ne fait que mettre en forme.
 */
async function main() {
  let brut = "";
  for await (const morceau of process.stdin) brut += morceau;
  process.stdout.write(pageAdoption(JSON.parse(brut || "{}")));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
