import { test } from "node:test";
import assert from "node:assert/strict";
import { join, resolve, sep } from "node:path";
import {
  MARQUEUR_COQUILLE_NUE,
  RANGE_HORS_FICHIER,
  RANGE_IGNORE,
  RANGE_PLAGE,
  estCoquilleNue,
  parseRange,
  resolveSafePath,
} from "../tools/serve-logic.mjs";

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

const plage = (start, end) => ({ type: RANGE_PLAGE, start, end });
const IGNORE = { type: RANGE_IGNORE };
const HORS_FICHIER = { type: RANGE_HORS_FICHIER };

test("parseRange interprète une plage explicite", () => {
  assert.deepEqual(parseRange("bytes=0-499", 1000), plage(0, 499));
  assert.deepEqual(parseRange("bytes=500-999", 1000), plage(500, 999));
});

test("parseRange borne la fin à la taille du fichier", () => {
  assert.deepEqual(parseRange("bytes=900-2000", 1000), plage(900, 999));
});

test("parseRange gère la borne ouverte et le suffixe", () => {
  assert.deepEqual(parseRange("bytes=500-", 1000), plage(500, 999));
  // « bytes=-200 » = les 200 derniers octets.
  assert.deepEqual(parseRange("bytes=-200", 1000), plage(800, 999));
  // Suffixe plus grand que le fichier : tout le fichier.
  assert.deepEqual(parseRange("bytes=-5000", 1000), plage(0, 999));
});

test("parseRange ignore un en-tête absent, illisible ou d'unité inconnue", () => {
  // RFC 9110 §14.2 : ces cas se servent en 200 complet, pas en 416.
  assert.deepEqual(parseRange(undefined, 1000), IGNORE);
  assert.deepEqual(parseRange("", 1000), IGNORE);
  assert.deepEqual(parseRange("bytes=-", 1000), IGNORE);
  assert.deepEqual(parseRange("octets=0-10", 1000), IGNORE);
  assert.deepEqual(parseRange("bytes=abc-def", 1000), IGNORE);
  // Spec invalide (fin avant début) : ignorée, pas refusée.
  assert.deepEqual(parseRange("bytes=600-400", 1000), IGNORE);
});

test("parseRange refuse une plage valide mais hors fichier", () => {
  // RFC 9110 §14.4 : le serveur doit répondre 416, jamais un 200 complet —
  // sinon le client prend le fichier entier pour le fragment demandé.
  assert.deepEqual(parseRange("bytes=1000-1200", 1000), HORS_FICHIER);
  assert.deepEqual(parseRange("bytes=1000-", 1000), HORS_FICHIER);
  // « bytes=-0 » ne désigne aucun octet.
  assert.deepEqual(parseRange("bytes=-0", 1000), HORS_FICHIER);
  // Fichier vide : aucune plage n'est satisfaisable.
  assert.deepEqual(parseRange("bytes=0-10", 0), HORS_FICHIER);
  assert.deepEqual(parseRange("bytes=-10", 0), HORS_FICHIER);
});

test("estCoquilleNue ne reconnaît que les deux adresses de la coquille", () => {
  assert.equal(estCoquilleNue(`/?${MARQUEUR_COQUILLE_NUE}`), true);
  assert.equal(estCoquilleNue(`/index.html?${MARQUEUR_COQUILLE_NUE}`), true);
  // Le marqueur peut voisiner d'autres paramètres.
  assert.equal(estCoquilleNue(`/?fresh=1&${MARQUEUR_COQUILLE_NUE}`), true);
});

test("estCoquilleNue refuse d'ouvrir une porte que le filtre vient de fermer", () => {
  // Une page quelconque affublée du marqueur n'est pas la coquille : la servir
  // comme telle rendrait à un document voisin le privilège qu'`isShellClient`
  // ne lui accorde plus.
  assert.equal(estCoquilleNue(`/404.html?${MARQUEUR_COQUILLE_NUE}`), false);
  assert.equal(estCoquilleNue(`/app/posts?${MARQUEUR_COQUILLE_NUE}`), false);
  assert.equal(estCoquilleNue(`/e2e-hote?${MARQUEUR_COQUILLE_NUE}`), false);
});

test("estCoquilleNue laisse la coquille normale intacte", () => {
  // Sans le marqueur, rien ne change : la publication réelle n'a pas de query.
  assert.equal(estCoquilleNue("/"), false);
  assert.equal(estCoquilleNue("/index.html"), false);
  assert.equal(estCoquilleNue("/?coquille=habillee"), false);
  assert.equal(estCoquilleNue(undefined), false);
});
