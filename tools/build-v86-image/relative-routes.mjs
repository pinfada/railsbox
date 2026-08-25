// Compatibilite des API internes du routeur Rails avec un deploiement sous
// RAILS_RELATIVE_URL_ROOT.
//
// Les helpers ajoutent ce prefixe aux URL generees. RouteSet#recognize_path,
// lui, reconnait un chemin interne a l'application : quelques applications lui
// repassent pourtant directement une URL issue d'un helper. Le serveur web
// retire normalement SCRIPT_NAME avant le routage, nous faisons donc la meme
// chose pour cet appel programmatique.

export const INITIALIZER_PATH = "config/initializers/zzz_railsbox_relative_routes.rb";

/** @returns {string} source Ruby */
export function buildRelativeRoutesInitializer() {
  return `# encoding: utf-8
# Genere par railsbox - rend recognize_path coherent avec RAILS_RELATIVE_URL_ROOT.
if ENV["RAILSBOX_SANDBOX"] == "1"
  module RailsboxRelativeRoutes
    def recognize_path(path, environment = {})
      prefix = ENV.fetch("RAILS_RELATIVE_URL_ROOT", "").sub(%r{/+\\z}, "")
      if path.is_a?(String) && !prefix.empty? &&
          (path == prefix || path.start_with?("#{prefix}/"))
        path = path[prefix.length..-1]
        path = "/" if path.nil? || path.empty?
      end
      super(path, environment)
    end
  end

  ActionDispatch::Routing::RouteSet.prepend(RailsboxRelativeRoutes)
end
`;
}
