import { test } from "node:test";
import assert from "node:assert/strict";
import {
  APP_PREFIX,
  appPrefix,
  appRequestRefusal,
  normalizeBasePath,
  errorPage,
  escapeHtml,
  isShellClient,
  prepareProxyHeaders,
  responseBodyFor,
  rewriteLocation,
  parseRootStaticIndex,
  rootStaticCandidate,
  rootStaticPath,
  staticAssetPath,
  relaxFrameAncestors,
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

// --- Frontière de la sandbox (HIGH-1) --------------------------------------
//
// Le Service Worker N'INTERCEPTE PAS que ses propres clients : une navigation
// est routée sur l'URL de la requête, pas sur son initiateur. Un POST forgé
// depuis un site tiers traverse donc le proxy, qui y attacherait la session du
// bocal — et le seul jeton d'authenticité ne couvre pas les routes en
// skip_forgery_protection.
//
// Les cas ci-dessous rejouent les SIGNAUX MESURÉS moteur par moteur sur une
// navigation interceptée (relevé complet dans proxy-logic.js) :
//  - Chromium pose `Origin` sur les navigations non-GET, rien d'autre ;
//  - Firefox et WebKit ne posent AUCUN en-tête d'origine — d'où le recours à
//    `destination` et `referrer`, renseignés sur les trois moteurs ;
//  - `Sec-Fetch-Site` n'est visible d'un worker sur aucun moteur (il est ajouté
//    après l'interception) : il n'est gardé qu'en défense supplémentaire.

test("appRequestRefusal refuse un POST forgé depuis un site tiers (Chromium)", () => {
  const refus = appRequestRefusal(
    {
      method: "POST",
      mode: "navigate",
      destination: "document",
      origin: "https://evil.example",
      referrer: "https://evil.example/",
    },
    ORIGINE,
  );
  assert.ok(refus, "un Origin étranger doit être refusé");
  assert.match(refus, /evil\.example/);
});

test("appRequestRefusal refuse le POST forgé SANS le moindre en-tête (Firefox, WebKit)", () => {
  // Le défaut mesuré : sur ces moteurs, la navigation forgée ne porte ni
  // Origin, ni Sec-Fetch-Site, ni Referer. Seule sa FORME la trahit — une
  // navigation de premier niveau, ce que l'application n'est jamais.
  const refus = appRequestRefusal(
    {
      method: "POST",
      mode: "navigate",
      destination: "document",
      origin: null,
      referrer: "http://127.0.0.1:8091/",
      secFetchSite: null,
    },
    ORIGINE,
  );
  assert.ok(refus, "le référent étranger suffit déjà");

  const sansReferent = appRequestRefusal(
    { method: "POST", mode: "navigate", destination: "document", origin: null, referrer: "" },
    ORIGINE,
  );
  assert.ok(sansReferent, "et sans référent non plus, rien ne doit passer");
  assert.match(sansReferent, /premier niveau/);
});

test("appRequestRefusal refuse toute navigation de premier niveau, même la nôtre", () => {
  // Le visiteur qui saisit /app/… à la main tombe de toute façon sur une VM
  // qui n'a pas booté : rien de légitime n'est perdu, et la règle reste un
  // prédicat sur la forme, sans exception à contourner.
  assert.ok(
    appRequestRefusal(
      {
        method: "GET",
        mode: "navigate",
        destination: "document",
        origin: null,
        referrer: `${ORIGINE}/railsbox-demo/`,
      },
      ORIGINE,
    ),
  );
});

test("appRequestRefusal refuse une navigation inter-site annoncée par Sec-Fetch-Site", () => {
  // Défense supplémentaire : aucun moteur ne l'expose aujourd'hui à un worker,
  // mais rien n'interdit qu'un moteur le fasse un jour.
  assert.ok(appRequestRefusal({ origin: null, secFetchSite: "cross-site" }, ORIGINE));
  // « same-site » = même domaine enregistrable, autre origine : sur github.io,
  // le Pages du voisin. Ce n'est pas nous.
  assert.ok(appRequestRefusal({ origin: null, secFetchSite: "same-site" }, ORIGINE));
});

test("appRequestRefusal refuse notre /app/ mis dans l'iframe d'un attaquant", () => {
  // frame-ancestors 'self' empêche seulement de RENDRE la réponse : la requête,
  // elle, a déjà traversé le pont et écrit dans la VM.
  const avecReferent = appRequestRefusal(
    {
      method: "GET",
      mode: "navigate",
      destination: "iframe",
      origin: null,
      referrer: "https://evil.example/piege",
    },
    ORIGINE,
  );
  assert.ok(avecReferent, "le référent étranger trahit l'attaquant");

  // Attaquant qui supprime son référent (meta name=referrer) : mesuré, il ne
  // reste alors AUCUN signal sur Firefox. Une écriture doit donc prouver son
  // origine au lieu de bénéficier du doute.
  const sansAucunSignal = appRequestRefusal(
    { method: "POST", mode: "navigate", destination: "iframe", origin: null, referrer: "" },
    ORIGINE,
  );
  assert.ok(sansAucunSignal, "une écriture non attribuable doit être refusée");
  assert.match(sansAucunSignal, /attribuable/);

  // Sur Chromium, la même attaque porte une origine opaque : elle n'est pas la
  // nôtre, donc elle tombe une ligne plus tôt.
  assert.ok(
    appRequestRefusal(
      { method: "POST", mode: "navigate", destination: "iframe", origin: "null", referrer: "" },
      ORIGINE,
    ),
  );
});

test("appRequestRefusal laisse passer ce que la sandbox produit elle-même", () => {
  const legitimes = [
    // Navigation de l'iframe créée par la coquille (GET) : Firefox/WebKit ne
    // donnent que le référent, Chromium non plus n'a pas d'Origin sur un GET.
    {
      method: "GET",
      mode: "navigate",
      destination: "iframe",
      origin: null,
      referrer: `${ORIGINE}/railsbox-demo/`,
    },
    // Soumission du formulaire « New post » DANS l'iframe : Chromium.
    {
      method: "POST",
      mode: "navigate",
      destination: "iframe",
      origin: ORIGINE,
      referrer: `${ORIGINE}/railsbox-demo/app/posts/new`,
      secFetchSite: "same-origin",
    },
    // La même, sur Firefox et WebKit : le référent seul l'atteste.
    {
      method: "POST",
      mode: "navigate",
      destination: "iframe",
      origin: null,
      referrer: `${ORIGINE}/railsbox-demo/app/posts/new`,
    },
    // fetch() de la coquille (la recette live crée un billet ainsi) : ce n'est
    // pas une navigation, donc hors de la règle de forme.
    {
      method: "POST",
      mode: "cors",
      destination: "",
      origin: null,
      referrer: `${ORIGINE}/railsbox-demo/`,
    },
    // fetch() de l'application, référent supprimé par l'application : une
    // sous-ressource n'est interceptée que pour un client contrôlé, donc
    // same-origin par construction — rien à prouver.
    { method: "POST", mode: "same-origin", destination: "", origin: null, referrer: "" },
    // Requête dont le référent n'est pas résolu (« about:client ») : ce n'est
    // pas une origine étrangère, c'est une absence.
    { method: "GET", mode: "cors", destination: "", origin: null, referrer: "about:client" },
  ];
  for (const signaux of legitimes) {
    assert.equal(
      appRequestRefusal(signaux, ORIGINE),
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

// ── Chemins racine inconnus (inventaire d'extraction) ──────────────────────
// L'allowlist en dur ne pouvait pas connaître les chemins racine d'une
// application tierce : tout ce qui n'y figurait pas faisait 404 en silence.
// La liste sert désormais de repli ; la vérité est l'inventaire écrit par
// tools/extract-assets.sh à partir de l'image elle-même.

test("rootStaticPath sert un fichier racine que seul l'inventaire connaît", () => {
  // Arrange : la panne rapportée — une application qui référence /agrimer.json
  // en dur, absent de toute liste écrite d'avance.
  const inventaire = new Set(["agrimer.json", "404.html"]);

  // Act / Assert
  assert.equal(rootStaticPath("/agrimer.json", "/", inventaire), "/disks/appstatic/agrimer.json");
  assert.equal(rootStaticPath("/app/404.html", "/", inventaire), "/disks/appstatic/404.html");
  // Ce que l'image ne contient pas n'est pas inventé.
  assert.equal(rootStaticPath("/favicon.ico", "/", inventaire), null);
});

test("rootStaticCandidate n'accepte qu'un nom de fichier d'un seul segment", () => {
  // Arrange / Act / Assert
  assert.equal(rootStaticCandidate("/agrimer.json"), "agrimer.json");
  assert.equal(rootStaticCandidate("/app/agrimer.json"), "agrimer.json");
  assert.equal(rootStaticCandidate("/images/logo.png"), null, "deux segments");
  assert.equal(rootStaticCandidate("/app/posts"), null, "pas d'extension");
  assert.equal(rootStaticCandidate("/"), null);
  assert.equal(rootStaticCandidate("/app"), null);
  assert.equal(rootStaticCandidate("/../secret.txt"), null, "traversée");
  assert.equal(rootStaticCandidate("/app/../../secret.txt"), null, "traversée préfixée");
  assert.equal(rootStaticCandidate("/hors-site.json", "/ma-demo/"), null, "hors du site");
});

test("un fichier de la coquille ne peut jamais être recouvert par l'application", () => {
  // Arrange : une application qui embarquerait public/main.js prendrait sinon
  // la place du chargeur de la coquille — le code qui pilote la VM.
  const inventaire = new Set(["main.js", "index.html", "sw-proxy.js", "badge.svg"]);

  // Act / Assert
  for (const nom of [...inventaire]) {
    assert.equal(rootStaticCandidate(`/${nom}`), null, nom);
    assert.equal(rootStaticPath(`/${nom}`, "/", inventaire), null, nom);
  }
});

test("parseRootStaticIndex revalide l'inventaire produit à partir d'une image tierce", () => {
  // Arrange : l'inventaire est une donnée, pas une autorité.
  const data = {
    files: [
      "agrimer.json",
      "../../etc/passwd",
      "/etc/passwd",
      "images/logo.png",
      "main.js",
      "sans-extension",
      "agrimer.json",
      42,
      null,
      "robots.txt",
    ],
  };

  // Act
  const noms = parseRootStaticIndex(data);

  // Assert
  assert.deepEqual(noms, ["agrimer.json", "robots.txt"]);
});

test("parseRootStaticIndex tolère un inventaire absent ou informe", () => {
  // Arrange / Act / Assert
  assert.deepEqual(parseRootStaticIndex(null), []);
  assert.deepEqual(parseRootStaticIndex({}), []);
  assert.deepEqual(parseRootStaticIndex("favicon.ico"), []);
  assert.deepEqual(parseRootStaticIndex(["robots.txt"]), ["robots.txt"]);
});

// L'application impose parfois qu'on ne l'encadre pas — et railsbox, lui,
// IMPOSE l'iframe. Défaut trouvé sur la première application tierce : boot
// réussi, requête 200, et un cadre vide portant « refuse la connexion », sans
// rien dans le journal. Deux en-têtes en cause, souvent les deux à la fois.
test("l'interdiction d'encadrement de l'application est levée, la protection reste", () => {
  // Arrange : ce que pose une application Rails durcie (X-Frame-Options: DENY
  // par default_headers, frame-ancestors :none par la CSP de production).
  const brut = [
    ["content-type", "text/html; charset=utf-8"],
    ["x-frame-options", "DENY"],
    ["content-security-policy", "default-src 'self'; frame-ancestors 'none'; object-src 'none'"],
  ];

  // Act
  const headers = prepareProxyHeaders(brut, {
    origin: "https://exemple.test",
    host: "exemple.test",
  });

  // Assert
  assert.equal(headers.get("x-frame-options"), null, "l'en-tête hérité doit disparaître");
  const politiques = headers.get("content-security-policy") ?? "";
  assert.doesNotMatch(politiques, /frame-ancestors 'none'/, "'none' annulerait notre 'self'");
  assert.match(politiques, /frame-ancestors 'self'/, "l'encadrement reste limité à notre origine");
  // Le reste de la politique de l'application n'est pas touché : on détend une
  // directive, on ne réécrit pas sa sécurité.
  assert.match(politiques, /object-src 'none'/);
});

test("relaxFrameAncestors ne touche qu'à sa directive", () => {
  assert.equal(
    relaxFrameAncestors("default-src 'self'; frame-ancestors https://ami.test; img-src *"),
    "default-src 'self'; frame-ancestors 'self'; img-src *",
  );
  // Une politique sans frame-ancestors passe telle quelle : rien à détendre.
  assert.equal(relaxFrameAncestors("default-src 'self'"), "default-src 'self'");
  // Casse et espaces multiples : la directive reste reconnue.
  assert.equal(relaxFrameAncestors("Frame-Ancestors   'none'"), "frame-ancestors 'self'");
  assert.equal(relaxFrameAncestors("   "), null);
});
