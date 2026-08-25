// Adaptateur de lecture pour les assets précompilés hors du guest.
//
// Quand l'étage amd64 a déjà produit le manifeste Sprockets, autoriser
// `config.assets.compile = true` dans la VM peut relancer Sass, Node ou un autre
// compilateur absent en i386. On revient donc au comportement de production
// normal (compile=false), tout en conservant `Rails.application.assets.find_asset`
// pour les applications qui lisent volontairement un asset afin de l'inliner.

export const INITIALIZER_PATH = "config/initializers/zzz_railsbox_precompiled_assets.rb";

/**
 * @param {{enabled?: boolean}} [options]
 * @returns {string} source Ruby, ou chaîne vide
 */
export function buildPrecompiledAssetsInitializer(options = {}) {
  const { enabled = true } = options;
  if (!enabled) return "";
  return `# encoding: utf-8
# Généré par railsbox — sert les assets précompilés sans compilateur dans le guest.
if ENV["RAILSBOX_SANDBOX"] == "1"
  require "json"

  Rails.application.config.assets.compile = false if Rails.application.config.respond_to?(:assets)
  # Un asset_host de production serait inaccessible depuis la VM et contournerait
  # les fichiers que RailsBox vient précisément d'embarquer.
  Rails.application.config.action_controller.asset_host = nil

  Rails.application.config.after_initialize do
    manifest_path = Dir[Rails.public_path.join("assets/.sprockets-manifest-*.json")].first
    next unless manifest_path

    logical_assets = JSON.parse(File.read(manifest_path)).fetch("assets", {})
    public_assets = Rails.public_path.join("assets")
    asset_value = Struct.new(:source, :filename)
    resolver = Object.new
    resolver.define_singleton_method(:find_asset) do |logical_path|
      digest_path = logical_assets[logical_path.to_s]
      next unless digest_path

      filename = public_assets.join(digest_path)
      asset_value.new(filename.read, filename)
    end
    resolver.define_singleton_method(:[]) { |logical_path| find_asset(logical_path) }
    Rails.application.define_singleton_method(:assets) { resolver }
  end
end
`;
}
