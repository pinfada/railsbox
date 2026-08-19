// Chemins absolus dans le JavaScript de l'application — le seul défaut que la
// sandbox ne révèle qu'AU CLIC.
//
// Vécu en réel : une application publiée s'affichait parfaitement, et un clic
// sur un bouton cassait la page. Ses contrôleurs Stimulus appelaient
// `fetch("/api/likes")`. Or une sandbox est publiée sur un GitHub Pages de
// projet : la coquille garde la racine et l'application est montée sous
// `/<depot>/app/` via RAILS_RELATIVE_URL_ROOT. Un chemin qui commence par « / »
// vise donc la racine du DOMAINE, pas celle de l'application : la requête part
// sur `https://<compte>.github.io/api/likes`, hors du périmètre que le Service
// Worker proxifie, GitHub Pages répond par sa page 404, l'iframe la charge, et
// le contexte devenu étranger casse tout.
//
// Rails suit le préfixe partout — `link_to`, `form_with`, `url_for` lisent le
// SCRIPT_NAME de Rack. RIEN de ce qui est écrit en JavaScript ne le lit. Le
// README documente déjà le piège pour les ROUTEURS de SPA ; personne ne le
// documentait pour les appels réseau, qui sont pourtant le cas le plus courant
// et le plus discret : une application sans SPA, avec trois contrôleurs
// Stimulus, le porte tout autant.
//
// Pourquoi une détection STATIQUE : aucun test GET ne peut attraper ça. La page
// se rend, les assets se chargent, la capture d'écran est parfaite. Seule une
// interaction d'écriture révèle la panne — et elle n'arrive qu'après la
// publication, chez le visiteur.
//
// Module PUR : il reçoit des contenus de fichiers, il rend des occurrences et
// des diagnostics. La lecture du disque appartient à detect.mjs.
import { SEVERITY, createFinding } from "./findings.mjs";

/** @typedef {import("./findings.mjs").Finding} Finding */

/**
 * Un appel réseau visant un chemin absorbé par la racine du domaine.
 * @typedef {object} AbsolutePathCall
 * @property {string} file nom du fichier, tel qu'il a été fourni
 * @property {number} line numéro de ligne, 1 pour la première
 * @property {string} kind forme d'appel reconnue (« fetch() », « axios.get() »…)
 * @property {string} path chemin absolu écrit dans le source
 */

/** Nombre d'appels nommés dans le message avant de résumer par un compte. */
const MAX_NAMED_CALLS = 10;

/** Longueur au-delà de laquelle un chemin est tronqué dans le message. */
const MAX_PATH_LENGTH = 80;

/**
 * Fragment reconnaissant l'ARGUMENT d'un appel : une chaîne littérale dont le
 * PREMIER caractère est une barre oblique, et dont le second n'en est pas une.
 *
 * Ces deux exigences portent tout le travail d'évitement des faux positifs :
 *
 *   · commencer par « / » exclut `fetch("https://…")` et `fetch("api/likes")` ;
 *   · le `(?!\/)` exclut `//cdn.exemple.test/lib.js`, qui est une URL
 *     protocol-relative — elle vise un AUTRE hôte, pas la racine du site ;
 *   · la chaîne doit suivre IMMÉDIATEMENT la parenthèse ouvrante (le `\(\s*`
 *     des motifs ci-dessous), ce qui écarte `fetch(prefix + "/api")` —
 *     précisément le code CORRIGÉ qu'on ne veut surtout pas dénoncer ;
 *   · un gabarit qui commence par une interpolation (`` `${racine}/api` ``)
 *     ne commence pas par « / » et ne matche donc pas non plus.
 *
 * Un gabarit interpolé APRÈS la barre (`` `/api/likes/${id}` ``) matche, lui,
 * et c'est voulu : c'est le premier caractère qui décide de la cible.
 */
const CHEMIN = "(?:'(/(?!/)[^'\\n]*)'|\"(/(?!/)[^\"\\n]*)\"|`(/(?!/)[^`]*)`)";

/** Fragment reconnaissant une chaîne littérale quelconque (la méthode d'un XHR). */
const CHAINE = "(?:'[^'\\n]*'|\"[^\"\\n]*\"|`[^`]*`)";

/**
 * Formes d'appel reconnues. Le catalogue est exporté pour que la documentation
 * et les tests s'y réfèrent plutôt que de recopier des motifs.
 *
 * `garde` : sous-chaîne devant être présente DANS LE FICHIER pour que la forme
 * soit cherchée. Elle n'existe que pour `.open()`, dont le nom est trop banal
 * (un tiroir, un dialogue, une connexion s'ouvrent aussi) : sans la mention de
 * XMLHttpRequest quelque part, la reconnaissance serait un générateur de bruit.
 *
 * `horsPerimetre` : la forme ne fonctionnera de toute façon PAS dans la
 * sandbox, préfixe ou pas — le pont série ne transporte que du HTTP.
 * @type {readonly {nom: string, motif: RegExp, garde?: string, horsPerimetre?: boolean}[]}
 */
export const APPELS_RESEAU = Object.freeze([
  Object.freeze({
    nom: "fetch()",
    // Le `(?<![\w$.])` interdit un point AVANT : `depot.fetch("/x")` est la
    // méthode d'un objet quelconque, pas le fetch du navigateur. Les seules
    // qualifications acceptées sont celles qui désignent bien l'objet global.
    motif: new RegExp(
      String.raw`(?<![\w$.])(?:(?:window|globalThis|self)\s*\.\s*)?fetch\s*\(\s*` + CHEMIN,
      "g",
    ),
  }),
  Object.freeze({
    nom: "axios",
    motif: new RegExp(
      String.raw`(?<![\w$.])axios\s*(?:\.\s*(?:get|post|put|patch|delete|head|options|request))?\s*\(\s*` +
        CHEMIN,
      "g",
    ),
  }),
  Object.freeze({
    // `axios.create({ baseURL: "/api/v1" })` est le cas que le README nomme
    // déjà : le chemin ne suit aucune parenthèse d'appel, il vit dans un objet
    // de configuration. La clé est assez spécifique pour être cherchée seule.
    nom: "baseURL",
    motif: new RegExp(String.raw`(?<![\w$])["']?baseURL["']?\s*:\s*` + CHEMIN, "g"),
  }),
  Object.freeze({
    nom: "new EventSource()",
    motif: new RegExp(String.raw`new\s+EventSource\s*\(\s*` + CHEMIN, "g"),
  }),
  Object.freeze({
    nom: "new WebSocket()",
    motif: new RegExp(String.raw`new\s+WebSocket\s*\(\s*` + CHEMIN, "g"),
    horsPerimetre: true,
  }),
  Object.freeze({
    nom: "XMLHttpRequest.open()",
    motif: new RegExp(String.raw`\.\s*open\s*\(\s*` + CHAINE + String.raw`\s*,\s*` + CHEMIN, "g"),
    garde: "XMLHttpRequest",
  }),
]);

/**
 * Remplace les commentaires par des blancs, en respectant les chaînes.
 *
 * Le point délicat est là : un `String.replace(/\/\/.*$/gm, "")` naïf coupe la
 * ligne au « // » de `const cdn = "https://exemple.test/lib.js"` et perd tout
 * ce qui suit — y compris le vrai chemin absolu écrit trois lignes plus bas.
 * D'où ce petit automate, qui traverse les chaînes avant de reconnaître un
 * commentaire.
 *
 * Les blancs remplacent les caractères UN POUR UN et les sauts de ligne sont
 * conservés : les positions restent celles du source, donc les numéros de ligne
 * rapportés sont ceux que l'utilisateur lira dans son éditeur.
 *
 * LIMITE ASSUMÉE : une expression régulière littérale contenant `//` ou `/*`
 * non échappés (`/[/]/`) serait prise pour un commentaire. C'est rarissime, et
 * le prix d'un vrai analyseur JavaScript pour ce seul gain serait absurde.
 * @param {string} source contenu du fichier
 * @returns {string} même contenu, commentaires blanchis
 */
export function retirerCommentaires(source) {
  const taille = source.length;
  let sortie = "";
  let i = 0;
  while (i < taille) {
    const caractere = source[i];
    const suivant = source[i + 1];
    if (caractere === "/" && suivant === "/") {
      while (i < taille && source[i] !== "\n") {
        sortie += " ";
        i += 1;
      }
      continue;
    }
    if (caractere === "/" && suivant === "*") {
      while (i < taille && !(source[i] === "*" && source[i + 1] === "/")) {
        sortie += source[i] === "\n" ? "\n" : " ";
        i += 1;
      }
      // Les deux caractères de fermeture, ou la fin d'un commentaire non clos.
      sortie += i < taille ? "  " : "";
      i += 2;
      continue;
    }
    if (caractere === "'" || caractere === '"' || caractere === "`") {
      sortie += caractere;
      i += 1;
      while (i < taille) {
        const courant = source[i];
        if (courant === "\\") {
          sortie += source.slice(i, i + 2);
          i += 2;
          continue;
        }
        sortie += courant;
        i += 1;
        if (courant === caractere) break;
        // Une apostrophe ou un guillemet non fermé s'arrête à la fin de ligne :
        // sans cette sortie, une seule quote orpheline avalerait le fichier.
        if (courant === "\n" && caractere !== "`") break;
      }
      continue;
    }
    sortie += caractere;
    i += 1;
  }
  return sortie;
}

/**
 * Le premier groupe capturé qui a matché, parmi les trois formes de guillemets.
 * @param {RegExpMatchArray} match résultat d'une expression du catalogue
 * @returns {string|null} chemin trouvé, ou `null`
 */
function cheminCapture(match) {
  return match.slice(1).find((groupe) => groupe !== undefined) ?? null;
}

/**
 * Relève les appels réseau visant un chemin absolu dans des sources JavaScript.
 * @param {readonly {name: string, text: string}[]} [files] fichiers à analyser
 * @returns {readonly AbsolutePathCall[]} occurrences, par fichier puis par ligne
 */
export function scanAbsolutePaths(files) {
  /** @type {AbsolutePathCall[]} */
  const occurrences = [];
  for (const fichier of files ?? []) {
    const nom = String(fichier?.name ?? "");
    const source = typeof fichier?.text === "string" ? fichier.text : "";
    if (source === "") continue;
    const code = retirerCommentaires(source);
    /** @type {{index: number, kind: string, path: string}[]} */
    const brutes = [];
    for (const appel of APPELS_RESEAU) {
      if (appel.garde && !code.includes(appel.garde)) continue;
      for (const match of code.matchAll(appel.motif)) {
        const chemin = cheminCapture(match);
        if (chemin === null) continue;
        brutes.push({ index: match.index ?? 0, kind: appel.nom, path: chemin });
      }
    }
    // Un balayage unique du source convertit les positions en numéros de ligne :
    // recompter depuis le début à chaque occurrence serait quadratique sur un
    // gros bundle vendorisé qui aurait échappé aux bornes du parcours.
    brutes.sort((a, b) => a.index - b.index);
    let ligne = 1;
    let curseur = 0;
    for (const brute of brutes) {
      while (curseur < brute.index) {
        if (code[curseur] === "\n") ligne += 1;
        curseur += 1;
      }
      occurrences.push(
        Object.freeze({ file: nom, line: ligne, kind: brute.kind, path: brute.path }),
      );
    }
  }
  return Object.freeze(occurrences);
}

/**
 * Raccourcit un chemin trop long pour tenir dans un message de rapport.
 * @param {string} chemin chemin relevé dans le source
 * @returns {string} chemin, tronqué si nécessaire
 */
function abreger(chemin) {
  return chemin.length <= MAX_PATH_LENGTH ? chemin : `${chemin.slice(0, MAX_PATH_LENGTH)}…`;
}

/**
 * Diagnostic unique nommant les fichiers et les chemins relevés.
 *
 * AVERTISSEMENT et jamais refus, pour deux raisons qu'aucune analyse statique
 * ne peut lever : l'application peut être montée à la racine chez elle (le
 * chemin est alors parfaitement correct), et rien ne prouve que la ligne
 * trouvée sera exécutée. Bloquer interdirait des applications qui marchent.
 *
 * UN SEUL diagnostic, pas un par appel : un contrôleur Stimulus bavard en
 * porte facilement une dizaine, et dix lignes identiques noieraient le reste
 * du rapport sans rien apprendre de plus.
 * @param {readonly AbsolutePathCall[]} [occurrences] appels relevés
 * @returns {readonly Finding[]} zéro ou un diagnostic, gelé
 */
export function absolutePathFindings(occurrences) {
  const appels = Array.isArray(occurrences) ? occurrences : [];
  if (appels.length === 0) return Object.freeze([]);

  const nommes = appels
    .slice(0, MAX_NAMED_CALLS)
    .map(({ file, line, kind, path }) => `${file}:${line} ${kind} → ${abreger(path)}`);
  const restants = appels.length - nommes.length;
  const liste = nommes.join(" ; ") + (restants > 0 ? ` … et ${restants} autres` : "");
  const pluriel = appels.length > 1;
  // Le sort des WebSockets est dit à part : les préfixer ne les fera pas
  // marcher pour autant, et mieux vaut l'apprendre ici qu'après publication.
  const websocket = appels.some((appel) => appel.kind === "new WebSocket()")
    ? " Les appels WebSocket, eux, ne fonctionneront pas dans la sandbox même bien préfixés : le " +
      "pont série ne transporte que du HTTP."
    : "";

  return Object.freeze([
    createFinding(
      SEVERITY.WARNING,
      "chemin-absolu-javascript",
      `${appels.length} appel${pluriel ? "s" : ""} JavaScript vise${pluriel ? "nt" : ""} un chemin ` +
        `absolu depuis la racine du DOMAINE : ${liste}. Dans la sandbox l'application est montée ` +
        `sous /<depot>/app/ : « /api/… » part sur https://<compte>.github.io/api/…, hors du ` +
        `périmètre proxifié par le Service Worker, et GitHub Pages répond par sa page 404. La ` +
        `page s'affichera pourtant sans la moindre erreur — seul un CLIC révélera la panne, chez ` +
        `le visiteur.${websocket}`,
      {
        calls: Object.freeze(appels.map((appel) => `${appel.file}:${appel.line}`)),
        files: Object.freeze([...new Set(appels.map((appel) => appel.file))]),
      },
    ),
  ]);
}
