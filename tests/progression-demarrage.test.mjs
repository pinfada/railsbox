// Ce que la coquille dit au visiteur pendant qu'elle démarre.
//
// Le module existe à cause d'une mesure (npm run test:bridage) : sur un
// processeur bridé 8×, la coquille annonçait « application disponible », posait
// l'iframe, et se taisait pendant les 12 à 15 s que la VM mettait à rendre la
// première page — une rangée de badges verts au-dessus d'un cadre vide, au bout
// d'un démarrage qui atteint déjà 54 s. Ces tests gardent les deux propriétés
// qui rendent cet affichage utile : l'étape est toujours nommée, et le message
// change de ton quand l'attente sort de ce qui a été mesuré.
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  ETAPES_DEMARRAGE,
  REFERENCE_MS,
  SEUIL_LENTEUR_MS,
  SEUIL_TRES_LENT_MS,
  creerIndicateurDemarrage,
  etatProgression,
} from "../public/shared/progression-demarrage.js";

test("chaque étape est numérotée sur le total et porte un titre", () => {
  const etat = etatProgression({ cle: "vm", ecouleMs: 12_000 });
  assert.equal(etat.position, 3);
  assert.equal(etat.total, ETAPES_DEMARRAGE.length);
  assert.equal(etat.secondes, 12);
  assert.match(etat.texte, /^Étape 3\/5 · .+ · 12 s$/);
});

test("le rendu de la première page est une étape à part entière", () => {
  // C'est LA découverte de la mesure sous bridage : l'attente la plus longue
  // sur un appareil lent commence après que tous les badges soient au vert.
  const cles = ETAPES_DEMARRAGE.map((etape) => etape.cle);
  assert.ok(cles.includes("premierePage"));
  assert.equal(cles.at(-1), "premierePage");
});

test("sous le seuil, aucun commentaire : un démarrage normal n'a rien à justifier", () => {
  const etat = etatProgression({ cle: "application", ecouleMs: SEUIL_LENTEUR_MS - 1 });
  assert.equal(etat.lenteur, "normale");
  assert.ok(!etat.texte.includes("—"));
});

test("passé le seuil, le message situe l'attente et dit que rien n'est bloqué", () => {
  const etat = etatProgression({ cle: "application", ecouleMs: SEUIL_LENTEUR_MS });
  assert.equal(etat.lenteur, "lente");
  assert.match(etat.texte, /25–54 s mesurées/);
  assert.match(etat.texte, /rien n'est bloqué/);
});

test("le seuil de lenteur reste au-dessus du pire démarrage mesuré", () => {
  // 54 s : application visible sur la sandbox publiée, processeur bridé 8×.
  // Un seuil plus bas ferait s'excuser la coquille d'un démarrage normal.
  assert.ok(
    SEUIL_LENTEUR_MS > REFERENCE_MS.lent,
    "le seuil doit laisser passer le pire démarrage mesuré sans commentaire",
  );
  assert.ok(SEUIL_TRES_LENT_MS > SEUIL_LENTEUR_MS, "les deux paliers doivent rester ordonnés");
});

test("au second palier, le message change de ton sans annoncer d'échec", () => {
  const etat = etatProgression({ cle: "application", ecouleMs: SEUIL_TRES_LENT_MS });
  assert.equal(etat.lenteur, "tres-lente");
  assert.match(etat.texte, /n'abandonne pas/);
  // Un démarrage lent n'est pas un démarrage raté : le mot « échec » ici
  // ferait fuir un visiteur dont l'application allait s'afficher.
  assert.ok(!/échec|erreur/i.test(etat.texte));
});

test("une étape inconnue est refusée bruyamment plutôt qu'affichée vide", () => {
  assert.throws(() => etatProgression({ cle: "inconnue", ecouleMs: 0 }), /Étape de démarrage/);
});

test("l'indicateur rafraîchit le compteur même quand l'étape ne change pas", () => {
  // Le cas qui compte : pendant le rendu de la première page, rien ne se passe
  // dans la coquille pendant des dizaines de secondes. Sans rafraîchissement,
  // l'affichage resterait figé sur « 0 s » et ressemblerait à un blocage.
  let horloge = 1_000;
  const rendus = [];
  /** @type {(() => void) | null} */
  let battement = null;
  const indicateur = creerIndicateurDemarrage({
    afficher: (etat) => rendus.push(etat.texte),
    maintenant: () => horloge,
    setTimer: (fn) => {
      battement = fn;
      return 42;
    },
    clearTimer: () => {
      battement = null;
    },
  });

  indicateur.etape("premierePage");
  horloge += 3_000;
  battement?.();
  horloge += 2_000;
  battement?.();

  assert.equal(rendus.length, 3);
  assert.match(rendus[0], /· 0 s$/);
  assert.match(rendus[1], /· 3 s$/);
  assert.match(rendus[2], /· 5 s$/);
});

test("la fin arrête le rafraîchissement et prévient l'appelant", () => {
  let horloge = 0;
  let arrete = false;
  let termine = false;
  /** @type {(() => void) | null} */
  let battement = null;
  const indicateur = creerIndicateurDemarrage({
    afficher: () => {},
    terminer: () => {
      termine = true;
    },
    maintenant: () => horloge,
    setTimer: (fn) => {
      battement = fn;
      return 7;
    },
    clearTimer: () => {
      arrete = true;
      battement = null;
    },
  });

  indicateur.etape("vm");
  horloge = 4_000;
  assert.equal(indicateur.ecouleMs(), 4_000);
  indicateur.fin();
  assert.equal(arrete, true);
  assert.equal(termine, true);
  // Un battement retardataire ne doit plus rien afficher.
  battement?.();
});

test("une seule minuterie, quel que soit le nombre de changements d'étape", () => {
  let minuteries = 0;
  const indicateur = creerIndicateurDemarrage({
    afficher: () => {},
    maintenant: () => 0,
    setTimer: () => {
      minuteries += 1;
      return minuteries;
    },
    clearTimer: () => {},
  });
  indicateur.etape("serviceWorker");
  indicateur.etape("isolation");
  indicateur.etape("vm");
  assert.equal(minuteries, 1);
});
