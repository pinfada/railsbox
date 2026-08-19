#!/bin/sh
# Prépare un dépôt VITRINE public pour héberger la sandbox d'un dépôt privé.
#
# POURQUOI CE SCRIPT. Le workflow railsbox ne crée rien : il pousse. Son jeton
# d'Actions n'a de droits que sur le dépôt courant — il ne peut ni créer un
# dépôt tiers, ni y poser une clé, ni s'écrire un secret. Publier depuis un
# dépôt privé demande donc six gestes manuels, dont deux échouent EN SILENCE :
#
#   1. le dépôt vitrine doit être créé VIDE. Coché « Add a README », GitHub
#      garde `main` comme branche par défaut, et la page du dépôt restera
#      désespérément vide — c'est le README de la branche par défaut qu'elle
#      affiche, jamais celui de gh-pages ;
#   2. GitHub Pages doit pointer sur `gh-pages`. Configuré sur `main` (vide),
#      le site répond 404 sans le moindre message, nulle part.
#
# Ce script fait les six gestes, dans l'ordre, et refuse plutôt que de deviner.
# Il tourne sur VOTRE machine avec VOTRE authentification `gh` : aucun jeton
# supplémentaire à créer, et la clé privée générée ne survit pas à l'exécution.
#
# Usage :
#   sh tools/amorcer-vitrine.sh <proprietaire/depot-source> <proprietaire/depot-vitrine>
#
# Exemple :
#   sh tools/amorcer-vitrine.sh acme/mon-app acme/mon-app-demo
#
# Prérequis : gh (authentifié : `gh auth login`), ssh-keygen.
set -eu

SOURCE="${1:-}"
VITRINE="${2:-}"

if [ -z "$SOURCE" ] || [ -z "$VITRINE" ]; then
  echo "Usage : sh tools/amorcer-vitrine.sh <proprietaire/depot-source> <proprietaire/depot-vitrine>" >&2
  echo "Exemple : sh tools/amorcer-vitrine.sh acme/mon-app acme/mon-app-demo" >&2
  exit 2
fi

for outil in gh ssh-keygen; do
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

echo "railsbox — amorçage d'une vitrine publique"
echo
echo "  dépôt source  : $SOURCE"
echo "  dépôt vitrine : $VITRINE  (PUBLIC — la démonstration y sera publiée)"
echo
echo "Ce script va :"
echo "  1. créer $VITRINE, public et VIDE, s'il n'existe pas"
echo "  2. générer une paire de clés dédiée à cette publication"
echo "  3. poser la clé publique en clé de déploiement ÉCRITURE sur la vitrine"
echo "  4. poser la clé privée en secret PUBLISH_KEY sur $SOURCE"
echo "  5. effacer la clé privée de votre disque"
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
if gh repo view "$VITRINE" >/dev/null 2>&1; then
  echo "→ $VITRINE existe déjà."
  # Un dépôt déjà peuplé garde `main` par défaut : la page du dépôt n'affichera
  # jamais le README de la sandbox. On le DIT plutôt que de le corriger de
  # force — changer la branche par défaut d'un dépôt existant n'est pas à nous.
  if gh api "repos/$VITRINE/commits?per_page=1" --jq 'length' 2>/dev/null | grep -q '^[1-9]'; then
    echo "  ATTENTION : il contient déjà des commits. Après la première"
    echo "  publication, vérifiez que sa branche par défaut est « gh-pages »,"
    echo "  sinon la page du dépôt restera vide aux yeux des visiteurs :"
    echo "    gh api -X PATCH repos/$VITRINE -f default_branch=gh-pages"
  fi
else
  echo "→ Création de $VITRINE (public, vide)…"
  # Ni README, ni licence, ni .gitignore : la première branche poussée devient
  # la branche par défaut, et ce sera gh-pages (piège n°1 de l'en-tête).
  gh repo create "$VITRINE" --public \
    --description "Démonstration jouable — sandbox railsbox (le code source reste privé)"
fi

# --- 2. La paire de clés, dans un répertoire temporaire ----------------------
TRAVAIL="$(mktemp -d)"
# Quoi qu'il arrive ensuite — succès, erreur, interruption — la clé privée
# disparaît. C'est le seul secret que ce script manipule.
trap 'rm -rf "$TRAVAIL"' EXIT INT TERM
CLE="$TRAVAIL/publish_key"

echo "→ Génération d'une paire de clés dédiée…"
ssh-keygen -t ed25519 -N "" -C "railsbox publish → $VITRINE" -f "$CLE" -q

# --- 3. La clé publique, en écriture sur la vitrine --------------------------
echo "→ Clé de déploiement (écriture) sur $VITRINE…"
if ! gh repo deploy-key add "$CLE.pub" --repo "$VITRINE" --allow-write \
  --title "railsbox publish (depuis $SOURCE)" >/dev/null; then
  echo "Erreur : la clé de déploiement n'a pas pu être posée sur $VITRINE." >&2
  echo "Une clé du même nom existe peut-être déjà : gh repo deploy-key list --repo $VITRINE" >&2
  exit 1
fi

# --- 4. La clé privée, en secret sur le dépôt source ------------------------
echo "→ Secret PUBLISH_KEY sur $SOURCE…"
gh secret set PUBLISH_KEY --repo "$SOURCE" < "$CLE"

# --- 5. Ce qu'il reste à faire, et que nous ne pouvons pas faire ------------
PROPRIETAIRE="$(printf '%s' "${VITRINE%%/*}" | tr '[:upper:]' '[:lower:]')"
DEPOT_VITRINE="${VITRINE##*/}"
ADRESSE="https://$PROPRIETAIRE.github.io/$DEPOT_VITRINE/"

echo
echo "Amorçage terminé. La clé privée a été effacée de ce poste."
echo
echo "Il reste UNE chose à faire, dans $SOURCE — ajoutez"
echo ".github/workflows/sandbox.yml :"
echo
cat <<YAML
name: Sandbox railsbox

on:
  push:
    branches: [main] # ← votre branche par défaut
  workflow_dispatch:

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
echo "Vérifiez la ligne « branches: » : un filtre qui ne nomme pas votre branche"
echo "par défaut ne déclenche jamais rien, et GitHub ne le signale pas."
echo
echo "Après la première construction, activez GitHub Pages sur la vitrine :"
echo "  gh api -X POST repos/$VITRINE/pages -f 'source[branch]=gh-pages' -f 'source[path]=/'"
echo "(ou Settings → Pages → Deploy from a branch → gh-pages / (root))"
echo
echo "La démonstration sera servie sur :"
echo "  $ADRESSE"
