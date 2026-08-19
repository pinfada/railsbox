// Une sandbox publiée, verte de bout en bout, dont la page d'accueil affichait
// « nothing here yet » : la base était vide, l'application n'avait pas de
// seeds, et RIEN dans la chaîne ne l'avait signalé. Une démonstration qui ne
// montre rien ne démontre rien — l'échec est commercial, et il est silencieux.
//
// La suite ci-dessous fixe les deux moitiés du contrat : ce qui déclenche
// l'avertissement (aucune commande retenue, ou un db/seeds.rb qui n'amorce
// rien), et surtout ce qui ne le déclenche PAS — une application qui a déclaré
// son jeu de démonstration ne doit plus jamais entendre parler de ce contrôle.
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  ETAT_SEEDS,
  etatFichierSeeds,
  sandboxSansDonneesFindings,
} from "../tools/detect/donnees-demo.mjs";
import { detectApp } from "../tools/detect/detect.mjs";
import { REMEDIES, formatReport } from "../tools/detect/report.mjs";

/**
 * Raccourci : les codes émis pour un état de seeds et une commande déclarée.
 * @param {{seedsFile?: string, seedCommand?: string|null}} entree contexte
 * @returns {string[]} codes émis
 */
function codes(entree) {
  return sandboxSansDonneesFindings(entree).map((finding) => finding.code);
}

// --- Lecture d'un db/seeds.rb ------------------------------------------------

test("un db/seeds.rb absent est un fichier absent, pas un fichier vide", () => {
  assert.equal(etatFichierSeeds(null), ETAT_SEEDS.ABSENT);
  assert.equal(etatFichierSeeds(undefined), ETAT_SEEDS.ABSENT);
});

test("un db/seeds.rb blanc ou fait de commentaires seuls compte comme vide", () => {
  assert.equal(etatFichierSeeds(""), ETAT_SEEDS.VIDE);
  assert.equal(etatFichierSeeds("\n\n   \n\t\n"), ETAT_SEEDS.VIDE);
  // Le db/seeds.rb livré par `rails new` : uniquement l'en-tête de commentaires.
  assert.equal(
    etatFichierSeeds(
      "# This file should ensure the existence of records required to run the app.\n" +
        "#\n" +
        "#   Examples:\n" +
        '#     Character.create(name: "Luke")\n',
    ),
    ETAT_SEEDS.VIDE,
  );
});

test("un commentaire en bloc =begin/=end compte aussi comme vide", () => {
  const source = "=begin\nPost.create!(title: 'ancien seed désactivé')\n=end\n";
  assert.equal(etatFichierSeeds(source), ETAT_SEEDS.VIDE);
});

test("la moindre instruction rend le fichier utile", () => {
  assert.equal(etatFichierSeeds("Post.create!(title: 'Bonjour')\n"), ETAT_SEEDS.UTILE);
  assert.equal(etatFichierSeeds("# en-tête\nUser.create!(email: 'a@b.c')\n"), ETAT_SEEDS.UTILE);
});

test("un db/seeds.rb qui ne fait que charger d'autres fichiers est utile", () => {
  // Découpage courant sur une grosse application : le fichier racine ne
  // contient que des require. Le compter comme vide serait un faux positif.
  assert.equal(
    etatFichierSeeds('require_relative "seeds/demo"\nrequire_relative "seeds/users"\n'),
    ETAT_SEEDS.UTILE,
  );
  assert.equal(etatFichierSeeds('load Rails.root.join("db/seeds/demo.rb")\n'), ETAT_SEEDS.UTILE);
});

// --- Conditions de déclenchement --------------------------------------------

test("aucune commande et aucun db/seeds.rb : la sandbox sera vide", () => {
  assert.deepEqual(codes({ seedsFile: ETAT_SEEDS.ABSENT }), ["sandbox-sans-donnees"]);
});

test("un db/seeds.rb vide déclenche aussi : la commande par défaut n'insérera rien", () => {
  assert.deepEqual(codes({ seedsFile: ETAT_SEEDS.VIDE }), ["sandbox-sans-donnees"]);
});

test("le message dit ce que le visiteur verra, pas seulement ce qui manque", () => {
  const [finding] = sandboxSansDonneesFindings({ seedsFile: ETAT_SEEDS.ABSENT });
  assert.match(finding.message, /vide/);
  assert.match(finding.message, /démonstration/);
});

test("le diagnostic est un AVERTISSEMENT, jamais un refus", () => {
  // Une application vitrine peut légitimement n'avoir aucune donnée : refuser
  // interdirait des sandboxes parfaitement valides.
  const [finding] = sandboxSansDonneesFindings({ seedsFile: ETAT_SEEDS.ABSENT });
  assert.equal(finding.severity, "warning");
});

test("l'état du fichier voyage dans les détails, pour le journal de build", () => {
  const [finding] = sandboxSansDonneesFindings({ seedsFile: ETAT_SEEDS.VIDE });
  assert.equal(finding.details.seedsFile, ETAT_SEEDS.VIDE);
});

// --- Silences attendus -------------------------------------------------------

test("une commande de seed déclarée dans railsbox.yml fait taire le contrôle", () => {
  // Même sans db/seeds.rb : la commande déclarée peut viser un fichier séparé
  // (bin/rails runner db/seeds/demo.rb), et l'analyse statique n'a pas à juger
  // ce qu'elle insère.
  assert.deepEqual(
    codes({ seedsFile: ETAT_SEEDS.ABSENT, seedCommand: "bin/rails runner db/seeds/demo.rb" }),
    [],
  );
  assert.deepEqual(codes({ seedsFile: ETAT_SEEDS.VIDE, seedCommand: "bin/rails db:seed" }), []);
});

test("un db/seeds.rb qui amorce vraiment fait taire le contrôle", () => {
  assert.deepEqual(codes({ seedsFile: ETAT_SEEDS.UTILE }), []);
});

test("une commande déclarée mais blanche ne compte pas pour une commande", () => {
  assert.deepEqual(codes({ seedsFile: ETAT_SEEDS.ABSENT, seedCommand: "   " }), [
    "sandbox-sans-donnees",
  ]);
});

// --- Câblage dans la détection et le rapport ---------------------------------

const createdDirs = [];

/**
 * Crée une application factice dans un dossier temporaire.
 * @param {Record<string, string>} files chemins relatifs vers contenus
 * @returns {Promise<string>} racine du dossier créé
 */
async function createApp(files) {
  const dir = await mkdtemp(join(tmpdir(), "railsbox-seeds-"));
  createdDirs.push(dir);
  for (const [relativePath, content] of Object.entries(files)) {
    const target = join(dir, relativePath);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, content, "utf8");
  }
  return dir;
}

after(async () => {
  for (const dir of createdDirs) {
    await rm(dir, { recursive: true, force: true });
  }
});

const LOCK_MINIMAL = `GEM
  remote: https://rubygems.org/
  specs:
    rails (7.1.3.4)

PLATFORMS
  ruby

DEPENDENCIES
  rails

BUNDLED WITH
   2.5.9
`;

test("la détection expose l'état du db/seeds.rb dans le manifeste", async () => {
  const sansSeeds = await createApp({
    Gemfile: 'source "https://rubygems.org"\ngem "rails"\n',
    "Gemfile.lock": LOCK_MINIMAL,
  });
  const { manifest } = await detectApp(sansSeeds);
  assert.equal(manifest.seedsFile, ETAT_SEEDS.ABSENT);

  const avecSeeds = await createApp({
    Gemfile: 'source "https://rubygems.org"\ngem "rails"\n',
    "Gemfile.lock": LOCK_MINIMAL,
    "db/seeds.rb": "Post.create!(title: 'Bonjour')\n",
  });
  const seede = await detectApp(avecSeeds);
  assert.equal(seede.manifest.seedsFile, ETAT_SEEDS.UTILE);
});

test("le rapport porte un remède qui explique comment déclarer un jeu de démo", () => {
  const remede = REMEDIES["sandbox-sans-donnees"];
  assert.ok(remede, "le code doit avoir un remède");
  assert.match(remede, /seed:/);
  assert.match(remede, /command:/);
  // Le disque est public et téléchargeable : aucune donnée réelle ne doit y
  // figurer (SECURITY.md).
  assert.match(remede, /SECURITY\.md/);
});

test("le remède apparaît sous le diagnostic dans le rapport rendu", () => {
  const findings = sandboxSansDonneesFindings({ seedsFile: ETAT_SEEDS.ABSENT });
  const texte = formatReport({ manifest: { ruby: "3.3.10" }, findings });
  assert.match(texte, /sandbox-sans-donnees/);
  assert.match(texte, /Remède :/);
});
