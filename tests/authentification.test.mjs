// Le mécanisme d'authentification reconnu — et l'aveu quand il ne l'est pas.
//
// CE QUE CES TESTS PROTÈGENT. `auto_login` promet « le visiteur arrive
// connecté ». La promesse tient si railsbox pose l'utilisateur là où
// l'application ira le chercher. Le 20/08/2026, sur une application Rails 8.1
// réelle, il l'a posé ailleurs : l'auto-connexion s'est exécutée, a trouvé
// l'utilisateur, a écrit une session Rack — que l'application ne lit jamais,
// puisqu'elle relit Session.find_by(id: cookies.signed[:session_id]).
//
// Le visiteur est arrivé déconnecté SANS AUCUN MESSAGE. Construction verte,
// journal muet, aucune exception : du point de vue de railsbox le travail avait
// été fait. C'est ce silence-là qui coûte cher, bien plus que l'absence d'un
// mécanisme.
//
// D'où la moitié de ces tests : ils portent sur le REFUS de conclure. Se
// tromper de mécanisme est pire que d'avouer ne pas savoir, parce qu'un
// avertissement se lit et qu'un silence ne se lit pas.
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import {
  LIBELLES,
  MECANISMES,
  detectMecanismeAuth,
  mecanismeCouvert,
  messageMecanismeInconnu,
} from "../tools/detect/authentification.mjs";
import { analyzeApp } from "../tools/build-v86-image/manifest-to-args.mjs";

/** Extrait du concern produit par `rails generate authentication`. */
const CONCERN_RAILS8 = `
  module Authentication
    private
      def find_session_by_cookie
        Session.find_by(id: cookies.signed[:session_id]) if cookies.signed[:session_id]
      end
  end
`;

const dossiers = [];

after(async () => {
  for (const dossier of dossiers) await rm(dossier, { recursive: true, force: true });
});

/**
 * Crée une application factice.
 * @param {Record<string, string>} fichiers chemins relatifs vers contenus
 * @returns {Promise<string>} racine du dossier créé
 */
async function application(fichiers) {
  const racine = await mkdtemp(join(tmpdir(), "railsbox-auth-"));
  dossiers.push(racine);
  for (const [relatif, contenu] of Object.entries(fichiers)) {
    const chemin = join(racine, relatif);
    await mkdir(dirname(chemin), { recursive: true });
    await writeFile(chemin, contenu);
  }
  return racine;
}

// --- Reconnaissance --------------------------------------------------------

test("Devise est reconnu par sa gem, quoi que contiennent les sources", () => {
  assert.equal(detectMecanismeAuth({ gems: ["rails", "devise"] }), MECANISMES.WARDEN);
  assert.equal(detectMecanismeAuth({ gems: ["warden"] }), MECANISMES.WARDEN);
});

test("Warden prime la forme Rails 8, parce que c'est lui qui décide", () => {
  // Une application Devise porte AUSSI une session Rack, et peut porter un
  // modèle Session. C'est Warden qui fixe current_user : se tromper d'ordre
  // ferait écrire au mauvais endroit sur toutes les applications Devise.
  const mecanisme = detectMecanismeAuth({
    gems: ["devise"],
    sources: CONCERN_RAILS8,
    modeles: ["session", "user"],
  });
  assert.equal(mecanisme, MECANISMES.WARDEN);
});

test("la session en base est reconnue par la LECTURE du cookie signé", () => {
  const mecanisme = detectMecanismeAuth({
    gems: ["rails"],
    sources: CONCERN_RAILS8,
    modeles: ["session", "user"],
  });
  assert.equal(mecanisme, MECANISMES.SESSION_COOKIE);
});

test("un modèle Session MÉTIER ne passe pas pour une authentification", () => {
  // Le piège de ce mécanisme : « Session » est un nom de modèle courant — une
  // séance de sport, un cours, un créneau. Le reconnaître au nom ferait créer
  // des enregistrements métier parasites. C'est la lecture du cookie qui
  // tranche, et elle n'existe que dans le concern généré.
  const mecanisme = detectMecanismeAuth({
    gems: ["rails"],
    sources: "class SessionsController < ApplicationController; end",
    modeles: ["session", "coach", "user"],
  });
  assert.notEqual(mecanisme, MECANISMES.SESSION_COOKIE);
});

test("la session Rack est reconnue sous ses formes courantes", () => {
  assert.equal(
    detectMecanismeAuth({ sources: "session[:user_id] = user.id" }),
    MECANISMES.SESSION_RACK,
  );
  assert.equal(
    detectMecanismeAuth({ sources: "session[:current_user_id] = utilisateur.id" }),
    MECANISMES.SESSION_RACK,
  );
});

test("l'authentification par jeton est nommée, pas confondue avec un inconnu", () => {
  // Elle a son propre remède (la recette auto_login_code du guide), et le
  // mainteneur doit savoir que railsbox l'a IDENTIFIÉE plutôt que ratée.
  assert.equal(detectMecanismeAuth({ gems: ["jwt", "knock"] }), MECANISMES.JETON);
});

test("sans signe reconnaissable, on rend « inconnu » plutôt que de deviner", () => {
  assert.equal(detectMecanismeAuth({}), MECANISMES.INCONNU);
  assert.equal(
    detectMecanismeAuth({ gems: ["rails"], sources: "class A; end" }),
    MECANISMES.INCONNU,
  );
});

test("les trois mécanismes couverts le sont, les autres non", () => {
  assert.ok(mecanismeCouvert(MECANISMES.WARDEN));
  assert.ok(mecanismeCouvert(MECANISMES.SESSION_COOKIE));
  assert.ok(mecanismeCouvert(MECANISMES.SESSION_RACK));
  assert.ok(!mecanismeCouvert(MECANISMES.JETON));
  assert.ok(!mecanismeCouvert(MECANISMES.INCONNU));
});

test("chaque mécanisme porte un libellé lisible dans le rapport", () => {
  for (const valeur of Object.values(MECANISMES)) {
    assert.ok(LIBELLES[valeur], `libellé manquant pour ${valeur}`);
  }
});

test("le message nomme le silence, pas seulement le manque", () => {
  // Un message qui dirait « mécanisme non reconnu » sans expliquer que l'échec
  // sera MUET laisserait croire à un détail cosmétique.
  const message = messageMecanismeInconnu(MECANISMES.INCONNU);
  assert.match(message, /DÉCONNECTÉ/);
  assert.match(message, /aucune erreur ne soit levée|ni construction rouge/);
});

// --- Bout en bout, sur des applications factices ---------------------------

test("auto_login sans mécanisme reconnu produit un avertissement", async () => {
  const racine = await application({
    Gemfile: 'source "https://rubygems.org"\ngem "rails"\n',
    "Gemfile.lock": "GEM\n  specs:\n    rails (8.0.0)\n",
    "railsbox.yml": 'seed:\n  command: "bin/rails db:seed"\n  auto_login: "demo@example.com"\n',
  });
  const analyse = await analyzeApp(racine, "app", { base: "3.3-r2" });
  const trouve = analyse.findings.find((f) => f.code === "auto-login-mecanisme-inconnu");
  assert.ok(trouve, "l'avertissement doit être émis");
  assert.equal(trouve.severity, "warning", "avertir, jamais refuser");
});

test("auto_login sur une application Rails 8 n'avertit pas", async () => {
  const racine = await application({
    Gemfile: 'source "https://rubygems.org"\ngem "rails"\n',
    "Gemfile.lock": "GEM\n  specs:\n    rails (8.0.0)\n",
    "app/models/session.rb": "class Session < ApplicationRecord\nend\n",
    "app/controllers/concerns/authentication.rb": CONCERN_RAILS8,
    "railsbox.yml": 'seed:\n  command: "bin/rails db:seed"\n  auto_login: "demo@example.com"\n',
  });
  const analyse = await analyzeApp(racine, "app", { base: "3.3-r2" });
  assert.equal(
    analyse.findings.find((f) => f.code === "auto-login-mecanisme-inconnu"),
    undefined,
  );
});

test("auto_login_code fait taire l'avertissement", async () => {
  // Le mainteneur qui écrit son propre fragment sait mieux que nous où
  // l'application range sa session : l'avertir serait du bruit.
  const racine = await application({
    Gemfile: 'source "https://rubygems.org"\ngem "rails"\n',
    "Gemfile.lock": "GEM\n  specs:\n    rails (8.0.0)\n",
    "railsbox.yml":
      'seed:\n  command: "bin/rails db:seed"\n  auto_login: "demo@example.com"\n' +
      '  auto_login_code: |\n    env["rack.session"][:jeton] = "x"\n',
  });
  const analyse = await analyzeApp(racine, "app", { base: "3.3-r2" });
  assert.equal(
    analyse.findings.find((f) => f.code === "auto-login-mecanisme-inconnu"),
    undefined,
  );
});

test("sans auto_login, aucun avertissement même sans mécanisme reconnu", async () => {
  // La très grande majorité des applications ne demandent pas d'auto-connexion :
  // leur imposer un diagnostic sur un mécanisme qu'elles n'utilisent pas
  // décrédibiliserait le rapport entier.
  const racine = await application({
    Gemfile: 'source "https://rubygems.org"\ngem "rails"\n',
    "Gemfile.lock": "GEM\n  specs:\n    rails (8.0.0)\n",
  });
  const analyse = await analyzeApp(racine, "app", { base: "3.3-r2" });
  assert.equal(
    analyse.findings.find((f) => f.code === "auto-login-mecanisme-inconnu"),
    undefined,
  );
});
