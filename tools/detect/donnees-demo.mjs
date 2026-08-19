// Une sandbox qui démarre parfaitement et ne montre RIEN.
//
// Le cas fondateur, mesuré en réel : construction verte, VM qui boote,
// application qui répond — et la page d'accueil affichait « nothing here yet ».
// L'application n'avait pas de seeds, la base était donc vierge, et rien dans
// la chaîne ne l'avait signalé. Tous les contrôles existants regardent ce qui
// EMPÊCHE la sandbox de fonctionner ; aucun ne regardait ce qu'elle MONTRE.
//
// L'échec est commercial, pas technique : une démonstration qui ne démontre
// rien est inutilisable alors que tous les voyants sont au vert, et le
// mainteneur ne le découvre qu'en ouvrant sa propre démo — après publication.
// C'est exactement le profil de panne que la détection existe pour tuer :
// signalée AVANT la construction, elle coûte une ligne de railsbox.yml ;
// découverte après, elle coûte une reconstruction complète et une démo morte
// pendant ce temps.
//
// AVERTISSEMENT et jamais refus : une vitrine, une page de documentation, un
// générateur de PDF peuvent légitimement n'avoir aucune donnée à amorcer.
// Bloquer interdirait des sandboxes parfaitement valides pour une heuristique
// qui, par construction, ne sait pas ce que l'application est censée montrer.
//
// Ce module ne décide PAS de la commande de seed : c'est `buildArgs`
// (tools/build-v86-image/manifest-to-args.mjs) qui la retient, en préférant
// `seed.command` de railsbox.yml au repli `bundle exec rails db:seed` déduit de
// la présence de db/seeds.rb. Le contrôle ci-dessous se contente de rejouer les
// mêmes deux entrées pour dire si ce qui sera exécuté insérera quoi que ce soit.
import { SEVERITY, createFinding } from "./findings.mjs";
import { stripRubyComments } from "./migrations.mjs";

/** @typedef {import("./findings.mjs").Finding} Finding */

/**
 * États possibles du `db/seeds.rb` d'une application.
 *
 * `VIDE` et `ABSENT` sont distingués parce qu'ils ne se corrigent pas
 * pareil — et surtout parce qu'ils ne se comportent pas pareil à la
 * construction : sans fichier, aucune commande n'est retenue ; avec un fichier
 * qui ne contient que des commentaires, `bundle exec rails db:seed` s'exécute,
 * réussit, et n'insère rien. Le second cas est le plus traître : le journal de
 * build montre une étape de seed VERTE.
 */
export const ETAT_SEEDS = Object.freeze({
  ABSENT: "absent",
  VIDE: "vide",
  UTILE: "utile",
});

/**
 * Commentaire Ruby en bloc. `stripRubyComments` ne traite que le `#` de fin de
 * ligne ; un ancien jeu de démonstration mis de côté entre `=begin` et `=end`
 * est du commentaire, et le compter comme du code serait un faux négatif —
 * précisément celui qui laisse passer une base vide.
 */
const BLOC_COMMENTAIRE = /^=begin\b[\s\S]*?^=end[ \t]*$/gm;

/**
 * Dit si un `db/seeds.rb` amorce quoi que ce soit.
 *
 * Le critère est volontairement GROSSIER : « reste-t-il une instruction une
 * fois les commentaires et les lignes blanches ôtés ? ». Aucune tentative de
 * comprendre ce que le fichier insère — un `require_relative "seeds/demo"` ne
 * crée aucun enregistrement à lui seul, mais il en charge, et le compter comme
 * vide serait un faux positif sur un découpage parfaitement courant. Le seul
 * faux négatif restant est un fichier plein d'instructions qui n'écrivent rien,
 * cas qu'aucune analyse statique honnête ne distingue.
 * @param {string|null|undefined} source contenu du fichier, `null` s'il est absent
 * @returns {string} une valeur de {@link ETAT_SEEDS}
 */
export function etatFichierSeeds(source) {
  if (typeof source !== "string") return ETAT_SEEDS.ABSENT;
  const code = stripRubyComments(source.replace(BLOC_COMMENTAIRE, ""));
  return code.trim() === "" ? ETAT_SEEDS.VIDE : ETAT_SEEDS.UTILE;
}

/**
 * Diagnostic AVERTISSEMENT quand rien n'amorcera la base de la sandbox.
 *
 * Deux conditions, et une seule règle qui les résume : le contrôle se tait dès
 * qu'une commande de seed NOMMÉE existe, sinon il regarde le seul autre
 * amorçage possible — le `db/seeds.rb` que le repli exécuterait.
 *
 * · Une commande déclarée dans railsbox.yml fait taire le contrôle, même sans
 *   `db/seeds.rb` : elle vise souvent un fichier séparé
 *   (`bin/rails runner db/seeds/demo.rb`), et rien ici ne peut ni ne doit
 *   juger ce qu'elle insère. Le mainteneur a répondu à la question.
 * · Sinon, seul `db/seeds.rb` peut amorcer, via le repli
 *   `bundle exec rails db:seed`. Absent ou dépourvu d'instruction, la base
 *   restera vierge et le visiteur ouvrira une application vide.
 *
 * Une commande blanche est traitée comme absente : le manifeste la rejette
 * déjà (`invalid-manifest-value`), mais le contrôle ne doit pas dépendre de ce
 * qu'un autre module valide en amont.
 * @param {{seedsFile?: string, seedCommand?: string|null}} [entree] état du
 *   `db/seeds.rb` détecté et commande déclarée dans railsbox.yml
 * @returns {readonly Finding[]} zéro ou un diagnostic, gelé
 */
export function sandboxSansDonneesFindings({ seedsFile, seedCommand } = {}) {
  const declaree = typeof seedCommand === "string" ? seedCommand.trim() : "";
  if (declaree !== "") return Object.freeze([]);
  if (seedsFile === ETAT_SEEDS.UTILE) return Object.freeze([]);

  const constat =
    seedsFile === ETAT_SEEDS.VIDE
      ? "db/seeds.rb n'amorce rien (il est vide ou ne contient que des commentaires) et " +
        "railsbox.yml ne déclare aucune commande de seed"
      : "l'application n'a pas de db/seeds.rb et railsbox.yml ne déclare aucune commande de seed";
  return Object.freeze([
    createFinding(
      SEVERITY.WARNING,
      "sandbox-sans-donnees",
      `${constat} : la base de la sandbox restera VIDE. Le visiteur ouvrira une application ` +
        "sans aucune donnée — listes vides, pages « nothing here yet », formulaires sans " +
        "contexte. La construction sera pourtant verte de bout en bout : rien d'autre ne " +
        "signalera qu'une démonstration ne démontre rien.",
      { seedsFile: seedsFile ?? ETAT_SEEDS.ABSENT },
    ),
  ]);
}
