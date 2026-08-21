# Pour qui c'est fait

Les profils auxquels railsbox répond, et ce qu'il n'est délibérément pas.

*Retour au [README](../README.md).*

---

**Mainteneurs open source Ruby/Rails.** Votre README montre du code ; il ne
montre pas votre application. Le badge « Try with railsbox » donne à quiconque
lit votre projet une instance jouable en un clic — peuplée de données de
démonstration, session déjà ouverte, sans installation ni création de compte.
Le lien ne tombe pas et ne coûte rien, parce qu'il n'y a pas de serveur derrière.

**Fondateurs de SaaS B2B, créateurs de produits.** Une démonstration permanente
sans infrastructure : vous choisissez les données affichées (`seed`), le visiteur
arrive connecté (`auto_login` ouvre une session — une interface qui
s'authentifie par jeton demande [la recette
JWT](spa.md)), et
l'addition reste à zéro même le jour où votre lien passe sur Hacker News. Contrepartie non négociable : **rien de réel ne doit
être embarqué** — ni clé Stripe live, ni identifiants OAuth, ni dump contenant
des données clients. Tout ce qui entre dans une sandbox est public
([`SECURITY.md`](../SECURITY.md)).

**Développeurs freelances, candidats, portfolios.** Un recruteur clique et voit
l'application tourner, pas une capture d'écran. Pas de cold start payant, pas
d'instance gratuite mise en veille, pas de facture qui arrive parce que le lien
a bien marché.

**Formateurs, bootcamps, auteurs de tutoriels.** Trente apprenants, c'est trente
environnements isolés : chaque apprenant est root dans SA copie, ses erreurs ne
polluent celles de personne, et il n'y a rien à installer avant de commencer.
L'isolation est celle du navigateur, donc elle sépare des **visiteurs**, pas des
onglets : deux onglets d'un même navigateur partagent la même sandbox, et un
seul la fait tourner à la fois — le second propose de reprendre la main.
Un `F5` remet tout à zéro. Ajoutez `?fresh=1` à la fin de
l'URL pour ignorer l'instantané et repartir d'un boot à froid.

Deux usages dérivent des mêmes propriétés : l'**aperçu de pull request jetable**
(une sandbox par branche, publiée puis oubliée) et la **reproduction de bug dans
une issue** (l'état exact qui plante, joignable en une URL).

---

## Ce que railsbox n'est PAS

- **Ce n'est pas un hébergeur de production.** railsbox sert à *montrer et faire
  essayer*, jamais à *opérer*. Pas de paiements bancaires live, pas de base de
  données partagée entre vos clients, pas de données qui survivent à l'onglet :
  chaque visiteur reçoit sa propre copie jetable. Une application qui doit
  encaisser, appeler des API tierces ou conserver de l'état n'a rien à faire ici.
- **Ce n'est pas un remplaçant de VS Code.** Ce n'est pas un IDE de développement
  quotidien, ni un environnement de travail distant : c'est un **lecteur
  universel de démonstration**. Vous développez chez vous, comme avant ; railsbox
  publie le résultat.
- **Ce n'est pas un émulateur de tout Rails.** ActionCable et les WebSockets sont
  hors périmètre, le réseau sortant n'existe pas, et la vitesse est celle d'une
  émulation — voir « [Limites connues](compatibilite.md#limites-connues) ».

Ces refus sont **délibérés**. Ce sont des défauts si l'on compare railsbox à un
hébergeur, et des propriétés dès qu'on assume le cadrage : une sandbox n'a rien
à protéger côté serveur, puisqu'il n'y a pas de serveur.

---
