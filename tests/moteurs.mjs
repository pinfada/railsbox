// Choix des moteurs de navigateur sur lesquels une suite Playwright s'exécute.
//
// Chromium reste le défaut : c'est le seul moteur que la CI installe, et une
// suite qui exigerait Firefox et WebKit ferait échouer un `npm run test:live`
// sur un poste qui ne les a pas téléchargés. Les autres moteurs s'ouvrent à la
// demande, par `RAILSBOX_MOTEURS` :
//
//   RAILSBOX_MOTEURS=tous            npm run test:live
//   RAILSBOX_MOTEURS=firefox,webkit  npm run test:e2e
//
// Une fois plusieurs moteurs déclarés, `--project=webkit` filtre encore.

/** Moteurs connus, dans l'ordre où on veut les voir dans un rapport. */
export const MOTEURS_CONNUS = ["chromium", "firefox", "webkit"];

const MOTEUR_PAR_DEFAUT = "chromium";

/**
 * Noms des moteurs demandés par l'environnement.
 * @param {string | undefined} brut valeur de RAILSBOX_MOTEURS
 * @returns {string[]}
 */
export function moteursDemandes(brut) {
  const valeur = (brut ?? "").trim().toLowerCase();
  if (valeur === "") return [MOTEUR_PAR_DEFAUT];
  if (valeur === "tous" || valeur === "all") return [...MOTEURS_CONNUS];
  const demandes = valeur
    .split(",")
    .map((nom) => nom.trim())
    .filter((nom) => nom !== "");
  const inconnus = demandes.filter((nom) => !MOTEURS_CONNUS.includes(nom));
  if (inconnus.length > 0) {
    throw new Error(
      `RAILSBOX_MOTEURS: moteur inconnu ${inconnus.join(", ")} (attendu : ${MOTEURS_CONNUS.join(", ")}, ou « tous »)`,
    );
  }
  // Dédoublonné et remis dans l'ordre canonique : un rapport doit se lire
  // pareil quel que soit l'ordre de frappe.
  return MOTEURS_CONNUS.filter((nom) => demandes.includes(nom));
}

/**
 * Projets Playwright correspondants.
 * @param {string | undefined} brut valeur de RAILSBOX_MOTEURS
 * @returns {{ name: string, use: { browserName: string } }[]}
 */
export function projetsMoteurs(brut) {
  return moteursDemandes(brut).map((nom) => ({
    name: nom,
    use: { browserName: /** @type {any} */ (nom) },
  }));
}
