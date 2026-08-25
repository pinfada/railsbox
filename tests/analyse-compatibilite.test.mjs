import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const shell = process.platform === "win32" ? "powershell.exe" : "pwsh";
const script = join(process.cwd(), "tools", "analyze-rails-compatibility.ps1");

function analyseLicense(license, omit = false) {
  const licenseProperty = omit ? "" : `Licence = '${license}'`;
  const command = `
. '${script.replaceAll("'", "''")}'
$source = [PSCustomObject]@{
  Nom = 'fixture'; EstApp = $true; Gemfile = 'gem "sqlite3"'; Seeds = 'User.create!'; RubyVersion = '3.3.12'; Readme = ''
  ${licenseProperty}
}
Get-Analyse -Source $source | ConvertTo-Json -Compress
`;
  const result = spawnSync(shell, ["-NoProfile", "-Command", command], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout.trim().split(/\r?\n/).at(-1));
}

test("les licences reconnues ne bloquent pas la qualification", () => {
  for (const license of ["MIT", "Apache-2.0", "GPL-3.0"]) {
    assert.equal(analyseLicense(license).Bloquants, "", license);
  }
});

test("la qualification locale reconnait les noms de fichiers de licence usuels", () => {
  for (const filename of ["LICENSE.txt", "LICENCE.md", "COPYING"]) {
    const root = mkdtempSync(join(tmpdir(), "railsbox-license-"));
    try {
      mkdirSync(join(root, "config"));
      mkdirSync(join(root, "bin"));
      mkdirSync(join(root, "db"));
      writeFileSync(join(root, "config", "application.rb"), "");
      writeFileSync(join(root, "bin", "rails"), "");
      writeFileSync(join(root, "Gemfile"), 'gem "sqlite3"');
      writeFileSync(join(root, "db", "seeds.rb"), "User.create!");
      writeFileSync(join(root, filename), "GNU General Public License");
      const command = `. '${script.replaceAll("'", "''")}'\nGet-ContenuLocal -Racine '${root.replaceAll("'", "''")}' | ConvertTo-Json -Compress`;
      const result = spawnSync(shell, ["-NoProfile", "-Command", command], { encoding: "utf8" });
      assert.equal(result.status, 0, result.stderr);
      assert.equal(JSON.parse(result.stdout.trim().split(/\r?\n/).at(-1)).Licence, "GPL", filename);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }
});

test("une licence non établie bloque la redistribution", () => {
  const cases = /** @type {Array<[string, boolean]>} */ ([
    ["NOASSERTION", false],
    ["", false],
    ["", true],
  ]);
  for (const [license, omit] of cases) {
    const analysis = analyseLicense(license, omit);
    assert.match(analysis.Verdict, /^bloqu/);
    assert.match(
      analysis.Bloquants,
      /RailsBox ne peut pas conclure que la redistribution est autoris/,
    );
  }
});
