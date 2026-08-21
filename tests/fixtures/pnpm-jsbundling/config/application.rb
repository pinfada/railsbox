require_relative "boot"

require "rails"
require "action_controller/railtie"

# Comme toute application Rails : c'est Bundler qui charge les gems du Gemfile,
# et lui seul connaît leur chemin de require. Les nommer à la main ici revenait
# à deviner — `require "jsbundling/rails"` n'existe pas.
Bundler.require(*Rails.groups)

module RailsboxFixture
  class Application < Rails::Application
    config.load_defaults 8.0
    config.eager_load = false
    config.secret_key_base = "fixture" * 10
  end
end
