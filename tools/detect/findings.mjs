// Vocabulaire commun des diagnostics de la détection. Un diagnostic est
// structuré (code machine stable + message français) : le rapport peut ainsi
// grouper et proposer un remède sans jamais réanalyser du texte libre.

/** Sévérités possibles d'un diagnostic, de la plus grave à la plus anodine. */
export const SEVERITY = Object.freeze({
  BLOCKING: "blocking",
  WARNING: "warning",
  INFO: "info",
});

/**
 * @typedef {object} Finding
 * @property {string} severity `blocking`, `warning` ou `info`
 * @property {string} code identifiant stable, sert de clé aux remèdes
 * @property {string} message texte français destiné à l'utilisateur
 * @property {Record<string, any>} [details] contexte additionnel (fichier, ligne, clé...)
 */

/**
 * Construit un diagnostic normalisé et gelé.
 * @param {string} severity une des valeurs de {@link SEVERITY}
 * @param {string} code identifiant stable du diagnostic
 * @param {string} message message français
 * @param {Record<string, any>} [details] contexte additionnel facultatif
 * @returns {Finding} diagnostic immuable
 */
export function createFinding(severity, code, message, details) {
  const finding = details ? { severity, code, message, details } : { severity, code, message };
  return Object.freeze(finding);
}
