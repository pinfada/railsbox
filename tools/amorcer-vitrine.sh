#!/bin/sh
# Prépare un dépôt VITRINE public pour héberger la sandbox d'un dépôt privé.
#
# POURQUOI CE SCRIPT. Le workflow railsbox ne crée rien : il pousse. Son jeton
# d'Actions n'a de droits que sur le dépôt courant — il ne peut ni créer un
# dépôt tiers, ni y poser une clé, ni s'écrire un secret. Publier depuis un
# dépôt privé demande donc une poignée de gestes manuels, dont deux échouent
# EN SILENCE :
#
#   1. le dépôt vitrine doit être créé VIDE. Coché « Add a README », GitHub
#      garde `main` comme branche par défaut, et la page du dépôt restera
#      désespérément vide — c'est le README de la branche par défaut qu'elle
#      affiche, jamais celui de gh-pages ;
#   2. GitHub Pages doit pointer sur `gh-pages`. Configuré sur `main` (vide),
#      le site répond 404 sans le moindre message, nulle part.
#
# Ce script ferme les deux. Le second lui a longtemps échappé : l'API refuse
# d'activer Pages sur une branche qui n'existe pas, et `gh-pages` n'existe
# qu'au bout de la première construction — neuf minutes plus tard. Le script
# se contentait donc d'imprimer la commande d'activation, renvoyant
# l'utilisateur au geste manuel exactement là où il écrit que l'échec est
# silencieux. Il POUSSE maintenant lui-même une page « construction en cours »
# sur `gh-pages`, ce qui lui donne d'un coup les trois effets qui manquaient :
# la branche existe (Pages peut être activé dans la foulée), elle devient la
# branche par défaut (c'est la première poussée sur un dépôt vide), et le
# visiteur qui arrive pendant la construction lit une phrase au lieu d'un 404.
# La première construction écrase cette page.
#
# Ce script fait les gestes, dans l'ordre, et refuse plutôt que de deviner :
# ce qui manquera à la fin est contrôlé AVANT la moindre création. Découvrir
# qu'on n'est pas administrateur du dépôt source une fois le dépôt public créé
# ne laisse derrière soi qu'une coquille vide à supprimer à la main.
#
# Il tourne sur VOTRE machine avec VOTRE authentification `gh` : aucun jeton
# supplémentaire à créer, et la clé privée générée ne survit pas à l'exécution.
#
# Usage :
#   sh tools/amorcer-vitrine.sh <proprietaire/source> <proprietaire/vitrine>
#   sh tools/amorcer-vitrine.sh --verifier <proprietaire/source> <proprietaire/vitrine>
#
# Exemple :
#   sh tools/amorcer-vitrine.sh acme/mon-app acme/mon-app-demo
#
# `--verifier` ne modifie RIEN : il relit l'installation de bout en bout et
# nomme, pour chaque point manquant, le geste qui le répare. C'est ce qui
# manque quand un amorçage s'est arrêté au milieu, quand la vitrine a été
# renommée, ou quand une clé a été révoquée — trois pannes qui, sinon, ne se
# découvrent qu'après une construction ratée.
#
# L'amorçage est réexécutable : il reprend ce qui manque et laisse en place ce
# qui est déjà bon. En particulier, il ne touche JAMAIS à une branche
# `gh-pages` existante — ce serait effacer une démonstration en ligne.
#
# Prérequis : gh (authentifié : `gh auth login`), git, ssh-keygen.
set -eu

TAB="$(printf '\t')"
MANQUES=0

usage() {
  echo "Usage :"
  echo "  sh tools/amorcer-vitrine.sh <proprietaire/source> <proprietaire/vitrine>"
  echo "  sh tools/amorcer-vitrine.sh --verifier <proprietaire/source> <proprietaire/vitrine>"
  echo
  echo "Exemple : sh tools/amorcer-vitrine.sh acme/mon-app acme/mon-app-demo"
}

minuscules() {
  printf '%s' "$1" | tr '[:upper:]' '[:lower:]'
}

# « proprietaire/depot », et rien d'autre. Sans ce contrôle, un argument sans
# barre oblique se propage jusqu'à l'adresse publique : `${V%%/*}` et
# `${V##*/}` rendent alors le même mot, et le script annonce en confiance une
# adresse qui n'existera jamais.
depot_valide() {
  case "$1" in
    */*/* | /* | */) return 1 ;;
    */*) return 0 ;;
    *) return 1 ;;
  esac
}

# Interroge l'API et rend la valeur demandée, ou une chaîne vide. Un 404 est
# une RÉPONSE ici (« ce n'est pas configuré »), pas une panne : sans ce
# garde-fou, `set -e` ferait sortir le script au premier point manquant, soit
# précisément ce que le mode --verifier doit énumérer.
api() {
  gh api "$@" 2>/dev/null || true
}

# --- Options ----------------------------------------------------------------
MODE="amorcer"
while [ $# -gt 0 ]; do
  case "$1" in
    --verifier)
      MODE="verifier"
      shift
      ;;
    -h | --aide | --help)
      usage
      exit 0
      ;;
    --)
      shift
      break
      ;;
    -*)
      echo "Erreur : option inconnue « $1 »." >&2
      usage >&2
      exit 2
      ;;
    *) break ;;
  esac
done

SOURCE="${1:-}"
VITRINE="${2:-}"

if [ -z "$SOURCE" ] || [ -z "$VITRINE" ]; then
  usage >&2
  exit 2
fi

for depot in "$SOURCE" "$VITRINE"; do
  if ! depot_valide "$depot"; then
    echo "Erreur : « $depot » n'est pas de la forme proprietaire/depot." >&2
    exit 2
  fi
done

for outil in gh git ssh-keygen; do
  if ! command -v "$outil" >/dev/null 2>&1; then
    echo "Erreur : « $outil » est introuvable." >&2
    exit 1
  fi
done

if ! gh auth status >/dev/null 2>&1; then
  echo "Erreur : gh n'est pas authentifié. Lancez « gh auth login »." >&2
  exit 1
fi

# Le dépôt source doit exister et être accessible : sans cela, le secret ne
# pourra pas y être posé, et l'utilisateur découvrirait l'échec après avoir
# déjà créé un dépôt public.
if ! gh repo view "$SOURCE" >/dev/null 2>&1; then
  echo "Erreur : le dépôt source « $SOURCE » est introuvable ou inaccessible." >&2
  exit 1
fi

PROPRIETAIRE="$(minuscules "${VITRINE%%/*}")"
DEPOT_VITRINE="${VITRINE##*/}"
ADRESSE="https://$PROPRIETAIRE.github.io/$DEPOT_VITRINE/"
TITRE_CLE="railsbox publish (depuis $SOURCE)"

# Identifiant et lecture-seule de la clé de déploiement posée par ce script,
# s'il y en a une. Le titre est comparé EXACTEMENT : une même vitrine peut
# servir deux dépôts sources, et une correspondance approximative supprimerait
# la clé de l'autre.
cle_deploiement() {
  gh api "repos/$VITRINE/keys" --paginate \
    --jq '.[] | "\(.id)\t\(.read_only)\t\(.title)"' 2>/dev/null \
    | while IFS="$TAB" read -r id lecture_seule titre; do
      if [ "$titre" = "$TITRE_CLE" ]; then
        printf '%s %s\n' "$id" "$lecture_seule"
        break
      fi
    done
}

secret_present() {
  gh api "repos/$SOURCE/actions/secrets/PUBLISH_KEY" >/dev/null 2>&1
}

branche_pages() {
  api "repos/$VITRINE/pages" --jq '.source.branch // ""'
}

# La commande exacte d'activation, imprimée telle quelle quand il faut la
# passer à la main — une seule ligne, pour qu'elle se copie d'un geste. Le
# corps attendu par l'API est un objet IMBRIQUÉ : on l'envoie tel quel plutôt
# que de compter sur l'aplatissement de `-f 'source[branch]=…'`, qui dépend de
# la version de gh et qui, quand il n'a pas lieu, se solde par une erreur de
# validation incompréhensible.
commande_pages() {
  echo "printf '%s' '{\"source\":{\"branch\":\"gh-pages\",\"path\":\"/\"}}' | gh api -X POST repos/$VITRINE/pages --input -"
}

# --- Mode --verifier : on lit, on ne touche à rien ---------------------------
point_ok() {
  printf '  ✓ %s\n' "$1"
}

point_manque() {
  MANQUES=$((MANQUES + 1))
  printf '  ✗ %s\n' "$1"
  printf '    → %s\n' "$2"
}

verifier_adresse() {
  if ! command -v curl >/dev/null 2>&1; then
    printf "  · curl absent : %s n'a pas été appelée.\n" "$ADRESSE"
    return 0
  fi
  code="$(curl -sSL -o /dev/null -w '%{http_code}' --max-time 15 "$ADRESSE" 2>/dev/null || echo 000)"
  case "$code" in
    2*) point_ok "l'adresse répond : $ADRESSE" ;;
    000) point_manque "l'adresse $ADRESSE est injoignable depuis ce poste" \
      "vérifiez votre réseau, puis rouvrez $ADRESSE dans un navigateur" ;;
    *) point_manque "l'adresse $ADRESSE répond $code" \
      "Pages met une à deux minutes après activation ; passé ce délai, relancez ce script" ;;
  esac
}

verifier() {
  echo "railsbox — vérification d'une vitrine (aucune modification)"
  echo
  echo "  dépôt source  : $SOURCE"
  echo "  dépôt vitrine : $VITRINE"
  echo

  visibilite="$(api "repos/$VITRINE" --jq '.visibility // ""')"
  if [ -z "$visibilite" ]; then
    point_manque "la vitrine $VITRINE est introuvable ou inaccessible" \
      "sh tools/amorcer-vitrine.sh $SOURCE $VITRINE — ou corrigez le nom : un dépôt renommé n'emporte pas son adresse Pages"
    return
  fi
  point_ok "la vitrine existe"

  if [ "$visibilite" = "public" ]; then
    point_ok "elle est publique"
  else
    point_manque "elle est « $visibilite » : Pages sur un dépôt non public exige un plan payant" \
      "gh repo edit $VITRINE --visibility public"
  fi

  defaut="$(api "repos/$VITRINE" --jq '.default_branch // ""')"
  if [ "$defaut" = "gh-pages" ]; then
    point_ok "sa branche par défaut est gh-pages"
  else
    point_manque "sa branche par défaut est « ${defaut:-inconnue} » : la page du dépôt affichera le README de CETTE branche, jamais celui de la sandbox" \
      "gh api -X PATCH repos/$VITRINE -f default_branch=gh-pages"
  fi

  info_cle="$(cle_deploiement)"
  if [ -z "$info_cle" ] && [ "$(api "repos/$VITRINE" --jq '.permissions.admin')" != "true" ]; then
    # Les clés de déploiement ne sont lisibles que d'un administrateur. Crier
    # « aucune clé » à quelqu'un qui n'a simplement pas le droit de les voir
    # l'enverrait réamorcer une installation parfaitement saine.
    echo "  · clés de déploiement invisibles sans le rôle « Admin » sur $VITRINE : non vérifiées."
  elif [ -z "$info_cle" ]; then
    point_manque "aucune clé de déploiement « $TITRE_CLE » sur la vitrine" \
      "sh tools/amorcer-vitrine.sh $SOURCE $VITRINE — il regénère la paire et remplace le secret"
  elif [ "${info_cle##* }" = "true" ]; then
    point_manque "cette clé de déploiement est en LECTURE SEULE : la poussée sera refusée, après neuf minutes de construction" \
      "sh tools/amorcer-vitrine.sh $SOURCE $VITRINE — il la remplace par une clé en écriture"
  else
    point_ok "la clé de déploiement (écriture) est en place"
  fi

  if secret_present; then
    point_ok "le secret PUBLISH_KEY existe sur $SOURCE"
  else
    point_manque "le secret PUBLISH_KEY manque sur $SOURCE : le workflow s'arrêtera avant de publier" \
      "sh tools/amorcer-vitrine.sh $SOURCE $VITRINE"
  fi

  pages="$(branche_pages)"
  if [ "$pages" = "gh-pages" ]; then
    point_ok "GitHub Pages sert la branche gh-pages"
  elif [ -n "$pages" ]; then
    point_manque "GitHub Pages sert « $pages » et non gh-pages : l'adresse servira autre chose que la sandbox" \
      "Settings → Pages → Deploy from a branch → gh-pages / (root)"
  else
    point_manque "GitHub Pages n'est pas activé : l'adresse répond 404, sans message nulle part" \
      "$(commande_pages)"
  fi

  verifier_adresse
}

if [ "$MODE" = "verifier" ]; then
  verifier
  echo
  if [ "$MANQUES" -gt 0 ]; then
    echo "$MANQUES point(s) à reprendre — voir les flèches ci-dessus."
    exit 1
  fi
  echo "Tout est en place. Une chose ne se vérifie pas à distance : que le"
  echo "secret PUBLISH_KEY soit bien la clé PRIVÉE de la clé de déploiement"
  echo "ci-dessus. Seule une publication le dira."
  exit 0
fi

# --- Contrôles de droits, AVANT toute création ------------------------------
VITRINE_EXISTE="non"
if gh repo view "$VITRINE" >/dev/null 2>&1; then
  VITRINE_EXISTE="oui"
fi

# Écrire un secret d'Actions exige l'ADMINISTRATION du dépôt : la lecture ou
# l'écriture du code ne suffisent pas. Contrôlé ici, le refus coûte une
# phrase ; contrôlé par gh à l'étape 6, il coûte un dépôt public orphelin.
controler_source() {
  admin="$(api "repos/$SOURCE" --jq '.permissions.admin')"
  case "$admin" in
    true) ;;
    false)
      echo "Erreur : vous n'êtes pas administrateur de $SOURCE." >&2
      echo "Le secret PUBLISH_KEY ne pourra pas y être écrit — Settings →" >&2
      echo "Secrets and variables est réservé aux administrateurs. Demandez le" >&2
      echo "rôle « Admin » sur ce dépôt, ou faites lancer ce script par" >&2
      echo "quelqu'un qui l'a." >&2
      exit 1
      ;;
    *)
      # Champ absent : jeton restreint, instance Enterprise, API en erreur. On
      # ne SAIT pas — et refuser sur une ignorance bloquerait un amorçage
      # parfaitement valide. On le dit, et l'écriture du secret tranchera.
      echo "  (droits sur $SOURCE illisibles — on continue, l'étape du secret tranchera)"
      ;;
  esac
}

# Créer un dépôt PUBLIC chez un propriétaire donné n'est pas toujours permis :
# chez un autre compte personnel, c'est simplement impossible ; dans une
# organisation, la politique peut l'interdire aux membres. `gh repo create`
# le dit — mais seulement après avoir généré la paire de clés, et avec un
# message d'API brut.
controler_proprietaire() {
  moi="$(api user --jq '.login')"
  if [ -z "$moi" ] || [ "$(minuscules "$moi")" = "$PROPRIETAIRE" ]; then
    return 0
  fi

  type_proprietaire="$(api "users/$PROPRIETAIRE" --jq '.type // ""')"
  if [ "$type_proprietaire" = "User" ]; then
    echo "Erreur : « $PROPRIETAIRE » est un compte personnel qui n'est pas le" >&2
    echo "vôtre ($moi). Personne ne peut créer un dépôt chez un autre compte" >&2
    echo "personnel. Visez votre propre compte ou une organisation dont vous" >&2
    echo "êtes membre : sh tools/amorcer-vitrine.sh $SOURCE $moi/$DEPOT_VITRINE" >&2
    exit 1
  fi

  if [ "$type_proprietaire" != "Organization" ]; then
    echo "  (propriétaire « $PROPRIETAIRE » illisible — on continue, la création tranchera)"
    return 0
  fi

  role="$(api "user/memberships/orgs/$PROPRIETAIRE" --jq '.role // ""')"
  if [ -z "$role" ]; then
    echo "Erreur : vous n'apparaissez pas membre de l'organisation" >&2
    echo "« $PROPRIETAIRE » — la création du dépôt y sera refusée." >&2
    echo "Demandez à en être membre, ou visez votre compte :" >&2
    echo "  sh tools/amorcer-vitrine.sh $SOURCE $moi/$DEPOT_VITRINE" >&2
    exit 1
  fi

  politique="$(api "orgs/$PROPRIETAIRE" --jq '.members_can_create_public_repositories')"
  if [ "$politique" = "false" ] && [ "$role" != "admin" ]; then
    echo "Erreur : l'organisation « $PROPRIETAIRE » interdit à ses membres de" >&2
    echo "créer des dépôts publics, et vous n'y êtes pas administrateur." >&2
    echo "Faites créer $VITRINE (public, VIDE, sans README) par un" >&2
    echo "administrateur, puis relancez ce script : il reprendra à la suite." >&2
    exit 1
  fi
}

# La clé de déploiement et l'activation de Pages passent toutes deux par des
# routes réservées aux administrateurs du dépôt visé.
controler_vitrine_existante() {
  admin="$(api "repos/$VITRINE" --jq '.permissions.admin')"
  if [ "$admin" = "false" ]; then
    echo "Erreur : vous n'êtes pas administrateur de $VITRINE." >&2
    echo "Ni la clé de déploiement ni l'activation de Pages ne vous seront" >&2
    echo "permises sur ce dépôt. Demandez le rôle « Admin », ou visez une" >&2
    echo "vitrine que vous administrez." >&2
    exit 1
  fi

  # Une vitrine privée fait un amorçage entièrement vert et une adresse en 404 :
  # GitHub Pages n'est servi depuis un dépôt privé qu'avec un plan payant.
  visibilite="$(api "repos/$VITRINE" --jq '.visibility // ""')"
  if [ -n "$visibilite" ] && [ "$visibilite" != "public" ]; then
    echo "Erreur : $VITRINE est « $visibilite ». La démonstration n'y serait" >&2
    echo "servie qu'avec un plan payant, et l'adresse répondrait 404 sans le" >&2
    echo "moindre message :" >&2
    echo "  gh repo edit $VITRINE --visibility public" >&2
    exit 1
  fi
}

echo "railsbox — amorçage d'une vitrine publique"
echo
echo "  dépôt source  : $SOURCE"
echo "  dépôt vitrine : $VITRINE  (PUBLIC — la démonstration y sera publiée)"
echo

controler_source
if [ "$VITRINE_EXISTE" = "oui" ]; then
  controler_vitrine_existante
else
  controler_proprietaire
fi

echo "Ce script va :"
echo "  1. créer $VITRINE, public et VIDE, s'il n'existe pas"
echo "  2. y pousser une page « construction en cours » sur gh-pages,"
echo "     qui devient ainsi la branche par défaut"
echo "  3. activer GitHub Pages sur cette branche"
echo "  4. générer une paire de clés dédiée à cette publication"
echo "  5. poser la clé publique en clé de déploiement ÉCRITURE sur la vitrine"
echo "  6. poser la clé privée en secret PUBLISH_KEY sur $SOURCE"
echo "  7. effacer la clé privée de votre disque"
echo
echo "Le code source de $SOURCE n'est PAS copié : seule la démonstration"
echo "construite sera publiée, et elle contient l'application (voir SECURITY.md)."
echo
printf "Continuer ? [o/N] "
read -r reponse
case "$reponse" in
  o | O | oui | Oui) ;;
  *)
    echo "Annulé."
    exit 0
    ;;
esac

# --- 1. Le dépôt vitrine, créé VIDE -----------------------------------------
CREE="non"
if [ "$VITRINE_EXISTE" = "oui" ]; then
  echo "→ $VITRINE existe déjà."
else
  echo "→ Création de $VITRINE (public, vide)…"
  # Ni README, ni licence, ni .gitignore : la première branche poussée devient
  # la branche par défaut, et ce sera gh-pages (piège n°1 de l'en-tête).
  gh repo create "$VITRINE" --public \
    --description "Démonstration jouable — sandbox railsbox (le code source reste privé)"
  CREE="oui"
fi

# --- Le répertoire de travail, effacé quoi qu'il arrive ---------------------
TRAVAIL="$(mktemp -d)"
# Quoi qu'il arrive ensuite — succès, erreur, interruption — la clé privée
# disparaît. C'est le seul secret que ce script manipule.
trap 'rm -rf "$TRAVAIL"' EXIT INT TERM
CLE="$TRAVAIL/publish_key"

# --- 2. La page d'attente, sur gh-pages -------------------------------------
# Elle ne promet rien qu'elle ne tienne, et ne nomme PAS le dépôt source :
# celui-ci est privé, et cette page-ci est publique.
ecrire_page_attente() {
  cat > "$1" <<'HTML'
<!doctype html>
<html lang="fr">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Démonstration en construction</title>
    <style>
      body {
        margin: 0;
        min-height: 100vh;
        display: grid;
        place-items: center;
        padding: 2rem;
        font: 16px/1.65 system-ui, -apple-system, "Segoe UI", sans-serif;
        color: #1b1c1e;
        background: #fbfbfa;
      }
      main {
        max-width: 34rem;
      }
      h1 {
        margin: 0 0 1rem;
        font-size: 1.35rem;
        letter-spacing: -0.01em;
      }
      p {
        margin: 0 0 0.9rem;
      }
      .discret {
        color: #6b6b6b;
        font-size: 0.92rem;
      }
      @media (prefers-color-scheme: dark) {
        body {
          color: #e8e8e6;
          background: #17181a;
        }
        .discret {
          color: #9a9a97;
        }
      }
    </style>
  </head>
  <body>
    <main>
      <h1>Démonstration en construction</h1>
      <p>
        Cette adresse hébergera une démonstration jouable dans le navigateur,
        construite par railsbox.
      </p>
      <p>
        La première construction prend une dizaine de minutes. Cette page sera
        remplacée par la démonstration dès qu'elle aura abouti : rechargez plus
        tard.
      </p>
      <p class="discret">
        Si cette page est encore là dans plusieurs heures, la construction a
        échoué — la trace est dans l'onglet Actions du dépôt source.
      </p>
    </main>
  </body>
</html>
HTML
}

# Appelée en condition (« if pousser_page_attente »), donc `set -e` y est
# NEUTRALISÉ de bout en bout : sans le `|| return 1` de chaque étape, un
# `git init` en échec laisserait le commit puis la poussée s'enchaîner sur un
# répertoire vide, et le script conclurait à une réussite.
pousser_page_attente() {
  racine="$TRAVAIL/vitrine"
  mkdir -p "$racine" || return 1
  ecrire_page_attente "$racine/index.html" || return 1

  git init -q "$racine" || return 1
  # `core.autocrlf=true` est le réglage par défaut des postes Windows : il
  # convertirait cette page à la volée et ferait aboyer git à chaque `add`.
  # Le dépôt de destination est servi par un serveur web, pas par un éditeur.
  git -C "$racine" config core.autocrlf false || return 1
  # `git init -b gh-pages` demande git ≥ 2.28 ; la référence symbolique fait
  # la même chose partout, y compris sur les git des distributions LTS.
  git -C "$racine" symbolic-ref HEAD refs/heads/gh-pages || return 1
  git -C "$racine" add index.html || return 1
  # Identité passée en ligne : sur un poste neuf, `user.email` n'est pas
  # configuré et le commit échouerait sur un message qui n'a rien à voir avec
  # la vitrine. Le message de commit ne nomme pas le dépôt source : il sera
  # public.
  git -C "$racine" \
    -c user.email=actions@github.com -c user.name=railsbox \
    commit -q -m "page d'attente — sandbox railsbox" || return 1

  # L'authentification est celle de `gh`, pas la clé de déploiement qui vient
  # d'être créée : cette clé-là est faite pour le runner, et rien n'oblige ce
  # poste à savoir s'en servir. Le `credential.helper=` vide d'abord la liste
  # héritée — sous Windows, le gestionnaire d'identifiants ouvrirait une
  # fenêtre et le script attendrait indéfiniment un clic.
  git -C "$racine" \
    -c credential.helper= \
    -c credential.helper='!gh auth git-credential' \
    push -q "https://github.com/$VITRINE.git" gh-pages || return 1
}

GH_PAGES_PRETE="non"
ATTENTE_POUSSEE="non"
if gh api "repos/$VITRINE/branches/gh-pages" >/dev/null 2>&1; then
  # On n'y touche PAS. Y pousser la page d'attente écraserait une démonstration
  # en ligne : neuf minutes de construction remplacées par « en construction ».
  echo "→ La branche gh-pages existe déjà : laissée intacte."
  GH_PAGES_PRETE="oui"
else
  echo "→ Page « construction en cours » sur gh-pages…"
  if pousser_page_attente; then
    GH_PAGES_PRETE="oui"
    ATTENTE_POUSSEE="oui"
  else
    echo "  ATTENTION : la poussée a échoué. GitHub Pages ne peut pas être" >&2
    echo "  activé sur une branche absente ; il faudra le faire après la" >&2
    echo "  première construction :" >&2
    commande_pages >&2
  fi
fi

if [ "$GH_PAGES_PRETE" = "oui" ]; then
  DEFAUT="$(api "repos/$VITRINE" --jq '.default_branch // ""')"
  if [ "$DEFAUT" != "gh-pages" ]; then
    if [ "$CREE" = "oui" ]; then
      # Le dépôt vient d'être créé par ce script et ne contient que notre page :
      # la branche par défaut nous appartient, on la remet droite sans demander.
      gh api -X PATCH "repos/$VITRINE" -f default_branch=gh-pages >/dev/null 2>&1 || true
    else
      # Dépôt préexistant : changer la branche par défaut de quelqu'un d'autre
      # n'est pas à nous. On le DIT.
      echo "  ATTENTION : la branche par défaut est « $DEFAUT ». La page du dépôt"
      echo "  affichera le README de cette branche-là, jamais celui de la sandbox :"
      echo "    gh api -X PATCH repos/$VITRINE -f default_branch=gh-pages"
    fi
  fi
fi

# --- 3. GitHub Pages, tout de suite -----------------------------------------
PAGES_OK="non"
activer_pages() {
  courante="$(branche_pages)"
  if [ "$courante" = "gh-pages" ]; then
    echo "→ GitHub Pages sert déjà gh-pages."
    return 0
  fi
  if [ -n "$courante" ]; then
    # Pages déjà activé sur une autre branche : POST rendrait un 409. La mise à
    # jour, elle, est un PUT — c'est ce qui rend ce script réexécutable.
    echo "→ GitHub Pages sert « $courante » : bascule sur gh-pages…"
    methode="PUT"
  else
    echo "→ Activation de GitHub Pages sur gh-pages…"
    methode="POST"
  fi
  printf '%s' '{"source":{"branch":"gh-pages","path":"/"}}' \
    | gh api -X "$methode" "repos/$VITRINE/pages" --input - >/dev/null 2>&1
}

if [ "$GH_PAGES_PRETE" = "oui" ]; then
  if activer_pages; then
    PAGES_OK="oui"
  else
    # L'amorçage a déjà réussi tout le reste : on ne le fait pas échouer pour
    # un réglage qui se rattrape en deux clics. Mais on ne le passe pas non
    # plus sous silence — c'est le piège n°2 de l'en-tête.
    echo "  ATTENTION : GitHub Pages n'a pas pu être activé automatiquement."
    echo "  Causes habituelles : droits d'administration insuffisants sur la"
    echo "  vitrine, ou une organisation qui restreint GitHub Pages. À faire à"
    echo "  la main — le reste de l'amorçage, lui, a réussi :"
    echo "    Settings → Pages → Deploy from a branch → gh-pages / (root)"
    echo "  ou :"
    commande_pages | sed 's/^/    /'
  fi
fi

# --- 4. La paire de clés ----------------------------------------------------
echo "→ Génération d'une paire de clés dédiée…"
ssh-keygen -t ed25519 -N "" -C "railsbox publish → $VITRINE" -f "$CLE" -q

# --- 5. La clé publique, en écriture sur la vitrine --------------------------
echo "→ Clé de déploiement (écriture) sur $VITRINE…"
INFO_CLE="$(cle_deploiement)"
if [ -n "$INFO_CLE" ]; then
  # Une clé homonyme, c'est une exécution précédente de ce script. Sa clé
  # PRIVÉE n'existe plus nulle part — ce script l'efface toujours — donc elle
  # n'ouvre plus rien à personne, pas même à nous : on la retire au lieu de
  # l'empiler. Une reprise faisait sinon tomber le script, et chaque reprise
  # réussie aurait laissé derrière elle une clé en ÉCRITURE de plus, autorisée
  # pour toujours et que plus personne n'aurait su rattacher à quoi que ce soit.
  echo "  Une clé « $TITRE_CLE » existe déjà : elle est remplacée."
  gh api -X DELETE "repos/$VITRINE/keys/${INFO_CLE%% *}" >/dev/null 2>&1 \
    || echo "  (suppression refusée — retirez-la à la main : gh repo deploy-key list --repo $VITRINE)"
fi
if ! gh repo deploy-key add "$CLE.pub" --repo "$VITRINE" --allow-write \
  --title "$TITRE_CLE" >/dev/null; then
  echo "Erreur : la clé de déploiement n'a pas pu être posée sur $VITRINE." >&2
  echo "Vérifiez vos droits d'administration et, en organisation, la politique" >&2
  echo "sur les clés de déploiement : gh repo deploy-key list --repo $VITRINE" >&2
  exit 1
fi

# --- 6. La clé privée, en secret sur le dépôt source ------------------------
echo "→ Secret PUBLISH_KEY sur $SOURCE…"
gh secret set PUBLISH_KEY --repo "$SOURCE" < "$CLE"

# --- 7. Ce qu'il reste à faire, et que nous ne pouvons pas faire ------------
echo
echo "Amorçage terminé. La clé privée a été effacée de ce poste."
echo
echo "Il reste UNE chose à faire, dans $SOURCE — ajoutez"
echo ".github/workflows/sandbox.yml :"
echo
cat <<YAML
name: Sandbox railsbox

on:
  workflow_dispatch: # ← vous lancez la construction quand vous le décidez
  # Pour construire à chaque poussée, décommentez ces trois lignes. Sur un
  # dépôt privé, chaque construction dure ~9 minutes FACTURÉES sur votre quota
  # d'Actions — sur un dépôt public, elles sont gratuites.
  # push:
  #   branches: [main] # ← votre branche par défaut

jobs:
  sandbox:
    uses: pinfada/railsbox/.github/workflows/construire-sandbox.yml@main
    permissions:
      contents: write
    with:
      target-repo: $VITRINE
    secrets:
      publish-key: \${{ secrets.PUBLISH_KEY }}
YAML
echo
echo "Si vous décommentez « push », vérifiez la ligne « branches: » : un filtre"
echo "qui ne nomme pas votre branche par défaut ne déclenche jamais rien, et"
echo "GitHub ne le signale pas."
echo
if [ "$PAGES_OK" = "oui" ] && [ "$ATTENTE_POUSSEE" = "oui" ]; then
  echo "GitHub Pages est activé sur gh-pages : l'adresse affiche déjà la page"
  echo "« construction en cours », que la première construction remplacera."
elif [ "$PAGES_OK" = "oui" ]; then
  # La branche existait : ce qu'elle sert n'est pas notre page d'attente, et
  # affirmer le contraire enverrait chercher une page qui n'y est pas.
  echo "GitHub Pages est activé sur gh-pages."
fi
echo "La démonstration sera servie sur :"
echo "  $ADRESSE"
echo
echo "Pour relire l'installation à tout moment, sans rien modifier :"
echo "  sh tools/amorcer-vitrine.sh --verifier $SOURCE $VITRINE"
