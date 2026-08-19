// Gems qui contactent un service DISTANT, et ce que cela coûte dans la VM.
//
// railsbox n'a AUCUN réseau sortant (voir SECURITY.md, « Principe fondamental ») :
// la VM n'a qu'un loopback émulé. Une application dont un initialiseur, un
// `db:prepare` ou un simple démarrage sollicite un service distant n'échoue pas
// à la détection ni à l'installation des gems — elle échoue VINGT MINUTES plus
// tard, à la capture de l'instantané, sur un message qui ne nomme jamais la
// cause. Le cas fondateur : `aws-sdk-s3` interroge l'adresse de métadonnées
// d'instance (169.254.169.254) pour obtenir des identifiants IAM, et la
// remontée d'erreur parle de « missing required option :name », pas de réseau.
//
// Ce module ne REFUSE rien : la présence d'une gem ne prouve pas qu'elle sera
// sollicitée au démarrage. Une application peut porter `stripe` et ne l'appeler
// que sur un clic. L'avertissement dit ce qui va casser SI la gem est
// sollicitée, et comment l'éviter — c'est tout ce qu'une analyse statique peut
// honnêtement affirmer.

import { SEVERITY, createFinding } from "./findings.mjs";

/** @typedef {import("./findings.mjs").Finding} Finding */

/**
 * Gems nommées une à une, avec le service qu'elles contactent. Le libellé sert
 * le message : « aws-sdk-s3 (Amazon S3) » se comprend sans documentation.
 */
export const SERVICES_EXTERNES = Object.freeze({
  "aws-sdk-s3": "Amazon S3",
  "aws-sdk-core": "Amazon Web Services",
  "google-cloud-storage": "Google Cloud Storage",
  "azure-storage-blob": "Azure Blob Storage",
  stripe: "Stripe",
  braintree: "Braintree",
  "sendgrid-ruby": "SendGrid",
  mailgun: "Mailgun",
  postmark: "Postmark",
  twilio: "Twilio",
  "sentry-ruby": "Sentry",
  "sentry-rails": "Sentry",
  bugsnag: "Bugsnag",
  rollbar: "Rollbar",
  honeybadger: "Honeybadger",
  newrelic_rpm: "New Relic",
  "datadog-ci": "Datadog",
  ddtrace: "Datadog",
  elasticsearch: "Elasticsearch",
  "opensearch-ruby": "OpenSearch",
  "aws-sdk-rails": "Amazon Web Services",
  "google-apis-core": "Google APIs",
  "omniauth-oauth2": "un fournisseur OAuth",
  octokit: "l'API GitHub",
  cloudinary: "Cloudinary",
  algolia: "Algolia",
  algoliasearch: "Algolia",
});

/**
 * Familles entières, reconnues par préfixe : `aws-sdk-*` compte des dizaines de
 * gems, et les énumérer produirait une liste morte le jour de la suivante.
 */
const FAMILLES = Object.freeze([
  { prefixe: "aws-sdk-", service: "Amazon Web Services" },
  { prefixe: "google-cloud-", service: "Google Cloud" },
  { prefixe: "google-apis-", service: "Google APIs" },
  { prefixe: "azure-", service: "Microsoft Azure" },
  { prefixe: "omniauth-", service: "un fournisseur d'identité" },
]);

/**
 * Le service distant qu'une gem contacte, ou null si elle n'en contacte aucun
 * de connu. Le nom exact prime sur la famille : `aws-sdk-s3` est plus précis
 * que « Amazon Web Services ».
 * @param {string} gem nom de la gem
 * @returns {string | null}
 */
export function serviceDistant(gem) {
  const nom = String(gem);
  if (Object.hasOwn(SERVICES_EXTERNES, nom)) return SERVICES_EXTERNES[nom];
  const famille = FAMILLES.find((f) => nom.startsWith(f.prefixe));
  return famille ? famille.service : null;
}

/**
 * Diagnostic unique nommant toutes les gems concernées.
 *
 * UN SEUL diagnostic, pas un par gem : une application moderne en porte
 * facilement cinq, et cinq lignes identiques noieraient le reste du rapport
 * sans rien apprendre de plus.
 * @param {Set<string> | Iterable<string>} specs noms de gems du Gemfile.lock
 * @returns {readonly Finding[]} zéro ou un diagnostic, gelé
 */
export function externalServiceFindings(specs) {
  const trouvees = [];
  for (const gem of specs ?? []) {
    const service = serviceDistant(gem);
    if (service !== null) trouvees.push({ gem: String(gem), service });
  }
  if (trouvees.length === 0) return Object.freeze([]);

  trouvees.sort((a, b) => a.gem.localeCompare(b.gem));
  const liste = trouvees.map(({ gem, service }) => `${gem} (${service})`).join(", ");
  return Object.freeze([
    createFinding(
      SEVERITY.WARNING,
      "service-externe-au-demarrage",
      `${trouvees.length} gem${trouvees.length > 1 ? "s contactent" : " contacte"} un service ` +
        `distant : ${liste}. La VM railsbox n'a AUCUN réseau sortant. Si l'une d'elles est ` +
        `sollicitée au démarrage — un initialiseur, une configuration ActiveStorage, un client ` +
        `construit au boot — l'application échouera dans la sandbox, et le message d'erreur ne ` +
        `nommera pas le réseau : un SDK cloud cherche d'abord ses identifiants sur l'adresse de ` +
        `métadonnées d'instance (169.254.169.254) et se plaint ensuite d'une option manquante.`,
      { gems: Object.freeze(trouvees.map((t) => t.gem)) },
    ),
  ]);
}
