// Bocal à cookies du proxy : c'est lui qui remplace le magasin que le
// navigateur refuse de tenir pour une réponse fabriquée par un Service Worker.
// Sans lui, aucune session Rails, donc aucun jeton CSRF valide, donc 422 sur
// tout POST — le défaut que ces tests figent.
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  createCookieJar,
  defaultPath,
  extractSetCookie,
  parseSetCookie,
  pathMatches,
  serializeCookies,
} from "../public/shared/cookie-jar.js";

const MAINTENANT = Date.UTC(2026, 0, 1, 12, 0, 0);

/** Bocal à horloge figée : les expirations se testent sans attendre. */
function bocal(instant = MAINTENANT) {
  const horloge = { instant };
  const jar = createCookieJar({ now: () => horloge.instant });
  return { jar, horloge };
}

test("defaultPath dérive le répertoire de la requête (RFC 6265 §5.1.4)", () => {
  assert.equal(defaultPath("/depot/app/posts/new"), "/depot/app/posts");
  assert.equal(defaultPath("/posts"), "/");
  assert.equal(defaultPath("/"), "/");
  assert.equal(defaultPath("relatif"), "/");
});

test("pathMatches respecte les frontières de segment", () => {
  assert.equal(pathMatches("/app", "/app"), true);
  assert.equal(pathMatches("/app", "/app/posts"), true);
  assert.equal(pathMatches("/app", "/application"), false);
  assert.equal(pathMatches("/", "/n/importe/quoi"), true);
  assert.equal(pathMatches("/app/", "/app/posts"), true);
});

test("parseSetCookie lit nom, valeur et attributs", () => {
  const cookie = parseSetCookie(
    "_demo_session=abc123; path=/; expires=Thu, 01 Jan 2026 13:00:00 GMT; HttpOnly; SameSite=Lax",
    { requestPath: "/app/posts", now: MAINTENANT },
  );
  assert.equal(cookie.name, "_demo_session");
  assert.equal(cookie.value, "abc123");
  assert.equal(cookie.path, "/");
  assert.equal(cookie.httpOnly, true);
  assert.equal(cookie.sameSite, "lax");
  assert.equal(cookie.expiresAt, Date.UTC(2026, 0, 1, 13, 0, 0));
});

test("parseSetCookie applique le chemin par défaut quand Path manque", () => {
  const cookie = parseSetCookie("panier=2", { requestPath: "/depot/app/posts/new" });
  assert.equal(cookie.path, "/depot/app/posts");
});

test("parseSetCookie fait primer Max-Age sur Expires (RFC 6265 §5.2.2)", () => {
  const cookie = parseSetCookie("a=1; Expires=Thu, 01 Jan 2026 13:00:00 GMT; Max-Age=60", {
    now: MAINTENANT,
  });
  assert.equal(cookie.expiresAt, MAINTENANT + 60_000);
});

test("parseSetCookie refuse ce qui permettrait une injection d'en-tête", () => {
  for (const mauvais of [
    "",
    "sansEgal",
    "=vide",
    `a=1${String.fromCharCode(13)}${String.fromCharCode(10)}X-Injecte: oui`,
    `a=${String.fromCharCode(0)}`,
  ]) {
    assert.equal(parseSetCookie(mauvais), null, `aurait dû refuser: ${JSON.stringify(mauvais)}`);
  }
});

test("extractSetCookie sépare les cookies du reste des en-têtes", () => {
  const { setCookies, headers } = extractSetCookie([
    ["content-type", "text/html"],
    ["set-cookie", "a=1"],
    ["Set-Cookie", "b=2; Path=/app"],
    ["location", "/app/posts/1"],
  ]);
  assert.deepEqual(setCookies, ["a=1", "b=2; Path=/app"]);
  assert.deepEqual(headers, [
    ["content-type", "text/html"],
    ["location", "/app/posts/1"],
  ]);
});

test("serializeCookies produit une valeur d'en-tête Cookie", () => {
  assert.equal(
    serializeCookies([
      { name: "a", value: "1" },
      { name: "b", value: "2" },
    ]),
    "a=1; b=2",
  );
});

test("le bocal range plusieurs Set-Cookie d'une même réponse et les renvoie", () => {
  // Le cas réel : Rails pose sa session ET l'auto-connexion pose son marqueur.
  const { jar } = bocal();
  const change = jar.ingest(
    ["_demo_session=abc; path=/; HttpOnly", "railsbox_auto_login=1; Path=/; SameSite=Lax"],
    "/app/posts",
  );
  assert.equal(change, true);
  assert.equal(jar.size, 2);
  assert.equal(jar.headerFor("/app/posts"), "_demo_session=abc; railsbox_auto_login=1");
});

test("le bocal réémet un cookie inchangé sans se déclarer modifié", () => {
  const { jar } = bocal();
  jar.ingest(["s=1; Path=/"], "/app/");
  assert.equal(jar.ingest(["s=1; Path=/"], "/app/"), false, "rien à persister");
  assert.equal(jar.ingest(["s=2; Path=/"], "/app/"), true, "nouvelle valeur = modification");
  assert.equal(jar.headerFor("/app/"), "s=2");
});

test("Max-Age=0 supprime le cookie (déconnexion Rails)", () => {
  const { jar } = bocal();
  jar.ingest(["_demo_session=abc; path=/"], "/app/");
  assert.equal(jar.headerFor("/app/posts"), "_demo_session=abc");

  const change = jar.ingest(["_demo_session=; path=/; max-age=0"], "/app/deconnexion");
  assert.equal(change, true);
  assert.equal(jar.size, 0);
  assert.equal(jar.headerFor("/app/posts"), null);
});

test("un Expires dans le passé supprime aussi le cookie", () => {
  const { jar } = bocal();
  jar.ingest(["a=1; Path=/"], "/app/");
  jar.ingest(["a=1; Path=/; Expires=Thu, 01 Jan 1970 00:00:00 GMT"], "/app/");
  assert.equal(jar.size, 0);
});

test("les cookies expirés disparaissent au passage du temps", () => {
  const { jar, horloge } = bocal();
  jar.ingest(["court=1; Path=/; Max-Age=60", "session=2; Path=/"], "/app/");
  assert.equal(jar.headerFor("/app/"), "court=1; session=2");

  horloge.instant += 61_000;
  assert.equal(jar.headerFor("/app/"), "session=2", "le cookie de session survit, l'autre non");
  assert.equal(jar.size, 1);
});

test("l'en-tête Cookie ne porte que les cookies dont le chemin correspond", () => {
  const { jar } = bocal();
  jar.ingest(["global=1; Path=/"], "/app/");
  jar.ingest(["local=2; Path=/depot/app/admin"], "/depot/app/admin/");

  assert.equal(jar.headerFor("/depot/app/posts"), "global=1");
  assert.equal(jar.headerFor("/depot/app/admin/users"), "local=2; global=1");
});

test("le chemin le plus spécifique passe en premier (RFC 6265 §5.4.2)", () => {
  const { jar } = bocal();
  jar.ingest(["a=1; Path=/"], "/app/");
  jar.ingest(["b=2; Path=/app/posts"], "/app/posts");
  jar.ingest(["c=3; Path=/app"], "/app/");
  assert.equal(jar.headerFor("/app/posts/1"), "b=2; c=3; a=1");
});

test("deux cookies de même nom et de chemins différents coexistent", () => {
  const { jar } = bocal();
  jar.ingest(["jeton=racine; Path=/"], "/app/");
  jar.ingest(["jeton=admin; Path=/app/admin"], "/app/admin/");
  assert.equal(jar.size, 2);
  assert.equal(jar.headerFor("/app/admin/x"), "jeton=admin; jeton=racine");
});

test("le bocal se recharge à l'identique après redémarrage du Service Worker", () => {
  // Le SW est tué dès qu'il est inactif : sans persistance, le visiteur
  // perdrait sa session en plein parcours.
  const { jar } = bocal();
  jar.ingest(["a=1; Path=/"], "/app/");
  jar.ingest(["b=2; Path=/app/posts"], "/app/posts");
  const persiste = JSON.parse(JSON.stringify(jar.snapshot()));

  const { jar: ressuscite } = bocal();
  ressuscite.load(persiste);
  assert.equal(ressuscite.headerFor("/app/posts/1"), "b=2; a=1", "même contenu, même ordre");
});

test("un instantané ne contient jamais de cookie expiré", () => {
  const { jar, horloge } = bocal();
  jar.ingest(["court=1; Path=/; Max-Age=10"], "/app/");
  horloge.instant += 11_000;
  assert.deepEqual(jar.snapshot(), []);
});

test("load ignore les enregistrements corrompus sans faire échouer le reste", () => {
  const { jar } = bocal();
  jar.load([null, { name: "a" }, { name: "b", path: "/", value: "2", expiresAt: null }]);
  assert.equal(jar.size, 1);
  assert.equal(jar.headerFor("/app/"), "b=2");
});

test("le bocal reste borné même si l'application déraille", () => {
  const { jar } = bocal();
  for (let index = 0; index < 250; index += 1) {
    jar.ingest([`c${index}=1; Path=/`], "/app/");
  }
  assert.ok(jar.size <= 200, `taille bornée, obtenu ${jar.size}`);
  assert.ok(jar.headerFor("/app/").includes("c249=1"), "le plus récent est conservé");
});
