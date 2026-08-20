// Redis n'est annoncé que s'il tourne.
//
// LE DÉFAUT, mesuré le 20/08/2026 sur une application tierce (Rails 8.1,
// PostgreSQL, construite sur la base 3.3-r2). Le rootfs de base exportait
// `REDIS_URL` dans /opt/rib/env.sh INCONDITIONNELLEMENT, alors que
// guest-init.sh ne démarre Redis que sur `RIB_WITH_REDIS=1`. Toute sandbox
// annonçait donc un Redis qui, la plupart du temps, n'existait pas.
//
// Ce que ça casse, et pourquoi c'est vicieux. Le patron correct pour un cache
// optionnel est exactement celui-ci :
//
//   config.cache_store =
//     if ENV["REDIS_URL"].present?
//       [ :redis_cache_store, { url: ENV["REDIS_URL"] } ]
//     else
//       :memory_store
//     end
//
// Une application qui l'écrit prenait la branche Redis à cause de notre
// variable, et mourait au démarrage : « Unable to load application: Could not
// find cache store adapter for redis_cache_store (redis is not part of the
// bundle) ». L'application était juste, sa configuration était juste — c'est la
// base qui mentait. Et l'erreur ne nomme jamais railsbox : elle accuse le
// Gemfile du mainteneur.
//
// Plus la même faute est faite avec soin ailleurs, plus elle est difficile à
// voir : app.Dockerfile, lui, ne déclarait la variable QUE sous
// `WITH_REDIS = 1`, et son commentaire raisonnait juste (« fournir un service
// sans l'annoncer revient à ne pas le fournir »). La contradiction vivait une
// couche plus bas.
//
// LA CORRECTION EST EN DEUX TEMPS, et les deux comptent. La base cesse de
// déclarer la variable — mais les bases publiées sont FIGÉES, 3.3-r2 gardera
// son env.sh pour toujours. C'est donc le disque applicatif qui la retire, par
// un `unset` : il est sourcé APRÈS la base (start-app.sh : env.sh, puis
// app-env.sh), et c'est la seule couche qui puisse corriger une base déjà
// publiée.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const RACINE = join(dirname(fileURLToPath(import.meta.url)), "..");
const BASE = join(RACINE, "tools", "build-v86-image", "base");

/**
 * Lit un fichier du dossier de la base.
 * @param {...string} morceaux chemin relatif à tools/build-v86-image/base
 * @returns {string} contenu du fichier
 */
function lire(...morceaux) {
  return readFileSync(join(BASE, ...morceaux), "utf8");
}

test("le rootfs de base n'annonce plus Redis", () => {
  // La base est mutualisée : elle sert AUSSI les applications sans Redis. Une
  // variable posée là s'impose à toutes, y compris à celles pour qui elle est
  // fausse.
  const dockerfile = lire("Dockerfile");
  const declarations = dockerfile
    .split("\n")
    .filter((ligne) => /^\s*export\s+REDIS_URL=/.test(ligne));
  assert.deepEqual(
    declarations,
    [],
    "la base ne doit déclarer REDIS_URL nulle part : elle ne sait pas si Redis tournera",
  );
});

test("le démarrage de Redis reste conditionné au drapeau de la base", () => {
  // L'invariant qui donne son sens au précédent : si guest-init.sh démarrait
  // Redis inconditionnellement, annoncer la variable serait légitime.
  const init = lire("rib", "guest-init.sh");
  assert.match(
    init,
    /if\s+\[\s+"\$RIB_WITH_REDIS"\s+=\s+1\s+\]/,
    "Redis doit rester démarré sous condition dans guest-init.sh",
  );
});

/**
 * Isole le garde WITH_REDIS qui ÉCRIT app-env.sh.
 *
 * app.Dockerfile en contient deux, et la distinction est tout l'enjeu : celui
 * de la CONSTRUCTION pose la variable dans le shell du build (`export REDIS_URL`
 * nu, pour db:prepare et les seeds) et n'a rien à corriger, puisque ce shell-là
 * ne source pas l'env.sh de la base. Celui du RUNTIME écrit des lignes dans un
 * fichier (`echo "export …"`), et c'est lui qui est sourcé après la base.
 * @returns {string} le bloc if/else/fi du garde d'exécution
 */
function gardeRuntime() {
  const app = lire("app.Dockerfile");
  const ancre = app.indexOf('echo "export REDIS_URL');
  assert.notEqual(ancre, -1, "app.Dockerfile doit écrire REDIS_URL dans app-env.sh");
  const debut = app.lastIndexOf('if [ "${WITH_REDIS}" = 1 ]', ancre);
  assert.notEqual(debut, -1, "cette écriture doit être gardée par WITH_REDIS");
  const bloc = app.slice(debut);
  return bloc.slice(0, bloc.indexOf("\n  fi") + 5);
}

test("le disque applicatif déclare REDIS_URL seulement quand Redis tourne", () => {
  assert.match(
    gardeRuntime(),
    /echo "export REDIS_URL=/,
    "la branche vraie doit écrire REDIS_URL dans l'environnement applicatif",
  );
});

test("le disque applicatif RETIRE REDIS_URL quand Redis ne tourne pas", () => {
  // Le cœur de la correction. Ne pas écrire la variable ne suffit pas : la base
  // publiée l'a déjà exportée, et le disque applicatif est sourcé après elle.
  // Sans ce `unset`, toutes les sandboxes bâties sur 3.3-r2 continueraient de
  // mentir.
  assert.match(
    gardeRuntime(),
    /else\s*\n\s*echo "unset REDIS_URL"/,
    "la branche fausse doit écrire `unset REDIS_URL` dans l'environnement applicatif",
  );
});

test("l'environnement applicatif est bien sourcé APRÈS celui de la base", () => {
  // Tout le mécanisme repose là-dessus : si l'ordre s'inversait, le `unset`
  // serait écrasé par la base et le défaut reviendrait, silencieusement.
  const start = lire("rib", "start-app.sh");
  const positionBase = start.indexOf("/opt/rib/env.sh");
  const positionApp = start.indexOf("/app/.railsbox/app-env.sh");
  assert.ok(positionBase !== -1, "start-app.sh doit sourcer l'environnement de la base");
  assert.ok(positionApp !== -1, "start-app.sh doit sourcer l'environnement de l'application");
  assert.ok(
    positionBase < positionApp,
    "app-env.sh doit être sourcé après env.sh, sinon le unset ne corrige rien",
  );
});
