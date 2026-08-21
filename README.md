# railsbox

*English version → [README.en.md](README.en.md)*

[![Try with railsbox](https://pinfada.github.io/railsbox-demo/badge.svg)](https://pinfada.github.io/railsbox-demo/)

**railsbox transforme une application Rails en démonstration jouable dans le
navigateur.** Vous collez un workflow GitHub Actions dans votre dépôt, vous
obtenez une URL publique où Puma, la base de données et vos gems C natives
tournent dans une VM Linux x86 émulée — sans serveur, sans conteneur, sans
facture.

**Essayer tout de suite → [pinfada.github.io/railsbox-demo](https://pinfada.github.io/railsbox-demo/)**

Exemple réel : [Zealot 6.2.2 tournant dans railsbox](https://pinfada.github.io/zealot/) —
démonstration non officielle, code source de l'application inchangé.

|                            |                                                                                                             |
| -------------------------- | ----------------------------------------------------------------------------------------------------------- |
| **Du vrai Rails**          | votre application, non modifiée : Puma, PostgreSQL ou SQLite, vos gems natives, vos migrations, vos seeds     |
| **Dans le navigateur**     | tout s'exécute dans l'onglet du visiteur, qui reçoit sa propre instance jetable                               |
| **Sans serveur permanent** | un hébergement statique suffit ; le lien ne tombe pas et ne coûte rien                                        |

---

## Je veux…

| Je veux…                                       | Aller vers                                                                                                            |
| ---------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| Essayer railsbox                               | **[la démonstration](https://pinfada.github.io/railsbox-demo/)**                                                        |
| Publier mon application open source            | **[Démarrer en 5 minutes](#démarrer-en-5-minutes)** ci-dessous                                                          |
| Publier depuis un dépôt privé                  | **[Guide dépôt privé](docs/depot-prive.md)**                                                                            |
| Vérifier si mon application est compatible     | **[Compatibilité](docs/compatibilite.md)**                                                                              |
| Configurer PostgreSQL, les seeds ou les assets | **[Configuration](docs/configuration.md)**                                                                              |
| Comprendre les limites et la sécurité          | **[Modèle de menace](SECURITY.md)**                                                                                     |
| Savoir ce que coûte le chargement              | **[Performances](docs/performances.md)**                                                                                |
| Poser une question                             | **[Discussions · Q&A](https://github.com/pinfada/railsbox/discussions/categories/q-a)**                                 |
| Montrer ma sandbox                             | **[Discussions · Show and tell](https://github.com/pinfada/railsbox/discussions/categories/show-and-tell)**             |
| Contribuer                                     | **[Guide de contribution](CONTRIBUTING.md)**                                                                            |

---

## Démarrer en 5 minutes

### 1. Ajoutez le workflow

Dans votre dépôt Rails, créez `.github/workflows/sandbox.yml` :

```yaml
name: Sandbox railsbox
on:
  push:
    branches: [main, master] # ← votre branche par défaut
  workflow_dispatch:

jobs:
  sandbox:
    uses: pinfada/railsbox/.github/workflows/construire-sandbox.yml@main
    permissions:
      contents: write
```

Le dépôt railsbox est public : n'importe quel dépôt peut référencer ce workflow.

> **Vérifiez la ligne `branches:`.** Un filtre qui ne nomme pas votre branche par
> défaut ne déclenche jamais rien, et **GitHub ne le signale pas** — le workflow
> semble simplement absent. Dans le doute, lancez une première construction à la
> main (bouton _Run workflow_).

> **`@main` bouge.** Sur une démonstration montrée à des tiers, épinglez une
> version : `…/construire-sandbox.yml@v2.3.0`
> ([toutes les versions](https://github.com/pinfada/railsbox/releases)). La version employée est écrite en première
> ligne du journal de boot de chaque sandbox — c'est ce qu'on vous demandera si
> vous signalez un problème.

> **Votre dépôt est privé ?** Sur un compte gratuit, GitHub Pages ne sert pas
> les dépôts privés. Le workflow vous avertit et propose la publication vers un
> dépôt vitrine public — voir le **[guide dépôt privé](docs/depot-prive.md)**.

### 2. Activez GitHub Pages sur la branche `gh-pages`

Poussez d'abord : c'est la première construction qui **crée** `gh-pages`.

_Settings → Pages → Source : Deploy from a branch → `gh-pages` / `(root)`._
Chaque construction republie votre démonstration sur
`https://<compte>.github.io/<depot>/`.

> **`gh-pages` est entièrement remplacée à chaque construction.** Si vous y
> publiez déjà autre chose, publiez la sandbox ailleurs avec l'entrée
> `target-repo` (voir « [Entrées du workflow](docs/configuration.md) »).

### 3. Collez le badge

```markdown
[![Try with railsbox](https://<compte>.github.io/<depot>/badge.svg)](https://<compte>.github.io/<depot>/)
```

Le workflow imprime ce badge tout prêt, avec vos URL, dans le résumé de chaque
construction. Il est servi par votre propre sandbox, pas par un générateur
tiers.

> **C'est à vous de le coller, et c'est délibéré.** railsbox n'écrit JAMAIS dans
> votre branche par défaut : il ne pousse que sur `gh-pages`.

Comptez **~9 minutes** par construction, et **~150–350 Mo** hébergés dans votre
dépôt selon votre application. Le détail est dans
« [Performances](docs/performances.md) ».

---

## Compatibilité, en un coup d'œil

|                          |                                                                                                     |
| ------------------------ | ----------------------------------------------------------------------------------------------------- |
| **Ruby**                 | 3.3.12 (fourni par la base `3.3-r2`, non modifiable)                                                   |
| **Bases de données**     | SQLite et PostgreSQL ; MySQL/MariaDB refusé avec un rapport explicite                                  |
| **Gestionnaires front**  | npm, et pnpm via Corepack ; yarn et bun sont signalés, pas exécutés                                    |
| **Assets**               | importmap, Propshaft, Sprockets, Tailwind, dart-sass, chaînes npm (esbuild, cssbundling, jsbundling)   |
| **Non pris en charge**   | réseau sortant, ActionCable et WebSockets                                                              |

Le détail, les révisions de base et ce qui demande une adaptation de votre code :
« [Compatibilité](docs/compatibilite.md) ».

---

## Limites essentielles

- **Tout l'artefact est public.** L'image disque et l'instantané mémoire sont
  téléchargeables par n'importe qui, et le visiteur est root dans sa VM.
  N'embarquez jamais de vrais secrets ni de vraies données
  ([`SECURITY.md`](SECURITY.md)).
- **Le temps de démarrage varie.** Environ 20–25 s pour la démonstration de
  référence ; jusqu'à 78 s mesurés sur l'application Zealot, selon la taille de
  l'instantané, le réseau et le processeur. Le démarrage ne casse pas, il
  s'allonge.
- **Aucun réseau sortant.** Une gem qui appelle un service distant au démarrage
  échouera ; l'analyse le signale avant la construction.
- **Aucune persistance partagée.** Chaque visiteur écrit dans sa copie, qui
  disparaît avec l'onglet. `F5` remet tout à zéro.
- **Ce n'est pas un hébergement de production.** railsbox sert à _montrer et
  faire essayer_, jamais à _opérer_.

---

## Documentation et communauté

| Page                                                                          | Ce qu'on y trouve                                                                  |
| ----------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| **[Configuration](docs/configuration.md)**                                     | `railsbox.yml`, entrées du workflow, PostgreSQL, seeds, auto-connexion, paquets     |
| **[Compatibilité](docs/compatibilite.md)**                                     | ce qui passe, ce qui est refusé, les limites du modèle                              |
| **[Performances](docs/performances.md)**                                       | ce que le visiteur télécharge, mesures par moteur et sous processeur bridé          |
| **[Dépôt privé](docs/depot-prive.md)**                                         | dépôt vitrine, clé de déploiement, coût des minutes Actions                         |
| **[Pour qui c'est fait](docs/usages.md)**                                      | les profils visés, et ce que railsbox n'est pas                                     |
| **[Applications à SPA](docs/spa.md)**                                          | React/Vue/Vite sous un préfixe d'URL, auto-connexion par jeton                       |
| **[Assets](docs/assets.md)**                                                   | Tailwind, dart-sass, chaînes npm : pourquoi un étage amd64                          |
| **[Fonctionnement](docs/fonctionnement.md)**                                   | modèle d'exécution, trajet d'une requête, cache des artefacts                       |
| **[Architecture du code](docs/architecture.md)**                               | par où commencer à lire les 17 000 lignes                                            |
| **[Développement](docs/developpement.md)**                                     | tester en local, republier la base, construire à la main                            |
| **[Retour d'expérience](docs/retour-experience.md)**                           | les défis résolus — la mémoire du projet                                             |
| **[Décisions (ADR)](docs/decisions/)**                                         | pourquoi les choix structurants ont été faits                                        |
| **[Modèle de menace](SECURITY.md)**                                            | ce qui est protégé, ce qui ne l'est pas                                              |
| **[Adoption](docs/adoption.md)** · **[Utilisateurs](docs/utilisateurs.md)**     | sandboxes détectées, et la liste tenue à la main                                     |
| **[Contribuer](CONTRIBUTING.md)** · **[Chantiers ouverts](docs/chantiers.md)** | comment aider
| **[Code de conduite](CODE_OF_CONDUCT.md)** | ce qu'on attend de chacun dans les espaces du projet                                                                        |

**[Q&A](https://github.com/pinfada/railsbox/discussions/categories/q-a)** pour
une question,
**[Show and tell](https://github.com/pinfada/railsbox/discussions/categories/show-and-tell)**
pour montrer une sandbox. Une faille se signale en privé (onglet Security),
jamais par une issue publique — voir [`SECURITY.md`](SECURITY.md).

---

## Licences tierces

railsbox est sous licence MIT ([`LICENSE`](LICENSE)). Il vendorise l'émulateur
[v86](https://github.com/copy/v86) (BSD 2-Clause,
[`public/vendor/v86/LICENSE`](public/vendor/v86/LICENSE)) et les firmwares qu'il
embarque : SeaBIOS (`seabios.bin`, LGPLv3) et le VGABIOS de Bochs
(`vgabios.bin`, LGPL). Les rootfs publiés dans `railsbox-assets` contiennent des
logiciels libres (Linux, Ruby, Rails…) sous leurs licences respectives.
