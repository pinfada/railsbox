// README de la branche publiée : la seule page que GitHub montre du dépôt qui
// héberge une sandbox.
//
// POURQUOI. Quand la sandbox est publiée sur un dépôt VITRINE (`target-repo`),
// ce dépôt est la seule surface publique — c'est le cas de tout dépôt privé,
// dont le README, lui, n'est visible de personne. Sans ce fichier, un visiteur
// qui arrive sur la vitrine trouve un dépôt sans titre, sans explication et
// sans lien vers la démonstration : exactement la page que le mainteneur
// partage à ses prospects. Constaté le 19/08/2026 sur deux vitrines réelles,
// vides toutes les deux.
//
// Le README est écrit sur la branche `gh-pages`, aux côtés de la coquille.
// GitHub l'affiche sur la page du dépôt dès que cette branche est la branche
// par défaut, et il reste de toute façon lisible dans l'onglet des branches.
// `.nojekyll` étant posé, Pages ne le transforme pas en page HTML : il ne
// concurrence pas `index.html`, qui reste ce que sert la racine du site.

import { pathToFileURL } from "node:url";

/**
 * Corps du README d'une vitrine.
 *
 * Aucune promesse sur ce que la sandbox contient : ce texte est publié tel quel
 * pour des applications qu'on ne connaît pas. Il dit où aller, ce qu'on va y
 * trouver techniquement, et — c'est le point qui compte pour un dépôt privé —
 * que le code source n'est pas ici.
 * @param {{ nom: string, adresse: string, sourcePubliee: boolean, depotSource?: string }} options
 * @returns {string} contenu Markdown, terminé par un saut de ligne
 */
export function readmeVitrine({ nom, adresse, sourcePubliee, depotSource }) {
  const titre = `# ${nom} — démonstration jouable`;
  const badge = `[![Try with railsbox](${adresse}badge.svg)](${adresse})`;

  // Deux publics, deux phrases. Sur une vitrine séparée, le visiteur doit
  // comprendre POURQUOI le code n'est pas là — sans quoi le dépôt vide passe
  // pour un abandon. Sur le dépôt de l'application elle-même, la question ne
  // se pose pas : le code est à côté.
  const provenance = sourcePubliee
    ? `Cette branche ne contient que la démonstration publiée. Le code de l'application vit sur la branche par défaut de ce dépôt.`
    : `Cette branche ne contient que la démonstration publiée : la coquille, les artefacts de la machine virtuelle et les assets. **Le code source de l'application n'est pas publié ici**${
        depotSource ? ` — il vit dans \`${depotSource}\`, qui reste privé` : ""
      }.`;

  return `${titre}

${badge}

**→ [Ouvrir la démonstration](${adresse})**

${provenance}

## Ce que vous ouvrez

Une application Rails complète — Puma, sa base de données, ses gems natives —
qui tourne **entièrement dans votre navigateur**, dans une machine virtuelle
Linux i386 émulée. Aucun serveur n'est sollicité : ce que vous voyez s'exécute
sur votre machine, et ce que vous saisissez ne quitte pas votre onglet.

- **Premier chargement** : de trente secondes à deux minutes selon votre
  processeur. Les visites suivantes repartent d'un instantané mis en cache.
- **Votre copie est jetable** : chaque visiteur reçoit la sienne, personne ne
  voit celle d'un autre, et un rechargement la remet à zéro.
- **Ce n'est pas un environnement de production** : pas de réseau sortant, pas
  de WebSockets, et la vitesse est celle d'une émulation.

## Sous le capot

Publié par [railsbox](https://github.com/pinfada/railsbox), qui construit la
sandbox depuis une action GitHub et la sert en fichiers statiques. Le système de
base est mutualisé entre toutes les sandboxes : ce dépôt n'héberge que
l'application.

*Cette page est régénérée à chaque publication.*
`;
}

/**
 * Point d'entrée en ligne de commande.
 *
 * Usage :
 *   node ecrire-readme-vitrine.mjs <sortie> --nom <nom> --adresse <url>
 *                                  [--depot-source <proprietaire/depot>]
 *                                  [--source-publiee]
 *
 * `--source-publiee` dit que la sandbox est publiée sur le dépôt de
 * l'application elle-même, et non sur une vitrine séparée : le texte cesse
 * alors d'expliquer l'absence du code.
 */
async function main() {
  const argv = process.argv.slice(2);
  const sortie = argv[0];
  const lire = (drapeau) => {
    const i = argv.indexOf(drapeau);
    return i === -1 ? undefined : argv[i + 1];
  };
  const nom = lire("--nom");
  const adresse = lire("--adresse");
  if (!sortie || !nom || !adresse) {
    process.stderr.write(
      "Usage : node ecrire-readme-vitrine.mjs <sortie> --nom <nom> --adresse <url> " +
        "[--depot-source <proprietaire/depot>] [--source-publiee]\n",
    );
    process.exit(2);
  }
  const { writeFile } = await import("node:fs/promises");
  await writeFile(
    sortie,
    readmeVitrine({
      nom,
      // Une adresse sans barre finale ferait `…/depotbadge.svg`.
      adresse: adresse.endsWith("/") ? adresse : `${adresse}/`,
      sourcePubliee: argv.includes("--source-publiee"),
      depotSource: lire("--depot-source"),
    }),
    "utf8",
  );
}

// Exécuté seulement en ligne de commande : l'import du module reste pur, pour
// que les tests appellent readmeVitrine sans écrire de fichier. Même forme que
// autoriser-origine-base.mjs — pathToFileURL évite les faux négatifs sous Windows.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
