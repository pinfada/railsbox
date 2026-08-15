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
const DEVISE_LINE =
  '{"timestamp":"2026-08-15T15:19:23.928+02:00","severity":"WARN","message":"[DEVISE] GOOGLE_CLIENT_ID/SECRET absent — Google OAuth strategy not registered."}';

// Messages réellement rencontrés pendant la mise au point de ce projet.
const REAL_FAILURES = [
  ["SIDEKIQ_USERNAME must be set in production", "SIDEKIQ_USERNAME"],
  ['KeyError: key not found: "AWS_SECRET_ACCESS_KEY"', "AWS_SECRET_ACCESS_KEY"],
  ["ACCESS_MASTER_SIGNING_KEY is missing or empty", "ACCESS_MASTER_SIGNING_KEY"],
  ["COMPLIANCE_PSEUDONYMIZATION_KEY must be at least 32 bytes", "COMPLIANCE_PSEUDONYMIZATION_KEY"],
  ["Missing required environment variable: MAILER_SENDER", "MAILER_SENDER"],
  ["La clé STRIPE_SECRET_KEY est manquante", "STRIPE_SECRET_KEY"],
];

test("detectVariablesInLine reconnaît les formulations d'échec courantes", () => {
  for (const [line, expected] of REAL_FAILURES) {
    assert.ok(
      detectVariablesInLine(line).includes(expected),
      `« ${line} » aurait dû révéler ${expected} (obtenu: ${detectVariablesInLine(line)})`,
    );
  }
});

test("detectVariablesInLine ignore les lignes de log ordinaires", () => {
  const ordinaryLines = [
    "Completed 200 OK in 27937ms (Views: 4516.0ms | ActiveRecord: 8286.4ms)",
    "[Rack::Attack] Event triggered: matched=allow localhost",
    "Puma starting in single mode...",
  ];
  for (const line of ordinaryLines) {
    assert.deepEqual(detectVariablesInLine(line), [], `faux positif sur « ${line} »`);
  }
});

test("detectVariablesInLine écarte les variables d'infrastructure", () => {
  assert.deepEqual(detectVariablesInLine("PATH is missing"), []);
  assert.deepEqual(detectVariablesInLine('key not found: "RAILS_ENV"'), []);
});

test("les étiquettes de journal entre crochets ne sont pas des variables", () => {
  const names = detectVariablesInLine(DEVISE_LINE);
  assert.ok(!names.includes("DEVISE"), "[DEVISE] est un sous-système, pas une variable");
  assert.ok(names.includes("GOOGLE_CLIENT_ID"), `attendu GOOGLE_CLIENT_ID, obtenu ${names}`);
  assert.ok(
    names.includes("GOOGLE_CLIENT_SECRET"),
    "le raccourci ID/SECRET désigne deux variables",
  );
});

test("severityOfLine distingue avertissement et échec bloquant", () => {
  assert.equal(severityOfLine(DEVISE_LINE), "warning");
  assert.equal(severityOfLine('{"severity":"FATAL","message":"boom"}'), "critical");
  assert.equal(severityOfLine("[Compliance::SigningKey] FATAL: clé absente"), "critical");
  assert.equal(severityOfLine("warning: already initialized constant X"), "warning");
  assert.equal(severityOfLine("SIDEKIQ_USERNAME must be set in production"), "critical");
});

test("une variable seulement avertie n'est pas comptée comme bloquante", () => {
  const registry = createEnvironmentRegistry();
  registry.ingestLogLine(DEVISE_LINE);
  const blocking = registry.list().filter((v) => v.severity === "critical");
  assert.equal(blocking.length, 0, "un WARN ne doit bloquer aucun démarrage");

  // La même variable citée plus tard dans une erreur fatale devient bloquante.
  registry.ingestLogLine('{"severity":"FATAL","message":"GOOGLE_CLIENT_ID is missing"}');
  assert.equal(registry.list().find((v) => v.name === "GOOGLE_CLIENT_ID").severity, "critical");
});

test("expandKnownGroups complète le triplet de chiffrement Active Record", () => {
  const names = expandKnownGroups([], "Missing Active Record encryption keys in production!");
  assert.equal(names.length, 3);
  assert.ok(names.every((n) => n.startsWith("ACTIVE_RECORD_ENCRYPTION_")));
});

test("classifyVariable distingue secrets internes et services tiers", () => {
  const internal = classifyVariable("ACCESS_MASTER_SIGNING_KEY");
  assert.equal(internal.kind, "internal");
  assert.ok(internal.mockable);
  assert.match(internal.generate(), /^[0-9a-f]{64}$/, "clé hexadécimale de 32 octets");

  const base = classifyVariable("SECRET_KEY_BASE");
  assert.match(base.generate(), /^[0-9a-f]{128}$/, "SECRET_KEY_BASE fait 64 octets");

  const external = classifyVariable("GOOGLE_CLIENT_SECRET");
  assert.equal(external.kind, "external");
  assert.equal(external.mockable, false, "aucune valeur inventée ne peut marcher");
  assert.equal(external.generate(), "");

  // Exception : Stripe valide un FORMAT localement, un faux au bon format passe.
  const stripe = classifyVariable("STRIPE_SECRET_KEY");
  assert.equal(stripe.kind, "external");
  assert.ok(stripe.mockable);
  assert.match(stripe.generate(), /^sk_live_[A-Za-z0-9]{24}$/);
});

test("le registre accumule, remplit les mocks et n'exporte que le rempli", () => {
  const registry = createEnvironmentRegistry();
  assert.deepEqual(registry.ingestLogLine("SIDEKIQ_USERNAME must be set in production"), [
    "SIDEKIQ_USERNAME",
  ]);
  assert.deepEqual(
    registry.ingestLogLine("SIDEKIQ_USERNAME must be set in production"),
    [],
    "pas de doublon",
  );
  registry.ingestLogLine("GOOGLE_CLIENT_SECRET is missing");
  assert.equal(registry.size, 2);

  const filledCount = registry.fillMocks();
  assert.equal(filledCount, 1, "seule la variable interne est simulable");

  const payload = registry.toPayload();
  assert.deepEqual(Object.keys(payload), ["SIDEKIQ_USERNAME"]);
  assert.equal(payload.GOOGLE_CLIENT_SECRET, undefined, "une valeur vide n'est jamais envoyée");

  registry.setValue("GOOGLE_CLIENT_SECRET", "valeur-fournie");
  assert.equal(registry.toPayload().GOOGLE_CLIENT_SECRET, "valeur-fournie");
});

test("le registre trie les internes avant les externes et refuse les noms invalides", () => {
  const registry = createEnvironmentRegistry();
  registry.add("ZZZ_API_KEY");
  registry.add("AAA_SIGNING_KEY");
  assert.deepEqual(
    registry.list().map((v) => v.name),
    ["AAA_SIGNING_KEY", "ZZZ_API_KEY"],
  );
  assert.equal(registry.add("nom invalide"), false);
  assert.equal(registry.add("AAA_SIGNING_KEY"), false, "pas de doublon");
});

test("hydrate restaure les valeurs d'une session précédente", () => {
  const registry = createEnvironmentRegistry();
  registry.hydrate({ MON_SECRET: "abc" });
  assert.equal(registry.size, 1);
  assert.equal(registry.toPayload().MON_SECRET, "abc");
});
