# Où sont précompilés les assets

Pourquoi certaines chaînes de construction passent par un étage amd64, et ce que cela implique pour votre application.

*Retour au [README](../README.md).*

---

## Où sont précompilés les assets

Le guest est un **i386**, et deux familles d'outils d'assets ne publient aucun
binaire pour cette architecture : les gems à exécutable précompilé
(`tailwindcss-ruby` dont dépend tailwindcss-rails, `dartsass-ruby`) et les
chaînes npm (esbuild, sass). Elles produisent pourtant du CSS et du JS
**ordinaires**, indépendants de l'architecture — on les exécute donc sur un
**étage amd64**, et le disque i386 ne reçoit que `public/assets`. Le guest
n'exécute jamais ces binaires.

L'auto-détection classe seule chaque application :

| Ce qu'elle trouve | Étage retenu | Ce qui tourne |
| --- | --- | --- |
| propshaft/sprockets + importmap | `i386` | `assets:precompile` dans le disque applicatif |
| tailwindcss-rails, dartsass-rails | `amd64` | `assets:precompile` sur l'hôte, copie de `public/assets` |
| `package.json` (jsbundling/cssbundling) | `amd64` | `npm ci` + scripts de build, puis `assets:precompile` |
| aucun pipeline | `aucun` | rien |

L'étage amd64 pose exactement le même `RAILS_RELATIVE_URL_ROOT` que le disque
applicatif : les URL figées dans le CSS portent le préfixe **public complet**
(`/depot/app/assets/…`), sous le site et non à la racine du domaine — sans quoi
le Service Worker ne pourrait même pas les rattraper.

Une variante Tailwind de l'application de démonstration sert de banc d'essai —
surcouche de sept fichiers sur `demo/`, comme `demo-pg` :

```bash
APP="$(bash tools/demo-app/preparer-demo-tailwind.sh)"
wsl -u root -e bash tools/build-v86-image/build-app-disk.sh "$APP"     --name demo-tailwind --base ghcr.io/pinfada/railsbox-base:3.3-r2
node tools/build-v86-image/make-delta-snapshot.mjs --name demo-tailwind --base base-3.3-r2
node --test tests/integration/vm-tailwind.it.mjs
```

Le test d'intégration ne se contente pas de constater qu'une feuille de style
existe : il va chercher dans le CSS **servi par la VM** un utilitaire à valeur
arbitraire (`tracking-[0.35em]`), qu'aucune feuille pré-construite ne peut
contenir. Sa présence prouve que le binaire `tailwindcss` a balayé les vues
pendant cette construction — sur l'hôte amd64, jamais dans le guest.

Deux points d'attention plutôt qu'un refus : sans `package-lock.json` (ou avec un
verrou bun, que railsbox ne relit pas), l'installation retombe sur
`npm install` et la construction n'est plus reproductible — c'est un
avertissement du rapport d'analyse. Et si l'étage amd64 ne produit **aucun**
asset, la construction s'arrête là.

### Ce que l'étage amd64 remonte dans la sandbox

L'étage n'exportait longtemps que `public/assets` et `app/assets/builds`. C'est
le compte exact pour sprockets/propshaft et pour `jsbundling-rails` — et pour
personne d'autre. `vite_rails` écrit dans `public/vite`, Shakapacker dans
`public/packs`, un `vite build` nu dans ce que dit sa configuration. Ces bundles
partaient à la poubelle **sans que rien n'échoue** : la construction
réussissait, la sandbox bootait, et le SPA manquait à l'affichage. Le garde-fou
« aucun asset produit → interruption » ne l'attrapait pas, puisque Tailwind,
lui, avait bien produit ses fichiers.

Trois dispositifs répondent à cette panne, du plus automatique au plus explicite.

**1. L'auto-détection**, qui couvre le cas courant sans que le mainteneur écrive
quoi que ce soit :

| Ce qu'elle trouve | Ce qu'elle ajoute à l'export |
| --- | --- |
| `vite_rails` / `vite_ruby` dans le Gemfile.lock | `public/vite` |
| `shakapacker` / `webpacker` | `public/packs` |
| `config/vite.json` (`publicOutputDir`) | le répertoire déclaré, tous environnements confondus |
| `config/shakapacker.yml` (`public_output_path`) | idem, ancres YAML comprises |

**2. `assets.output`**, l'échappatoire, pour ce que personne ne peut deviner —
un `vite build` appelé directement, un script maison :

```yaml
assets:
  scripts: ["build:css", "build:react"]
  output: ["public/dist"]
```

**3. L'avertissement de fin d'étage**, la garde qui rattrape les deux autres.
Juste avant de lancer les scripts, l'étage pose un repère temporel ; juste
après, il relève les répertoires qui ont été écrits et ne seront pas exportés,
et les nomme :

```
⚠ Répertoires produits par les builds mais NON exportés vers la sandbox :
    public/dist
  Leur contenu reste sur l'étage amd64 : la sandbox servira la version
  versionnée dans le dépôt, ou rien du tout. Déclarez-les dans railsbox.yml :
    assets:
      output: [public/dist]
```

C'est un **avertissement**, pas un refus : un répertoire produit et non exporté
est parfois exactement ce qu'on veut (un rapport de couverture, un cache de
build). La comparaison élague `node_modules`, `.git`, `tmp`, `log`,
`vendor/bundle`, `.bundle`, `storage` et `coverage` — sans quoi elle coûterait
plus cher que ce qu'elle rapporte.
