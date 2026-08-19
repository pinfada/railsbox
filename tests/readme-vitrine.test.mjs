// Le dépôt vitrine est la SEULE surface publique d'une sandbox publiée depuis
// un dépôt privé : le README du dépôt source, lui, n'est visible de personne.
// Constaté le 19/08/2026 sur deux vitrines réelles, vides toutes les deux — un
// visiteur y trouvait un dépôt sans titre, sans lien et sans explication.
import test from "node:test";
import assert from "node:assert/strict";
import { readmeVitrine } from "../tools/build-v86-image/ecrire-readme-vitrine.mjs";

const VITRINE = {
  nom: "fractal",
  adresse: "https://pinfada.github.io/fractal-demo/",
  sourcePubliee: false,
  depotSource: "pinfada/fractal",
};

test("le badge et le lien pointent sur la sandbox publiée", () => {
  const md = readmeVitrine(VITRINE);
  assert.match(
    md,
    /!\[Try with railsbox\]\(https:\/\/pinfada\.github\.io\/fractal-demo\/badge\.svg\)/,
  );
  assert.match(md, /\]\(https:\/\/pinfada\.github\.io\/fractal-demo\/\)/);
});

test("une vitrine séparée dit que le code source n'est pas là", () => {
  const md = readmeVitrine(VITRINE);
  assert.match(md, /n'est pas publié ici/);
  assert.match(md, /pinfada\/fractal/, "le dépôt source est nommé");
});

test("publiée sur son propre dépôt, la sandbox n'invente pas une absence", () => {
  // Le code est à côté : expliquer son absence serait faux et inquiétant.
  const md = readmeVitrine({ ...VITRINE, sourcePubliee: true, depotSource: undefined });
  assert.doesNotMatch(md, /n'est pas publié ici/);
  assert.match(md, /branche par défaut/);
});

test("sans dépôt source nommé, la phrase reste grammaticale", () => {
  // Le workflow ne connaît pas toujours le dépôt source ; le texte ne doit pas
  // finir par « il vit dans , qui reste privé ».
  const md = readmeVitrine({ ...VITRINE, depotSource: undefined });
  assert.match(md, /n'est pas publié ici\*\*\./, "la phrase se ferme proprement");
  assert.doesNotMatch(md, /il vit dans/, "aucun dépôt fantôme");
});

test("le titre porte le nom de la sandbox", () => {
  assert.match(readmeVitrine(VITRINE), /^# fractal — démonstration jouable/);
});

test("les limites sont annoncées, pas cachées", () => {
  // Une vitrine qui promet une application de production ferait une mauvaise
  // première impression au premier clic qui échoue.
  const md = readmeVitrine(VITRINE);
  for (const attendu of [/réseau sortant/, /WebSockets/, /jetable/]) {
    assert.match(md, attendu);
  }
});
