// La VENTILATION du disque applicatif : d'où viennent les mégaoctets.
//
// POURQUOI ELLE EXISTE. La garde de volumétrie (d03cc23) dit COMBIEN il reste
// de place ; elle ne dit pas ce qui la consomme. Or la question ouverte est
// celle du PÉRIMÈTRE PRODUIT : 512 Mo suffisent-ils, faut-il une géométrie
// supérieure ou configurable ? On ne peut pas y répondre avec un seul chiffre
// global, ni avec un seul échantillon.
//
// Le diagnostic existant — `plus_gros_repertoires` — nomme les plus gros
// répertoires, ce qui aide un mainteneur à ALLÉGER son application. Il ne
// permet pas de COMPARER deux applications : ses lignes dépendent de l'arbre
// de chacune. La ventilation, elle, range toujours dans les mêmes cases, ce
// qui la rend comparable d'une application à l'autre.
//
// Cinq postes, choisis parce qu'ils ont des CAUSES différentes :
//   gems ............ dépend du Gemfile de l'application
//   node_modules .... dépend de la chaîne front, et n'est exporté que par
//                     exception (asset-output.mjs)
//   assets .......... produit de la précompilation
//   base pré-semée .. coût STRUCTUREL de railsbox : ~38 Mo de datadir minimum,
//                     mesuré, avant même la moindre donnée applicative
//   surcouche ....... paquets système que la base mutualisée ne porte pas
//                     (ADR 0006)
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const SCRIPT = readFileSync("tools/build-v86-image/build-app-disk.sh", "utf8");

test("la ventilation range dans des cases COMPARABLES d'une application à l'autre", () => {
  const bloc = SCRIPT.slice(SCRIPT.indexOf("ventiler_contenu"));
  assert.ok(bloc.length > 0, "la fonction de ventilation doit exister");

  // Les chemins sont ceux que railsbox IMPOSE : ils ne dépendent d'aucune
  // application, c'est ce qui rend la comparaison possible.
  for (const poste of ["vendor/bundle", "node_modules", "public/assets", "var/pg", "opt/systeme"]) {
    assert.ok(bloc.includes(poste), `le poste « ${poste} » doit être ventilé`);
  }
});

test("le reste n'est pas escamoté", () => {
  // Une ventilation dont les postes ne totalisent pas le contenu laisserait
  // croire que tout est expliqué. Le reliquat doit apparaître, sous son nom.
  const bloc = SCRIPT.slice(SCRIPT.indexOf("ventiler_contenu"));
  assert.match(bloc, /reste|autre/i, "le reliquat doit être nommé et affiché");
});

test("la ventilation est affichée à CHAQUE construction, pas seulement au refus", () => {
  // Sur un refus, elle arrive trop tard pour décider de la géométrie : c'est
  // sur les constructions qui RÉUSSISSENT que se lit la tendance.
  const appel = SCRIPT.slice(SCRIPT.indexOf('echo "  Contenu /app'));
  const jusquAuRefus = appel.slice(0, appel.indexOf("if ["));
  assert.match(
    jusquAuRefus,
    /ventiler_contenu/,
    "la ventilation doit être émise avant la garde, donc dans tous les cas",
  );
});
