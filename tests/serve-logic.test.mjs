import { test } from "node:test";
import assert from "node:assert/strict";
import { join, resolve, sep } from "node:path";
import { parseRange, resolveSafePath } from "../tools/serve-logic.mjs";

const PUBLIC_DIR = resolve("/srv/railsbox/public");

test("resolveSafePath sert les fichiers sous la racine publique", () => {
  assert.equal(resolveSafePath("/main.js", PUBLIC_DIR), join(PUBLIC_DIR, "main.js"));
  assert.equal(
    resolveSafePath("/shared/serial-codec.js", PUBLIC_DIR),
    join(PUBLIC_DIR, "shared", "serial-codec.js"),
  );
});

test("resolveSafePath résout un répertoire vers son index.html", () => {
  assert.equal(resolveSafePath("/", PUBLIC_DIR), join(PUBLIC_DIR, "index.html"));
});

test("resolveSafePath ignore la query string", () => {
  assert.equal(resolveSafePath("/main.js?v=3", PUBLIC_DIR), join(PUBLIC_DIR, "main.js"));
});

test("resolveSafePath refuse la traversée de répertoire", () => {
  assert.equal(resolveSafePath("/../secrets.txt", PUBLIC_DIR), null);
  assert.equal(resolveSafePath("/a/../../etc/passwd", PUBLIC_DIR), null);
  // Variante percent-encodée : décodée avant le contrôle.
  assert.equal(resolveSafePath("/%2e%2e/secrets.txt", PUBLIC_DIR), null);
});

test("resolveSafePath refuse un percent-encoding invalide au lieu de planter", () => {
  assert.equal(resolveSafePath("/%zz", PUBLIC_DIR), null);
});

test("resolveSafePath n'autorise pas de sortir par un préfixe voisin", () => {
  // /srv/railsbox/public-evil partage le préfixe textuel mais pas le répertoire.
  assert.equal(resolveSafePath(`/..${sep}public-evil/x`, PUBLIC_DIR), null);
});

test("parseRange interprète une plage explicite", () => {
  assert.deepEqual(parseRange("bytes=0-499", 1000), { start: 0, end: 499 });
  assert.deepEqual(parseRange("bytes=500-999", 1000), { start: 500, end: 999 });
});

test("parseRange borne la fin à la taille du fichier", () => {
  assert.deepEqual(parseRange("bytes=900-2000", 1000), { start: 900, end: 999 });
});

test("parseRange gère la borne ouverte et le suffixe", () => {
  assert.deepEqual(parseRange("bytes=500-", 1000), { start: 500, end: 999 });
  // « bytes=-200 » = les 200 derniers octets.
  assert.deepEqual(parseRange("bytes=-200", 1000), { start: 800, end: 999 });
  // Suffixe plus grand que le fichier : tout le fichier.
  assert.deepEqual(parseRange("bytes=-5000", 1000), { start: 0, end: 999 });
});

test("parseRange rejette les plages illisibles ou hors fichier", () => {
  assert.equal(parseRange(undefined, 1000), null);
  assert.equal(parseRange("", 1000), null);
  assert.equal(parseRange("bytes=-", 1000), null);
  assert.equal(parseRange("octets=0-10", 1000), null);
  assert.equal(parseRange("bytes=600-400", 1000), null);
  assert.equal(parseRange("bytes=1000-1200", 1000), null, "début au-delà de la fin du fichier");
});
