// Les objets de compilation des gems natives ne partent pas sur le disque.
//
// LE DISQUE APPLICATIF EST FIGÉ À 512 Mo (ADR 0002) et il est peuplé par un
// `docker export` de l'image, donc par TOUT ce qui vit sous /app —
// `BUNDLE_PATH=/app/vendor/bundle` compris. Une gem native compilée depuis les
// sources y laisse ses fichiers intermédiaires, dont rien n'a besoin une fois
// le `.so` produit.
//
// Mesuré le 21/08/2026 sur woofed-crm, deuxième application tierce candidate :
//
//   gems installées ........... 1 895 Mo
//   dont grpc-1.65.2 .......... 1 677 Mo
//   dont objets .o/.a ......... 1 604 Mo   (1 472 fichiers)
//   grpc sans eux .............    55 Mo
//
// Autrement dit : 1,6 Go de l'arbre livré ne sert à rien, et l'application ne
// tient pas dans 512 Mo à cause de cela seul. Le message d'échec de
// build-app-disk.sh affirmait pourtant que « les gems ne s'allègent qu'en
// retirant des dépendances du Gemfile » — vrai pour le code des gems, faux
// pour leurs résidus de compilation.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

// LES DEUX CHEMINS, et c'est le point. Trois des huit correctifs qu'a coûtés la
// première application tierce venaient d'une divergence entre le chemin
// monolithique et le chemin découplé — celui que la chaîne PUBLIQUE emploie.
const DOCKERFILES = [
  "tools/build-v86-image/Dockerfile",
  "tools/build-v86-image/base/app.Dockerfile",
];

test("les deux chemins retirent les objets de compilation des gems", () => {
  for (const chemin of DOCKERFILES) {
    const source = readFileSync(chemin, "utf8");
    assert.match(
      source,
      /-name ['"]\*\.o['"]/,
      `${chemin} doit retirer les fichiers .o laissés par la compilation`,
    );
    assert.match(
      source,
      /-name ['"]\*\.a['"]/,
      `${chemin} doit retirer les archives .a laissées par la compilation`,
    );
  }
});

test("le nettoyage ne touche JAMAIS aux bibliothèques chargées par Ruby", () => {
  // Un `.so` supprimé, c'est une gem native qui ne se charge plus — et l'erreur
  // survient au boot de la VM, chez le visiteur, pas à la construction.
  for (const chemin of DOCKERFILES) {
    const source = readFileSync(chemin, "utf8");
    const lignesDeNettoyage = source
      .split("\n")
      .filter((ligne) => /-name ['"]\*\.[oa]['"]/.test(ligne));

    assert.ok(lignesDeNettoyage.length > 0, `${chemin} : aucune ligne de nettoyage trouvée`);
    for (const ligne of lignesDeNettoyage) {
      assert.doesNotMatch(
        ligne,
        /\*\.so/,
        `${chemin} : le nettoyage ne doit pas viser les .so — ${ligne.trim()}`,
      );
    }
  }
});

test("le nettoyage suit le `bundle install` qu'il nettoie", () => {
  // Dans une couche ULTÉRIEURE, la suppression n'allégerait pas l'image Docker.
  // Elle allégerait tout de même l'ext2 — peuplé par `docker export`, donc par
  // le système de fichiers aplati — mais autant ne pas payer les deux fois.
  for (const chemin of DOCKERFILES) {
    const source = readFileSync(chemin, "utf8");
    const install = source.lastIndexOf("bundle install");
    const nettoyage = source.search(/-name ['"]\*\.o['"]/);

    assert.ok(nettoyage > 0, `${chemin} : nettoyage absent`);
    assert.ok(
      nettoyage > source.indexOf("bundle install"),
      `${chemin} : le nettoyage précède le premier bundle install`,
    );
    assert.ok(install > 0, `${chemin} : bundle install introuvable`);
  }
});

test("la surcouche système n'emporte ni archives statiques ni en-têtes", () => {
  // Même classe de défaut que les résidus `.o` du bundle, sur l'AUTRE arbre :
  // les paquets `-dev` sont installés pour que les gems natives compilent, et
  // la relocalisation emportait leurs `.a` et leurs `/usr/include`.
  //
  // Mesuré le 21/08/2026 sur woofed-crm : 84 Mo d'archives et 21 Mo d'en-têtes
  // sur 230 Mo de surcouche. 105 Mo qui ne sont jamais chargés dans la VM, et
  // qui faisaient déborder la géométrie fixe de 512 Mo.
  const source = readFileSync("tools/build-v86-image/base/app.Dockerfile", "utf8");

  assert.match(source, /\*\.a\|\*\.la\) continue/, "les archives statiques doivent être écartées");
  assert.match(source, /\/usr\/include\/\*\) continue/, "les en-têtes doivent être écartés");
});
