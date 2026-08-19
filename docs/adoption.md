# Adoption

*Mesuré le 19/08/2026. Cette page est régénérée chaque semaine ; l'historique vit
dans les commits de ce fichier — l'API de trafic de GitHub, elle, n'expose que
les quatorze derniers jours.*

## Mesures

| Indicateur | Valeur | Fenêtre |
| --- | --- | --- |
| Vues du dépôt | 81 (1 unique) | 14 jours |
| Clones | 193 (28 uniques) | 14 jours |
| Tirages de l'image de base | — | cumulé |
| Dépôts publics détectés | 4 | instantané |
| Dépôts privés | **non mesurable** | — |

Le **tirage de l'image de base** (`ghcr.io/pinfada/railsbox-base`) est le seul
signal qui compte aussi les constructions privées : toute construction la tire,
quelle que soit la visibilité du dépôt. Il compte des constructions, pas des
utilisateurs — une re-exécution de CI en ajoute une.

## Sandboxes publiques détectées

- [`pinfada/GenealogyApp`](https://github.com/pinfada/GenealogyApp)
- [`pinfada/fractal`](https://github.com/pinfada/fractal)
- [`pinfada/sharemybag`](https://github.com/pinfada/sharemybag)
- [`pinfada/tchopmygrinds`](https://github.com/pinfada/tchopmygrinds)

Détection automatique, par recherche du workflow réutilisable dans le code
public. Cette liste est une observation, pas une liste de références : un dépôt
y figure parce qu'il déclare publiquement utiliser railsbox.

## À lire avec les chiffres

- **Les clones ne mesurent pas l'adoption.** Chaque construction de sandbox clone ce dépôt (`actions/checkout`) : 87 construction(s) sur la période y contribuent, sans compter la CI de railsbox elle-même. Les « uniques » sont des runners éphémères, pas des personnes.
- **Les dépôts privés sont invisibles.** Aucune recherche ne les voit, aucun compteur ne les distingue. C'est le modèle — pas de serveur, pas de compte, pas de télémétrie — et non un défaut d'outillage.
- **La recherche de code dépend du jeton employé** : elle voit les dépôts publics, plus les dépôts privés auxquels ce jeton a accès. La liste ci-dessus peut donc contenir des dépôts privés du mainteneur.

---

*Page générée par `.github/workflows/mesurer-adoption.yml`. Pour figurer
comme utilisateur — y compris depuis un dépôt privé — voir « Qui l'utilise »
dans le [README](../README.md).*
