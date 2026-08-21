# Publier depuis un dépôt privé

Pages ne sert pas un dépôt privé sur un compte gratuit, et ne le dit nulle part. Les deux issues, l'amorçage d'un dépôt vitrine, et ce que ça coûte.

*Retour au [README](../README.md).*

---


Sur un dépôt public, les trois étapes ci-dessus suffisent et tout est gratuit :
Actions et Pages le sont. Sur un dépôt privé, elles ne suffisent pas — et
l'échec est du genre qu'on met une soirée à comprendre : la construction passe,
`gh-pages` est bien poussée, l'onglet Actions reste vert, et **il n'y a pas de
page**. GitHub Pages ne sert pas un dépôt privé sur un compte gratuit ; il ne le
dit nulle part. C'est exactement ce qui est arrivé au premier dépôt privé
installé avec le workflow public : jamais aucune page, jamais aucun message.

Deux issues, dont une seule est gratuite :

- **Plan Pro, Team ou Enterprise** : Pages fonctionne depuis un dépôt privé, et
  le workflow public ci-dessus marche tel quel. Notez ce qu'il publie : **le
  site, lui, est public** — seul le code reste privé. Les minutes Actions
  restent facturées.
- **N'importe quel plan, y compris gratuit** : le code reste privé et la sandbox
  est publiée dans un **dépôt vitrine public dédié**. C'est le chemin
  recommandé, et le seul qui ne coûte rien.

Le reste de cette section décrit le second.

## 1. Amorcez la vitrine

Le workflow **ne crée rien** : il pousse. Son jeton n'a de droits que sur le
dépôt courant, donc il ne peut ni créer le dépôt vitrine, ni y poser une clé, ni
s'écrire un secret. Un script fait ces gestes depuis votre machine, avec votre
authentification `gh` — aucun jeton supplémentaire à créer, et la clé privée
qu'il génère est effacée en fin d'exécution :

```sh
curl -fsSL -o amorcer-vitrine.sh https://raw.githubusercontent.com/pinfada/railsbox/main/tools/amorcer-vitrine.sh
sh amorcer-vitrine.sh <compte>/<depot-source> <compte>/<depot-vitrine>
```

Deux lignes, et pas de `curl … | sh` : le script vous demande confirmation
**sur l'entrée standard**, que le tube occupe déjà — il partirait sans vous
attendre, ou refuserait de lire. Sur un projet qui explique par ailleurs ce
qu'il ne protège pas, avaler un script distant sans l'avoir sous les yeux serait
en plus un mauvais signal. Téléchargez, lisez si vous voulez, exécutez.

Il crée la vitrine **vide** (un README coché à la création suffirait à garder
`main` comme branche par défaut, et la page du dépôt resterait vide aux yeux des
visiteurs), génère une paire de clés dédiée, pose la publique en clé de
déploiement écriture sur la vitrine, la privée en secret `PUBLISH_KEY` sur votre
dépôt, pousse une branche `gh-pages` d'attente et **active GitHub Pages dessus
dans la foulée** — il n'y a donc rien à activer après la première construction.
Il **refuse plutôt que de deviner**, et il refuse **avant** de créer quoi que
ce soit : `gh` non authentifié, dépôt source inaccessible ou dont vous n'êtes
pas administrateur, vitrine visée chez un autre compte personnel, organisation
qui interdit les dépôts publics, vitrine existante que vous n'administrez pas
ou qui n'est pas publique. En revanche une vitrine **déjà amorcée** ne l'arrête
pas : il reprend là où il faut, et ne touche jamais à une branche `gh-pages`
existante — ce serait effacer une démonstration en ligne.

Un amorçage déjà fait se contrôle sans rien modifier :
`sh amorcer-vitrine.sh --verifier <compte>/<depot-source> <compte>/<depot-vitrine>`.

## 2. Collez ce workflow

```yaml
name: Sandbox railsbox

on:
  workflow_dispatch: # ← à la demande : voir « Le coût » ci-dessous
  # push:
  #   branches: [main]

jobs:
  sandbox:
    uses: pinfada/railsbox/.github/workflows/construire-sandbox.yml@main
    permissions:
      contents: write
    with:
      target-repo: <compte>/<depot-vitrine>
    secrets:
      publish-key: ${{ secrets.PUBLISH_KEY }}
```

`target-repo` dit où publier, `publish-key` est la clé d'écriture posée par le
script : le jeton du workflow ne vaut que pour le dépôt courant, il ne peut rien
écrire ailleurs. Sans ce secret, la construction s'arrête au moment de publier.
La démonstration sera servie sur `https://<compte>.github.io/<depot-vitrine>/`,
et c'est cette URL-là que porte votre badge.

## Le coût

Sur un dépôt privé, les minutes Actions sont **facturées**, et une construction
railsbox en consomme **~9**. Avec `on: push`, c'est neuf minutes à chaque
poussée sur votre branche par défaut — y compris pour les commits qui ne
changent rien à ce que la démonstration montre. D'où le `workflow_dispatch` seul
ci-dessus : sur un dépôt privé, republiez quand vous avez quelque chose de
nouveau à montrer, pas à chaque `git push`. Décommentez le `push:` en
connaissance de cause.
