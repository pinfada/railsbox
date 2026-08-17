// Choix des taux de bridage processeur sur lesquels la mesure s'exécute.
//
// Le bridage est un multiplicateur de lenteur appliqué au thread principal du
// rendu par Chrome DevTools Protocol (`Emulation.setCPUThrottlingRate`) : 1 =
// aucun bridage, 4 = « ce thread avance quatre fois moins vite ». C'est la
// seule façon d'approcher un vrai processeur lent depuis un poste de bureau,
// et c'est précisément ce que l'émulation mobile de Playwright NE fait pas
// (elle ne change que la fenêtre et l'agent utilisateur).
//
// Les taux par défaut sont choisis pour correspondre à des appareils réels,
// d'après les repères publics de l'outillage web :
//   1× — le poste de bureau qui exécute la mesure (référence)
//   4× — téléphone de milieu de gamme
//   6× — entrée de gamme récente
//   8× — vieil appareil / entrée de gamme ancienne
//
//   RAILSBOX_BRIDAGE_TAUX=1,4        npm run test:bridage
//   RAILSBOX_BRIDAGE_REPETITIONS=3   npm run test:bridage

/** Taux mesurés quand l'environnement ne dit rien. */
export const TAUX_PAR_DEFAUT = [1, 4, 6, 8];

/** Au-delà, le boot dépasse l'heure : refusé plutôt que laissé courir. */
const TAUX_MAXIMAL = 20;

/**
 * Taux de bridage demandés par l'environnement, triés et dédoublonnés.
 * @param {string | undefined} brut valeur de RAILSBOX_BRIDAGE_TAUX
 * @returns {number[]}
 */
export function tauxDemandes(brut) {
  const valeur = (brut ?? "").trim();
  if (valeur === "") return [...TAUX_PAR_DEFAUT];
  const demandes = valeur
    .split(",")
    .map((morceau) => morceau.trim())
    .filter((morceau) => morceau !== "")
    .map((morceau) => Number(morceau));
  const invalides = demandes.filter(
    (taux) => !Number.isFinite(taux) || taux < 1 || taux > TAUX_MAXIMAL,
  );
  if (demandes.length === 0 || invalides.length > 0) {
    throw new Error(
      `RAILSBOX_BRIDAGE_TAUX: taux invalide « ${valeur} » (attendu : nombres entre 1 et ${TAUX_MAXIMAL}, séparés par des virgules)`,
    );
  }
  return [...new Set(demandes)].sort((a, b) => a - b);
}

/**
 * Nombre de boots mesurés par taux. Un seul par défaut : chaque répétition
 * coûte un boot complet et une trentaine de mégaoctets téléchargés.
 * @param {string | undefined} brut valeur de RAILSBOX_BRIDAGE_REPETITIONS
 * @returns {number}
 */
export function repetitionsDemandees(brut) {
  const valeur = (brut ?? "").trim();
  if (valeur === "") return 1;
  const nombre = Number(valeur);
  if (!Number.isInteger(nombre) || nombre < 1 || nombre > 10) {
    throw new Error(
      `RAILSBOX_BRIDAGE_REPETITIONS: valeur invalide « ${valeur} » (attendu : entier entre 1 et 10)`,
    );
  }
  return nombre;
}
