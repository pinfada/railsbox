import { test } from "node:test";
import assert from "node:assert/strict";
import {
  APP_PREFIX,
  appPrefix,
  crossOriginRefusal,
  normalizeBasePath,
  errorPage,
  escapeHtml,
  isShellClient,
  prepareProxyHeaders,
  responseBodyFor,
  rewriteLocation,
  rootStaticPath,
  staticAssetPath,
} from "../public/shared/proxy-logic.js";

const SELF = { origin: "http://localhost:8080", host: "localhost:8080" };
const ORIGINE = "https://pinfada.github.io";

test("rewriteLocation ramène un chemin absolu sans préfixe sous /app", () => {
  assert.equal(rewriteLocation("/users/sign_in", SELF), "/app/users/sign_in");
});

test("rewriteLocation laisse intact un chemin déjà préfixé", () => {
  assert.equal(rewriteLocation("/app/users/sign_in", SELF), "/app/users/sign_in");
  assert.equal(rewriteLocation("/app", SELF), "/app");
});

test("rewriteLocation réécrit les URL absolues vers la page hôte", () => {
  // Rails génère « https://localhost:8080/… » à cause du X-Forwarded-Proto :
  // suivie telle quelle, cette URL tenterait du TLS sur un port en clair.
  assert.equal(rewriteLocation("https://localhost:8080/gymhouses", SELF), "/app/gymhouses");
  assert.equal(rewriteLocation("http://127.0.0.1/comptes", SELF), "/app/comptes");
});

test("rewriteLocation préserve query et fragment", () => {
  assert.equal(
    rewriteLocation("/recherche?q=yoga&page=2#resultats", SELF),
    "/app/recherche?q=yoga&page=2#resultats",
  );
});

test("rewriteLocation ne touche pas aux redirections externes", () => {
  assert.equal(
    rewriteLocation("https://accounts.google.com/o/oauth2/auth", SELF),
    "https://accounts.google.com/o/oauth2/auth",
  );
});

test("rewriteLocation laisse intact un en-tête inexploitable", () => {
  assert.equal(rewriteLocation("http://", SELF), "http://");
});

test("responseBodyFor supprime le corps des statuts qui l'interdisent", () => {
  const body = new ArrayBuffer(4);
  assert.equal(responseBodyFor(204, body), null);
  assert.equal(responseBodyFor(304, body), null);
  assert.equal(responseBodyFor(101, body), null);
  assert.equal(responseBodyFor(205, body), null);
  assert.equal(responseBodyFor(200, body), body);
  assert.equal(responseBodyFor(200, undefined), null);
});

test("prepareProxyHeaders réécrit Location et pose l'isolation", () => {
  const headers = prepareProxyHeaders(
    [
      ["location", "/users/sign_in"],
      ["content-type", "text/html"],
    ],
    SELF,
  );
  assert.equal(headers.get("location"), "/app/users/sign_in");
  assert.equal(headers.get("content-type"), "text/html");
  assert.equal(headers.get("cross-origin-embedder-policy"), "require-corp");
  assert.equal(headers.get("cross-origin-resource-policy"), "same-origin");
});

test("prepareProxyHeaders applique la CSP applicative aux documents HTML", () => {
  const headers = prepareProxyHeaders([["content-type", "text/html; charset=utf-8"]], SELF);
  const csp = headers.get("content-security-policy");
  assert.ok(csp, "un document HTML proxifié doit porter une CSP");
  assert.ok(csp.includes("connect-src 'self'"), "l'exfiltration fetch/XHR doit être bloquée");
  assert.ok(csp.includes("form-action 'self'"), "l'envoi de formulaires externes doit être bloqué");
});

test("prepareProxyHeaders ajoute SA CSP même quand l'application en pose une", () => {
  // Défaut corrigé : la CSP du proxy n'était posée QUE si l'application n'en
  // fournissait pas — une application à la politique permissive désactivait
  // donc la nôtre, alors que SECURITY.md la donne pour inconditionnelle. Les
  // deux politiques s'appliquent désormais conjointement (elles s'intersectent).
  const headers = prepareProxyHeaders(
    [
      ["content-type", "text/html"],
      ["content-security-policy", "default-src 'none'"],
    ],
    SELF,
  );
  const csp = headers.get("content-security-policy");
  assert.ok(csp.includes("default-src 'none'"), "la politique de l'application est conservée");
  assert.ok(csp.includes("connect-src 'self'"), "celle du proxy s'y ajoute");
});

test("prepareProxyHeaders n'impose pas de CSP aux réponses non-HTML", () => {
  const headers = prepareProxyHeaders([["content-type", "application/json"]], SELF);
  assert.equal(headers.get("content-security-policy"), null);
});

test("prepareProxyHeaders tolère l'absence d'en-têtes", () => {
  const headers = prepareProxyHeaders(undefined, SELF);
  assert.equal(headers.get("cross-origin-embedder-policy"), "require-corp");
  assert.equal(headers.get("location"), null);
});

// --- Frontière d'origine (HIGH-1) -----------------------------------------
//
// Le Service Worker N'INTERCEPTE PAS que ses propres clients : une navigation
// est routée sur l'URL de la requête, pas sur son initiateur. Un POST forgé
// depuis un site tiers traverse donc le proxy, qui y attacherait la session du
// bocal — et le seul jeton d'authenticité ne couvre pas les routes en
// skip_forgery_protection. Ces cas figent la règle de refus.

test("crossOriginRefusal refuse un POST forgé depuis un site tiers", () => {
  const refus = crossOriginRefusal(
    { origin: "https://evil.example", secFetchSite: "cross-site" },
    ORIGINE,
  );
  assert.ok(refus, "un Origin étranger doit être refusé");
  assert.match(refus, /evil\.example/);
});

test("crossOriginRefusal refuse une navigation inter-site SANS Origin", () => {
  // Une navigation GET n'a pas forcément d'Origin : Sec-Fetch-Site est alors
  // le seul signal, et c'est justement le cas d'un lien forgé.
  assert.ok(crossOriginRefusal({ origin: null, secFetchSite: "cross-site" }, ORIGINE));
  // « same-site » = même domaine enregistrable, autre origine : sur github.io,
  // le Pages du voisin. Ce n'est pas nous.
  assert.ok(crossOriginRefusal({ origin: null, secFetchSite: "same-site" }, ORIGINE));
});

test("crossOriginRefusal laisse passer ce que la sandbox produit elle-même", () => {
  const legitimes = [
    // POST de l'iframe applicative : Origin présent, et c'est le nôtre.
    { origin: ORIGINE, secFetchSite: "same-origin" },
    // Navigation same-origin en GET : aucun Origin, seul Sec-Fetch-Site parle.
    { origin: null, secFetchSite: "same-origin" },
    // Saisie directe ou marque-page du visiteur.
    { origin: null, secFetchSite: "none" },
    // Navigateur qui ne pose pas Fetch Metadata : rien ne prouve un abus.
    { origin: null, secFetchSite: null },
  ];
  for (const signaux of legitimes) {
    assert.equal(
      crossOriginRefusal(signaux, ORIGINE),
      null,
      `aurait dû passer: ${JSON.stringify(signaux)}`,
    );
  }
});

// --- Filtre du document coquille (HIGH-2) ---------------------------------

test("isShellClient refuse l'iframe applicative, seule surface d'un XSS", () => {
  // Sans ce filtre, un XSS dans l'application postait son propre « bridge-port »
  // et recevait chaque descripteur de requête, cookie: EN CLAIR.
  const self = { origin: ORIGINE, basePath: "/railsbox-demo/" };
  assert.equal(isShellClient(`${ORIGINE}/railsbox-demo/app/posts`, self), false);
  assert.equal(isShellClient(`${ORIGINE}/railsbox-demo/app`, self), false);
  assert.equal(isShellClient(`${ORIGINE}/railsbox-demo/app/`, self), false);
});

test("isShellClient accepte le document coquille, à la racine de publication", () => {
  const self = { origin: ORIGINE, basePath: "/railsbox-demo/" };
  assert.equal(isShellClient(`${ORIGINE}/railsbox-demo/`, self), true);
  assert.equal(isShellClient(`${ORIGINE}/railsbox-demo/index.html?fresh=1`, self), true);
  // Publication à la racine d'une origine : le cas du développement local.
  assert.equal(isShellClient(`${ORIGINE}/`, { origin: ORIGINE, basePath: "/" }), true);
});

test("isShellClient refuse une autre origine et une source sans URL", () => {
  const self = { origin: ORIGINE, basePath: "/railsbox-demo/" };
  assert.equal(isShellClient("https://evil.example/railsbox-demo/", self), false);
  assert.equal(isShellClient(null, self), false);
  assert.equal(isShellClient("pas une URL", self), false);
});

test("escapeHtml neutralise les cinq caractères dangereux", () => {
  assert.equal(
    escapeHtml(`<script>alert("xss") & 'fin'</script>`),
    "&lt;script&gt;alert(&quot;xss&quot;) &amp; &#39;fin&#39;&lt;/script&gt;",
  );
  assert.equal(escapeHtml(42), "42");
});

test("errorPage échappe le message et coerce le statut", () => {
  const page = errorPage(502, `<img src=x onerror=alert(1)>`);
  assert.ok(!page.includes("<img"), "le HTML injecté doit être neutralisé");
  assert.ok(page.includes("&lt;img"), "le message reste lisible, échappé");
  assert.ok(page.includes(">502<"), "le statut apparaît en clair");
});

test("APP_PREFIX est bien la frontière du proxy", () => {
  assert.equal(APP_PREFIX, "/app");
});

test("staticAssetPath traduit les assets applicatifs vers l'extraction statique", () => {
  assert.equal(
    staticAssetPath("/app/assets/tailwind-abc123.css"),
    "/disks/assets/tailwind-abc123.css",
  );
  assert.equal(
    staticAssetPath("/app/assets/vendor/leaflet-def456.js"),
    "/disks/assets/vendor/leaflet-def456.js",
  );
});

test("rootStaticPath sert les fichiers racine écrits en dur par Rails", () => {
  assert.equal(rootStaticPath("/favicon.ico"), "/disks/appstatic/favicon.ico");
  assert.equal(rootStaticPath("/site.webmanifest"), "/disks/appstatic/site.webmanifest");
  // La variante préfixée /app est ramenée au même fichier.
  assert.equal(rootStaticPath("/app/favicon.ico"), "/disks/appstatic/favicon.ico");
});

test("rootStaticPath ignore tout le reste", () => {
  assert.equal(rootStaticPath("/"), null);
  assert.equal(rootStaticPath("/app/gymhouses"), null);
  assert.equal(rootStaticPath("/main.js"), null);
  assert.equal(rootStaticPath("/favicon.ico/../x"), null);
});

test("staticAssetPath refuse tout ce qui n'est pas un asset sûr", () => {
  assert.equal(staticAssetPath("/app/gymhouses"), null, "page dynamique");
  assert.equal(staticAssetPath("/app/assets/"), null, "chemin vide");
  assert.equal(staticAssetPath("/app/assets/../secrets"), null, "traversée");
  assert.equal(staticAssetPath("/autre/assets/x.js"), null, "hors préfixe /app");
});

// ── Publication sous un sous-répertoire (Pages de projet, ADR 0004) ────────
// Chaque démonstration est servie sous https://compte.github.io/<depot>/ :
// la frontière du proxy et les racines statiques doivent suivre, sinon la
// coquille cherche ses ressources hors du site.

test("normalizeBasePath ramène les formes équivalentes à une seule", () => {
  assert.equal(normalizeBasePath("/"), "");
  assert.equal(normalizeBasePath(""), "");
  assert.equal(normalizeBasePath("/depot/"), "/depot");
  assert.equal(normalizeBasePath("/depot"), "/depot");
  assert.equal(normalizeBasePath("depot"), "/depot");
});

test("appPrefix suit la racine de publication", () => {
  assert.equal(appPrefix("/"), "/app");
  assert.equal(appPrefix("/ma-demo/"), "/ma-demo/app");
});

test("rewriteLocation préfixe sous le sous-répertoire de publication", () => {
  assert.equal(rewriteLocation("/users/sign_in", SELF, "/ma-demo/"), "/ma-demo/app/users/sign_in");
  // Déjà préfixé : laissé tel quel.
  assert.equal(rewriteLocation("/ma-demo/app/posts", SELF, "/ma-demo/"), "/ma-demo/app/posts");
  // Une redirection externe reste intacte quelle que soit la racine.
  assert.equal(
    rewriteLocation("https://accounts.google.com/o/oauth2/auth", SELF, "/ma-demo/"),
    "https://accounts.google.com/o/oauth2/auth",
  );
});

test("staticAssetPath résout les assets sous le sous-répertoire", () => {
  assert.equal(
    staticAssetPath("/ma-demo/app/assets/application-abc123.css", "/ma-demo/"),
    "/ma-demo/disks/assets/application-abc123.css",
  );
  // Le chemin racine ne doit plus correspondre une fois la coquille déplacée.
  assert.equal(staticAssetPath("/app/assets/application-abc123.css", "/ma-demo/"), null);
  // Traversée toujours refusée.
  assert.equal(staticAssetPath("/ma-demo/app/assets/../secret", "/ma-demo/"), null);
});

test("rootStaticPath résout les fichiers racine sous le sous-répertoire", () => {
  assert.equal(
    rootStaticPath("/ma-demo/app/favicon.ico", "/ma-demo/"),
    "/ma-demo/disks/appstatic/favicon.ico",
  );
  assert.equal(
    rootStaticPath("/ma-demo/favicon.ico", "/ma-demo/"),
    "/ma-demo/disks/appstatic/favicon.ico",
  );
  assert.equal(rootStaticPath("/ma-demo/inconnu.txt", "/ma-demo/"), null);
});
