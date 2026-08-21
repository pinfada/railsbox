// Où l'instantané va chercher ses artefacts, et où il écrit le sien.
//
// Extrait de make-snapshot.mjs pour être ÉPROUVÉ sans booter de VM : ces
// quelques règles décident quels fichiers sont lus et lequel est écrasé, et se
// tromper coûte l'instantané d'une autre application — plusieurs centaines de
// mégaoctets et une dizaine de minutes de capture.
import { join } from "node:path";

/** Configuration de la page d'accueil, celle que la coquille boote par défaut. */
export const CONFIG_PAR_DEFAUT = "v86-config.json";

/**
 * Nom de fichier de configuration : un seul segment, terminé par `.json`.
 *
 * La forme est VALIDÉE, pas nettoyée. L'argument sert à composer un chemin sous
 * public/disks/ : un chemin absolu, un séparateur ou un `..` n'y ont aucune
 * raison d'être, et les accepter pour les assainir ensuite serait se donner une
 * occasion de se tromper.
 * @param {string | undefined} demande argument de ligne de commande
 * @returns {string} nom retenu
 */
export function nomConfiguration(demande) {
  if (demande === undefined || demande === "") return CONFIG_PAR_DEFAUT;
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*\.json$/.test(demande)) {
    throw new Error(
      `nom de configuration invalide : « ${demande} » — attendu un nom de fichier ` +
        `de public/disks/, par exemple zealot-config.json`,
    );
  }
  return demande;
}

/**
 * Chemin local d'un artefact désigné par la configuration.
 *
 * Les valeurs y sont écrites POUR LE NAVIGATEUR (`/disks/x.ext2`, ou `disks/x`
 * sur un Pages de projet) : seul le nom de fichier nous concerne, et lui aussi
 * est validé — la configuration d'une application tierce n'a pas à pouvoir
 * désigner un fichier hors du dossier des artefacts.
 * @param {unknown} valeur entrée `kernel`, `initrd` ou `disk`
 * @param {string} quoi nom de l'entrée, pour le message d'erreur
 * @param {string} disksDir dossier des artefacts
 * @returns {string} chemin absolu
 */
export function cheminArtefact(valeur, quoi, disksDir) {
  if (typeof valeur !== "string" || valeur === "") {
    throw new Error(`configuration sans entrée « ${quoi} »`);
  }
  const nu = valeur.replace(/^\/?disks\//, "");
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(nu)) {
    throw new Error(`entrée « ${quoi} » hors du dossier des artefacts : ${valeur}`);
  }
  return join(disksDir, nu);
}

/**
 * Nom du fichier d'instantané à produire.
 *
 * IL SUIT LE NOM DE LA CONFIGURATION, pas celui du disque. Deux configurations
 * peuvent parfaitement désigner des disques de même nom de base — rien ne
 * l'interdit — et l'instantané de l'une écraserait alors celui de l'autre. Le
 * nom de configuration, lui, est unique par construction : c'est un fichier.
 *
 * `v86-config.json` fait exception, et c'est délibéré : ce n'est pas le nom
 * d'une application mais celui de la PAGE D'ACCUEIL, qui désigne l'image
 * courante. Son instantané suit donc le disque — ce qui reproduit exactement le
 * comportement d'avant cette généralisation, quand l'outil ne savait traiter
 * que jiyufit.
 * @param {string} nomConfig nom de configuration déjà validé
 * @param {string} cheminDisque chemin du disque, pour le cas de la page d'accueil
 * @returns {string} nom de fichier, sans dossier
 */
export function nomInstantane(nomConfig, cheminDisque) {
  if (nomConfig !== CONFIG_PAR_DEFAUT) {
    return `${nomConfig.replace(/-?config\.json$/, "").replace(/\.json$/, "")}-state.bin`;
  }
  const base = String(cheminDisque).split(/[\\/]/).pop() ?? "";
  return `${base.replace(/\.ext2$/, "")}-state.bin`;
}

// `verifierInstantane` vit dans public/shared/ : la COQUILLE en a besoin, et
// elle ne peut importer que ce qui est servi. Réexporté ici pour que la
// chaîne de construction n'ait qu'un seul module de cibles à connaître.
export { INSTANTANE, verifierInstantane } from "../../public/shared/instantane-lien.js";

/**
 * L'instantané visé appartient-il bien à CETTE configuration ?
 *
 * Un fichier déjà présent que la configuration ne référence pas est
 * l'instantané de quelqu'un d'autre : le remplacer détruirait une capture qui
 * a coûté une dizaine de minutes. Une RE-capture, elle, passe — la
 * configuration référence alors déjà le fichier, puisque la capture précédente
 * l'y a inscrit.
 * @param {{ existe: boolean, etatDeclare?: unknown, nomInstantane: string }} etat
 * @returns {{ autorise: boolean, raison: string }}
 */
export function ecrasementAutorise({ existe, etatDeclare, nomInstantane: vise }) {
  if (!existe) return { autorise: true, raison: "" };
  const declare = typeof etatDeclare === "string" ? etatDeclare.split(/[\\/]/).pop() : null;
  if (declare === vise) return { autorise: true, raison: "" };
  return {
    autorise: false,
    raison:
      `${vise} existe déjà et n'est pas référencé par cette configuration : c'est ` +
      `l'instantané d'une autre image. Renommez-le, ou supprimez-le sciemment.`,
  };
}

/**
 * SCELLE une configuration sur l'instantané qu'on vient de capturer.
 *
 * Deux captures existent — monolithique (make-snapshot.mjs) et par delta
 * (make-delta-snapshot.mjs, celle de la chaîne PUBLIQUE) — et seule la
 * première écrivait `stateFor`. La seconde produisait donc des sandboxes que
 * `verifierInstantane` classe SANS_MARQUE : tolérées, jamais vérifiées. Le
 * garde n'existait pas là où il servait.
 *
 * `stateFor` lie l'instantané à la construction DÉCLARÉE qu'il a figée (ADR
 * 0007) : si la configuration est réécrite sans recapture, le lien se voit
 * ROMPU au lieu de se deviner — un état mémoire posé sur un système de
 * fichiers qu'il ne connaît pas ne rend jamais la main, et rien ne le dirait.
 *
 * Ce n'est PAS une identité de contenu : les deux valeurs viennent de la
 * configuration, jamais des octets du disque. La portée exacte du verdict, et
 * ce qu'il laisse passer, sont détaillées dans instantane-lien.js.
 *
 * D'où `appDiskSha256`, l'empreinte du disque applicatif RÉELLEMENT attaché à
 * la capture, inscrite ici sous le nom `stateForAppDiskSha256` (ADR 0009).
 *
 * CE SCELLEMENT N'ÉCRIT QUE LA MOITIÉ DU LIEN, et c'est délibéré. La seconde
 * empreinte — `appDiskSha256`, celle du disque que la configuration NOMME — est
 * posée par le découpage, qui la calcule sur les octets qu'il publie
 * (split-artifact.mjs). Écrire les deux ici les rendrait égales par
 * construction : exactement le défaut de `stateFor`/`builtAt` que l'issue #4 a
 * démonté. Le lien ne vaut que parce que DEUX lectures indépendantes peuvent
 * diverger.
 *
 * L'absence de `builtAt` est une ERREUR, pas un cas à tolérer : sceller sans
 * lui écrirait un `stateFor` vide, que JSON.stringify ôte, et la sandbox
 * repartirait silencieusement sans garde. Une empreinte MAL FORMÉE l'est tout
 * autant : le lecteur l'écarterait en silence, et le garde disparaîtrait là où
 * on croit l'avoir posé.
 * @param {{ builtAt?: unknown, [champ: string]: unknown }} config configuration à sceller
 * @param {string} etat référence de l'instantané, telle qu'elle sera servie
 * @param {{ appDiskSha256?: string }} [marques] empreinte du disque attaché à la capture
 * @returns {Record<string, unknown> & { state: string, stateFor: string }} configuration scellée
 * @throws {TypeError} si `builtAt`, la référence d'état ou l'empreinte est invalide
 */
export function scellerInstantane(config, etat, marques = {}) {
  const builtAt = config?.builtAt;
  if (typeof builtAt !== "string" || builtAt === "") {
    throw new TypeError(
      "scellerInstantane exige un builtAt : sans lui, l'instantané ne peut être lié " +
        "à sa construction, et la sandbox repartirait sans garde.",
    );
  }
  if (typeof etat !== "string" || etat === "") {
    throw new TypeError("scellerInstantane exige la référence de l'instantané");
  }
  const { appDiskSha256 } = marques;
  // LE CONTRÔLE PORTE SUR LA VALEUR REÇUE, PAS SUR SA COERCITION EN CHAÎNE.
  // Valider `String(appDiskSha256)` acceptait tout objet dont `toString()` rend
  // 64 caractères hexadécimaux — et c'est la valeur D'ORIGINE qui partait dans
  // la configuration, sous la forme `"stateForAppDiskSha256": {}`. Le lecteur
  // écarte cette marque, faute de forme, et retombe en silence sur la date :
  // une marque présente et sans effet, soit le contraire du contrat annoncé.
  if (appDiskSha256 !== undefined) {
    if (typeof appDiskSha256 !== "string" || !SHA256_COMPLET.test(appDiskSha256)) {
      throw new TypeError(
        "scellerInstantane exige une empreinte SHA-256 complète (64 caractères " +
          `hexadécimaux minuscules), reçu : ${JSON.stringify(appDiskSha256)}`,
      );
    }
  }
  return {
    ...config,
    state: etat,
    stateFor: builtAt,
    ...(appDiskSha256 ? { stateForAppDiskSha256: appDiskSha256 } : {}),
  };
}

/**
 * Forme exigée d'une empreinte à l'ÉCRITURE : un SHA-256 complet.
 *
 * Le lecteur (instantane-lien.js) est plus tolérant — de 12 à 64 caractères —
 * pour ne pas se lier à un choix de troncature. Ce qu'on ÉCRIT, en revanche, ne
 * doit avoir qu'une seule forme : une empreinte tronquée face à une complète
 * est un désaccord, donc un boot à froid, donc une panne silencieuse déguisée
 * en prudence.
 */
const SHA256_COMPLET = /^[0-9a-f]{64}$/;
