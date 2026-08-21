// Le lien entre un instantané et le disque qu'il a figé, verdict par verdict.
//
// Ce garde décide s'il faut RESTAURER ou booter à froid. Se tromper dans un
// sens coûte plusieurs minutes de boot ; se tromper dans l'autre donne une VM
// dont Puma ne répond jamais — 337 s de sondes muettes, sans un message. Les
// règles sont pures : elles se vérifient sans VM, sans navigateur, sans
// artefact.
//
// L'issue #4 a montré ce que le lien par DATE laissait passer : sur le chemin
// découplé, `builtAt` naît à la capture, donc `stateFor === builtAt` est vrai
// par construction. Deux captures successives sur un disque INCHANGÉ faisaient
// pourtant bouger `builtAt` de 10:20:09Z à 10:34:15Z : la valeur ne dit rien du
// contenu. D'où l'empreinte, lue sur les octets par deux acteurs distincts
// (ADR 0009).
import { test } from "node:test";
import assert from "node:assert/strict";

import { INSTANTANE, verifierInstantane } from "../public/shared/instantane-lien.js";

/** Deux empreintes complètes, de 64 caractères, comme la chaîne les écrit. */
const DISQUE_A = "a".repeat(64);
const DISQUE_B = "b".repeat(64);

// --- L'empreinte prime sur la date ---------------------------------------

test("deux empreintes identiques accordent l'instantané", () => {
  const verdict = verifierInstantane({
    state: "disks/zealot-split-state.bin.gz",
    appDiskSha256: DISQUE_A,
    stateForAppDiskSha256: DISQUE_A,
  });

  assert.equal(verdict.verdict, INSTANTANE.ACCORDE);
  assert.equal(verdict.raison, "");
});

test("un disque échangé entre la capture et la publication est REFUSÉ", () => {
  // Le trou exact de l'issue #4. La date ne le voyait pas : `stateFor` et
  // `builtAt` sont ici parfaitement d'accord, et pourtant les octets diffèrent.
  const verdict = verifierInstantane({
    state: "disks/zealot-split-state.bin.gz",
    stateFor: "2026-08-21T10:34:15Z",
    builtAt: "2026-08-21T10:34:15Z",
    appDiskSha256: DISQUE_B,
    stateForAppDiskSha256: DISQUE_A,
  });

  assert.equal(verdict.verdict, INSTANTANE.DESACCORDE);
  assert.match(verdict.raison, /octets/);
});

test("l'empreinte l'emporte sur une date en désaccord", () => {
  // L'inverse du test précédent : les octets s'accordent, les dates non. La
  // date est un renseignement de diagnostic, pas une identité — une
  // configuration régénérée sans recapture ne doit pas faire booter à froid une
  // sandbox dont le disque est le bon.
  const verdict = verifierInstantane({
    state: "disks/zealot-split-state.bin.gz",
    stateFor: "2026-08-21T10:20:09Z",
    builtAt: "2026-08-21T10:34:15Z",
    appDiskSha256: DISQUE_A,
    stateForAppDiskSha256: DISQUE_A,
  });

  assert.equal(verdict.verdict, INSTANTANE.ACCORDE);
});

test("deux empreintes de LONGUEURS différentes sont un désaccord, pas une tolérance", () => {
  // Le lecteur accepte de 12 à 64 caractères pour ne pas se lier à un choix de
  // troncature. Mais dès que DEUX empreintes sont là, la comparaison est
  // STRICTE : une valeur tronquée face à une valeur complète n'est pas une
  // correspondance partielle, c'est une chaîne de construction incohérente.
  const verdict = verifierInstantane({
    state: "disks/zealot-split-state.bin.gz",
    appDiskSha256: DISQUE_A,
    stateForAppDiskSha256: DISQUE_A.slice(0, 12),
  });

  assert.equal(verdict.verdict, INSTANTANE.DESACCORDE);
});

// --- Le repli sur la date, pour tout ce qui est déjà publié --------------

test("une seule empreinte présente n'est PAS un désaccord : on juge sur la date", () => {
  // Une configuration à cheval sur deux versions de la chaîne est saine. La
  // refuser sur cette seule asymétrie ferait booter à froid — plusieurs minutes
  // — une sandbox parfaitement valide. Arbitrage (a) de l'ADR 0009.
  const cotes = [{ appDiskSha256: DISQUE_A }, { stateForAppDiskSha256: DISQUE_A }];

  for (const cote of cotes) {
    const accorde = verifierInstantane({
      state: "disks/z.bin",
      stateFor: "2026-08-21T10:34:15Z",
      builtAt: "2026-08-21T10:34:15Z",
      ...cote,
    });
    assert.equal(accorde.verdict, INSTANTANE.ACCORDE, JSON.stringify(cote));

    const desaccorde = verifierInstantane({
      state: "disks/z.bin",
      stateFor: "2026-08-21T10:20:09Z",
      builtAt: "2026-08-21T10:34:15Z",
      ...cote,
    });
    assert.equal(desaccorde.verdict, INSTANTANE.DESACCORDE, JSON.stringify(cote));
  }
});

test("une empreinte MAL FORMÉE renvoie à la date, elle ne refuse pas", () => {
  // Deux valeurs invalides et différentes — un `null` et un `""` rescapés d'un
  // JSON.stringify malheureux — feraient refuser un instantané sain si on les
  // comparait. Elles ne sont pas des empreintes : elles ne comptent pas.
  const malFormees = [null, "", 42, "ZZZZ", "a".repeat(11), { sha: DISQUE_A }];

  for (const valeur of malFormees) {
    const verdict = verifierInstantane({
      state: "disks/z.bin",
      stateFor: "2026-08-21T10:34:15Z",
      builtAt: "2026-08-21T10:34:15Z",
      appDiskSha256: valeur,
      stateForAppDiskSha256: DISQUE_A,
    });
    assert.equal(verdict.verdict, INSTANTANE.ACCORDE, JSON.stringify(valeur));
  }
});

test("les sandboxes publiées avant l'empreinte gardent leurs verdicts", () => {
  // La non-régression qui compte : ces trois formes sont EN LIGNE aujourd'hui.
  const sansMarque = verifierInstantane({ state: "/disks/jiyufit-state.bin" });
  assert.equal(sansMarque.verdict, INSTANTANE.SANS_MARQUE);

  const parDate = verifierInstantane({
    state: "/disks/z-state.bin",
    stateFor: "2026-08-16T00:00:00Z",
    builtAt: "2026-08-16T00:00:00Z",
  });
  assert.equal(parDate.verdict, INSTANTANE.ACCORDE);

  const dateRompue = verifierInstantane({
    state: "/disks/z-state.bin",
    stateFor: "2026-08-16T00:00:00Z",
    builtAt: "2026-08-19T08:09:20Z",
  });
  assert.equal(dateRompue.verdict, INSTANTANE.DESACCORDE);
});

test("sans instantané référencé, il n'y a rien à vérifier", () => {
  for (const config of [{}, { state: "" }, { state: 12 }, null, undefined]) {
    const entree = /** @type {{ state?: unknown }} */ (config);
    assert.equal(verifierInstantane(entree).verdict, INSTANTANE.AUCUN, JSON.stringify(config));
  }
});

test("aucun instantané l'emporte sur une empreinte en désaccord", () => {
  // L'ordre compte : sans `state`, il n'y a pas d'état à écarter, donc pas de
  // désaccord à prononcer. Le message doit dire l'absence, pas le panachage.
  const verdict = verifierInstantane({
    appDiskSha256: DISQUE_A,
    stateForAppDiskSha256: DISQUE_B,
  });

  assert.equal(verdict.verdict, INSTANTANE.AUCUN);
});
