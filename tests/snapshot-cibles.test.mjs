// Quels fichiers l'instantané lit, et lequel il écrase.
//
// L'outil ne savait fabriquer que l'instantané de jiyufit : noyau, initrd,
// disque et nom d'état y étaient écrits en dur. Une seconde application restait
// donc sans instantané, donc avec un boot à froid de plusieurs minutes — ce
// qu'aucune démonstration ne supporte.
//
// La généralisation touche à ce qui EFFACE des fichiers de plusieurs centaines
// de mégaoctets, capturés en une dizaine de minutes. D'où ces épreuves, qui ne
// bootent aucune VM : les règles sont pures, elles se vérifient comme telles.
import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";

import {
  CONFIG_PAR_DEFAUT,
  cheminArtefact,
  ecrasementAutorise,
  INSTANTANE,
  scellerInstantane,
  verifierInstantane,
  nomConfiguration,
  nomInstantane,
} from "../tools/build-v86-image/snapshot-cibles.mjs";

const DISQUES = join("/srv", "railsbox", "public", "disks");

// --- L'appel historique ne bouge pas -------------------------------------

test("le scellement rend un instantané ACCORDÉ, quelle que soit la capture", () => {
  // Les DEUX captures passent par ici : monolithique et par delta. La seconde
  // écrivait sa configuration à la main et OUBLIAIT `stateFor` — or c'est elle
  // que la chaîne publique emploie, donc le garde n'existait nulle part où il
  // servait. Une seule fonction, un seul test.
  const formes = [
    { name: "zealot", builtAt: "2026-08-21T10:20:09Z", disk: "/disks/base.ext2" },
    {
      name: "zealot",
      builtAt: "2026-08-21T10:20:09Z",
      disk: "disks/base.ext2",
      appDisk: "disks/z-app.ext2",
    },
  ];

  for (const config of formes) {
    const scellee = scellerInstantane(config, "/disks/zealot-state.bin");

    assert.equal(scellee.stateFor, config.builtAt);
    assert.equal(scellee.state, "/disks/zealot-state.bin");
    assert.equal(verifierInstantane(scellee).verdict, "accorde", JSON.stringify(config));
  }
});

test("sceller SANS builtAt échoue, au lieu de produire une sandbox sans garde", () => {
  // Le piège évité : un `stateFor` undefined que JSON.stringify ôte. La
  // configuration partirait sans marque, `verifierInstantane` la classerait
  // SANS_MARQUE — tolérée — et le défaut serait invisible.
  for (const config of [{}, { builtAt: "" }, { builtAt: 12 }, null]) {
    const entree = /** @type {{ builtAt?: unknown }} */ (config);
    assert.throws(
      () => scellerInstantane(entree, "/disks/z-state.bin"),
      TypeError,
      JSON.stringify(config),
    );
  }
  assert.throws(() => scellerInstantane({ builtAt: "2026-01-01T00:00:00Z" }, ""), TypeError);

  // Ce que l'échec évite, dit explicitement.
  assert.equal(verifierInstantane({ state: "/disks/z.bin" }).verdict, "sans-marque");
});
test("sans argument, la configuration reste celle de la page d'accueil", () => {
  assert.equal(nomConfiguration(undefined), CONFIG_PAR_DEFAUT);
  assert.equal(nomConfiguration(""), CONFIG_PAR_DEFAUT);
});

test("l'appel historique produit EXACTEMENT le même nom d'instantané qu'avant", () => {
  // `v86-config.json` ne nomme pas une application : c'est la configuration de
  // la page d'accueil, qui désigne l'image courante. Son instantané suit donc
  // le disque — et pour jiyufit, cela redonne `jiyufit-state.bin`, le nom que
  // la démonstration publiée référence déjà.
  const disque = join(DISQUES, "jiyufit.ext2");
  assert.equal(nomInstantane(CONFIG_PAR_DEFAUT, disque), "jiyufit-state.bin");
});

// --- Le nom d'état suit la CONFIGURATION, pas le disque ------------------

test("une configuration nommée donne un instantané qui porte son nom", () => {
  assert.equal(
    nomInstantane("zealot-config.json", join(DISQUES, "zealot.ext2")),
    "zealot-state.bin",
  );
  assert.equal(nomInstantane("demo-pg-config.json", join(DISQUES, "x.ext2")), "demo-pg-state.bin");
});

test("deux configurations qui désignent le même nom de disque ne se marchent pas dessus", () => {
  // Rien n'interdit à deux images de s'appuyer sur des disques de même nom de
  // base — un `app.ext2` construit dans deux dossiers, par exemple. Dériver
  // l'instantané du DISQUE les faisait collisionner en silence ; le dériver de
  // la configuration ne le peut pas, un nom de fichier étant unique.
  const memeDisque = join(DISQUES, "app.ext2");
  const premier = nomInstantane("zealot-config.json", memeDisque);
  const second = nomInstantane("planner-config.json", memeDisque);

  assert.notEqual(premier, second);
  assert.equal(premier, "zealot-state.bin");
  assert.equal(second, "planner-state.bin");
});

// --- Ce que l'argument ne peut pas être ----------------------------------

test("un chemin, un séparateur ou un `..` sont refusés, pas assainis", () => {
  const refuses = [
    "/etc/passwd.json",
    "C:\\\\Windows\\\\config.json",
    "../v86-config.json",
    "../../public/disks/v86-config.json",
    "sous/dossier/config.json",
    "sous\\\\dossier\\\\config.json",
    ".hidden.json",
    "-config.json",
    "config.json.bak",
    "config",
    "config.yaml",
  ];

  for (const nom of refuses) {
    assert.throws(() => nomConfiguration(nom), /invalide/, `refusé : ${nom}`);
  }
});

test("les noms légitimes passent", () => {
  for (const nom of ["v86-config.json", "zealot-config.json", "demo_pg-config.json", "a1.json"]) {
    assert.equal(nomConfiguration(nom), nom);
  }
});

// --- Les artefacts viennent de la configuration lue ----------------------

test("noyau, initrd et disque sont tirés de la configuration, dans le dossier des artefacts", () => {
  const config = {
    kernel: "/disks/zealot-vmlinuz",
    initrd: "disks/zealot-initrd",
    disk: "/disks/zealot.ext2",
  };

  assert.equal(cheminArtefact(config.kernel, "kernel", DISQUES), join(DISQUES, "zealot-vmlinuz"));
  // Les deux écritures coexistent : la publication émet du relatif (Pages de
  // projet), une construction locale de l'absolu.
  assert.equal(cheminArtefact(config.initrd, "initrd", DISQUES), join(DISQUES, "zealot-initrd"));
  assert.equal(cheminArtefact(config.disk, "disk", DISQUES), join(DISQUES, "zealot.ext2"));
});

test("une configuration qui viserait hors du dossier des artefacts est refusée", () => {
  // La configuration d'une application TIERCE ne doit pas pouvoir désigner un
  // fichier ailleurs : elle sert à ouvrir des fichiers, pas à en choisir.
  for (const valeur of ["../../etc/passwd", "/etc/shadow", "disks/../../secret", "sub/dir/x"]) {
    assert.throws(() => cheminArtefact(valeur, "disk", DISQUES), /hors du dossier/);
  }
  for (const manquant of [undefined, null, "", 42]) {
    assert.throws(() => cheminArtefact(manquant, "disk", DISQUES), /sans entrée/);
  }
});

// --- Ne jamais effacer l'instantané d'une autre image --------------------

test("une première capture écrit sans discuter", () => {
  const verdict = ecrasementAutorise({ existe: false, nomInstantane: "zealot-state.bin" });
  assert.equal(verdict.autorise, true);
});

test("une RE-capture de la même image est autorisée", () => {
  // La capture précédente a inscrit l'instantané dans la configuration : c'est
  // ce lien qui prouve qu'il nous appartient.
  const verdict = ecrasementAutorise({
    existe: true,
    etatDeclare: "/disks/zealot-state.bin",
    nomInstantane: "zealot-state.bin",
  });
  assert.equal(verdict.autorise, true);
});

test("l'instantané d'une AUTRE image n'est jamais écrasé", () => {
  const verdict = ecrasementAutorise({
    existe: true,
    etatDeclare: "/disks/jiyufit-state.bin",
    nomInstantane: "zealot-state.bin",
  });

  assert.equal(verdict.autorise, false);
  assert.match(verdict.raison, /autre image/);
});

test("un instantané présent qu'aucune configuration ne réclame est protégé", () => {
  // Cas d'une reconstruction : build.sh réécrit la configuration SANS `state`,
  // et l'instantané resté sur le disque décrit alors l'image PRÉCÉDENTE. Le
  // restaurer sur le nouveau disque est exactement le panachage que l'ADR 0007
  // décrit — mieux vaut refuser et le faire supprimer sciemment.
  const verdict = ecrasementAutorise({
    existe: true,
    etatDeclare: undefined,
    nomInstantane: "zealot-state.bin",
  });

  assert.equal(verdict.autorise, false);
});

// --- L'instantané est lié à la construction qu'il a figée ----------------

test("un instantané et un disque de la même construction sont accordés", () => {
  const { verdict } = verifierInstantane({
    state: "/disks/zealot-state.bin",
    stateFor: "2026-08-20T23:14:26Z",
    builtAt: "2026-08-20T23:14:26Z",
  });

  assert.equal(verdict, INSTANTANE.ACCORDE);
});

test("un disque RECONSTRUIT met l'instantané d'avant en désaccord", () => {
  // LE VRAI DANGER N'EST PAS L'ÉCRASEMENT, C'EST LE PANACHAGE : les deux
  // fichiers portent les mêmes noms, et rien dans les noms ne dit qu'ils ne
  // vont plus ensemble. Restaurer un état mémoire sur un système de fichiers
  // qu'il ne connaît pas donne une VM dont Puma ne répond jamais — le défaut
  // de l'ADR 0007, qui avait coûté 337 s de sondes muettes.
  const { verdict, raison } = verifierInstantane({
    state: "/disks/zealot-state.bin",
    stateFor: "2026-08-20T23:14:26Z",
    builtAt: "2026-08-21T08:00:00Z",
  });

  assert.equal(verdict, INSTANTANE.DESACCORDE);
  assert.match(raison, /2026-08-20T23:14:26Z[\s\S]*2026-08-21T08:00:00Z/);
});

test("un instantané SANS marque n'est pas fautif : c'est celui des sandboxes publiées", () => {
  // Toutes les démonstrations en ligne ont un `state` et pas de `stateFor` :
  // les refuser les ferait booter à froid, plusieurs minutes, alors qu'elles
  // fonctionnent. Le verdict le DIT, il ne condamne pas — c'est l'appelant qui
  // tranche.
  const { verdict } = verifierInstantane({
    state: "/disks/jiyufit-state.bin",
    builtAt: "2026-08-15T12:56:15Z",
  });

  assert.equal(verdict, INSTANTANE.SANS_MARQUE);
  assert.notEqual(verdict, INSTANTANE.DESACCORDE, "l'absence de marque n'est pas un désaccord");
});

test("une configuration sans instantané le dit, sans se plaindre", () => {
  const { verdict } = verifierInstantane({ builtAt: "2026-08-20T23:14:26Z" });

  assert.equal(verdict, INSTANTANE.AUCUN);
});
