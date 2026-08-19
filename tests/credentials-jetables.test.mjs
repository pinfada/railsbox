// Credentials jetables : la paire substituée doit être lisible par RAILS, pas
// seulement par nous.
//
// Ce que ces tests protègent. L'écrasante majorité des applications visées par
// railsbox versionnent `config/credentials.yml.enc` et PAS `config/master.key`.
// Quand leur `production.rb` porte `config.require_master_key = true`, Rails
// refuse de démarrer et la construction meurt sur « Missing encryption key to
// decrypt file with » — au milieu d'un build Docker, sans que le journal nomme
// la cause. La substitution d'une paire jetable lève cette panne entière.
//
// Le risque propre à ce module est le format. Il réimplémente en Node ce que
// `ActiveSupport::EncryptedFile` fait en Ruby : Marshal, puis aes-128-gcm, puis
// `base64--base64--base64`. Une erreur d'un octet produit un fichier que Rails
// rejette, et la panne serait identique à celle qu'on prétend corriger. L'ancre
// est donc la paire RÉELLE versionnée dans l'application de démonstration,
// écrite par un vrai `rails credentials:edit` : ce que Rails a produit, nous
// devons savoir le lire, et ce que nous produisons doit passer par le même
// chemin de déchiffrement.
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { createDecipheriv } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  chiffrerCredentials,
  contenuCredentials,
  ENV_SANDBOX,
  formaterRapport,
  genererPaire,
  KEEP_VARIABLE,
  MARQUEUR_DOCKERIGNORE,
  marshalChaineBinaire,
  reintegrerDansDockerignore,
  resoudrePaire,
  sourceDeLaCle,
  substituerCredentials,
} from "../tools/build-v86-image/credentials-jetables.mjs";

const RACINE_DEPOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const DEMO_CONFIG = join(RACINE_DEPOT, "tools", "demo-app", "demo", "config");

const dossiers = [];

after(async () => {
  for (const dossier of dossiers) await rm(dossier, { recursive: true, force: true });
});

/**
 * Crée un contexte de construction factice.
 * @param {Record<string, string>} fichiers chemins relatifs vers contenus
 * @returns {Promise<string>} racine du dossier créé
 */
async function contexte(fichiers = {}) {
  const racine = await mkdtemp(join(tmpdir(), "railsbox-credentials-"));
  dossiers.push(racine);
  for (const [relatif, contenu] of Object.entries(fichiers)) {
    const chemin = resolve(racine, relatif);
    await mkdir(dirname(chemin), { recursive: true });
    await writeFile(chemin, contenu);
  }
  return racine;
}

/**
 * Déchiffre comme le ferait `ActiveSupport::EncryptedFile` : implémentation
 * indépendante de celle du module, pour que le test prouve autre chose que sa
 * propre symétrie.
 * @param {string} fichier contenu du `.yml.enc`
 * @param {string} cleHex clé hexadécimale
 * @returns {string} contenu en clair
 */
function dechiffrerCommeRails(fichier, cleHex) {
  const [chiffre, iv, sceau] = fichier.split("--").map((part) => Buffer.from(part, "base64"));
  const dechiffreur = createDecipheriv("aes-128-gcm", Buffer.from(cleHex, "hex"), iv);
  dechiffreur.setAuthTag(sceau);
  const marshal = Buffer.concat([dechiffreur.update(chiffre), dechiffreur.final()]);
  assert.deepEqual([...marshal.subarray(0, 3)], [0x04, 0x08, 0x22], "en-tête Marshal d'une chaîne");
  const { valeur, suivant } = lireLongueurMarshal(marshal, 3);
  return marshal.subarray(suivant, suivant + valeur).toString("utf8");
}

/**
 * Décode un entier Marshal : 0, forme courte (valeur + 5) sous 123, ou forme
 * longue (nombre d'octets, puis petit-boutiste).
 * @param {Buffer} marshal flux Marshal
 * @param {number} position index de l'octet de tête
 * @returns {{valeur: number, suivant: number}} valeur décodée et index suivant
 */
function lireLongueurMarshal(marshal, position) {
  const tete = marshal[position];
  if (tete === 0) return { valeur: 0, suivant: position + 1 };
  if (tete <= 4) {
    let valeur = 0;
    for (let index = 0; index < tete; index += 1) {
      valeur += marshal[position + 1 + index] * 256 ** index;
    }
    return { valeur, suivant: position + 1 + tete };
  }
  return { valeur: tete - 5, suivant: position + 1 };
}

test("lit la paire réelle écrite par rails credentials:edit", () => {
  // Ancre du format : cette paire n'a pas été produite par ce module, mais par
  // Rails. Si notre lecture s'en écarte, notre écriture s'en écarte aussi.
  const cle = readFileSync(join(DEMO_CONFIG, "master.key"), "utf8").trim();
  const fichier = readFileSync(join(DEMO_CONFIG, "credentials.yml.enc"), "utf8").trim();
  const clair = dechiffrerCommeRails(fichier, cle);
  assert.match(clair, /^secret_key_base: [0-9a-f]{128}$/m);
});

test("réencode à l'identique ce que Rails a écrit", () => {
  // Même clé, même IV, même sceau attendu : la seule variable est notre
  // sérialisation. Un octet d'écart sur l'en-tête Marshal casserait l'égalité.
  const cle = readFileSync(join(DEMO_CONFIG, "master.key"), "utf8").trim();
  const fichier = readFileSync(join(DEMO_CONFIG, "credentials.yml.enc"), "utf8").trim();
  const [, iv] = fichier.split("--");
  const clair = dechiffrerCommeRails(fichier, cle);
  assert.equal(chiffrerCredentials(clair, cle, Buffer.from(iv, "base64")), fichier);
});

test("la paire générée se relit par le chemin de Rails", () => {
  const { cle, contenu, clair } = genererPaire();
  assert.match(cle, /^[0-9a-f]{32}$/, "32 caractères hexadécimaux : check_key_length");
  assert.equal(dechiffrerCommeRails(contenu, cle), clair);
  assert.match(clair, /^secret_key_base: [0-9a-f]{128}$/m);
  assert.match(clair, /^\s+primary_key: [0-9a-f]{32}$/m);
  assert.match(clair, /^\s+deterministic_key: [0-9a-f]{32}$/m);
  assert.match(clair, /^\s+key_derivation_salt: [0-9a-f]{32}$/m);
});

test("enveloppe Marshal : forme longue au-delà de 122 octets", () => {
  assert.deepEqual([...marshalChaineBinaire(Buffer.alloc(3))], [0x04, 0x08, 0x22, 8, 0, 0, 0]);
  const long = marshalChaineBinaire(Buffer.alloc(372));
  assert.deepEqual([...long.subarray(0, 6)], [0x04, 0x08, 0x22, 0x02, 0x74, 0x01]);
});

test("deux constructions ne partagent aucun secret", () => {
  const premiere = genererPaire();
  const seconde = genererPaire();
  assert.notEqual(premiere.cle, seconde.cle);
  assert.notEqual(premiere.clair, seconde.clair);
});

test("la paire propre à l'environnement prime la paire par défaut", async () => {
  const racine = await contexte({
    "config/credentials.yml.enc": "defaut",
    [`config/credentials/${ENV_SANDBOX}.yml.enc`]: "production",
  });
  assert.deepEqual(resoudrePaire(racine), {
    contenu: `config/credentials/${ENV_SANDBOX}.yml.enc`,
    cle: `config/credentials/${ENV_SANDBOX}.key`,
  });
});

test("sans paire d'environnement, c'est master.key qui décide", async () => {
  const racine = await contexte({ "config/credentials.yml.enc": "defaut" });
  assert.deepEqual(resoudrePaire(racine), {
    contenu: "config/credentials.yml.enc",
    cle: "config/master.key",
  });
});

test("une clé versionnée est conservée telle quelle", async () => {
  const racine = await contexte({
    "config/credentials.yml.enc": "chiffré",
    "config/master.key": "77acef8c4959066030ecda51cc70f9f6",
  });
  const resultat = substituerCredentials(racine);
  assert.equal(resultat.substituee, false);
  assert.equal(resultat.raison, "fichier");
  assert.equal(await readFile(join(racine, "config/credentials.yml.enc"), "utf8"), "chiffré");
});

test("un RAILS_MASTER_KEY déclaré dans railsbox.yml est respecté", async () => {
  const racine = await contexte({ "config/credentials.yml.enc": "chiffré" });
  const envManifest =
    "export DEMO_TOKEN='x'\nexport RAILS_MASTER_KEY='77acef8c4959066030ecda51cc70f9f6'\n";
  assert.equal(sourceDeLaCle(racine, resoudrePaire(racine), envManifest), "environnement");
  const resultat = substituerCredentials(racine, { envManifest });
  assert.equal(resultat.substituee, false);
  assert.equal(await readFile(join(racine, "config/credentials.yml.enc"), "utf8"), "chiffré");
});

test("une variable au nom voisin ne passe pas pour la clé", async () => {
  const racine = await contexte({ "config/credentials.yml.enc": "chiffré" });
  const envManifest = "export DUMP_RAILS_MASTER_KEY='non'\n";
  assert.equal(sourceDeLaCle(racine, resoudrePaire(racine), envManifest), null);
});

test("sans clé, la paire est substituée et redevient lisible", async () => {
  const racine = await contexte({ "config/credentials.yml.enc": "indéchiffrable" });
  const resultat = substituerCredentials(racine);
  assert.equal(resultat.substituee, true);
  const cle = await readFile(join(racine, "config/master.key"), "utf8");
  const contenu = await readFile(join(racine, "config/credentials.yml.enc"), "utf8");
  assert.match(cle, /^[0-9a-f]{32}$/, "aucun saut de ligne parasite");
  assert.match(dechiffrerCommeRails(contenu, cle), /^secret_key_base: /m);
});

test("la substitution suit la paire propre à l'environnement", async () => {
  const racine = await contexte({
    "config/credentials.yml.enc": "defaut",
    [`config/credentials/${ENV_SANDBOX}.yml.enc`]: "indéchiffrable",
  });
  const resultat = substituerCredentials(racine);
  assert.equal(resultat.paire.cle, `config/credentials/${ENV_SANDBOX}.key`);
  const cle = await readFile(join(racine, `config/credentials/${ENV_SANDBOX}.key`), "utf8");
  const contenu = await readFile(join(racine, `config/credentials/${ENV_SANDBOX}.yml.enc`), "utf8");
  assert.match(dechiffrerCommeRails(contenu, cle), /^secret_key_base: /m);
  // La paire par défaut n'est pas touchée : Rails ne la lira pas.
  assert.equal(await readFile(join(racine, "config/credentials.yml.enc"), "utf8"), "defaut");
});

test("le .dockerignore de Rails n'écarte plus la clé écrite", async () => {
  // Sans cette réintégration, BuildKit supprimerait du contexte la clé qu'on
  // vient d'y déposer, et la construction échouerait exactement comme avant.
  const racine = await contexte({
    "config/credentials.yml.enc": "indéchiffrable",
    ".dockerignore": "/config/master.key\n/config/credentials/*.key\n",
  });
  const resultat = substituerCredentials(racine);
  assert.equal(resultat.dockerignore, true);
  const dockerignore = await readFile(join(racine, ".dockerignore"), "utf8");
  assert.match(dockerignore, /^!config\/master\.key$/m);
  assert.match(dockerignore, /^!config\/credentials\.yml\.enc$/m);
  // Les règles de l'application restent en place : seules les négations, qui
  // gagnent parce qu'elles sont dernières, s'y ajoutent.
  assert.ok(dockerignore.startsWith("/config/master.key\n"));
  assert.ok(
    dockerignore.indexOf("!config/master.key") > dockerignore.indexOf("/config/master.key"),
  );
});

test("le .dockerignore n'est complété qu'une fois", async () => {
  const racine = await contexte({ ".dockerignore": "/config/master.key" });
  const paire = resoudrePaire(racine);
  assert.equal(reintegrerDansDockerignore(racine, paire), true);
  assert.equal(reintegrerDansDockerignore(racine, paire), false);
  const dockerignore = await readFile(join(racine, ".dockerignore"), "utf8");
  assert.equal(dockerignore.split(MARQUEUR_DOCKERIGNORE).length - 1, 1);
});

test("sans .dockerignore, il n'y a rien à contredire", async () => {
  const racine = await contexte({ "config/credentials.yml.enc": "indéchiffrable" });
  const resultat = substituerCredentials(racine);
  assert.equal(resultat.dockerignore, false);
});

test("la substitution se désarme, et le dit", async () => {
  const racine = await contexte({ "config/credentials.yml.enc": "indéchiffrable" });
  const resultat = substituerCredentials(racine, { keep: true });
  assert.equal(resultat.substituee, false);
  assert.match(formaterRapport(resultat), new RegExp(KEEP_VARIABLE));
});

test("le rapport nomme la substitution plutôt que de la taire", async () => {
  const racine = await contexte({
    "config/credentials.yml.enc": "indéchiffrable",
    ".dockerignore": "/config/master.key\n",
  });
  const rapport = formaterRapport(substituerCredentials(racine));
  assert.match(rapport, /config\/master\.key absent/);
  assert.match(rapport, /JETABLE/);
  assert.match(rapport, /\.dockerignore/);
});

test("le contenu n'annonce jamais un secret réel", () => {
  const clair = contenuCredentials({
    secretKeyBase: "a".repeat(128),
    primaryKey: "b".repeat(32),
    deterministicKey: "c".repeat(32),
    keyDerivationSalt: "d".repeat(32),
  });
  assert.match(clair, /JETABLES/);
  assert.match(clair, /tirées au hasard/);
});
