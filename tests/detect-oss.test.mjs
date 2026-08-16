// Contrôle de détection sur de VRAIES applications Rails open source.
//
// Le panel des variantes de démonstration (panel-variantes.test.mjs) fige des
// applications que NOUS écrivons : il prouve la cohérence, pas la
// représentativité. Ces deux dépôts-là, personne chez railsbox ne les tient —
// et ils couvrent exactement les deux façons d'atterrir sur l'étage amd64 :
//
//   rubygems.org  gem à exécutable (tailwindcss-ruby), aucun package.json
//   mastodon      chaîne npm (et un verrou yarn que railsbox ne relit pas)
//
// La suite s'IGNORE tant que les clones ne sont pas là : `npm test` ne doit
// dépendre ni du réseau ni de GitHub. C'est le workflow valider-variantes.yml
// qui les clone (--depth 1) et pose RAILSBOX_OSS_DIR.
//
//   git clone --depth 1 https://github.com/rubygems/rubygems.org .oss/rubygems.org
//   RAILSBOX_OSS_DIR=.oss npm test
//
// Les assertions sont volontairement étroites : l'adaptateur, l'étage de
// précompilation, la présence d'une chaîne npm, les gems à binaire. Tout le
// reste (versions de Ruby, de Rails, listes de gems natives) bouge chez eux
// sans rien dire de notre classement, et figer ce bruit rendrait la suite
// rouge pour des raisons qui ne nous concernent pas.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { detectApp } from "../tools/detect/detect.mjs";
import { hasBlocking } from "../tools/detect/report.mjs";

const PROJECT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const CONFIGURED = process.env.RAILSBOX_OSS_DIR ?? ".oss";
const OSS_DIR = isAbsolute(CONFIGURED) ? CONFIGURED : join(PROJECT_ROOT, CONFIGURED);

/**
 * Applications de contrôle, et ce que railsbox doit en déduire.
 * `clone` est la commande que la CI exécute : la garder ici évite qu'elle
 * dérive du dossier attendu par le test.
 */
const APPLICATIONS = Object.freeze([
  {
    dossier: "rubygems.org",
    depot: "https://github.com/rubygems/rubygems.org",
    attendu: {
      database: "postgresql",
      stage: "amd64",
      npm: false,
      binaryGems: ["tailwindcss-rails", "tailwindcss-ruby"],
    },
  },
  {
    dossier: "mastodon",
    depot: "https://github.com/mastodon/mastodon",
    attendu: {
      database: "postgresql",
      stage: "amd64",
      npm: true,
      binaryGems: [],
    },
  },
]);

for (const { dossier, depot, attendu } of APPLICATIONS) {
  const appDir = join(OSS_DIR, dossier);
  const present = existsSync(join(appDir, "Gemfile.lock"));

  test(
    `détection sur ${dossier} (application OSS réelle)`,
    { skip: present ? false : `clone absent : git clone --depth 1 ${depot} ${appDir}` },
    async () => {
      // Arrange / Act
      const { manifest, findings } = await detectApp(appDir);

      // Assert
      assert.equal(manifest.database, attendu.database);
      assert.equal(manifest.assets.stage, attendu.stage);
      assert.equal(manifest.assets.npm, attendu.npm);
      assert.deepEqual([...manifest.assets.binaryGems], attendu.binaryGems);
      // Un refus sur une application réelle et supportée serait une régression
      // du classement, pas un verdict sur l'application.
      assert.equal(hasBlocking(findings), false, "aucune de ces applications ne doit être refusée");
      // Ces dépôts sont des applications Rails : le détecteur doit les
      // reconnaître comme telles, sans quoi tout le reste est un hasard.
      assert.ok(manifest.rails, "la version de Rails doit être résolue depuis le Gemfile.lock");
      assert.ok(manifest.ruby, "la version de Ruby doit être résolue");
    },
  );
}
