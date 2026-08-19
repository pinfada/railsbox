// L'API de trafic de GitHub n'expose que quatorze jours : sans capture
// régulière, l'histoire de l'adoption est définitivement perdue. Cette page
// est la capture — et elle doit dire ce qu'elle NE mesure pas, sans quoi elle
// se lirait comme un recensement.
import test from "node:test";
import assert from "node:assert/strict";
import { pageAdoption } from "../tools/mesurer-adoption.mjs";

const MESURES = {
  date: "19 août 2026",
  trafic: { vues: 81, vuesUniques: 1, clones: 193, clonesUniques: 28 },
  tiragesBase: 412,
  depotsPublics: ["pinfada/tchopmygrinds", "acme/boutique"],
  constructionsInternes: 31,
};

test("une mesure absente s'écrit « — », jamais zéro", () => {
  // Zéro est une mesure ; l'absence n'en est pas une. Les confondre ferait
  // lire une chute d'activité là où le jeton a simplement manqué.
  const md = pageAdoption({ date: "x" });
  assert.match(md, /Vues du dépôt \| — /);
  assert.doesNotMatch(md, /Vues du dépôt \| 0 /);
});

test("« unique » s'accorde", () => {
  const md = pageAdoption(MESURES);
  assert.match(md, /81 \(1 unique\)/);
  assert.match(md, /193 \(28 uniques\)/);
});

test("les dépôts privés sont déclarés non mesurables, pas comptés à zéro", () => {
  const md = pageAdoption(MESURES);
  assert.match(md, /\*\*non mesurable\*\*/);
  assert.match(md, /Les dépôts privés sont invisibles/);
});

test("la mise en garde sur les clones cite les constructions internes", () => {
  // Sans elle, on lit une adoption là où on mesure sa propre CI.
  assert.match(pageAdoption(MESURES), /31 construction\(s\)/);
});

test("la mise en garde tient même sans ce chiffre", () => {
  const md = pageAdoption({ ...MESURES, constructionsInternes: null });
  assert.match(md, /Les clones ne mesurent pas l'adoption/);
  assert.doesNotMatch(md, /null/);
});

test("les dépôts détectés sont triés et liés", () => {
  const md = pageAdoption(MESURES);
  const i = md.indexOf("acme/boutique");
  const j = md.indexOf("pinfada/tchopmygrinds");
  assert.ok(i !== -1 && j !== -1 && i < j, "ordre alphabétique");
  assert.match(md, /\[`acme\/boutique`\]\(https:\/\/github\.com\/acme\/boutique\)/);
});

test("aucun dépôt détecté ne produit pas une liste vide muette", () => {
  assert.match(pageAdoption({ date: "x", depotsPublics: [] }), /Aucun dépôt public détecté/);
});

test("la date de mesure figure en tête", () => {
  assert.match(pageAdoption(MESURES), /Mesuré le 19 août 2026/);
});

test("la limite de la recherche de code est écrite", () => {
  // Elle voit les privés du jeton employé : sans le dire, la liste passerait
  // pour un recensement public exhaustif.
  assert.match(pageAdoption(MESURES), /dépend du jeton employé/);
});
