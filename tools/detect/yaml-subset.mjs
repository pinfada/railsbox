// Analyse lexicale du sous-ensemble YAML accepté par `railsbox.yml`.
// Isolé du schéma (manifest.mjs) : ici on ne sait rien des clés attendues, on
// ne fait que transformer du texte en valeurs.

/**
 * Retire un commentaire `#` en dehors des chaînes entre guillemets.
 * @param {string} line ligne brute
 * @returns {string} ligne sans commentaire
 */
export function stripComment(line) {
  let quote = null;
  for (let index = 0; index < line.length; index += 1) {
    const char = line[index];
    if (quote !== null) {
      if (char === quote) quote = null;
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      continue;
    }
    if (char === "#") return line.slice(0, index);
  }
  return line;
}

/**
 * Convertit une valeur scalaire YAML du sous-ensemble supporté.
 * @param {string} raw texte à droite du `:`
 * @returns {string|boolean|string[]} valeur typée
 */
export function parseScalar(raw) {
  const value = raw.trim();
  if (value.startsWith("[") && value.endsWith("]")) return parseFlowArray(value);
  if (value === "true") return true;
  if (value === "false") return false;
  const quoted = /^"([\s\S]*)"$/.exec(value) ?? /^'([\s\S]*)'$/.exec(value);
  return quoted ? quoted[1] : value;
}

/**
 * Analyse un tableau en style « flow » : `[a, "b"]`.
 * @param {string} value texte incluant les crochets
 * @returns {string[]} éléments non vides
 */
export function parseFlowArray(value) {
  return value
    .slice(1, -1)
    .split(",")
    .map((item) => String(parseScalar(item)))
    .filter((item) => item !== "");
}

/**
 * Normalise une valeur attendue comme texte.
 * @param {*} value valeur analysée
 * @returns {string|null} texte, ou `null` si la valeur est inexploitable
 */
export function normalizeText(value) {
  if (Array.isArray(value)) return null;
  const text = String(value).trim();
  return text === "" ? null : text;
}

/**
 * Normalise la liste de scripts d'assets (un scalaire vaut une liste d'un élément).
 * @param {*} value valeur analysée
 * @returns {string[]|null} liste de scripts, ou `null` si inexploitable
 */
export function normalizeScripts(value) {
  if (Array.isArray(value)) return value;
  const text = normalizeText(value);
  return text === null ? null : [text];
}
