// URL de la sandbox PUBLIÉE que contrôle la suite live. Partagée entre la
// configuration Playwright (qui en fait la baseURL) et la spécification.
//
// Par défaut la démonstration de référence ; `RAILSBOX_SANDBOX_URL` permet de
// pointer n'importe quelle sandbox construite par le workflow réutilisable —
// c'est ainsi qu'un mainteneur tiers vérifie la sienne.
export const URL_SANDBOX_PAR_DEFAUT = "https://pinfada.github.io/railsbox-demo/";

/**
 * URL de la sandbox à vérifier, toujours terminée par une barre oblique : elle
 * sert de base à des résolutions relatives (« app/posts », « disks/… »), où un
 * dernier segment sans barre serait remplacé au lieu d'être conservé.
 * @returns {string}
 */
export function urlSandbox() {
  const brute = (process.env.RAILSBOX_SANDBOX_URL ?? "").trim() || URL_SANDBOX_PAR_DEFAUT;
  return brute.endsWith("/") ? brute : `${brute}/`;
}
