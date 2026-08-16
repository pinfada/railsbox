// Autorise l'origine du dépôt d'artefacts dans la CSP de la coquille publiée.
//
// La coquille du dépôt déclare `connect-src 'self'` : en développement et sur
// la démonstration de référence, la base est same-origin et tout passe. Chez
// un mainteneur tiers (`autre.github.io/depot/`), les XHR de v86 vers
// `pinfada.github.io/railsbox-assets/…` sont cross-origin : la CSP de la page
// les bloquerait AVANT toute question de CORS — et le défaut, invisible en
// local, ne se révélerait qu'une fois la sandbox publiée.
//
// Ce module est appelé à l'assemblage de la coquille (construire-sandbox.yml) :
// si l'origine de la base diffère de celle du site cible, elle est ajoutée à
// `connect-src`. Rien d'autre ne change — les autres directives restent
// fermées, et une base same-origin laisse la coquille strictement intacte.
//
// Logique pure (aucune E/S) exportée pour les tests ; la CLI en bas du fichier
// fait la seule écriture.

/**
 * Origine d'une URL, au sens CSP (schéma + hôte + port).
 * @param {string} url
 * @returns {string}
 */
export function origineDe(url) {
  return new URL(url).origin;
}

/**
 * Ajoute une origine à la directive `connect-src` d'une CSP.
 * Idempotent : une origine déjà listée n'est pas dupliquée.
 * @param {string} csp texte de la politique (valeur de l'attribut content)
 * @param {string} origine origine à autoriser
 * @returns {string}
 */
export function ajouterOrigineConnectSrc(csp, origine) {
  if (!/connect-src/.test(csp)) {
    throw new Error("directive connect-src introuvable dans la CSP");
  }
  return csp.replace(/connect-src([^;]*)/, (directive, sources) => {
    const listees = sources.trim().split(/\s+/);
    if (listees.includes(origine)) return directive;
    return `connect-src${sources} ${origine}`;
  });
}

/**
 * Réécrit la coquille pour autoriser l'origine de la base, si nécessaire.
 * @param {string} html contenu d'index.html
 * @param {string} baseUrl racine des artefacts de base (URL complète)
 * @param {string} siteOrigin origine du site publié (`https://user.github.io`)
 * @returns {{ html: string, modifie: boolean }}
 */
export function coquilleAutorisantBase(html, baseUrl, siteOrigin) {
  const origine = origineDe(baseUrl);
  if (origine === origineDe(siteOrigin)) return { html, modifie: false };

  const occurrences = html.match(/connect-src/g) ?? [];
  if (occurrences.length !== 1) {
    throw new Error(
      `index.html doit porter exactement une directive connect-src (${occurrences.length} trouvée·s)`,
    );
  }
  const reecrit = ajouterOrigineConnectSrc(html, origine);
  return { html: reecrit, modifie: reecrit !== html };
}

// --- CLI -------------------------------------------------------------------
// node autoriser-origine-base.mjs <index.html> --base-url <url> --site-origin <origine>
const { pathToFileURL } = await import("node:url");
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { readFileSync, writeFileSync } = await import("node:fs");
  const args = process.argv.slice(2);
  const chemin = args[0];
  const baseUrl = args[args.indexOf("--base-url") + 1];
  const siteOrigin = args[args.indexOf("--site-origin") + 1];
  if (!chemin || args.indexOf("--base-url") < 0 || args.indexOf("--site-origin") < 0) {
    console.error(
      "usage : node autoriser-origine-base.mjs <index.html> --base-url <url> --site-origin <origine>",
    );
    process.exit(2);
  }
  const { html, modifie } = coquilleAutorisantBase(
    readFileSync(chemin, "utf8"),
    baseUrl,
    siteOrigin,
  );
  if (modifie) {
    writeFileSync(chemin, html);
    console.log(`CSP : connect-src autorise ${origineDe(baseUrl)} (base cross-origin)`);
  } else if (origineDe(baseUrl) === origineDe(siteOrigin)) {
    console.log("CSP : base same-origin, coquille inchangée");
  } else {
    console.log("CSP : origine de la base déjà autorisée, coquille inchangée");
  }
}
