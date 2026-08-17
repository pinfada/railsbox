// Frontière de sécurité de la surcouche système (ADR 0006).
//
// Les noms de paquets traités ici viennent de DEUX sources, dont l'une est du
// code tiers : la table gem → bibliothèques (gems.mjs, écrite par railsbox) et
// la clé `system_packages:` de railsbox.yml (écrite par le dépôt analysé). Ils
// finissent en arguments d'un `apt-get install` exécuté sur le runner de CI du
// mainteneur, avec le réseau. C'est le seul endroit du projet où une donnée
// tierce atteint une commande privilégiée — la validation est donc en liste
// BLANCHE stricte, et rien d'autre ne passe.
//
// Ce que la validation garantit :
//   · aucun métacaractère de shell (`;`, `$`, backtick, espace, guillemet…) ;
//   · aucun nom commençant par `-` — donc aucune OPTION apt déguisée en paquet
//     (`--allow-downgrades`, `-o APT::Get::AllowUnauthenticated=true`) ;
//   · aucun chemin (`/`, `./`, `..`) — donc aucun `.deb` local ni traversée ;
//   · aucune épingle de version ni de dépôt (`=`, `/`) ;
//   · un nombre et une longueur bornés.
//
// Ce qu'elle ne garantit PAS, et qu'il faut assumer : un nom valide désigne un
// paquet quelconque de l'archive Debian bookworm i386. C'est le risque accepté
// — l'archive est signée, servie en HTTPS, et le paquet n'est installé que dans
// un conteneur de construction jetable, jamais sur le runner lui-même.
import { SEVERITY, createFinding } from "./findings.mjs";

/** @typedef {import("./findings.mjs").Finding} Finding */

/**
 * Nom de paquet Debian, tel que la charte Debian le définit : au moins deux
 * caractères, minuscules, chiffres, et `+ - .` — le premier étant
 * alphanumérique. La contrainte sur le PREMIER caractère est celle qui interdit
 * qu'une option apt se fasse passer pour un paquet.
 */
export const DEBIAN_PACKAGE_NAME = /^[a-z0-9][a-z0-9+.-]+$/;

/** Longueur maximale d'un nom de paquet (la charte Debian n'en fixe pas). */
export const MAX_PACKAGE_NAME_LENGTH = 100;

/**
 * Nombre maximal de paquets dans une surcouche. Le plafond réel est la
 * géométrie du disque applicatif (512 Mo) et il est vérifié à la construction ;
 * celui-ci ne sert qu'à couper court à une liste manifestement absurde avant
 * même de lancer apt.
 */
export const MAX_SYSTEM_PACKAGES = 32;

/**
 * Valide une liste de noms de paquets système.
 *
 * Ne lève jamais : un nom refusé devient un diagnostic et disparaît de la
 * liste. Refuser en bloc priverait le mainteneur de l'information utile (quel
 * nom, pourquoi), et laisser passer serait pire.
 * @param {readonly string[]|string|null|undefined} names noms déclarés
 * @param {string} [source] origine, citée dans les diagnostics
 * @returns {{packages: readonly string[], findings: readonly Finding[]}} noms retenus, triés et dédoublonnés
 */
export function validateSystemPackages(names, source = "railsbox.yml") {
  /** @type {Finding[]} */
  const findings = [];
  const brut =
    typeof names === "string" ? names.split(/\s+/) : Array.isArray(names) ? [...names] : [];
  /** @type {Set<string>} */
  const retenus = new Set();
  for (const candidat of brut) {
    const nom = typeof candidat === "string" ? candidat.trim() : "";
    if (nom === "") continue;
    const refus = motifDeRefus(nom);
    if (refus !== null) {
      findings.push(
        createFinding(
          SEVERITY.BLOCKING,
          "invalid-system-package",
          `Nom de paquet système refusé dans ${source} : « ${apercu(nom)} » (${refus}).`,
          { package: apercu(nom), source },
        ),
      );
      continue;
    }
    retenus.add(nom);
  }
  const packages = [...retenus].sort();
  if (packages.length > MAX_SYSTEM_PACKAGES) {
    findings.push(
      createFinding(
        SEVERITY.BLOCKING,
        "too-many-system-packages",
        `${packages.length} paquets système demandés dans ${source} : ${MAX_SYSTEM_PACKAGES} au maximum.`,
        { count: packages.length, source },
      ),
    );
    return { packages: Object.freeze([]), findings: Object.freeze(findings) };
  }
  return { packages: Object.freeze(packages), findings: Object.freeze(findings) };
}

/**
 * Explique pourquoi un nom est refusé, en français et sans jargon.
 * @param {string} nom nom candidat, déjà rogné
 * @returns {string|null} motif, ou `null` si le nom est acceptable
 */
function motifDeRefus(nom) {
  if (nom.length > MAX_PACKAGE_NAME_LENGTH) return "nom trop long";
  if (nom.startsWith("-")) return "un nom de paquet ne peut pas commencer par un tiret";
  if (nom.includes("/")) return "un chemin n'est pas un nom de paquet";
  if (nom.includes("=")) return "les épingles de version ne sont pas acceptées";
  if (!DEBIAN_PACKAGE_NAME.test(nom)) {
    return "seuls minuscules, chiffres et « + - . » sont admis, le premier caractère étant alphanumérique";
  }
  return null;
}

/**
 * Tronque un nom pour le citer sans inonder le rapport.
 * @param {string} nom nom brut
 * @returns {string} nom borné
 */
function apercu(nom) {
  return nom.length > MAX_PACKAGE_NAME_LENGTH ? `${nom.slice(0, MAX_PACKAGE_NAME_LENGTH)}…` : nom;
}
