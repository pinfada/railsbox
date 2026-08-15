import { test } from "node:test";
import assert from "node:assert/strict";
import {
  classifyVariable,
  createEnvironmentRegistry,
  detectVariablesInLine,
  expandKnownGroups,
  severityOfLine,
} from "../public/shared/env-detector.js";

// Ligne authentique observée pendant le test de la VM : elle piégeait la
// détection à deux titres — l'étiquette [DEVISE] était prise pour une
// variable, et l'avertissement était classé bloquant alors qu'il ne l'est pas.
const LIGNE_DEVISE =
  '{"timestamp":"2026-08-15T15:19:23.928+02:00","severity":"WARN","message":"[DEVISE] GOOGLE_CLIENT_ID/SECRET absent — Google OAuth strategy not registered."}';

// Messages réellement rencontrés pendant la mise au point de ce projet.
const VRAIS_ECHECS = [
  ['SIDEKIQ_USERNAME must be set in production', "SIDEKIQ_USERNAME"],
  ['KeyError: key not found: "AWS_SECRET_ACCESS_KEY"', "AWS_SECRET_ACCESS_KEY"],
  ["ACCESS_MASTER_SIGNING_KEY is missing or empty", "ACCESS_MASTER_SIGNING_KEY"],
  ["COMPLIANCE_PSEUDONYMIZATION_KEY must be at least 32 bytes", "COMPLIANCE_PSEUDONYMIZATION_KEY"],
  ["Missing required environment variable: MAILER_SENDER", "MAILER_SENDER"],
  ["La clé STRIPE_SECRET_KEY est manquante", "STRIPE_SECRET_KEY"],
];

test("detectVariablesInLine reconnaît les formulations d'échec courantes", () => {
  for (const [ligne, attendu] of VRAIS_ECHECS) {
    assert.ok(
      detectVariablesInLine(ligne).includes(attendu),
      `« ${ligne} » aurait dû révéler ${attendu} (obtenu: ${detectVariablesInLine(ligne)})`,
    );
  }
});

test("detectVariablesInLine ignore les lignes de log ordinaires", () => {
  const ordinaires = [
    'Completed 200 OK in 27937ms (Views: 4516.0ms | ActiveRecord: 8286.4ms)',
    "[Rack::Attack] Event triggered: matched=allow localhost",
    "Puma starting in single mode...",
  ];
  for (const ligne of ordinaires) {
    assert.deepEqual(detectVariablesInLine(ligne), [], `faux positif sur « ${ligne} »`);
  }
});

test("detectVariablesInLine écarte les variables d'infrastructure", () => {
  assert.deepEqual(detectVariablesInLine("PATH is missing"), []);
  assert.deepEqual(detectVariablesInLine('key not found: "RAILS_ENV"'), []);
});

test("les étiquettes de journal entre crochets ne sont pas des variables", () => {
  const noms = detectVariablesInLine(LIGNE_DEVISE);
  assert.ok(!noms.includes("DEVISE"), "[DEVISE] est un sous-système, pas une variable");
  assert.ok(noms.includes("GOOGLE_CLIENT_ID"), `attendu GOOGLE_CLIENT_ID, obtenu ${noms}`);
  assert.ok(noms.includes("GOOGLE_CLIENT_SECRET"), "le raccourci ID/SECRET désigne deux variables");
});

test("severityOfLine distingue avertissement et échec bloquant", () => {
  assert.equal(severityOfLine(LIGNE_DEVISE), "avertissement");
  assert.equal(severityOfLine('{"severity":"FATAL","message":"boom"}'), "critique");
  assert.equal(severityOfLine("[Compliance::SigningKey] FATAL: clé absente"), "critique");
  assert.equal(severityOfLine("warning: already initialized constant X"), "avertissement");
  assert.equal(severityOfLine("SIDEKIQ_USERNAME must be set in production"), "critique");
});

test("une variable seulement avertie n'est pas comptée comme bloquante", () => {
  const registre = createEnvironmentRegistry();
  registre.ingestLogLine(LIGNE_DEVISE);
  const bloquantes = registre.list().filter((v) => v.gravite === "critique");
  assert.equal(bloquantes.length, 0, "un WARN ne doit bloquer aucun démarrage");

  // La même variable citée plus tard dans une erreur fatale devient bloquante.
  registre.ingestLogLine('{"severity":"FATAL","message":"GOOGLE_CLIENT_ID is missing"}');
  assert.equal(registre.list().find((v) => v.name === "GOOGLE_CLIENT_ID").gravite, "critique");
});

test("expandKnownGroups complète le triplet de chiffrement Active Record", () => {
  const noms = expandKnownGroups([], "Missing Active Record encryption keys in production!");
  assert.equal(noms.length, 3);
  assert.ok(noms.every((n) => n.startsWith("ACTIVE_RECORD_ENCRYPTION_")));
});

test("classifyVariable distingue secrets internes et services tiers", () => {
  const interne = classifyVariable("ACCESS_MASTER_SIGNING_KEY");
  assert.equal(interne.kind, "interne");
  assert.ok(interne.mockable);
  assert.match(interne.generate(), /^[0-9a-f]{64}$/, "clé hexadécimale de 32 octets");

  const base = classifyVariable("SECRET_KEY_BASE");
  assert.match(base.generate(), /^[0-9a-f]{128}$/, "SECRET_KEY_BASE fait 64 octets");

  const externe = classifyVariable("GOOGLE_CLIENT_SECRET");
  assert.equal(externe.kind, "externe");
  assert.equal(externe.mockable, false, "aucune valeur inventée ne peut marcher");
  assert.equal(externe.generate(), "");

  // Exception : Stripe valide un FORMAT localement, un faux au bon format passe.
  const stripe = classifyVariable("STRIPE_SECRET_KEY");
  assert.equal(stripe.kind, "externe");
  assert.ok(stripe.mockable);
  assert.match(stripe.generate(), /^sk_live_[A-Za-z0-9]{24}$/);
});

test("le registre accumule, remplit les mocks et n'exporte que le rempli", () => {
  const registre = createEnvironmentRegistry();
  assert.deepEqual(registre.ingestLogLine("SIDEKIQ_USERNAME must be set in production"), ["SIDEKIQ_USERNAME"]);
  assert.deepEqual(registre.ingestLogLine("SIDEKIQ_USERNAME must be set in production"), [], "pas de doublon");
  registre.ingestLogLine("GOOGLE_CLIENT_SECRET is missing");
  assert.equal(registre.size, 2);

  const remplies = registre.fillMocks();
  assert.equal(remplies, 1, "seule la variable interne est simulable");

  const charge = registre.toPayload();
  assert.deepEqual(Object.keys(charge), ["SIDEKIQ_USERNAME"]);
  assert.equal(charge.GOOGLE_CLIENT_SECRET, undefined, "une valeur vide n'est jamais envoyée");

  registre.setValue("GOOGLE_CLIENT_SECRET", "valeur-fournie");
  assert.equal(registre.toPayload().GOOGLE_CLIENT_SECRET, "valeur-fournie");
});

test("le registre trie les internes avant les externes et refuse les noms invalides", () => {
  const registre = createEnvironmentRegistry();
  registre.add("ZZZ_API_KEY");
  registre.add("AAA_SIGNING_KEY");
  assert.deepEqual(registre.list().map((v) => v.name), ["AAA_SIGNING_KEY", "ZZZ_API_KEY"]);
  assert.equal(registre.add("nom invalide"), false);
  assert.equal(registre.add("AAA_SIGNING_KEY"), false, "pas de doublon");
});

test("hydrate restaure les valeurs d'une session précédente", () => {
  const registre = createEnvironmentRegistry();
  registre.hydrate({ MON_SECRET: "abc" });
  assert.equal(registre.size, 1);
  assert.equal(registre.toPayload().MON_SECRET, "abc");
});
