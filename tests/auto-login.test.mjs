import { test } from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_MODEL,
  INITIALIZER_PATH,
  buildAutoLoginInitializer,
  rubyStringLiteral,
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
  assert.match(source, /def deja_tente\?\(env\)\s+env\["HTTP_COOKIE"\]/);
  assert.match(source, /COOKIE = "railsbox_auto_login"/);
});

test("la colonne email est vérifiée avant d'être interrogée", () => {
  // find_by(email:) lève sur un modèle sans cette colonne.
  const source = buildAutoLoginInitializer({ autoLogin: "a@b.c" });
  assert.match(source, /column_names\.include\?\("email"\)/);
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
