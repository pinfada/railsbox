# Adoption

*Mesuré le 19/08/2026. Cette page est régénérée chaque semaine ; l'historique vit
dans les commits de ce fichier — l'API de trafic de GitHub, elle, n'expose que
les quatorze derniers jours.*

## Mesures

| Indicateur | Valeur | Fenêtre |
| --- | --- | --- |
| Vues du dépôt | 81 (1 unique) | 14 jours |
| Clones | 193 (28 uniques) | 14 jours |
| Versions publiées de l'image de base | 5 | cumulé |
| Dépôts publics détectés | 4 | instantané |
| Dépôts privés | **non mesurable** | — |

**Aucune ligne de ce tableau ne mesure l'usage privé, et il n'en existe pas.**
On a pu croire que le compteur de l'image de base y suppléerait — toute
construction la tire, quelle que soit la visibilité du dépôt. Vérification
faite, l'API de GitHub n'expose **aucun compteur de téléchargements** pour une
image de conteneur : seulement le nombre de versions que *nous* avons publiées,
c'est-à-dire notre propre activité. Le chiffre reste ici pour dater les
révisions de base, jamais comme signal d'adoption.

## Qui l'utilise

_Personne ne s'est encore déclaré. Si railsbox vous sert, ajoutez-vous : c'est le seul retour que le projet reçoit — et **la seule façon d'apparaître depuis un dépôt privé**, qu'aucune détection ne verra jamais._

Liste tenue à la main, dans [docs/utilisateurs.md](utilisateurs.md) — le seul
fichier à modifier : cette page-ci est régénérée chaque semaine.

## Sandboxes publiques détectées

- [`pinfada/fractal-demo`](https://github.com/pinfada/fractal-demo)
- [`pinfada/genealogyapp-demo`](https://github.com/pinfada/genealogyapp-demo)
- [`pinfada/sharemybag`](https://github.com/pinfada/sharemybag)
- [`pinfada/tchopmygrinds`](https://github.com/pinfada/tchopmygrinds)

Détection automatique, par recherche du workflow réutilisable. **Seules des
sandboxes publiques y figurent** : quand la source est privée, c'est sa vitrine
publique qui est nommée — jamais le dépôt privé, que cette page ne divulguera
pas. Un dépôt dont la visibilité ou le workflow est illisible n'y figure pas du
tout : le silence vaut mieux qu'une fuite.

Cette liste est une observation, pas une liste de références.

## À lire avec les chiffres

- **Les clones ne mesurent pas l'adoption.** Chaque construction de sandbox clone ce dépôt (`actions/checkout`) : 91 construction(s) sur la période y contribuent, sans compter la CI de railsbox elle-même. Les « uniques » sont des runners éphémères, pas des personnes.
- **Les dépôts privés sont invisibles.** Aucune recherche ne les voit, aucun compteur ne les distingue. C'est le modèle — pas de serveur, pas de compte, pas de télémétrie — et non un défaut d'outillage.
- **La recherche de code dépend du jeton employé** : elle voit les dépôts publics, plus les dépôts privés auxquels ce jeton a accès. La liste ci-dessus peut donc contenir des dépôts privés du mainteneur.

---

*Page générée par `.github/workflows/mesurer-adoption.yml`. Pour figurer
comme utilisateur — y compris depuis un dépôt privé — voir « Qui l'utilise »
dans le [README](../README.md).*
