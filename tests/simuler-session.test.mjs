// Contrat du bord authentifiant simulé (tools/simuler-session.mjs). Ce que
// ces tests figent n'est pas une commodité de développement : c'est la forme
// EXACTE que le bord de production devra respecter, et dont chaque clause
// découle d'une limite mesurée du chargeur de v86.
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  AUTH_EXPIREE,
  COOKIE_SESSION,
  EN_TETE_AUTH,
  TTL_DEFAUT_MS,
  cookieSession,
  decisionBord,
  estRequeteArtefact,
  etatDeSession,
  lireSimulation,
  refusDeSession,
  sessionActive,
  valeurCookie,
} from "../tools/simuler-session.mjs";
import { estRefusDeSession } from "../public/shared/session-privee.js";

const MAINTENANT = 1_760_000_000_000;

// --- Configuration : éteint par défaut ------------------------------------

test("la simulation est éteinte tant que RAILSBOX_SIMULER_AUTH ne vaut pas 1", () => {
  // Non-régression du chemin public gratuit : serve.mjs doit rester
  // strictement identique hors de ce mode.
  assert.equal(lireSimulation({}).active, false);
  assert.equal(lireSimulation({ RAILSBOX_SIMULER_AUTH: "0" }).active, false);
  assert.equal(lireSimulation({ RAILSBOX_SIMULER_AUTH: "oui" }).active, false);
  assert.equal(lireSimulation({ RAILSBOX_SIMULER_AUTH: "1" }).active, true);
});

test("la durée de session est paramétrable, et le renouvellement en hérite", () => {
  assert.equal(lireSimulation({}).ttlMs, TTL_DEFAUT_MS);
  const config = lireSimulation({ RAILSBOX_AUTH_TTL_MS: "5000" });
  assert.equal(config.ttlMs, 5000);
  assert.equal(config.ttlRenouvellementMs, 5000, "hérite du TTL principal par défaut");
});

test("une session peut naître expirée et se rétablir durablement", () => {
  // Ce que ce couple achète : un test de bout en bout déterministe, qui n'a
  // pas besoin d'attendre qu'une échéance tombe.
  const config = lireSimulation({
    RAILSBOX_AUTH_TTL_MS: "0",
    RAILSBOX_AUTH_TTL_RENOUVELLEMENT_MS: "600000",
  });
  assert.equal(config.ttlMs, 0);
  assert.equal(config.ttlRenouvellementMs, 600_000);
});

test("une durée illisible ou négative retombe sur le défaut", () => {
  assert.equal(lireSimulation({ RAILSBOX_AUTH_TTL_MS: "plus tard" }).ttlMs, TTL_DEFAUT_MS);
  assert.equal(lireSimulation({ RAILSBOX_AUTH_TTL_MS: "-1" }).ttlMs, TTL_DEFAUT_MS);
});

// --- Lecture du cookie ----------------------------------------------------

test("le cookie est lu au milieu des autres, sans confusion de préfixe", () => {
  const entete = `autre=1; ${COOKIE_SESSION}=42; ${COOKIE_SESSION}_bis=99`;
  assert.equal(valeurCookie(entete, COOKIE_SESSION), "42");
  assert.equal(valeurCookie("", COOKIE_SESSION), null);
  assert.equal(valeurCookie(undefined, COOKIE_SESSION), null);
  assert.equal(valeurCookie("sans-egal", COOKIE_SESSION), null);
});

test("une échéance dépassée, absente ou illisible vaut « expirée »", () => {
  assert.equal(sessionActive(String(MAINTENANT + 1), MAINTENANT), true);
  assert.equal(sessionActive(String(MAINTENANT), MAINTENANT), false, "échéance atteinte");
  assert.equal(sessionActive(String(MAINTENANT - 1), MAINTENANT), false);
  assert.equal(sessionActive(null, MAINTENANT), false);
  assert.equal(sessionActive("", MAINTENANT), false);
  assert.equal(sessionActive("bientot", MAINTENANT), false);
});

test("le cookie posé est host-only et HttpOnly", () => {
  // Sous « un sous-domaine par sandbox », un cookie de domaine parent partirait
  // vers TOUTES les sandboxes de tous les clients (c.3 de la note).
  const entete = cookieSession(MAINTENANT, 1000);
  assert.equal(entete.startsWith(`${COOKIE_SESSION}=${MAINTENANT + 1000};`), true);
  assert.match(entete, /HttpOnly/);
  assert.doesNotMatch(entete, /Domain=/i, "jamais de Domain : le cookie reste host-only");
});

// --- Le contrat du refus (C1 à C6) ----------------------------------------

test("le refus est un 401, jamais un 3xx ni un 5xx", () => {
  // C1 : un 3xx suivi rend un 200 porteur de HTML, que v86 prendrait pour des
  // octets de disque et que le worker mettrait en cache SOUS L'URL DU MORCEAU.
  // C2 : un 5xx ferait réessayer v86 indéfiniment, en silence.
  assert.equal(refusDeSession().status, 401);
});

test("le refus porte l'en-tête qui permet de trancher sans lire le corps", () => {
  assert.equal(refusDeSession().headers[EN_TETE_AUTH], AUTH_EXPIREE);
});

test("le refus n'est ni cacheable ni HTML, et varie sur le cookie", () => {
  const { headers, body } = refusDeSession();
  assert.equal(headers["Cache-Control"], "no-store", "C5");
  assert.match(headers["Content-Type"], /application\/json/, "C4");
  assert.equal(headers.Vary, "Cookie", "C6");
  assert.equal(body.length < 200, true, "C4 : corps court");
  assert.deepEqual(JSON.parse(body), { erreur: "session_expiree" });
});

test("le refus du bord est EXACTEMENT ce que le worker reconnaît", () => {
  // Le point de jonction des deux moitiés du dispositif : si l'une des deux
  // dérive, ce test tombe avant que la sandbox ne gèle chez un client.
  const { status, headers } = refusDeSession();
  assert.equal(estRefusDeSession(status, headers), true);
});

// --- /auth/etat -----------------------------------------------------------

test("l'état d'une session valide est un 200 non cacheable", () => {
  const reponse = etatDeSession(String(MAINTENANT + 5000), MAINTENANT);
  assert.equal(reponse.status, 200);
  assert.equal(reponse.headers["Cache-Control"], "no-store");
  assert.deepEqual(JSON.parse(reponse.body), { etat: "active", expireDansMs: 5000 });
});

test("l'état d'une session échue est le refus, à l'identique", () => {
  // La coquille sonde ce point pendant que la VM est en pause : il doit dire
  // la même chose que le refus sur artefact, sans quoi elle reprendrait trop
  // tôt ou jamais.
  assert.deepEqual(etatDeSession(String(MAINTENANT - 1), MAINTENANT), refusDeSession());
  assert.deepEqual(etatDeSession(null, MAINTENANT), refusDeSession());
});

// --- La décision du bord --------------------------------------------------

test("un artefact sans session valide est refusé", () => {
  const decision = decisionBord({
    urlPath: "/disks/demo-app-0-4194304.ext2.zst",
    cookie: undefined,
    maintenant: MAINTENANT,
    ttlMs: 1000,
  });
  assert.equal(decision.verdict, "refus");
});

test("un artefact sous session valide passe sans être touché", () => {
  const decision = decisionBord({
    urlPath: "/disks/demo-app-0-4194304.ext2.zst",
    cookie: `${COOKIE_SESSION}=${MAINTENANT + 1000}`,
    maintenant: MAINTENANT,
    ttlMs: 1000,
  });
  assert.equal(decision.verdict, "laisser");
  assert.equal(decision.setCookie, undefined);
});

test("la première visite d'une page pose la session", () => {
  const decision = decisionBord({
    urlPath: "/",
    cookie: undefined,
    maintenant: MAINTENANT,
    ttlMs: 1000,
  });
  assert.equal(decision.verdict, "poser");
  assert.equal(decision.setCookie, cookieSession(MAINTENANT, 1000));
});

test("une session EXPIRÉE n'est jamais réémise d'office", () => {
  // Sinon la moindre navigation supprimerait le phénomène qu'on observe : le
  // rétablissement doit passer par /auth/renouveler, c'est-à-dire par un geste.
  const decision = decisionBord({
    urlPath: "/",
    cookie: `${COOKIE_SESSION}=${MAINTENANT - 1}`,
    maintenant: MAINTENANT,
    ttlMs: 1000,
  });
  assert.equal(decision.verdict, "laisser");
  assert.equal(decision.setCookie, undefined);
});

test("la coquille et ses scripts restent servis même session expirée", () => {
  // Refuser la coquille elle-même laisserait le visiteur devant une page
  // blanche, sans le moyen de se reconnecter (b.5 : l'interface de
  // reconnexion vit DANS le document coquille).
  for (const chemin of ["/", "/index.html", "/main.js", "/sw-proxy.js", "/shared/veille.js"]) {
    const decision = decisionBord({
      urlPath: chemin,
      cookie: `${COOKIE_SESSION}=${MAINTENANT - 1}`,
      maintenant: MAINTENANT,
      ttlMs: 1000,
    });
    assert.notEqual(decision.verdict, "refus", `${chemin} doit rester servi`);
  }
});

test("la zone protégée est /disks/, chaîne de recherche comprise", () => {
  assert.equal(estRequeteArtefact("/disks/demo.ext2.zst"), true);
  assert.equal(estRequeteArtefact("/disks/v86-config.json?fresh=1"), true);
  assert.equal(estRequeteArtefact("/disks"), false);
  assert.equal(estRequeteArtefact("/main.js"), false);
});
