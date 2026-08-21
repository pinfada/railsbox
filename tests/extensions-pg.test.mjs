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

test("la base COMPILE réellement l'extension qu'elle prétend fournir", () => {
  // Une table qui annonce `vector: "3.3-r3"` sans que le Dockerfile l'installe
  // serait pire que le refus d'avant : elle laisserait passer la construction
  // pour la faire échouer au boot, chez le visiteur.
  const dockerfile = readFileSync("tools/build-v86-image/base/Dockerfile", "utf8");

  assert.match(dockerfile, /pgvector/, "la base doit installer pgvector");
  assert.match(
    dockerfile,
    /test -f "\$\(pg_config --sharedir\)\/extension\/vector\.control"/,
    "et le VÉRIFIER : une compilation silencieusement ratée ne doit pas produire une base",
  );
});
