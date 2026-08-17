# Feuilles compilées par dart-sass. Le nom « dartsass » plutôt que
# « application » est délibéré : la variante garde la feuille Propshaft
# classique de la démo (application.css) à côté, si bien que les deux chemins
# — CSS ordinaire et CSS compilé sur l'étage amd64 — restent exercés, et que
# l'origine de l'affichage reste décidable.
Rails.application.config.dartsass.builds = {
  "dartsass.scss" => "dartsass.css",
}
