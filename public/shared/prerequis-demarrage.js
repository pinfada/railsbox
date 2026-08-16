// Conditions préalables au démarrage de la coquille, et reprise après
// rechargement. Logique PURE : elle ne touche ni au DOM, ni à
// `location.reload()`, ni à `sessionStorage` — main.js s'en charge, ce module
// décide. C'est ce qui la rend testable sans navigateur.
//
// Deux questions, un seul module, parce qu'elles répondent ensemble à « la
// coquille peut-elle démarrer ici, et sinon que dit-on au visiteur ? ».

/** Gardes de rechargement, une par RAISON de recharger. */
export const GARDE_CONTROLE = "rib-reprise-controle";
export const GARDE_ISOLATION = "rib-reprise-isolation";

/**
 * @typedef {{
 *   contexteSecurise: boolean,
 *   serviceWorker: boolean,
 *   webAssembly: boolean,
 *   cacheStorage: boolean,
 *   indexedDb: boolean,
 *   decompression: boolean,
 * }} Capacites
 */

/**
 * @typedef {{ cle: string, titre: string, consequence: string }} Manque
 */

// Sans l'une de ces trois-là, rien ne peut fonctionner : aucune dégradation
// n'est possible, seul un message honnête l'est.
//
// SharedArrayBuffer est délibérément ABSENT de cette liste : il n'apparaît
// qu'une fois la page cross-origin isolée, donc APRÈS que le Service Worker a
// réinjecté COOP/COEP. Le tester avant le démarrage accuserait à tort tous les
// navigateurs, y compris ceux qui fonctionnent. C'est l'étape d'isolation qui
// le constate, au bon moment.
const BLOQUANTS = [
  {
    cle: "contexteSecurise",
    titre: "Contexte non sécurisé",
    consequence:
      "Service Worker et mémoire partagée n'existent qu'en HTTPS (ou sur localhost). " +
      "Ouvrez la sandbox par son adresse https://.",
  },
  {
    cle: "serviceWorker",
    titre: "Service Worker indisponible",
    consequence:
      "Toute la sandbox repose dessus : proxy des requêtes de l'application et réinjection " +
      "des en-têtes d'isolation. Il est bloqué en navigation privée sur certains navigateurs, " +
      "et dans la plupart des webviews intégrées aux applications (réseaux sociaux, messageries). " +
      "Ouvrez la page dans un onglet de navigateur ordinaire.",
  },
  {
    cle: "webAssembly",
    titre: "WebAssembly indisponible",
    consequence: "L'émulateur x86 est un module WebAssembly : sans lui, aucune VM ne peut tourner.",
  },
];

// Manques qui coûtent des téléchargements ou un boot à froid, jamais le
// fonctionnement : on les signale, on ne s'arrête pas.
const DEGRADANTS = [
  {
    cle: "cacheStorage",
    titre: "Cache Storage indisponible",
    consequence: "Les morceaux de disque seront retéléchargés à chaque visite.",
  },
  {
    cle: "indexedDb",
    titre: "IndexedDB indisponible",
    consequence:
      "L'instantané mémoire ne peut pas être conservé localement : chaque visite le retélécharge.",
  },
  {
    cle: "decompression",
    titre: "DecompressionStream indisponible",
    consequence:
      "Un instantané livré gzippé ne peut pas être décompressé : la VM devra booter à froid.",
  },
];

/**
 * Relève les capacités d'une portée globale (window). Passée en paramètre
 * plutôt que lue directement : c'est ce qui permet de la simuler en test.
 * @param {any} portee
 * @returns {Capacites}
 */
export function releverCapacites(portee) {
  return {
    contexteSecurise: portee.isSecureContext === true,
    serviceWorker: Boolean(portee.navigator?.serviceWorker),
    webAssembly: typeof portee.WebAssembly === "object",
    cacheStorage: Boolean(portee.caches),
    indexedDb: Boolean(portee.indexedDB),
    decompression: typeof portee.DecompressionStream === "function",
  };
}

/**
 * @param {Manque[]} references
 * @param {Capacites} capacites
 * @returns {Manque[]}
 */
function manquants(references, capacites) {
  return references.filter((manque) => capacites[manque.cle] !== true);
}

/**
 * Diagnostic complet : ce qui interdit de démarrer, et ce qui ne fera que
 * coûter cher.
 * @param {Capacites} capacites
 * @returns {{ demarrable: boolean, bloquants: Manque[], degradations: Manque[] }}
 */
export function diagnostiquer(capacites) {
  const bloquants = manquants(BLOQUANTS, capacites);
  return {
    demarrable: bloquants.length === 0,
    bloquants,
    degradations: manquants(DEGRADANTS, capacites),
  };
}

/**
 * Message destiné au visiteur. Il nomme ce qui manque et ce que cela empêche :
 * « ça ne marche pas » n'aide personne à savoir s'il doit changer d'onglet, de
 * navigateur, ou renoncer.
 * @param {Manque[]} manques
 * @returns {string}
 */
export function resumerManques(manques) {
  return manques.map((manque) => `${manque.titre} — ${manque.consequence}`).join("\n");
}

/**
 * Étape de démarrage qui exige une condition du navigateur, et peut être
 * satisfaite par UN rechargement (le Service Worker vient de s'installer, la
 * navigation suivante passera par lui).
 *
 * Chaque étape a sa PROPRE garde : la première visite a besoin des deux
 * rechargements — l'un pour que le Service Worker prenne le contrôle, l'autre
 * pour que la navigation qu'il intercepte porte enfin COOP/COEP. Une garde
 * unique, consommée par le premier, interdisait le second ; c'est ce qui
 * faisait échouer Firefox et WebKit, où le contrôle est pris dès la première
 * page (`clients.claim()`) alors que l'isolation, elle, exige une navigation
 * de plus.
 *
 * @param {{ satisfait: boolean, dejaRecharge: boolean }} contexte
 * @returns {"poursuivre" | "recharger" | "abandonner"}
 */
export function decisionReprise({ satisfait, dejaRecharge }) {
  if (satisfait) return "poursuivre";
  return dejaRecharge ? "abandonner" : "recharger";
}
