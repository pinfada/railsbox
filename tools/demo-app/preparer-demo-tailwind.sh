#!/usr/bin/env bash
# Matérialise la variante Tailwind de l'application de démonstration.
#
# demo-tailwind/ n'est pas une troisième application : c'est une SURCOUCHE de
# demo/, réduite aux fichiers qui changent (Gemfile, Gemfile.lock, le point
# d'entrée Tailwind, la feuille Propshaft réduite, le layout, la vue index du
# scaffold et les seeds). Même convention que demo-pg/ : dupliquer les
# cinquante fichiers d'un `rails new` pour en modifier sept ferait diverger les
# démos au premier correctif.
#
# Ce que cette variante met à l'épreuve, et que les deux autres ne touchent
# pas : la voie « assets sur étage amd64 ». tailwindcss-rails tire
# tailwindcss-ruby, dont AUCUNE variante binaire n'existe en i386 — le CSS est
# donc compilé sur l'hôte de construction, et le guest reçoit le seul résultat.
#
#   bash tools/demo-app/preparer-demo-tailwind.sh [dossier-cible]
#
# Sans argument, la cible est un dossier temporaire dont le chemin est écrit sur
# la sortie standard (le reste part sur la sortie d'erreur), de sorte que :
#
#   APP="$(bash tools/demo-app/preparer-demo-tailwind.sh)"
#   bash tools/build-v86-image/build-app-disk.sh "$APP" --name demo-tailwind
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
SOURCE_DIR="$SCRIPT_DIR/demo"
OVERLAY_DIR="$SCRIPT_DIR/demo-tailwind"

[ -d "$SOURCE_DIR" ] || { echo "Application de base introuvable : $SOURCE_DIR" >&2; exit 1; }
[ -d "$OVERLAY_DIR" ] || { echo "Surcouche introuvable : $OVERLAY_DIR" >&2; exit 1; }

TARGET="${1:-}"
[ -n "$TARGET" ] || TARGET="$(mktemp -d -t railsbox-demo-tailwind-XXXXXX)"
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

echo "→ Variante Tailwind prête dans $TARGET" >&2
echo "  Gemfile, Gemfile.lock, app/assets/tailwind/, la feuille Propshaft, le layout," >&2
echo "  la vue index du scaffold et db/seeds.rb viennent de la surcouche." >&2
echo "$TARGET"
