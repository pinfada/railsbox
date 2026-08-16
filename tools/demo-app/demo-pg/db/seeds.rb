# Données de démonstration de la variante PostgreSQL. Le texte diffère de celui
# de la démo sqlite3 : c'est ce qui permet au test d'intégration de prouver que
# la page servie vient bien du cluster PostgreSQL embarqué dans le disque
# applicatif, et non d'un fichier sqlite3 resté là par accident.
# Idempotent (find_or_create) — le seed est rejoué à chaque construction.
[
  {
    title: "Bienvenue dans railsbox (PostgreSQL)",
    body: "Ces billets sont servis par un cluster PostgreSQL 15 qui tourne dans " \
          "une VM Linux i386 émulée par v86, entièrement dans votre navigateur.",
  },
  {
    title: "Où vivent les données",
    body: "Le répertoire de données du cluster est /app/var/pg, sur le disque " \
          "applicatif. Il a été initialisé, migré et peuplé à la construction : " \
          "le premier boot n'a plus rien à faire.",
  },
  {
    title: "Quand démarre le cluster",
    body: "Jamais avant le montage du disque applicatif. L'instantané mémoire de " \
          "la base fige les processus, et un postmaster gelé y pointerait un " \
          "répertoire de données qui n'existe pas encore.",
  },
].each do |attributes|
  Post.find_or_create_by!(title: attributes[:title]) do |post|
    post.body = attributes[:body]
  end
end

puts "Seed PostgreSQL terminé : #{Post.count} billets."
