#!/usr/bin/env bash
# Matérialise la variante dart-sass de l'application de démonstration.
#
# demo-dartsass/ n'est pas une troisième application : c'est une SURCOUCHE de
# demo/, réduite aux fichiers qui changent (Gemfile, Gemfile.lock, le point
# d'entrée dart-sass, la feuille Propshaft réduite, le layout, la vue index du
# scaffold et les seeds). Même convention que demo-pg/ : dupliquer les
# cinquante fichiers d'un `rails new` pour en modifier huit ferait diverger les
# démos au premier correctif.
#
# Ce que cette variante met à l'épreuve, et que demo-tailwind ne couvre pas
# tout à fait : dartsass-rails tire sass-embedded, qui ne publie AUCUN
# exécutable i386 et n'offre pas de repli « ruby » utilisable dans le guest.
# Là où Tailwind valide une gem à variante « ruby », celle-ci valide le cas
# strict — le SCSS est compilé sur l'hôte amd64, le guest ne reçoit qu'une
# feuille CSS ordinaire.
#
#   bash tools/demo-app/preparer-demo-dartsass.sh [dossier-cible]
#
# Sans argument, la cible est un dossier temporaire dont le chemin est écrit sur
# la sortie standard (le reste part sur la sortie d'erreur), de sorte que :
#
#   APP="$(bash tools/demo-app/preparer-demo-dartsass.sh)"
#   bash tools/build-v86-image/build-app-disk.sh "$APP" --name demo-dartsass
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
SOURCE_DIR="$SCRIPT_DIR/demo"
OVERLAY_DIR="$SCRIPT_DIR/demo-dartsass"

[ -d "$SOURCE_DIR" ] || { echo "Application de base introuvable : $SOURCE_DIR" >&2; exit 1; }
[ -d "$OVERLAY_DIR" ] || { echo "Surcouche introuvable : $OVERLAY_DIR" >&2; exit 1; }

TARGET="${1:-}"
[ -n "$TARGET" ] || TARGET="$(mktemp -d -t railsbox-demo-dartsass-XXXXXX)"
mkdir -p "$TARGET"

# Copie du contenu (et non du dossier) : la cible peut préexister.
cp -a "$SOURCE_DIR"/. "$TARGET"/
cp -a "$OVERLAY_DIR"/. "$TARGET"/

# Le fichier sqlite3 versionné dans la démo n'a plus lieu d'être : la base est
# recréée et seedée pendant la construction du disque applicatif.
rm -f "$TARGET"/storage/*.sqlite3*

# Répertoire de sortie du binaire tailwindcss. Il est créé par le générateur de
# la gem dans une application ordinaire ; ici la surcouche ne versionne pas de
# dossier vide, et son absence ferait échouer la précompilation.
mkdir -p "$TARGET/app/assets/builds"

echo "→ Variante dart-sass prête dans $TARGET" >&2
echo "  Gemfile, Gemfile.lock, app/assets/stylesheets/dartsass.scss, l'initialiseur," >&2
echo "  le layout, la vue index du scaffold et db/seeds.rb viennent de la surcouche." >&2
echo "$TARGET"
