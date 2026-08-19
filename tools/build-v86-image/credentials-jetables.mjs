// Credentials JETABLES : ce qui permet à une application Rails ORDINAIRE de
// démarrer dans la sandbox sans que sa vraie clé de chiffrement en approche.
//
// Le problème. `config/credentials.yml.enc` est versionné par tout `rails new`
// depuis 5.2 ; `config/master.key` ne l'est jamais — le `.gitignore` généré
// l'exclut, et c'est la bonne pratique. railsbox ne reçoit donc, d'un dépôt
// tiers, que la moitié chiffrée d'une paire. Tant que rien ne lit les
// credentials, l'absence de clé passe inaperçue. Mais `config.require_master_key
// = true` — présent dans le `production.rb` de beaucoup d'applications — la rend
// fatale : Rails refuse de démarrer, et `assets:precompile` meurt sur « Missing
// encryption key to decrypt file with ». La panne tombe au milieu du build
// Docker, et rien dans le journal ne dit que la cause est une clé absente.
//
// Pourquoi on ne peut pas simplement transporter la vraie clé. Le disque
// applicatif est PUBLIC : chaque visiteur le télécharge, et un curieux le monte
// hors ligne (SECURITY.md). Y déposer un `master.key` réel, ce n'est pas
// configurer l'application, c'est publier sa clé — raison pour laquelle la
// détection refuse déjà tout `…MASTER_KEY…` dans le bloc `env:` de railsbox.yml
// (detect/env-secrets.mjs). Aucune entrée du workflow réutilisable n'ouvre de
// canal pour une telle clé, et il ne faut pas en ouvrir.
//
// La parade. Substituer, DANS LE CONTEXTE DE CONSTRUCTION seulement, une paire
// NEUVE tirée au hasard ici : une clé jetable et un `credentials.yml.enc`
// qu'elle déchiffre. `require_master_key` est satisfait, l'application démarre,
// et rien de secret n'a voyagé — les valeurs publiées sont celles qu'on vient
// d'inventer pour cette construction. Une application qui lit un credential
// métier (`credentials.stripe.secret`) obtiendra `nil`, exactement comme
// aujourd'hui où le fichier est de toute façon indéchiffrable : une sandbox sert
// à faire essayer, pas à opérer un service.
//
// Le contenu ne porte que les deux entrées que RAILS LUI-MÊME lit :
// `secret_key_base` et `active_record_encryption`. La seconde n'est pas
// décorative — l'initialiseur `active_record.encryption` interroge les
// credentials à chaque démarrage, et une application qui utilise `encrypts`
// planterait sans elle.
//
// Le piège du .dockerignore. Écrire la clé dans le contexte ne suffit pas : le
// `.dockerignore` généré par Rails depuis 7.1 contient `/config/master.key` et
// `/config/credentials/*.key`, et build-app-disk.sh CONSERVE délibérément le
// `.dockerignore` de l'application (BuildKit l'applique par-dessus le filtrage).
// La clé qu'on vient d'écrire serait donc écartée du build, en silence. Les
// négations sont ajoutées à la COPIE du `.dockerignore` — jamais au dépôt.
import { createCipheriv, randomBytes } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** Environnement Rails de la sandbox : le disque est bâti et démarre en production. */
export const ENV_SANDBOX = "production";

/** Variable d'environnement qui désarme la substitution. */
export const KEEP_VARIABLE = "RAILSBOX_KEEP_CREDENTIALS";

/** Ligne posée dans le .dockerignore : sert aussi de garde d'idempotence. */
export const MARQUEUR_DOCKERIGNORE = "# railsbox : credentials jetables réintégrés au contexte";

/**
 * @typedef {object} Paire
 * @property {string} contenu chemin du fichier chiffré, relatif à la racine
 * @property {string} cle chemin de la clé, relatif à la racine
 */

/**
 * Résout la paire de credentials qu'une application Rails utilisera dans un
 * environnement donné, selon les mêmes règles que
 * `Rails::Application::Configuration#credentials` : une paire propre à
 * l'environnement prime la paire par défaut, et c'est son EXISTENCE seule qui
 * décide — pas celle de sa clé.
 * @param {string} racine racine de l'application
 * @param {string} [env] environnement Rails visé
 * @returns {Paire} chemins relatifs, séparateur `/` sur toutes les plateformes
 */
export function resoudrePaire(racine, env = ENV_SANDBOX) {
  const parEnv = `config/credentials/${env}.yml.enc`;
  if (existsSync(resolve(racine, parEnv))) {
    return { contenu: parEnv, cle: `config/credentials/${env}.key` };
  }
  return { contenu: "config/credentials.yml.enc", cle: "config/master.key" };
}

/**
 * Dit d'où viendrait la clé de déchiffrement, si elle existe.
 *
 * Deux sources, et deux seulement : le fichier versionné par l'application
 * (railsbox le respecte — sa propre application de démonstration commite le
 * sien), et `RAILS_MASTER_KEY` déclaré dans le bloc `env:` de railsbox.yml. Le
 * second cas suppose que le mainteneur a nommé la variable dans
 * `env_assume_public:`, donc qu'il assume de la publier : c'est son choix, et la
 * substitution n'a pas à le contredire.
 * @param {string} racine racine de l'application
 * @param {Paire} paire paire résolue
 * @param {string} [envManifest] fragment shell `export NOM='valeur'`
 * @returns {"fichier"|"environnement"|null} source, ou null si aucune clé
 */
export function sourceDeLaCle(racine, paire, envManifest = "") {
  if (existsSync(resolve(racine, paire.cle))) return "fichier";
  if (/^export\s+RAILS_MASTER_KEY=/m.test(envManifest)) return "environnement";
  return null;
}

/**
 * Encode un entier au format Marshal de Ruby (petites valeurs sur un octet,
 * au-delà : nombre d'octets puis petit-boutiste).
 * @param {number} valeur entier positif ou nul
 * @returns {Buffer} encodage Marshal
 */
function marshalEntier(valeur) {
  if (valeur === 0) return Buffer.from([0]);
  if (valeur < 123) return Buffer.from([valeur + 5]);
  const octets = [];
  for (let reste = valeur; reste > 0; reste = Math.floor(reste / 256)) octets.push(reste % 256);
  return Buffer.from([octets.length, ...octets]);
}

/**
 * Sérialise une chaîne binaire au format Marshal 4.8.
 *
 * `ActiveSupport::EncryptedFile` chiffre `Marshal.dump(contenu)`, pas le texte
 * brut : un fichier qui ne porterait que le YAML serait refusé au
 * déchiffrement. La forme émise ici (`\x04\x08"` sans marqueur d'encodage) est
 * celle qu'un `rails credentials:edit` produit — vérifiée octet à octet sur la
 * paire versionnée de l'application de démonstration.
 * @param {Buffer} octets contenu à envelopper
 * @returns {Buffer} flux Marshal
 */
export function marshalChaineBinaire(octets) {
  return Buffer.concat([Buffer.from([0x04, 0x08, 0x22]), marshalEntier(octets.length), octets]);
}

/**
 * Chiffre un contenu comme `ActiveSupport::EncryptedFile` : aes-128-gcm, puis
 * `base64(chiffré)--base64(iv)--base64(sceau)`.
 * @param {string} texte contenu en clair
 * @param {string} cleHex clé de 32 caractères hexadécimaux
 * @param {Buffer} [iv] vecteur d'initialisation de 12 octets (tiré au hasard sinon)
 * @returns {string} fichier `.yml.enc` prêt à écrire
 */
export function chiffrerCredentials(texte, cleHex, iv = randomBytes(12)) {
  const chiffreur = createCipheriv("aes-128-gcm", Buffer.from(cleHex, "hex"), iv);
  const charge = marshalChaineBinaire(Buffer.from(texte, "utf8"));
  const chiffre = Buffer.concat([chiffreur.update(charge), chiffreur.final()]);
  return [chiffre, iv, chiffreur.getAuthTag()].map((part) => part.toString("base64")).join("--");
}

/**
 * Compose le YAML en clair des credentials jetables.
 * @param {{secretKeyBase: string, primaryKey: string, deterministicKey: string, keyDerivationSalt: string}} valeurs secrets tirés au hasard
 * @returns {string} document YAML
 */
export function contenuCredentials(valeurs) {
  return `# Généré par railsbox — credentials JETABLES, propres à cette construction.
#
# L'application publie son fichier chiffré sans sa clé : c'est la règle, et
# railsbox ne cherche pas à la contourner. Une paire neuve la remplace ici, le
# temps de bâtir la sandbox, pour qu'une application qui exige une clé
# (config.require_master_key) démarre sans qu'aucun secret réel n'entre dans un
# disque que tout visiteur télécharge.
#
# Les valeurs ci-dessous ont été tirées au hasard à la construction. Elles ne
# protègent rien et n'ouvrent rien : les données de la sandbox sont amorcées par
# les seeds, et la VM n'a aucun réseau sortant.
secret_key_base: ${valeurs.secretKeyBase}

# Lues par l'initialiseur active_record.encryption à CHAQUE démarrage : une
# application qui déclare \`encrypts\` ne démarre pas sans elles.
active_record_encryption:
  primary_key: ${valeurs.primaryKey}
  deterministic_key: ${valeurs.deterministicKey}
  key_derivation_salt: ${valeurs.keyDerivationSalt}
`;
}

/**
 * Fabrique une paire de credentials complète.
 * @param {(taille: number) => Buffer} [alea] source d'aléa (injectable pour les tests)
 * @returns {{cle: string, contenu: string, clair: string}} clé hexadécimale, fichier chiffré, clair
 */
export function genererPaire(alea = randomBytes) {
  const hex = (taille) => Buffer.from(alea(taille)).toString("hex");
  // 16 octets : aes-128-gcm, et les 32 caractères hexadécimaux qu'exige le
  // contrôle de longueur de `EncryptedFile#check_key_length`.
  const cle = hex(16);
  const clair = contenuCredentials({
    secretKeyBase: hex(64),
    primaryKey: hex(16),
    deterministicKey: hex(16),
    keyDerivationSalt: hex(16),
  });
  return { cle, contenu: chiffrerCredentials(clair, cle), clair };
}

/**
 * Ajoute au `.dockerignore` du CONTEXTE les négations qui réintègrent la paire.
 *
 * Sans elles, BuildKit écarterait la clé qu'on vient d'écrire — le
 * `.dockerignore` de Rails l'ignore explicitement, et railsbox conserve celui de
 * l'application. Sans fichier, il n'y a aucun filtrage à contredire.
 * @param {string} racine racine du contexte de construction
 * @param {Paire} paire paire à réintégrer
 * @returns {boolean} vrai si le fichier a été complété
 */
export function reintegrerDansDockerignore(racine, paire) {
  const chemin = resolve(racine, ".dockerignore");
  if (!existsSync(chemin)) return false;
  const existant = readFileSync(chemin, "utf8");
  if (existant.includes(MARQUEUR_DOCKERIGNORE)) return false;
  const separateur = existant === "" || existant.endsWith("\n") ? "" : "\n";
  const negations = [MARQUEUR_DOCKERIGNORE, `!${paire.cle}`, `!${paire.contenu}`];
  appendFileSync(chemin, `${separateur}\n${negations.join("\n")}\n`);
  return true;
}

/**
 * @typedef {object} Substitution
 * @property {boolean} substituee vrai si une paire jetable a été écrite
 * @property {"fichier"|"environnement"|"desarme"|"aucune-cle"} raison ce qui a décidé
 * @property {Paire} paire paire concernée
 * @property {boolean} dockerignore vrai si le .dockerignore du contexte a été complété
 */

/**
 * Substitue une paire jetable dans un contexte de construction, si nécessaire.
 *
 * N'écrit JAMAIS dans le dépôt analysé : l'appelant passe la copie filtrée.
 * @param {string} racine racine du contexte de construction
 * @param {{env?: string, envManifest?: string, keep?: boolean, alea?: (taille: number) => Buffer}} [options] réglages
 * @returns {Substitution} ce qui a été fait
 */
export function substituerCredentials(racine, options = {}) {
  const { env = ENV_SANDBOX, envManifest = "", keep = false, alea = randomBytes } = options;
  const paire = resoudrePaire(racine, env);
  if (keep) return { substituee: false, raison: "desarme", paire, dockerignore: false };
  const source = sourceDeLaCle(racine, paire, envManifest);
  if (source) return { substituee: false, raison: source, paire, dockerignore: false };

  const { cle, contenu } = genererPaire(alea);
  for (const [relatif, texte] of [
    [paire.cle, cle],
    [paire.contenu, contenu],
  ]) {
    const chemin = resolve(racine, relatif);
    mkdirSync(dirname(chemin), { recursive: true });
    // Sans saut de ligne final, comme les écrit Rails : `read_key_file` fait un
    // `strip`, mais le décodage base64 du fichier chiffré, lui, est strict.
    writeFileSync(chemin, texte);
  }
  return {
    substituee: true,
    raison: "aucune-cle",
    paire,
    dockerignore: reintegrerDansDockerignore(racine, paire),
  };
}

/**
 * Rend compte de l'opération dans le journal de construction.
 *
 * Une substitution silencieuse serait la pire des options : elle modifie le
 * comportement de l'application livrée, le mainteneur doit le lire.
 * @param {Substitution} resultat issue de la substitution
 * @returns {string} lignes à afficher, sans saut de ligne final
 */
export function formaterRapport(resultat) {
  const { paire } = resultat;
  if (resultat.raison === "fichier") {
    return `  ${paire.cle} versionné : clé de l'application conservée.`;
  }
  if (resultat.raison === "environnement") {
    return "  RAILS_MASTER_KEY déclaré dans railsbox.yml : clé de l'application conservée.";
  }
  if (resultat.raison === "desarme") {
    return `  Substitution désarmée (${KEEP_VARIABLE}) : l'application démarrera sans clé.`;
  }
  const lignes = [
    `  ${paire.cle} absent : paire JETABLE substituée pour cette construction.`,
    "    Aucun secret réel n'entre dans la sandbox ; les credentials métier vaudront nil.",
  ];
  if (resultat.dockerignore) {
    lignes.push("    .dockerignore du contexte complété : la clé écrite n'en sera pas écartée.");
  }
  return lignes.join("\n");
}

// ---------------------------------------------------------------------------
// Interface en ligne de commande (appelée par build-app-disk.sh)
//   APP_ENV_MANIFEST=… node credentials-jetables.mjs <contexte-de-construction>
// ---------------------------------------------------------------------------
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const racine = process.argv[2];
  if (!racine) {
    process.stderr.write("Usage : node credentials-jetables.mjs <contexte-de-construction>\n");
    process.exitCode = 2;
  } else {
    const resultat = substituerCredentials(racine, {
      envManifest: process.env.APP_ENV_MANIFEST ?? "",
      keep: process.env[KEEP_VARIABLE] === "1",
    });
    process.stdout.write(`${formaterRapport(resultat)}\n`);
  }
}
