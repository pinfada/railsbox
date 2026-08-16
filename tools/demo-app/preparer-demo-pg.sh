#!/usr/bin/env bash
# Matérialise la variante PostgreSQL de l'application de démonstration.
#
# demo-pg/ n'est pas une seconde application : c'est une SURCOUCHE de demo/,
# réduite aux quatre fichiers qui changent (Gemfile, Gemfile.lock,
# config/database.yml, db/seeds.rb). Dupliquer les cinquante fichiers d'un
# `rails new` pour en modifier quatre ferait diverger les deux démos au premier
# correctif — et gonflerait le dépôt sans rien prouver de plus.
#
#   bash tools/demo-app/preparer-demo-pg.sh [dossier-cible]
#
# Sans argument, la cible est un dossier temporaire dont le chemin est écrit sur
# la sortie standard (le reste part sur la sortie d'erreur), de sorte que :
#
#   APP="$(bash tools/demo-app/preparer-demo-pg.sh)"
#   bash tools/build-v86-image/build-app-disk.sh "$APP" --name demo-pg
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
SOURCE_DIR="$SCRIPT_DIR/demo"
OVERLAY_DIR="$SCRIPT_DIR/demo-pg"

[ -d "$SOURCE_DIR" ] || { echo "Application de base introuvable : $SOURCE_DIR" >&2; exit 1; }
[ -d "$OVERLAY_DIR" ] || { echo "Surcouche introuvable : $OVERLAY_DIR" >&2; exit 1; }

TARGET="${1:-}"
[ -n "$TARGET" ] || TARGET="$(mktemp -d -t railsbox-demo-pg-XXXXXX)"
mkdir -p "$TARGET"

# Copie du contenu (et non du dossier) : la cible peut préexister.
cp -a "$SOURCE_DIR"/. "$TARGET"/
cp -a "$OVERLAY_DIR"/. "$TARGET"/

# Le fichier sqlite3 versionné dans la démo n'a plus lieu d'être : le laisser
# donnerait un disque applicatif portant DEUX bases, dont une morte.
rm -f "$TARGET"/storage/*.sqlite3*

echo "→ Variante PostgreSQL prête dans $TARGET" >&2
echo "  Gemfile, Gemfile.lock, config/database.yml et db/seeds.rb viennent de la surcouche." >&2
echo "$TARGET"
