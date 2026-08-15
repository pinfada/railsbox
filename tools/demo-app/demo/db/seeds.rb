# Données de démonstration de railsbox : quelques billets pour que le bac à
# sable montre du contenu réel dès le premier boot. Idempotent (find_or_create)
# — le seed est rejoué à chaque construction d'image.
[
  {
    title: "Bienvenue dans railsbox",
    body: "Cette application Rails tourne dans une VM Linux i386 émulée par v86, " \
          "entièrement dans votre navigateur. Aucun serveur distant n'est sollicité.",
  },
  {
    title: "Comment ça marche",
    body: "Le Service Worker intercepte les requêtes de la page et les transmet au " \
          "port série de la VM. Un démon Python les rejoue sur Puma, en local, " \
          "puis renvoie la réponse HTTP encodée en base64.",
  },
  {
    title: "Essayez donc",
    body: "Créez, modifiez ou supprimez un billet : les écritures vont dans la base " \
          "SQLite de l'image disque, elle-même persistée dans IndexedDB.",
  },
].each do |attributes|
  Post.find_or_create_by!(title: attributes[:title]) do |post|
    post.body = attributes[:body]
  end
end

puts "Seed terminé : #{Post.count} billets."
