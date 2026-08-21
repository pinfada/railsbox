// Le lien entre un instantané mémoire et le disque qu'il a figé.
//
// Module partagé parce que les DEUX côtés en ont besoin : la chaîne de
// construction, qui pose la marque à la capture, et la coquille, qui décide au
// démarrage s'il faut restaurer ou booter à froid.

/** Verdicts possibles sur le lien entre un instantané et son disque. */
export const INSTANTANE = Object.freeze({
  ACCORDE: "accorde",
  AUCUN: "aucun",
  SANS_MARQUE: "sans-marque",
  DESACCORDE: "desaccorde",
});

/**
 * L'instantané est-il celui de CETTE version du disque ?
 *
 * LE VRAI DANGER N'EST PAS L'ÉCRASEMENT, C'EST LE PANACHAGE. Un
 * `zealot.ext2` reconstruit et un `zealot-state.bin` d'avant portent les mêmes
 * noms : rien, dans les noms, ne dit qu'ils ne vont plus ensemble. Restaurer un
 * état mémoire sur un système de fichiers qu'il ne connaît pas donne une VM
 * dont Puma ne répond jamais — le défaut exact que l'ADR 0007 décrit, et qui
 * avait coûté 337 s de sondes muettes sans un seul message.
 *
 * La capture inscrit donc `stateFor` : le `builtAt` de la configuration qu'elle
 * a figée.
 *
 * CE QUE CE VERDICT GARANTIT, EXACTEMENT : une COHÉRENCE DE CONSTRUCTION
 * DÉCLARÉE, et non une identité de CONTENU. Les deux valeurs comparées sont
 * produites par la configuration ; aucune n'est lue sur les octets du disque.
 *
 * Il attrape une configuration réécrite, ou servie périmée par un cache
 * d'hébergeur, face à un instantané qui n'est plus le sien — le cas décrit dans
 * main.js — ainsi qu'une reconstruction MONOLITHIQUE, `build.sh` réécrivant la
 * configuration à chaque passage, donc `builtAt`, alors que `stateFor` garde
 * l'ancienne valeur.
 *
 * Il N'ATTRAPE PAS un disque applicatif reconstruit sans que la configuration
 * soit régénérée. Sur le chemin découplé, `builtAt` naît à la CAPTURE —
 * buildSplitConfig le date lui-même — de sorte que les deux valeurs sont
 * égales par construction : un `<nom>-app.ext2` remplacé sous une configuration
 * inchangée passerait sans un mot. La chaîne publique régénère disque, capture
 * et configuration dans une seule exécution et n'atteint donc pas ce trou ; une
 * manipulation manuelle hors séquence, si.
 *
 * La liaison par EMPREINTE DU CONTENU du disque — la seule qui fermerait ce
 * trou — demande son propre ADR et une migration rétrocompatible : elle fait
 * l'objet d'une issue distincte, et n'est PAS ce que ce module fait.
 *
 * TROIS VERDICTS PLUTÔT QU'UN BOOLÉEN, et c'est délibéré. Un instantané SANS
 * marque n'est pas un instantané fautif : c'est celui de toutes les sandboxes
 * publiées avant que cette marque n'existe. Le refuser ferait booter à froid —
 * plusieurs minutes — des démonstrations qui fonctionnent parfaitement.
 * L'appelant décide donc : la coquille tolère l'absence de marque et ne refuse
 * que le DÉSACCORD, une chaîne de construction peut être plus stricte.
 * @param {{ state?: unknown, stateFor?: unknown, builtAt?: unknown }} config
 * @returns {{ verdict: string, raison: string }}
 */
export function verifierInstantane(config) {
  if (typeof config?.state !== "string" || config.state === "") {
    return { verdict: INSTANTANE.AUCUN, raison: "aucun instantané référencé" };
  }
  if (typeof config.stateFor !== "string" || config.stateFor === "") {
    return {
      verdict: INSTANTANE.SANS_MARQUE,
      raison:
        "instantané sans marque d'origine (`stateFor`) : capturé avant que la " +
        "marque n'existe. Restauré tel quel ; une recapture le lierait à sa " +
        "construction.",
    };
  }
  if (config.stateFor !== config.builtAt) {
    return {
      verdict: INSTANTANE.DESACCORDE,
      raison:
        `instantané capturé sur la construction du ${config.stateFor}, alors que le ` +
        `disque est celui du ${config.builtAt} : le restaurer poserait un état ` +
        "mémoire sur un système de fichiers qu'il ne connaît pas.",
    };
  }
  return { verdict: INSTANTANE.ACCORDE, raison: "" };
}
