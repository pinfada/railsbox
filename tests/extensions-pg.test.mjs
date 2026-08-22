// Les extensions PostgreSQL qu'une application exige, sues AVANT de construire.
//
// Le défaut trouvé le 21/08/2026 sur woofed-crm : `db/migrate/…_add_pg_vector_
// extension.rb` appelle `enable_extension 'vector'`, la base ne la fournit pas,
// et la construction échoue au bout de QUATRE MINUTES sur un message qui ne dit
// pas quoi faire — « extension "vector" is not available ». Deux `grep` sur
// db/migrate donnaient la réponse en deux secondes.
//
// C'est la doctrine que docs/chantiers.md énonce déjà : « Quand un code d'échec
// aval peut devenir un refus amont, c'est ce qu'il faut faire. »
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  BASE_PG_EXTENSIONS,
  extensionsManquantes,
  extensionsRequises,
} from "../tools/detect/extensions-pg.mjs";

test("extensionsRequises lit les deux écritures, Rails et SQL", () => {
  const requises = extensionsRequises([
    { name: "20240501041116_add_pg_vector_extension.rb", text: "  enable_extension 'vector'\n" },
    { name: "20230318185136_create_good_jobs.rb", text: '  enable_extension "pgcrypto"\n' },
    { name: "structure.sql", text: 'CREATE EXTENSION IF NOT EXISTS "citext";\n' },
  ]);

  assert.deepEqual(requises, ["citext", "pgcrypto", "vector"], "triées et dédoublonnées");
});

test("extensionsRequises ne voit rien là où il n'y a rien", () => {
  assert.deepEqual(extensionsRequises([]), []);
  assert.deepEqual(extensionsRequises([{ name: "x.rb", text: "class X; end" }]), []);
  // Une mention en commentaire ou dans une chaîne n'est pas un appel.
  assert.deepEqual(extensionsRequises([{ name: "x.rb", text: "# enable_extension 'vector'" }]), []);
});

test("la table dit ce que la base fournit RÉELLEMENT, révision par révision", () => {
  // Relevé le 21/08/2026 par `SELECT name FROM pg_available_extensions` dans
  // ghcr.io/pinfada/railsbox-base:3.3-r2 — mesuré, pas supposé.
  assert.equal(BASE_PG_EXTENSIONS.pgcrypto, "3.3");
  assert.equal(BASE_PG_EXTENSIONS.citext, "3.3");
  assert.equal(BASE_PG_EXTENSIONS["uuid-ossp"], "3.3");
  assert.equal(BASE_PG_EXTENSIONS.vector, "3.3-r3", "pgvector n'arrive qu'en r3");
});

test("une extension absente de la base épinglée est signalée, pas devinée", () => {
  assert.deepEqual(extensionsManquantes(["pgcrypto", "vector"], "3.3-r2"), ["vector"]);
  assert.deepEqual(extensionsManquantes(["pgcrypto", "vector"], "3.3-r3"), []);
  assert.deepEqual(extensionsManquantes(["pgcrypto"], "3.3"), []);
});

test("une extension INCONNUE est déclarée manquante, jamais supposée présente", () => {
  // La direction sûre : un refus amont se lit en dix secondes, un échec de
  // migration se paie en minutes et ne nomme pas le remède.
  assert.deepEqual(extensionsManquantes(["postgis"], "3.3-r3"), ["postgis"]);
  assert.deepEqual(extensionsManquantes(["timescaledb"], "3.3-r2"), ["timescaledb"]);
});

test("plpgsql ne compte pas : PostgreSQL l'installe lui-même", () => {
  assert.deepEqual(extensionsManquantes(["plpgsql"], "3.3"), []);
});

test("pgvector est compilé dans un étage JETABLE, jamais dans la base", () => {
  // `postgresql-server-dev-15` traîne la chaîne LLVM : mesuré le 22/08/2026,
  // 360 Mo dans /usr/lib/llvm-14 et 10 paquets llvm/clang qu'un `apt-get purge`
  // suivi d'`autoremove` NE RETIRE PAS — PostgreSQL en dépend pour son JIT.
  // Compilé dans la base, cela coûtait 461 Mo pour une extension de 961 Ko,
  // dans un rootfs que TOUS les visiteurs téléchargent. En multi-étage : 1,2 Mo.
  const dockerfile = readFileSync("tools/build-v86-image/base/Dockerfile", "utf8");

  assert.match(dockerfile, /FROM .+ AS pgvector/, "un étage de compilation séparé");
  assert.match(
    dockerfile,
    /COPY --from=pgvector .*vector\.so/,
    "la base ne reçoit que la bibliothèque",
  );
  assert.match(dockerfile, /COPY --from=pgvector .*vector\.control/);

  // Et l'étage de la BASE ne doit jamais installer le paquet de développement.
  const base = dockerfile.slice(dockerfile.indexOf("AS base"));
  assert.doesNotMatch(
    base,
    /postgresql-server-dev/,
    "le paquet de développement n'a rien à faire dans l'image publiée",
  );
});

test("la base COMPILE réellement l'extension qu'elle prétend fournir", () => {
  // Une table qui annonce `vector: "3.3-r3"` sans que le Dockerfile l'installe
  // serait pire que le refus d'avant : elle laisserait passer la construction
  // pour la faire échouer au boot, chez le visiteur.
  const dockerfile = readFileSync("tools/build-v86-image/base/Dockerfile", "utf8");

  assert.match(dockerfile, /pgvector/, "la base doit fournir pgvector");
  assert.match(
    dockerfile,
    /test -f "\$\(pg_config --sharedir\)\/extension\/vector\.control"/,
    "et le VÉRIFIER : une copie silencieusement ratée ne doit pas produire une base",
  );
});

test("la base EXÉCUTE l'extension qu'elle fournit, elle ne se contente pas de la copier", () => {
  // La présence du fichier de contrôle ne prouve que la copie. Elle laisserait
  // passer une vector.so d'une autre architecture, liée à un autre PostgreSQL,
  // ou une migration SQL manquante : trois pannes qui ne se déclareraient qu'au
  // CREATE EXTENSION, dans une VM, chez le visiteur, sans remède affichable.
  const dockerfile = readFileSync("tools/build-v86-image/base/Dockerfile", "utf8");

  assert.match(dockerfile, /CREATE EXTENSION vector;/, "l'extension est réellement créée");
  assert.match(
    dockerfile,
    /vector\(3\)/,
    "et le TYPE exercé : une colonne, donc le code compilé, pas seulement le catalogue",
  );
  assert.match(dockerfile, /<->/, "avec un opérateur de distance, qui passe par vector.so");
  // Construit et mesuré le 22/08/2026 : la distance L2 entre [1,2,3] et
  // [4,5,6] vaut 5,1962. Contre-épreuve jouée — attendre une autre valeur fait
  // bien échouer la construction de la base.
  assert.match(dockerfile, /5\.1962/, "contre une valeur ATTENDUE, pas seulement « ça répond »");
  // Et le cluster de vérification ne doit pas survivre : la base publiée n'a
  // aucun datadir, c'est le disque applicatif qui l'apporte.
  assert.match(dockerfile, /test ! -d \/tmp\/preuve-pgvector/);
});

test("la source de pgvector est épinglée par empreinte, pas par tag", () => {
  // Un tag git se déplace ; la base est publiée une fois et se veut immuable.
  // Sans empreinte, deux constructions à un an d'écart peuvent livrer deux
  // extensions différentes sous la même révision de base — et rien ne le dirait.
  const dockerfile = readFileSync("tools/build-v86-image/base/Dockerfile", "utf8");

  assert.match(dockerfile, /ARG PGVECTOR_SHA256=[0-9a-f]{64}/, "une empreinte complète, épinglée");
  assert.match(
    dockerfile,
    /sha256sum -c -/,
    "et RÉELLEMENT vérifiée : une empreinte inscrite mais jamais contrôlée ne vaut rien",
  );
});
