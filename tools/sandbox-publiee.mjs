// Résout un dépôt trouvé vers la SANDBOX publique qu'il publie — ou vers rien.
//
// POURQUOI CE MODULE EXISTE. La recherche de code voit les dépôts privés
// auxquels le jeton a accès. Publier leurs noms dans un dépôt PUBLIC les
// divulguerait — exactement ce que l'offre « dépôt privé » promet d'éviter.
// L'erreur a été commise le 19/08/2026 : deux dépôts privés se sont retrouvés
// listés dans docs/adoption.md, sous un titre affirmant qu'ils étaient publics.
//
// CE QUI EST PUBLIABLE, c'est la sandbox, pas la source. Un dépôt privé publie
// la sienne sur une vitrine désignée par `target-repo` : cette vitrine est
// publique par construction, on peut la nommer sans rien révéler. Un dépôt
// public publie chez lui et se nomme lui-même. Dans le doute — workflow
// illisible, visibilité inconnue — on ne publie rien : le silence vaut mieux
// qu'une fuite.

/**
 * Cible de publication déclarée dans un workflow appelant, ou null.
 *
 * Fonction PURE : elle lit du texte, pas le réseau. C'est ce qui la rend
 * testable, et c'est là que vit la seule décision délicate.
 * @param {string | null | undefined} yaml contenu du workflow appelant
 * @returns {string | null} `proprietaire/depot` de la vitrine, ou null
 */
export function cibleDePublication(yaml) {
  if (typeof yaml !== "string") return null;
  // Une ligne commentée ne déclare rien : « # target-repo: … » est un exemple,
  // pas une configuration.
  for (const ligne of yaml.split(/\r?\n/)) {
    if (/^\s*#/.test(ligne)) continue;
    const trouve = ligne.match(/^\s*target-repo:\s*["']?([\w.-]+\/[\w.-]+)["']?\s*(?:#.*)?$/);
    if (trouve) return trouve[1];
  }
  return null;
}

/**
 * Ce qu'on a le droit de nommer, pour un dépôt trouvé.
 *
 * @param {{ visibilite: string | null, workflow: string | null }} etat
 * @param {string} depot `proprietaire/depot` trouvé par la recherche
 * @returns {string | null} le dépôt à nommer, ou null si rien n'est publiable
 */
export function nommable({ visibilite, workflow }, depot) {
  const cible = cibleDePublication(workflow);
  // La vitrine prime, y compris pour un dépôt public : c'est là que vit la
  // sandbox, donc c'est elle qu'un lecteur veut ouvrir.
  if (cible !== null) return cible;
  return visibilite === "public" ? depot : null;
}
