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
