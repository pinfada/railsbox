# Données de démonstration de la variante Tailwind. Le texte diffère de celui
# des deux autres démos : c'est ce qui permet au test d'intégration de prouver
# que la page servie vient bien de CE disque applicatif, et non d'un artefact
# d'une construction précédente resté dans public/disks.
# Idempotent (find_or_create) — le seed est rejoué à chaque construction.
[
  {
    title: "Bienvenue dans railsbox (Tailwind)",
    body: "Le style de cette page a été compilé par le binaire tailwindcss, qui " \
          "n'existe pour aucune architecture i386. Il a donc tourné sur l'étage " \
          "amd64 de la construction, jamais dans la VM.",
  },
  {
    title: "Ce qui voyage dans le disque",
    body: "Uniquement le résultat : public/assets et app/assets/builds. Le binaire " \
          "reste sur l'hôte de construction, et la gem tailwindcss-ruby installée " \
          "dans le guest est sa variante « ruby », sans exécutable.",
  },
  {
    title: "Comment le vérifier",
    body: "La feuille servie contient un utilitaire à valeur arbitraire, " \
          "tracking-[0.35em], qu'aucune feuille Tailwind pré-construite ne peut " \
          "porter : elle n'existe que si les vues ont été balayées à la construction.",
  },
].each do |attributes|
  Post.find_or_create_by!(title: attributes[:title]) do |post|
    post.body = attributes[:body]
  end
end

puts "Seed Tailwind terminé : #{Post.count} billets."
