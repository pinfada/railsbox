// Active Storage dans une sandbox sans réseau sortant.
//
// Une application de production pointe souvent vers S3, GCS ou Azure. Ces
// services sont inaccessibles dans railsbox et Active Storage construit son
// client dès que Blob est chargé, parfois au boot. La sandbox fournit donc un
// service Disk privé, dans /app/storage. L'initialiseur est généré uniquement
// quand la gem activestorage est résolue et reste désarmable pour le diagnostic.

export const INITIALIZER_PATH = "config/initializers/zzz_railsbox_active_storage.rb";
export const KEEP_VARIABLE = "RAILSBOX_KEEP_ACTIVE_STORAGE_SERVICE";

/**
 * @param {{enabled?: boolean}} [options]
 * @returns {string} source Ruby, ou chaîne vide
 */
export function buildActiveStorageInitializer(options = {}) {
  const { enabled = true } = options;
  if (!enabled) return "";
  return `# encoding: utf-8
# Généré par railsbox — stockage local de la sandbox, sans réseau sortant.
if ENV["RAILSBOX_SANDBOX"] == "1" && ENV["${KEEP_VARIABLE}"] != "1"
  configurations = Rails.application.config.active_storage.service_configurations ||= {}
  configurations["railsbox_local"] = {
    "service" => "Disk",
    "root" => Rails.root.join("storage").to_s
  }
  Rails.application.config.active_storage.service = :railsbox_local
end
`;
}
