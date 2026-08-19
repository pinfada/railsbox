// Le réseau sortant n'existe pas dans la VM (SECURITY.md). Une application
// dont une gem contacte un service au démarrage échoue APRÈS vingt minutes de
// construction, sur un message que rien ne relie à cette contrainte — vécu
// avec aws-sdk-s3, qui interroge l'adresse de métadonnées d'instance
// (169.254.169.254) pour ses identifiants.
import test from "node:test";
import assert from "node:assert/strict";
import { SERVICES_EXTERNES, externalServiceFindings } from "../tools/detect/services-externes.mjs";

test("aws-sdk-s3 déclenche un avertissement nommant le service", () => {
  const findings = externalServiceFindings(new Set(["aws-sdk-s3", "rails"]));
  assert.equal(findings.length, 1);
  assert.equal(findings[0].code, "service-externe-au-demarrage");
  assert.match(findings[0].message, /aws-sdk-s3/);
  assert.match(findings[0].message, /Amazon S3/);
});

test("plusieurs gems produisent un seul diagnostic qui les nomme toutes", () => {
  const findings = externalServiceFindings(new Set(["aws-sdk-s3", "stripe", "sendgrid-ruby"]));
  assert.equal(findings.length, 1, "un seul diagnostic, pas un par gem");
  for (const gem of ["aws-sdk-s3", "stripe", "sendgrid-ruby"]) {
    assert.match(findings[0].message, new RegExp(gem));
  }
});

test("une application sans service externe ne déclenche rien", () => {
  assert.deepEqual(externalServiceFindings(new Set(["rails", "puma", "pg"])), []);
});

test("le diagnostic est un AVERTISSEMENT, jamais un refus", () => {
  // La gem peut être présente sans être sollicitée au démarrage : refuser
  // interdirait des applications qui fonctionnent parfaitement.
  const findings = externalServiceFindings(new Set(["aws-sdk-s3"]));
  assert.equal(findings[0].severity, "warning");
});

test("le catalogue est exporté, pour que doc et tests s'y réfèrent", () => {
  assert.ok(SERVICES_EXTERNES["aws-sdk-s3"]);
  assert.equal(typeof SERVICES_EXTERNES["aws-sdk-s3"], "string");
});

test("les familles de gems à préfixe sont reconnues", () => {
  // aws-sdk-* compte des dizaines de gems : les nommer une à une serait une
  // liste morte le jour de la suivante.
  const findings = externalServiceFindings(new Set(["aws-sdk-dynamodb"]));
  assert.equal(findings.length, 1);
  assert.match(findings[0].message, /aws-sdk-dynamodb/);
});
