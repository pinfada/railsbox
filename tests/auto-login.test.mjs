import { test } from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_MODEL,
  INITIALIZER_PATH,
  buildAutoLoginInitializer,
  rubyStringLiteral,
  wantsFirstUser,
} from "../tools/build-v86-image/auto-login.mjs";

test("aucune auto-connexion demandée : aucun fichier généré", () => {
  assert.equal(buildAutoLoginInitializer({}), "");
  assert.equal(buildAutoLoginInitializer({ autoLogin: null }), "");
  assert.equal(buildAutoLoginInitializer({ autoLogin: "" }), "");
});

test("rubyStringLiteral empêche l'interpolation et l'évasion de chaîne", () => {
  // Les guillemets doubles interpoleraient #{} : du code tiers s'exécuterait
  // au chargement de l'initialiseur. D'où l'apostrophe simple.
  assert.equal(rubyStringLiteral('a#{system("rm -rf /")}b'), `'a#{system("rm -rf /")}b'`);
  assert.equal(rubyStringLiteral("l'apostrophe"), "'l\\'apostrophe'");
  assert.equal(rubyStringLiteral("anti\\slash"), "'anti\\\\slash'");
});

test("convention : un identifiant produit une résolution stricte", () => {
  const source = buildAutoLoginInitializer({ autoLogin: "admin@example.com" });
  assert.match(source, /resoudre\('admin@example\.com', 'User'\)/);
  // Résolution stricte : aucun repli silencieux sur le premier utilisateur.
  assert.doesNotMatch(source, /\|\|\s*modele\.first/);
  assert.match(source, /return modele\.first if identifiant\.nil\?/);
});

test("convention : true connecte explicitement le premier utilisateur", () => {
  const source = buildAutoLoginInitializer({ autoLogin: true });
  assert.match(source, /resoudre\(nil, 'User'\)/);
});

test("la portée Warden est calculée, jamais laissée à :default", () => {
  const source = buildAutoLoginInitializer({ autoLogin: "a@b.c" });
  assert.match(source, /set_user\(utilisateur, scope: portee_warden\(utilisateur\)\)/);
  assert.match(source, /Devise::Mapping\.find_scope!/);
});

test("une seule tentative par visiteur, marquée par un cookie", () => {
  const source = buildAutoLoginInitializer({ autoLogin: "a@b.c" });
  // Le marqueur ne peut pas vivre dans la session : la déconnexion l'effacerait
  // et le visiteur serait reconnecté aussitôt.
  assert.match(source, /def deja_tente\?\(env\)/);
  assert.match(source, /COOKIE = "railsbox_auto_login_[0-9a-f]{12}"/);
});

// --- Le marqueur est ISOLÉ par sandbox et par construction ----------------
//
// Constaté dans Chrome le 22/08/2026 : le bocal de cookies contenait
// `railsbox_auto_login` en Path=/, posé par une démonstration PRÉCÉDENTE
// (zealot), à côté de `_zealot_session` et `_gymshare_session`. Comme
// l'auto-connexion n'a lieu qu'UNE fois par visiteur, woofed n'a jamais été
// connecté : le visiteur arrivait sur l'écran de connexion. Sur GitHub Pages,
// toutes les démonstrations d'un compte partagent `compte.github.io` — le
// défaut frappe donc dès la deuxième démonstration qu'un visiteur ouvre.

/** Nom de marqueur produit par une génération donnée. */
const marqueur = (source) => source.match(/COOKIE = "([^"]+)"/)?.[1] ?? null;

test("l'ancien cookie GLOBAL ne bloque plus l'auto-connexion", () => {
  const source = buildAutoLoginInitializer({
    autoLogin: "a@b.c",
    mountPath: "/woofed-crm/app",
    buildIdentity: "build-1",
  });

  // Le nom a changé : `railsbox_auto_login=` d'une ancienne sandbox ne peut
  // plus satisfaire la recherche, qui porte sur le nom SUFFIXÉ.
  assert.notEqual(marqueur(source), "railsbox_auto_login");
  assert.match(marqueur(source), /^railsbox_auto_login_[0-9a-f]{12}$/);
});

test("le marqueur d'une sandbox A ne bloque pas la sandbox B", () => {
  const a = buildAutoLoginInitializer({
    autoLogin: "a@b.c",
    mountPath: "/zealot/app",
    buildIdentity: "meme-construction",
  });
  const b = buildAutoLoginInitializer({
    autoLogin: "a@b.c",
    mountPath: "/woofed-crm/app",
    buildIdentity: "meme-construction",
  });

  assert.notEqual(marqueur(a), marqueur(b), "deux chemins, deux marqueurs");
});

test("le marqueur de la MÊME sandbox empêche bien une seconde tentative", () => {
  const options = {
    autoLogin: "a@b.c",
    mountPath: "/woofed-crm/app",
    buildIdentity: "build-1",
  };

  assert.equal(
    marqueur(buildAutoLoginInitializer(options)),
    marqueur(buildAutoLoginInitializer(options)),
    "même chemin, même construction : même marqueur",
  );
  // Et la garde le cherche bel et bien dans les cookies reçus.
  assert.match(buildAutoLoginInitializer(options), /env\["HTTP_COOKIE"\]\.to_s\.include\?/);
});

test("une nouvelle identité de construction produit un marqueur différent", () => {
  // Republier au MÊME chemin doit retenter l'auto-connexion : le visiteur qui
  // revient sur une démonstration reconstruite ne doit pas rester déconnecté.
  const avant = buildAutoLoginInitializer({
    autoLogin: "a@b.c",
    mountPath: "/woofed-crm/app",
    buildIdentity: "build-1",
  });
  const apres = buildAutoLoginInitializer({
    autoLogin: "a@b.c",
    mountPath: "/woofed-crm/app",
    buildIdentity: "build-2",
  });

  assert.notEqual(marqueur(avant), marqueur(apres));
});

test("le chemin racine retombe sur « / », jamais sur une chaîne vide", () => {
  // Une sandbox servie à la racine d'un domaine n'a pas de préfixe. `Path=`
  // vide n'est pas un chemin valide : le cookie serait rattaché au répertoire
  // de la requête, donc invisible ailleurs dans l'application.
  for (const vide of ["", null, undefined]) {
    const source = buildAutoLoginInitializer({
      autoLogin: "a@b.c",
      mountPath: /** @type {*} */ (vide),
      buildIdentity: "build-1",
    });
    assert.match(source, /CHEMIN = "\/"/, JSON.stringify(vide));
    // Le chemin est posé par une constante : on vérifie qu'il n'est jamais vide.
    assert.doesNotMatch(source, /CHEMIN = ""/, JSON.stringify(vide));
  }
});

test("le marqueur est posé sur le chemin de la sandbox, pas sur la racine", () => {
  const source = buildAutoLoginInitializer({
    autoLogin: "a@b.c",
    mountPath: "/woofed-crm/app",
    buildIdentity: "build-1",
  });

  assert.match(source, /CHEMIN = "\/woofed-crm\/app"/);
  assert.match(source, /Path=#\{CHEMIN\}/, "le cookie doit porter ce chemin");
});

test("la colonne est vérifiée avant d'être interrogée", () => {
  // find_by(email:) lève sur un modèle sans cette colonne.
  const source = buildAutoLoginInitializer({ autoLogin: "a@b.c" });
  assert.match(source, /column_names\.include\?\(colonne\)/);
  assert.match(
    source,
    /next unless modele\.column_names\.include\?\(colonne\)\s*\n\s*trouve = modele\.find_by/,
    "la vérification doit précéder immédiatement l'interrogation",
  );
});

test("les deux conventions de colonne d'adresse sont essayées", () => {
  // « email » est la convention de Devise ; « email_address » celle que produit
  // `bin/rails generate authentication`, l'authentification intégrée de
  // Rails 8, donc celle des applications neuves. N'en chercher qu'une laissait
  // l'auto-connexion échouer EN SILENCE sur les autres : l'utilisateur
  // existait, le visiteur arrivait déconnecté, et rien ne l'expliquait.
  // Constaté sur une application tierce (Rails 8.1) le 20/08/2026.
  const source = buildAutoLoginInitializer({ autoLogin: "a@b.c" });
  assert.match(source, /\["email", "email_address"\]\.each do \|colonne\|/);
});

test("le fichier est inerte hors sandbox", () => {
  const source = buildAutoLoginInitializer({ autoLogin: "a@b.c" });
  assert.match(source, /if ENV\["RAILSBOX_SANDBOX"\] == "1"/);
});

test("échappatoire : le fragment du mainteneur est recopié verbatim", () => {
  const code =
    'compte = Account.find_by(email: "demo@example.com")\nenv["rack.session"][:account_id] = compte.id';
  const source = buildAutoLoginInitializer({ autoLoginCode: code });
  assert.match(source, /compte = Account\.find_by\(email: "demo@example\.com"\)/);
  assert.match(source, /env\["rack\.session"\]\[:account_id\] = compte\.id/);
  // La convention n'est pas générée en même temps : le fragment la remplace.
  assert.doesNotMatch(source, /def resoudre/);
});

test("échappatoire : une exception du fragment ne casse pas la requête", () => {
  const source = buildAutoLoginInitializer({ autoLoginCode: "raise 'boum'" });
  assert.match(source, /rescue StandardError => erreur\s+avertir/);
  // La réponse est produite dans tous les cas.
  assert.match(source, /statut, entetes, corps = @app\.call\(env\)/);
});

test("le fragment l'emporte sur la convention", () => {
  const source = buildAutoLoginInitializer({
    autoLogin: "ignoré@example.com",
    autoLoginCode: "env['rack.session'][:user_id] = 42",
  });
  assert.match(source, /env\['rack\.session'\]\[:user_id\] = 42/);
  assert.doesNotMatch(source, /ignoré@example\.com/);
});

test("le middleware s'ajoute en fin de pile", () => {
  // En fin de pile = au plus près de l'application : session et Warden sont
  // déjà en place. Plus haut, env["rack.session"] n'existerait pas encore.
  const source = buildAutoLoginInitializer({ autoLogin: true });
  assert.match(source, /Rails\.application\.config\.middleware\.use Railsbox::AutoLogin/);
});

test("constantes exposées", () => {
  assert.equal(DEFAULT_MODEL, "User");
  assert.match(INITIALIZER_PATH, /^config\/initializers\/.*\.rb$/);
});

test("wantsFirstUser reconnaît le booléen YAML normalisé en texte", () => {
  // L'analyseur du manifeste rend tout en chaîne : `auto_login: true` arrive
  // ici sous la forme "true".
  assert.equal(wantsFirstUser(true), true);
  assert.equal(wantsFirstUser("true"), true);
  assert.equal(wantsFirstUser("True"), true);
  assert.equal(wantsFirstUser("admin@example.com"), false);
  assert.equal(wantsFirstUser(null), false);
});

test("auto_login: true venu du YAML produit bien la résolution « premier »", () => {
  const source = buildAutoLoginInitializer({ autoLogin: "true" });
  assert.match(source, /resoudre\(nil, 'User'\)/);
});
