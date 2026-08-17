// Neutralisation de `config.force_ssl` DANS LE GUEST.
//
// Le problème. `config.force_ssl = true` est le défaut d'un `rails new` depuis
// Rails 7 : il est présent dans l'écrasante majorité des applications que
// railsbox vise. Or la sandbox n'a aucune terminaison TLS — Puma écoute en
// clair sur 127.0.0.1:3000 et le pont série transporte des octets. Quand Rails
// se croit en http, `ActionDispatch::SSL` répond 301 vers https (boucle
// infinie), pose un `Strict-Transport-Security` et réécrit chaque `Set-Cookie`
// en `secure`.
//
// Ce que railsbox faisait déjà, et pourquoi ça ne suffit pas. Le proxy et le
// harnais annoncent `x-forwarded-proto: https` (sw-proxy.js, vm-harness.mjs,
// validate-boot.mjs), ce qui suffit à Rails dans le cas nominal. Mais cet
// en-tête est une CONVENTION, pas une garantie : Rack ne l'honore que selon
// `Rack::Request.forwarded_priority`, une application peut poser
// `config.action_dispatch.trusted_proxies`, un `rack-attack` ou un middleware
// maison peut le filtrer. Le critère du projet est qu'une application NON
// MODIFIÉE fonctionne : on ne peut pas le tenir avec un en-tête que
// l'application a le droit d'ignorer.
//
// La parade. Un initialiseur déposé dans l'arbre applicatif — même mécanisme
// que l'auto-connexion (auto-login.mjs) — remet `config.force_ssl` à faux. Il
// est chargé par `:load_config_initializers`, qui précède le
// `:build_middleware_stack` des finisher initializers : `ActionDispatch::SSL`
// n'est donc jamais inséré, plutôt que d'être inséré puis contourné.
//
// Pourquoi c'est sans danger. La VM n'a aucun réseau sortant, le seul client
// est le pont série de l'onglet, et l'image entière est publique et
// téléchargeable (voir SECURITY.md) : il n'y a rien à protéger d'une écoute
// qui n'existe pas. La garde `RAILSBOX_SANDBOX` rend le fichier inerte partout
// ailleurs, et `RAILSBOX_KEEP_FORCE_SSL=1` le désarme pour qui veut observer
// le comportement d'origine.

import { KEEP_FORCE_SSL_VALUE, KEEP_FORCE_SSL_VARIABLE } from "../detect/ssl.mjs";

/** Chemin du fichier généré, relatif à la racine de l'application. */
export const INITIALIZER_PATH = "config/initializers/zzz_railsbox_force_ssl.rb";

/** Variable d'environnement qui désarme la neutralisation. */
export const KEEP_VARIABLE = KEEP_FORCE_SSL_VARIABLE;

/**
 * Produit l'initialiseur de neutralisation à déposer dans l'application.
 *
 * Émis INCONDITIONNELLEMENT quand la neutralisation est demandée, sans
 * attendre que la détection ait vu `config.force_ssl` : le réglage peut venir
 * de `config/application.rb`, d'un `concern` partagé, d'une gem, ou d'un
 * `production.rb` que l'analyse statique lit mal. Poser `force_ssl = false`
 * sur une application qui ne l'active pas est un non-événement.
 * @param {{enabled?: boolean}} [options] `enabled: false` n'émet aucun fichier
 * @returns {string} source Ruby, vide si la neutralisation est désactivée
 */
export function buildForceSslInitializer(options = {}) {
  const { enabled = true } = options;
  if (!enabled) return "";
  return `# encoding: utf-8
# Généré par railsbox — ne pas modifier, ce fichier est réécrit à chaque build.
#
# Désactive la redirection https dans la sandbox : la VM sert l'application en
# clair derrière le pont série, sans terminaison TLS. Avec config.force_ssl,
# Rails répondrait 301 vers https (boucle) et n'émettrait que des cookies
# « secure ». Inerte hors sandbox, et désarmé par ${KEEP_VARIABLE}=${KEEP_FORCE_SSL_VALUE}.
if ENV["RAILSBOX_SANDBOX"] == "1" && ENV["${KEEP_VARIABLE}"] != "${KEEP_FORCE_SSL_VALUE}"
  # Cet initialiseur est chargé par :load_config_initializers, qui précède le
  # :build_middleware_stack des finisher initializers : ActionDispatch::SSL
  # n'est même pas inséré, au lieu d'être inséré puis contourné.
  #
  # Rien d'autre n'est touché. Le proxy continue d'annoncer
  # x-forwarded-proto: https, donc Rails génère toujours ses URL absolues en
  # https comme la coquille les sert : seule la REDIRECTION disparaît.
  Rails.application.config.force_ssl = false
  Rails.application.config.ssl_options = {}
end
`;
}
