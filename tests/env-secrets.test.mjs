// Le bloc `env:` de railsbox.yml finit VERBATIM dans /app/.railsbox/app-env.sh,
// sur le disque applicatif — un artefact public que le navigateur de chaque
// visiteur télécharge et qui se monte hors ligne (SECURITY.md, « il n'y a pas
// de serveur à protéger »). Le `chmod 600` posé dessus ne protège rien : il est
// root dans sa propre VM, et le fichier .ext2 est de toute façon lisible tel
// quel.
//
// La suite ci-dessous vérifie donc qu'un vrai secret déclaré là est REFUSÉ
// avant la construction, et qu'une démonstration qui porte volontairement un
// faux jeton peut le dire — clé par clé, jamais en bloc.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  ENV_SECRET_NAME_HINTS,
  envSecretFindings,
  looksLikeSecretValue,
} from "../tools/detect/env-secrets.mjs";
import { mergeManifest, parseRailsboxYml } from "../tools/detect/manifest.mjs";
import { REMEDIES } from "../tools/detect/report.mjs";

/**
 * Raccourci : les codes de diagnostic émis pour un bloc `env:` donné.
 * @param {Record<string, string>} env variables déclarées
 * @param {readonly string[]} [assumePublic] clés assumées publiques
 * @returns {string[]} codes émis
 */
function codes(env, assumePublic = []) {
  return envSecretFindings({ env, assumePublic }).map((finding) => finding.code);
}

// --- Noms à haut risque ----------------------------------------------------

test("un nom de variable qui annonce un secret est BLOQUANT", () => {
  for (const nom of [
    "RAILS_MASTER_KEY",
    "SECRET_KEY_BASE",
    "ADMIN_PASSWORD",
    "GITHUB_TOKEN",
    "SENDGRID_API_KEY",
    "SSH_PRIVATE_KEY",
    "GOOGLE_CREDENTIALS",
    "AWS_ACCESS_KEY_ID",
  ]) {
    assert.deepEqual(
      codes({ [nom]: "peu importe" }),
      ["env-secret-published"],
      `${nom} devrait bloquer`,
    );
  }
});

test("la reconnaissance du nom ignore la casse et la position", () => {
  assert.deepEqual(codes({ mon_secret_a_moi: "x" }), ["env-secret-published"]);
  assert.deepEqual(codes({ Token: "x" }), ["env-secret-published"]);
});

test("une variable anodine passe sans un mot", () => {
  const env = {
    RAILS_ENV: "production",
    APP_HOST: "http://localhost:8080",
    RAILSBOX_KEEP_FORCE_SSL: "1",
    TZ: "Europe/Paris",
  };
  assert.deepEqual(codes(env), []);
});

test("le diagnostic nomme la clé et dit pourquoi, sans jamais citer la valeur", () => {
  const [finding] = envSecretFindings({ env: { RAILS_MASTER_KEY: "0123456789abcdef" } });

  assert.equal(finding.severity, "blocking");
  assert.equal(finding.details.key, "RAILS_MASTER_KEY");
  // Le rapport d'analyse est publié dans les journaux de CI : y recopier la
  // valeur suspecte la divulguerait une seconde fois.
  assert.equal(finding.message.includes("0123456789abcdef"), false);
  assert.match(finding.message, /RAILS_MASTER_KEY/);
  assert.match(finding.message, /disque/);
});

test("chaque clé suspecte porte son propre diagnostic", () => {
  const findings = envSecretFindings({ env: { A_SECRET: "x", B_TOKEN: "y", RAILS_ENV: "z" } });

  assert.deepEqual(
    findings.map((finding) => finding.details.key),
    ["A_SECRET", "B_TOKEN"],
  );
});

// --- Valeurs à préfixe de jeton connu --------------------------------------

test("une valeur à préfixe de jeton connu bloque même sous un nom anodin", () => {
  for (const valeur of [
    "ghp_0123456789abcdefghijklmnopqrstuvwxyz",
    "github_pat_11ABCDEFG0123456789_abcdefghijklmnopqrstuvwxyz",
    "sk_live_0123456789abcdefghij",
    "sk-proj-0123456789abcdefghijklmnopqrstuvwxyz",
    "AKIAIOSFODNN7EXAMPLE",
    "xoxb-fixture-fixture-fixture",
    "glpat-0123456789abcdefghij",
    "AIzaSyA0123456789abcdefghijklmnopqrstuvw",
    "-----BEGIN RSA PRIVATE KEY-----",
  ]) {
    assert.deepEqual(
      codes({ VALEUR_DEMO: valeur }),
      ["env-secret-published"],
      `${valeur} devrait bloquer`,
    );
  }
});

test("une valeur ordinaire ne déclenche rien", () => {
  assert.equal(looksLikeSecretValue("http://localhost:8080"), false);
  assert.equal(looksLikeSecretValue("production"), false);
  assert.equal(looksLikeSecretValue(""), false);
  // Un identifiant qui commence par « sk » sans être un jeton Stripe/OpenAI.
  assert.equal(looksLikeSecretValue("skateboard"), false);
});

// --- Dérogation nommée -----------------------------------------------------

test("une clé dérogée passe, et elle seule", () => {
  const env = { DEMO_TOKEN: "jeton-bidon", RAILS_MASTER_KEY: "0123456789abcdef" };

  assert.deepEqual(
    envSecretFindings({ env, assumePublic: ["DEMO_TOKEN"] }).map((f) => f.details.key),
    ["RAILS_MASTER_KEY"],
  );
});

test("la dérogation ne peut pas être globale", () => {
  // Ni joker ni valeur fourre-tout : une dérogation qui ne nomme pas sa clé
  // n'en couvre aucune, sinon elle reviendrait à désarmer le contrôle.
  const env = { RAILS_MASTER_KEY: "0123456789abcdef" };
  for (const derogation of [["*"], ["all"], [""], ["RAILS_MASTER_KEY2"]]) {
    assert.deepEqual(
      codes(env, derogation),
      ["env-secret-published"],
      `${derogation} ne doit rien couvrir`,
    );
  }
});

// --- Câblage dans railsbox.yml ---------------------------------------------

test("railsbox.yml déclare la dérogation en liste, comme system_packages", () => {
  const { manifest, findings } = parseRailsboxYml(
    "env_assume_public: [DEMO_TOKEN, FAKE_API_KEY]\nenv:\n  DEMO_TOKEN: jeton-bidon\n",
  );

  assert.deepEqual([...manifest.envAssumePublic], ["DEMO_TOKEN", "FAKE_API_KEY"]);
  assert.deepEqual([...findings], []);
});

test("un nom de variable invalide dans la dérogation est refusé, pas assaini", () => {
  const { findings } = parseRailsboxYml("env_assume_public: [1BAD, bad-name]\n");

  assert.deepEqual(
    findings.map((finding) => finding.code),
    ["invalid-env-assume-public", "invalid-env-assume-public"],
  );
});

test("mergeManifest bloque un secret du bloc env: déclaré", () => {
  const { findings } = mergeManifest({}, { env: { RAILS_MASTER_KEY: "0123456789abcdef" } });

  assert.deepEqual(
    findings.map((finding) => finding.code),
    ["env-secret-published"],
  );
});

test("mergeManifest respecte la dérogation déclarée à côté du bloc env:", () => {
  const { manifest, findings } = mergeManifest(
    {},
    { env: { DEMO_TOKEN: "jeton-bidon" }, envAssumePublic: ["DEMO_TOKEN"] },
  );

  assert.deepEqual([...findings], []);
  assert.equal(manifest.env.DEMO_TOKEN, "jeton-bidon");
});

test("le diagnostic a son remède dans le rapport", () => {
  assert.ok(REMEDIES["env-secret-published"]);
  assert.ok(REMEDIES["invalid-env-assume-public"]);
});

test("la liste des fragments de noms est exportée, pour que doc et tests s'y réfèrent", () => {
  assert.ok(ENV_SECRET_NAME_HINTS.includes("MASTER_KEY"));
  assert.ok(ENV_SECRET_NAME_HINTS.includes("ACCESS_KEY"));
});

test("une clé de chiffrement est reconnue comme secret par son nom", () => {
  // Trou trouvé en mangeant notre propre nourriture : la premiere application
  // privée passée au détecteur portait MEDICAL_DATA_ENCRYPTION_KEY — une clé
  // de chiffrement de données médicales — et aucun motif ne la voyait.
  const constats = envSecretFindings({ env: { MEDICAL_DATA_ENCRYPTION_KEY: "0123456789abcdef" } });
  assert.equal(constats.length, 1, "ENCRYPTION_KEY doit déclencher le refus");
  assert.equal(constats[0].details.key, "MEDICAL_DATA_ENCRYPTION_KEY");
});

test("une clé de signature est reconnue comme secret par son nom", () => {
  const constats = envSecretFindings({ env: { JWT_SIGNING_KEY: "0123456789abcdef" } });
  assert.equal(constats.length, 1, "SIGNING_KEY doit déclencher le refus");
});
