// La MARGE D'EXÉCUTION du disque applicatif : ce que le guest doit pouvoir
// écrire une fois l'image construite.
//
// LE DÉFAUT. La garde comparait le contenu livré aux 512 Mo de la géométrie, et
// s'arrêtait là. Elle acceptait donc une image CONSTRUCTIBLE mais INCAPABLE DE
// FONCTIONNER : à 498 Mo de contenu la construction passait, et PostgreSQL
// échouait au démarrage sur « No space left on device » — chez le visiteur,
// sans que rien n'ait prévenu. Trouvé sur woofed-crm.
//
// CE QUE LA MESURE A MONTRÉ (Docker, i386, base 3.3-r3, PostgreSQL 15) :
//
//   ext2 de 512 Mo, mke2fs par défaut
//     blocs réservés à root ........ 6 553 blocs = 25 Mo
//     métadonnées (32 768 inodes) ... ~8 Mo
//     utilisable par un NON-ROOT .... 470 Mo, pas 512
//
//   PostgreSQL, datadir seul
//     après initdb ................. 38 Mo (dont 33 Mo de pg_wal)
//     après démarrage .............. 38 Mo — le démarrage seul n'écrit rien
//     après 20 000 lignes .......... 66 Mo
//     après 100 000 lignes ......... 102 Mo, dont 49 Mo de pg_wal
//
// Deux enseignements, dont un CONTRE-INTUITIF :
//
//  1. Les 25 Mo réservés sont inaccessibles à PostgreSQL, qui tourne sous
//     l'utilisateur `postgres`. Sur un disque JETABLE à usage unique, cette
//     réserve — prévue pour que root puisse réparer un disque plein — ne sert
//     rien ni personne. `mke2fs -m 0` la supprime.
//  2. Borner `max_wal_size` NE CHANGE RIEN : mesuré à 49 Mo de WAL avec et sans
//     borne. Les 80 Mo de `min_wal_size` sont un plancher de recyclage, pas une
//     préallocation. L'hypothèse était séduisante et fausse ; elle n'est pas
//     retenue.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const SCRIPT = readFileSync("tools/build-v86-image/build-app-disk.sh", "utf8");

test("le disque applicatif ne RÉSERVE rien à root", () => {
  // 25 Mo sur 512, soit 5 %, rendus à l'application pour le prix d'un drapeau.
  // Le disque est jeté avec l'onglet : personne ne viendra jamais le réparer.
  assert.match(
    SCRIPT,
    /mke2fs[^\n]*-m 0/,
    "mke2fs doit passer -m 0 : sinon 5 % du disque sont inaccessibles à postgres",
  );
});

test("la garde EXIGE une marge libre, pas seulement de tenir dans la géométrie", () => {
  // Le cœur du défaut : `contenu <= 512` acceptait un disque plein à 100 %.
  assert.match(
    SCRIPT,
    /MARGE_EXECUTION_MB=\d+/,
    "la marge doit être une constante NOMMÉE, pas un nombre noyé dans une condition",
  );
  // La marge doit être DANS LA CONDITION, pas seulement dans le message qui
  // suit. Une première version de cette épreuve cherchait le nom de la
  // constante n'importe où dans le script : retirer la marge du `if` la
  // laissait verte, puisque le mot restait dans le texte du refus. Une
  // assertion qui ne peut pas rougir ne garde rien.
  const condition = SCRIPT.split("\n").find(
    (ligne) => ligne.trimStart().startsWith("if [") && ligne.includes("APP_DISK_MB"),
  );
  assert.ok(condition, "la garde de volumétrie doit exister");
  assert.match(
    condition,
    /MARGE_EXECUTION_MB/,
    `la condition doit compter la marge, or elle vaut : ${condition?.trim()}`,
  );
});

test("la marge retenue couvre le besoin MESURÉ de PostgreSQL", () => {
  // 49 Mo de pg_wal sous charge soutenue, plus les journaux et tmp de Rails.
  // En dessous de 64 Mo, la mesure ne couvre plus le pire cas observé.
  const marge = Number(SCRIPT.match(/MARGE_EXECUTION_MB=(\d+)/)?.[1] ?? 0);
  assert.ok(
    marge >= 64,
    `marge de ${marge} Mo : le WAL seul a été mesuré à 49 Mo sous charge, il faut au moins 64`,
  );
  // Et pas absurde dans l'autre sens : au-delà, on refuserait des applications
  // que la mesure dit parfaitement viables — woofed-crm tient à 323 Mo.
  assert.ok(marge <= 128, `marge de ${marge} Mo : trop large, elle refuserait des cas viables`);
});

test("le refus NOMME la marge et ce qu'elle sert, pas seulement un dépassement", () => {
  // Un « ça ne tient pas » sans explication renvoie le mainteneur à deviner.
  // Le message doit dire QUE le disque doit rester écrivable À L'EXÉCUTION.
  const refus = SCRIPT.slice(SCRIPT.indexOf("MARGE_EXECUTION_MB"));
  assert.match(refus, /marge/i, "le message doit parler de la marge");
  assert.match(
    refus,
    /PostgreSQL|exécution|écrire/i,
    "et dire à quoi elle sert : le guest doit pouvoir écrire",
  );
  // Le diagnostic existant — les plus gros répertoires — reste le seul moyen
  // d'agir : il doit être servi aussi sur ce refus-ci.
  assert.match(refus, /plus_gros_repertoires/, "le refus doit montrer ce qui pèse");
});

test("la marge est contrôlée sur l'espace libre RÉEL de l'ext2, pas sur la géométrie", () => {
  // L'incohérence que cette épreuve ferme, et que la mesure a révélée :
  // `contenu + marge <= 512` raisonne sur la géométrie NOMINALE. Or un ext2 ne
  // met pas toute sa géométrie à disposition — les métadonnées de ses inodes en
  // prennent leur part.
  //
  // MESURÉ sur de vrais ext2 de 512 Mo peuplés de contenu aléatoire : le
  // nominal surestime de 9 à 10 Mo, de façon stable.
  //   contenu 241 Mo → nominal 271, réel 262
  //   contenu 324 Mo → nominal 188, réel 179
  //   contenu 401 Mo → nominal 111, réel 101
  //   contenu 449 Mo → nominal  63, réel  53  ← refusé ici, accepté par l'autre
  //
  // Le seul chiffre qui ne ment pas est celui que le système de fichiers
  // déclare une fois construit. Une constante estimée dérive dès que la
  // géométrie, la taille de bloc ou le nombre d'inodes changent.
  assert.match(
    SCRIPT,
    /dumpe2fs/,
    "l'espace libre doit être LU sur le système de fichiers construit",
  );
  const bloc = SCRIPT.slice(SCRIPT.indexOf("dumpe2fs"));
  assert.match(bloc, /Free blocks/i, "c'est le compte de blocs libres qui fait foi");
  assert.match(
    bloc,
    /MARGE_EXECUTION_MB/,
    "et il doit être comparé à la marge, sinon il n'est qu'affiché",
  );
});

test("le contrôle réel a lieu APRÈS la fabrication, et échoue avant publication", () => {
  // Une vérification qui n'arrêterait rien laisserait passer exactement ce
  // qu'elle prétend attraper.
  const apresMke2fs = SCRIPT.slice(SCRIPT.indexOf("mke2fs -q -t ext2"));
  assert.match(apresMke2fs, /dumpe2fs/, "le contrôle doit suivre la fabrication");
  const controle = apresMke2fs.slice(apresMke2fs.indexOf("dumpe2fs"));
  assert.match(controle.slice(0, 1200), /exit 1/, "et interrompre la construction");
});
