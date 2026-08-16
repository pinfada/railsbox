# Montage sous-URI : le config.ru de l'application la lance à la RACINE, donc
# ses helpers de routes génèrent « /posts » — des liens qui échappent au
# périmètre /app du Service Worker et tombent sur le serveur statique.
# RAILS_RELATIVE_URL_ROOT ne suffit pas : il ne préfixe que les assets, car
# les helpers de routes s'appuient sur le SCRIPT_NAME Rack. On monte donc
# l'application via Rack::URLMap, sans toucher au code applicatif.
#
# Base découplée (ADR 0002) : /app est le disque applicatif (hdb) monté au
# lancement de Puma — pas au boot de la base.
require "/app/config/environment"

map ENV.fetch("RAILS_RELATIVE_URL_ROOT", "/") do
  run Rails.application
end
Rails.application.load_server
