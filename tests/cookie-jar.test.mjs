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
  mergeBrowserCookies,
  parseDocumentCookie,
  parseSetCookie,
  pathMatches,
  serializeCookies,
} from "../public/shared/cookie-jar.js";
import { sanitizeCookieHeader } from "../public/shared/request-codec.js";

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

// --- MEDIUM-3 : la persistance n'est pas un canal de confiance ------------

test("load refuse une entrée persistée qui réinjecterait un « ; »", () => {
  // IndexedDB vit dans l'origine, qu'un XSS de l'application partage : une
  // entrée forgée y ferait naître un SECOND cookie à la sérialisation.
  const { jar } = bocal();
  jar.load([
    { name: "session", path: "/", value: "a; admin=1", expiresAt: null },
    { name: "sain", path: "/", value: "ok", expiresAt: null },
  ]);
  assert.equal(jar.size, 1, "l'entrée empoisonnée est écartée");
  assert.equal(jar.headerFor("/app/"), "sain=ok");
});

test("ni le bocal ni la frontière n'acceptent un codepoint hors latin-1", () => {
  // Le pont côté guest encode les en-têtes en latin-1 : au-delà de U+00FF il
  // lève, ce qui se traduit par un 502. Persisté, ce 502 revient à CHAQUE
  // requête, y compris après un redémarrage du worker.
  const hanzi = "valeur中";
  assert.equal(parseSetCookie(`a=${hanzi}; Path=/`), null, "refusé dès l'ingestion");

  const { jar } = bocal();
  jar.load([{ name: "a", path: "/", value: hanzi, expiresAt: null }]);
  assert.equal(jar.size, 0, "refusé aussi au rechargement");

  assert.equal(sanitizeCookieHeader(`a=${hanzi}`), null, "et refusé à la frontière du guest");
});

// --- MEDIUM-4 : perdre TOUS les cookies plutôt qu'un seul -----------------

test("le bocal borne l'en-tête SÉRIALISÉ, au lieu de le faire abandonner", () => {
  // sanitizeCookieHeader rend null au-delà de 8192 octets : aucun cookie ne
  // part alors, soit exactement le 422 que le bocal existe pour éliminer.
  const { jar } = bocal();
  jar.ingest(["_session=graine-csrf; Path=/"], "/app/");
  for (let index = 0; index < 40; index += 1) {
    jar.headerFor("/app/"); // la session sert à chaque requête
    jar.ingest([`gros${index}=${"x".repeat(500)}; Path=/`], "/app/");
  }
  const entete = jar.headerFor("/app/");
  assert.ok(entete.length <= 8192, `en-tête borné, obtenu ${entete.length}`);
  assert.equal(sanitizeCookieHeader(entete), entete, "la frontière du guest l'accepte");
});

// --- MEDIUM-5 : la session ne doit JAMAIS être la première évincée --------

test("l'éviction sacrifie le moins récemment UTILISÉ, pas le plus ancien", () => {
  // La session Rails est créée en premier et garde son rang de création à
  // chaque réémission : évincer par ancienneté de création la désignait
  // systématiquement victime. Elle repart pourtant à chaque requête.
  const { jar } = bocal();
  jar.ingest(["_session=graine-csrf; Path=/"], "/app/");
  for (let index = 0; index < 260; index += 1) {
    jar.headerFor("/app/"); // la session est relue à chaque passage
    jar.ingest([`jetable${index}=1; Path=/`], "/app/");
  }
  assert.ok(
    jar.headerFor("/app/").includes("_session=graine-csrf"),
    "la session doit survivre à l'inondation",
  );
});

// --- MEDIUM-6 : les cookies posés en JavaScript par l'application ---------

test("mergeBrowserCookies ajoute ce que le bocal ignore, sans le supplanter", () => {
  // L'iframe est same-origin : « document.cookie = "timezone=…" » crée un vrai
  // cookie du navigateur, dont aucun Set-Cookie n'a informé le bocal. Sans
  // fusion, ce motif courant (fuseau, locale, consentement) n'atteint plus
  // jamais le serveur.
  const fusion = mergeBrowserCookies(
    "_session=graine-csrf",
    [
      { name: "timezone", value: "Europe/Paris", path: "/" },
      { name: "_session", value: "usurpe", path: "/" },
    ],
    "/app/posts",
  );
  assert.equal(fusion, "_session=graine-csrf; timezone=Europe/Paris");
});

test("mergeBrowserCookies filtre chemin, injection et en-tête trop long", () => {
  assert.equal(
    mergeBrowserCookies(null, [{ name: "admin", value: "1", path: "/autre" }], "/app/posts"),
    null,
    "un cookie d'un autre chemin ne part pas",
  );
  assert.equal(
    mergeBrowserCookies(null, [{ name: "a", value: "1; admin=1", path: "/" }], "/app/"),
    null,
    "une valeur porteuse de « ; » forgerait un second cookie",
  );
  const plein = `s=${"x".repeat(8100)}`;
  assert.equal(
    mergeBrowserCookies(plein, [{ name: "tz", value: "x".repeat(200), path: "/" }], "/app/"),
    plein,
    "on n'ajoute rien qui ferait dépasser la borne de l'en-tête",
  );
});

test("mergeBrowserCookies sans rapport du document rend l'en-tête du bocal intact", () => {
  // Coquille muette (page figée, délai dépassé) : on doit retomber exactement
  // sur le comportement du bocal seul, jamais échouer.
  assert.equal(mergeBrowserCookies("a=1", [], "/app/"), "a=1");
  assert.equal(mergeBrowserCookies(null, undefined, "/app/"), null);
});

test("mergeBrowserCookies refuse ce que le pont série ne sait pas encoder", () => {
  // Le guest passe les en-têtes à http.client, qui les encode en latin-1 :
  // au-delà de U+00FF il lève, l'exception devient un 502 — et comme le
  // cookie, lui, reste dans le navigateur, le 502 revient à CHAQUE requête.
  // « é » (U+00E9) passe, « € » (U+20AC) non.
  assert.equal(
    mergeBrowserCookies(null, [{ name: "devise", value: "€", path: "/" }], "/app/"),
    null,
    "un codepoint hors latin-1 ne doit pas atteindre le pont",
  );
  assert.equal(
    mergeBrowserCookies(null, [{ name: "prenom", value: "rené", path: "/" }], "/app/"),
    "prenom=rené",
  );
});

// --- Rapport de `document.cookie` par le document coquille -----------------
//
// Un Service Worker n'a pas de DOM : il ne peut PAS lire document.cookie, et
// le navigateur ne lui montre pas davantage l'en-tête Cookie des requêtes
// qu'il intercepte. Le seul chemin qui existe sur les trois moteurs est de le
// demander à un client. Le Cookie Store API, lui, manque à WebKit.

test("parseDocumentCookie lit la chaîne que le navigateur montre au document", () => {
  assert.deepEqual(parseDocumentCookie("timezone=Europe/Paris; locale=fr"), [
    { name: "timezone", value: "Europe/Paris", path: "/" },
    { name: "locale", value: "fr", path: "/" },
  ]);
  // Une valeur peut contenir des « = » (base64 rembourré, jeton signé) :
  // seule la PREMIÈRE occurrence sépare le nom de la valeur.
  assert.deepEqual(parseDocumentCookie("jeton=YWJj=="), [
    { name: "jeton", value: "YWJj==", path: "/" },
  ]);
});

test("parseDocumentCookie ignore ce qui n'a pas de nom", () => {
  // Un cookie à nom vide est rendu par le navigateur comme sa seule valeur :
  // sans nom, rien à réémettre — et surtout rien à confondre avec un nom.
  assert.deepEqual(parseDocumentCookie("valeur-orpheline"), []);
  assert.deepEqual(parseDocumentCookie("=vide; bon=1"), [{ name: "bon", value: "1", path: "/" }]);
});

test("parseDocumentCookie ne fabrique rien à partir de rien", () => {
  assert.deepEqual(parseDocumentCookie(""), []);
  assert.deepEqual(parseDocumentCookie(null), []);
  assert.deepEqual(parseDocumentCookie(undefined), []);
  assert.deepEqual(parseDocumentCookie(42), []);
});

test("le rapport du document ne franchit que les validations d'ingestion", () => {
  // Le rapport vient d'un client : il passe par le MÊME filtre que les
  // Set-Cookie de la VM et que la relecture d'IndexedDB. Le chemin prêté est
  // « / », parce que le navigateur ne montre à la coquille que des cookies
  // qui apparient déjà « <base>/app/… ».
  const rapporte = parseDocumentCookie("timezone=Europe/Paris; consentement=oui");
  assert.equal(
    mergeBrowserCookies("_session=graine-csrf", rapporte, "/app/posts"),
    "_session=graine-csrf; timezone=Europe/Paris; consentement=oui",
  );
  assert.equal(
    sanitizeCookieHeader(mergeBrowserCookies(null, rapporte, "/app/posts")),
    "timezone=Europe/Paris; consentement=oui",
    "et la frontière du guest l'accepte tel quel",
  );
});
