// Génération du middleware d'auto-connexion déposé dans l'application.
//
// Contrainte produit : le visiteur d'une démonstration doit arriver sur une
// application peuplée, session ouverte — pas sur un écran de connexion. Or
// railsbox avale des dépôts tiers arbitraires et ne peut pas connaître leur
// brique d'authentification. D'où deux niveaux :
//
//   seed.auto_login       une convention qui couvre les cas courants
//   seed.auto_login_code  un fragment Ruby, pour tout le reste
//
// Le fragment vient de code TIERS. Il est écrit VERBATIM dans un fichier que
// seul le guest exécute — jamais évalué à la construction. C'est sans
// escalade : la sandbox exécute déjà le code de l'application.
//
// Logique pure (chaînes en entrée, source Ruby en sortie) → testable sans
// Rails ni VM.

/** Chemin du fichier généré, relatif à la racine de l'application. */
export const INITIALIZER_PATH = "config/initializers/zzz_railsbox_auto_login.rb";

/** Modèle interrogé par défaut quand la convention est utilisée. */
export const DEFAULT_MODEL = "User";

/**
 * Protège une valeur pour une insertion littérale dans du Ruby.
 *
 * Chaîne à apostrophes simples volontairement : les guillemets doubles y
 * interpoleraient `#{...}`, ce qui exécuterait du code fourni par un tiers au
 * chargement de l'initialiseur.
 * @param {string} value
 * @returns {string} littéral Ruby
 */
export function rubyStringLiteral(value) {
  return `'${String(value).replaceAll("\\", "\\\\").replaceAll("'", "\\'")}'`;
}

/**
 * `auto_login: true` demande « le premier utilisateur, peu importe lequel ».
 * L'analyseur du manifeste normalise toute valeur en texte : le booléen YAML
 * arrive donc ici sous la forme « true », qu'il faut reconnaître comme telle
 * sans confondre avec un identifiant qui vaudrait littéralement « true ».
 * @param {string|boolean|null|undefined} autoLogin
 * @returns {boolean}
 */
export function wantsFirstUser(autoLogin) {
  return autoLogin === true || String(autoLogin).trim().toLowerCase() === "true";
}

/**
 * Corps de la méthode de connexion, selon le niveau utilisé.
 * @param {{ autoLogin?: string|boolean|null, autoLoginCode?: string|null, model?: string }} options
 * @returns {string} lignes Ruby indentées de six espaces
 */
function connectionBody({ autoLoginCode, autoLogin, model = DEFAULT_MODEL }) {
  if (autoLoginCode) {
    // Fragment du mainteneur, recopié tel quel. `env` est dans sa portée, et
    // toute exception est rattrapée par l'appelant.
    return autoLoginCode
      .split(/\r?\n/)
      .map((line) => (line.trim() === "" ? "" : `      ${line}`))
      .join("\n");
  }
  const premier = wantsFirstUser(autoLogin);
  const identifiant = premier ? "nil" : rubyStringLiteral(String(autoLogin));
  const description = premier ? "la demande" : String(autoLogin).replace(/["\\]/g, "");
  return `      utilisateur = resoudre(${identifiant}, ${rubyStringLiteral(model)})
      return avertir("aucun utilisateur ne correspond à ${description}") if utilisateur.nil?
      connecter(env, utilisateur)`;
}

/**
 * Produit l'initialiseur Rails à déposer dans l'arbre de l'application, ou une
 * chaîne vide si aucune auto-connexion n'est demandée.
 * @param {{ autoLogin?: string|boolean|null, autoLoginCode?: string|null, model?: string }} options
 * @returns {string} source Ruby, vide si rien à générer
 */
export function buildAutoLoginInitializer(options = {}) {
  const { autoLogin = null, autoLoginCode = null } = options;
  if (!autoLoginCode && (autoLogin === null || autoLogin === undefined || autoLogin === "")) {
    return "";
  }
  const aides = autoLoginCode ? "" : `${HELPERS}\n`;

  return `# encoding: utf-8
# Généré par railsbox — ne pas modifier, ce fichier est réécrit à chaque build.
#
# Connecte le visiteur d'une sandbox de démonstration dès sa première requête,
# pour qu'il arrive sur une application peuplée plutôt que sur un écran de
# connexion. Inerte hors sandbox : la garde ci-dessous fait que ce fichier ne
# peut rien déclencher s'il se retrouve un jour dans un autre contexte.
if ENV["RAILSBOX_SANDBOX"] == "1"
  module Railsbox
    class AutoLogin
      COOKIE = "railsbox_auto_login".freeze

      def initialize(app)
        @app = app
      end

      def call(env)
        pose = deja_tente?(env) ? false : tenter(env)
        statut, entetes, corps = @app.call(env)
        marquer!(entetes) if pose
        [statut, entetes, corps]
      end

      private

      # UNE SEULE tentative par visiteur. Rejouer à chaque requête
      # reconnecterait quiconque vient de se déconnecter, et la démonstration
      # serait incapable de montrer son propre écran de connexion. Le marqueur
      # est un cookie et non la session, que la déconnexion remet justement à
      # zéro.
      def deja_tente?(env)
        env["HTTP_COOKIE"].to_s.include?("#{COOKIE}=")
      end

      def tenter(env)
${connectionBody(options)}
        true
      rescue StandardError => erreur
        avertir("#{erreur.class} : #{erreur.message}")
      end

      def connecter(env, utilisateur)
        pose = false
        warden = env["warden"]
        if warden.respond_to?(:set_user)
          # Devise raisonne par PORTÉES : set_user sans portée écrit dans
          # :default, que current_user ne lit jamais — l'auto-connexion
          # paraîtrait réussir et le visiteur resterait déconnecté.
          warden.set_user(utilisateur, scope: portee_warden(utilisateur))
          pose = true
        else
          # Pas de Warden : l'application n'utilise ni Devise ni la pile qui en
          # dépend. C'est le cas de l'authentification INTÉGRÉE de Rails 8,
          # celle que produit « rails generate authentication » — donc celle de
          # la plupart des applications neuves. Elle ne lit ni Warden ni
          # rack.session : elle relit Session.find_by(id:
          # cookies.signed[:session_id]) à chaque requête. Sans ce chemin,
          # l'auto-connexion s'exécutait, trouvait l'utilisateur, écrivait une
          # session que PERSONNE ne lisait, et le visiteur arrivait déconnecté
          # sans le moindre message.
          #
          # La tentative est réservée au cas « sans Warden » : une application
          # Devise qui aurait par ailleurs un modèle Session métier (un coaching,
          # une séance) ne doit surtout pas s'en voir créer un enregistrement.
          pose = true if connecter_par_cookie(env, utilisateur)
        end
        session = env["rack.session"]
        if session
          session[:user_id] = utilisateur.id
          pose = true
        end
        raise "ni Warden, ni cookie de session, ni session Rack n'est disponible" unless pose
      end

      # Ouvre une session au format de « rails generate authentication ».
      #
      # On ne signe rien à la main : le middleware est monté DANS la pile, donc
      # à l'intérieur d'ActionDispatch::Cookies, et écrire dans son porte-cookies
      # laisse Rails signer, sérialiser et poser l'en-tête exactement comme le
      # ferait l'application. Écrire AVANT l'appel applicatif a un second effet
      # utile : la valeur est relisible dans la même requête, qui part donc déjà
      # authentifiée au lieu d'attendre la suivante.
      #
      # Rend false — jamais une exception — dès qu'un signe manque : ce chemin
      # est une tentative, pas une exigence.
      def connecter_par_cookie(env, utilisateur)
        return false unless defined?(::ActionDispatch::Request)
        return false unless Object.const_defined?("Session")
        modele = Object.const_get("Session")
        return false unless modele.respond_to?(:column_names)
        colonnes = modele.column_names
        # Forme de la table produite par le générateur. « user_id » seul ne
        # suffit pas à distinguer une session d'authentification d'un modèle
        # métier homonyme ; « ip_address » ou « user_agent » le font.
        return false unless colonnes.include?("user_id")
        return false unless colonnes.include?("ip_address") || colonnes.include?("user_agent")
        return false unless utilisateur.respond_to?(:sessions)

        requete = ::ActionDispatch::Request.new(env)
        return false unless requete.respond_to?(:cookie_jar)

        attributs = {}
        attributs[:user_agent] = env["HTTP_USER_AGENT"].to_s if colonnes.include?("user_agent")
        attributs[:ip_address] = env["REMOTE_ADDR"].to_s if colonnes.include?("ip_address")
        session = utilisateur.sessions.create!(attributs)

        # Mêmes options que le générateur : permanent, httponly, same_site lax.
        requete.cookie_jar.signed.permanent[:session_id] = {
          value: session.id,
          httponly: true,
          same_site: :lax
        }
        true
      rescue StandardError => erreur
        avertir("session par cookie impossible (#{erreur.class} : #{erreur.message})")
        false
      end

      def portee_warden(utilisateur)
        return :user unless defined?(::Devise::Mapping)
        ::Devise::Mapping.find_scope!(utilisateur)
      rescue StandardError
        :user
      end
${aides}
      # Rack 2 attend « Set-Cookie », Rack 3 des en-têtes en minuscules. On
      # écrit sous la clé déjà présente, sinon selon la version. Un marqueur
      # manquant ne justifie jamais de casser la réponse.
      def marquer!(entetes)
        valeur = "#{COOKIE}=1; Path=/; SameSite=Lax"
        cle = if entetes.key?("set-cookie")
                "set-cookie"
              elsif entetes.key?("Set-Cookie")
                "Set-Cookie"
              elsif defined?(::Rack) && ::Rack.respond_to?(:release) && ::Rack.release.to_s.to_i >= 3
                "set-cookie"
              else
                "Set-Cookie"
              end
        existant = entetes[cle]
        entetes[cle] = if existant.nil? || existant.to_s.empty?
                         valeur
                       else
                         [existant, valeur].flatten
                       end
      rescue StandardError
        nil
      end

      def avertir(message)
        texte = "[railsbox] auto-connexion ignorée : #{message}"
        ::Rails.logger.warn(texte) if defined?(::Rails) && ::Rails.respond_to?(:logger) && ::Rails.logger
        warn(texte)
        false
      end
    end
  end

  # En fin de pile, donc au plus près de l'application : la session et Warden
  # sont déjà en place quand notre middleware s'exécute.
  Rails.application.config.middleware.use Railsbox::AutoLogin
end
`;
}

// Résolution stricte, volontairement. Un repli sur « le premier utilisateur
// venu » transformerait un identifiant devenu obsolète en démonstration
// plausible mais fausse — un compte sans les bons droits, ou celui d'un autre
// locataire. Pour « peu importe qui », le mainteneur écrit `auto_login: true`.
const HELPERS = `
      def resoudre(identifiant, nom_modele)
        return nil unless Object.const_defined?(nom_modele)
        modele = Object.const_get(nom_modele)
        return modele.first if identifiant.nil?
        # Deux conventions, pas une. « email » est celle de Devise et des
        # applications antérieures ; « email_address » est celle que produit
        # « rails generate authentication », l'authentification intégrée de
        # Rails 8 — donc celle de la plupart des applications neuves. Ne
        # chercher que la première laissait l'auto-connexion échouer en silence
        # sur les secondes : l'utilisateur existait, le visiteur arrivait
        # déconnecté, et rien ne disait pourquoi.
        if modele.respond_to?(:column_names)
          ["email", "email_address"].each do |colonne|
            next unless modele.column_names.include?(colonne)
            trouve = modele.find_by(colonne => identifiant)
            return trouve if trouve
          end
        end
        return modele.find_by(id: identifiant) if identifiant.to_s.match?(/\\A\\d+\\z/)
        nil
      end
`;
