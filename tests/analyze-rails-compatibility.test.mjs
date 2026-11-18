import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const RACINE = join(dirname(fileURLToPath(import.meta.url)), "..");
const SCRIPT = join(RACINE, "tools", "analyze-rails-compatibility.ps1");
const POWERSHELL = process.platform === "win32" ? "powershell.exe" : "pwsh";

function ligneCsv(ligne) {
  const valeurs = [];
  let valeur = "";
  let guillemets = false;
  for (let i = 0; i < ligne.length; i += 1) {
    const caractere = ligne[i];
    if (caractere === '"') {
      if (guillemets && ligne[i + 1] === '"') {
        valeur += '"';
        i += 1;
      } else {
        guillemets = !guillemets;
      }
    } else if (caractere === "," && !guillemets) {
      valeurs.push(valeur);
      valeur = "";
    } else {
      valeur += caractere;
    }
  }
  valeurs.push(valeur);
  return valeurs;
}

function ecrire(racine, relatif, contenu = "") {
  const chemin = join(racine, relatif);
  mkdirSync(dirname(chemin), { recursive: true });
  writeFileSync(chemin, contenu);
}

test("les commentaires et services externes ne dégradent pas le verdict", () => {
  const racine = mkdtempSync(join(tmpdir(), "railsbox-analyse-"));
  const sortie = join(racine, "analyse.csv");
  ecrire(racine, "config/application.rb");
  ecrire(racine, "bin/rails");
  ecrire(
    racine,
    "Gemfile",
    `# gem "mysql2"
# gem "aws-sdk-s3"
ruby "3.3.12"
gem "pg"
gem "stripe"
`,
  );
  ecrire(racine, "db/seeds.rb", 'User.create!(email: "demo@example.test")\n');
  ecrire(racine, "LICENSE", "MIT License\n");

  try {
    const resultat = spawnSync(
      POWERSHELL,
      [
        "-NoProfile",
        "-ExecutionPolicy",
        "Bypass",
        "-File",
        SCRIPT,
        "-Chemin",
        racine,
        "-Sortie",
        sortie,
      ],
      { encoding: "utf8" },
    );
    assert.equal(resultat.status, 0, `${resultat.stdout}\n${resultat.stderr}`);

    const lignes = readFileSync(sortie, "utf8")
      .replace(/^\uFEFF/, "")
      .trim()
      .split(/\r?\n/);
    const entetes = ligneCsv(lignes[0]);
    const valeurs = ligneCsv(lignes[1]);
    const analyse = Object.fromEntries(entetes.map((nom, index) => [nom, valeurs[index]]));

    assert.equal(analyse.Verdict, "compatible");
    assert.equal(analyse.Base, "postgresql", "le mysql commenté ne compte pas");
    assert.equal(analyse.Externes, "stripe", "inventorié, mais pas transformé en réserve");
    assert.equal(analyse.Reserves, "");
  } finally {
    rmSync(racine, { recursive: true, force: true });
  }
});
