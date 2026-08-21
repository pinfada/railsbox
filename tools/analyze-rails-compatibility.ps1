<#
.SYNOPSIS
  Dit si une application Rails a des chances de tourner dans RailsBox, et ce
  qui l'en empêche.

.DESCRIPTION
  L'outil répond à une question que la documentation pose sans y répondre
  mécaniquement : « mon application passe-t-elle ? ». Il lit ce qui décide,
  et rien d'autre.

  CE QU'IL REGARDE, ET POURQUOI CHAQUE POINT COMPTE.

  · Application ou gem. RailsBox construit une image qui BOOTE l'application.
    Une bibliothèque n'a rien à booter. Le critère est la présence simultanée
    de `config/application.rb` et `bin/rails`.

  · Version de Ruby. C'est le point le plus souvent bloquant, et le moins
    visible. L'interpréteur est compilé dans l'image de BASE mutualisée
    (ADR 0004) : le disque applicatif ne peut pas en changer. Une directive
    `ruby` dans le Gemfile — `ruby file: ".ruby-version"` comprise — est
    imposée par Bundler, donc l'application exige une base de cette série
    exacte. Sans directive, seule la compatibilité des gems tranche.

  · Base de données. PostgreSQL et SQLite sont dans la base ; MySQL ne l'est
    pas.

  · Seeds. Une démonstration sur une base vide ne montre rien. Le fichier
    `db/seeds.rb` par défaut de Rails ne contient QUE des commentaires : on
    compte les lignes exécutables, jamais les octets.

  · Services externes. LA VM N'A AUCUN RÉSEAU SORTANT. Stripe, S3, un
    fournisseur OAuth ou Elasticsearch ne répondront jamais. L'application
    démarre quand même — ce n'est pas rédhibitoire — mais toute page qui en
    dépend sera dégradée, et mieux vaut le savoir avant de construire.

  · Licence. Une sandbox publiée redistribue le code de l'application dans une
    image disque téléchargeable. Une licence absente n'autorise rien.

  Le verdict n'est pas une garantie : seule une construction réelle en est
  une. Il évite de lancer une construction longue vouée à échouer.

.PARAMETER Depot
  Un ou plusieurs dépôts GitHub, au format `proprietaire/nom`.

.PARAMETER Chemin
  Un ou plusieurs dossiers locaux contenant une application Rails.

.PARAMETER Sortie
  Chemin d'un CSV à écrire. Facultatif.

.EXAMPLE
  .\tools\analyze-rails-compatibility.ps1 -Depot tryzealot/zealot
  .\tools\analyze-rails-compatibility.ps1 -Chemin ..\mon-app -Sortie rapport.csv
  .\tools\analyze-rails-compatibility.ps1 -Depot a/b, c/d
#>
[CmdletBinding(DefaultParameterSetName = 'Depot')]
param(
    [Parameter(ParameterSetName = 'Depot', Position = 0)]
    [string[]] $Depot,

    [Parameter(ParameterSetName = 'Chemin')]
    [string[]] $Chemin,

    [string] $Sortie
)

$ErrorActionPreference = 'Stop'

# La console de Windows PowerShell 5.1 est en codepage ANSI : sans ceci, les
# accents de ce script s'affichent en « DÃ©pÃ´ts ».
try { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8 } catch { }

# Séries de base publiées par RailsBox. Une application qui exige autre chose
# demande une base qui n'existe pas encore.
$SeriesPubliees = @('3.3')

function Get-ContenuDepot {
    <#
      Rapporte en UNE requête GraphQL les fichiers qui décident. Un appel par
      fichier coûterait six allers-retours par dépôt.

      La requête part par FICHIER : Windows PowerShell 5.1 supprime les
      guillemets internes d'un argument transmis à un exécutable natif, si
      bien que `expression: "HEAD:Gemfile"` arrivait à gh sous la forme
      `expression: HEAD:Gemfile` — GraphQL répondait « Expected NAME, actual:
      COLON ». Le fichier doit en outre être écrit SANS BOM, que le parseur
      refuse comme premier caractère.
    #>
    param([string] $Depot)

    $proprietaire, $nom = $Depot -split '/', 2
    $requete = @"
query {
  repository(owner: "$proprietaire", name: "$nom") {
    nameWithOwner
    description
    licenseInfo { spdxId }
    appRb:    object(expression: "HEAD:config/application.rb") { __typename }
    binRails: object(expression: "HEAD:bin/rails")             { __typename }
    gemfile:  object(expression: "HEAD:Gemfile")               { ... on Blob { text } }
    seeds:    object(expression: "HEAD:db/seeds.rb")           { ... on Blob { text } }
    rubyVer:  object(expression: "HEAD:.ruby-version")         { ... on Blob { text } }
    readme:   object(expression: "HEAD:README.md")             { ... on Blob { text } }
  }
}
"@
    $fichier = Join-Path ([System.IO.Path]::GetTempPath()) "railsbox-compat-$([guid]::NewGuid()).graphql"
    [System.IO.File]::WriteAllText($fichier, $requete, (New-Object System.Text.UTF8Encoding($false)))
    try {
        $reponse = gh api graphql -F query=@$fichier | ConvertFrom-Json
    } finally {
        Remove-Item -Path $fichier -ErrorAction SilentlyContinue
    }
    $r = $reponse.data.repository
    if (-not $r) { throw "dépôt introuvable : $Depot" }

    [PSCustomObject]@{
        Nom         = $r.nameWithOwner
        Description = $r.description
        Licence     = if ($r.licenseInfo.spdxId) { $r.licenseInfo.spdxId } else { 'aucune' }
        EstApp      = [bool]($r.appRb -and $r.binRails)
        Gemfile     = if ($r.gemfile.text) { $r.gemfile.text } else { '' }
        Seeds       = if ($r.seeds.text) { $r.seeds.text } else { '' }
        RubyVersion = if ($r.rubyVer.text) { $r.rubyVer.text.Trim() } else { '' }
        Readme      = if ($r.readme.text) { $r.readme.text } else { '' }
    }
}

function Get-ContenuLocal {
    param([string] $Racine)
    $lire = {
        param($relatif)
        $chemin = Join-Path $Racine $relatif
        if (Test-Path $chemin) { Get-Content $chemin -Raw -ErrorAction SilentlyContinue } else { '' }
    }
    $licence = & $lire 'LICENSE'
    if (-not $licence) { $licence = & $lire 'LICENSE.md' }

    [PSCustomObject]@{
        Nom         = (Resolve-Path $Racine).Path
        Description = ''
        Licence     = if ($licence -match 'MIT') { 'MIT' }
                      elseif ($licence -match 'Apache') { 'Apache-2.0' }
                      elseif ($licence -match 'GNU (Affero )?General Public') { 'GPL' }
                      elseif ($licence) { 'autre' } else { 'aucune' }
        EstApp      = (Test-Path (Join-Path $Racine 'config/application.rb')) -and
                      (Test-Path (Join-Path $Racine 'bin/rails'))
        Gemfile     = & $lire 'Gemfile'
        Seeds       = & $lire 'db/seeds.rb'
        RubyVersion = (& $lire '.ruby-version').Trim()
        Readme      = & $lire 'README.md'
    }
}

function Get-Analyse {
    param([PSCustomObject] $Source)

    $gemfile = $Source.Gemfile

    # Contrainte Ruby : une directive `ruby` du Gemfile est IMPOSÉE par
    # Bundler. `ruby file: ".ruby-version"` en est une : Bundler lit le
    # fichier et exige sa valeur.
    $directive = if ($gemfile -match '(?m)^\s*ruby\s+(.+)$') { $Matches[1].Trim() } else { '' }
    $versionExigee = ''
    if ($directive -match "[`"'](\d+\.\d+(\.\d+)?)[`"']") { $versionExigee = $Matches[1] }
    elseif ($directive -and $Source.RubyVersion) { $versionExigee = $Source.RubyVersion }
    elseif ($Source.RubyVersion) { $versionExigee = $Source.RubyVersion }

    $serie = if ($versionExigee -match '^(\d+\.\d+)') { $Matches[1] } else { '' }
    $rubyImpose = [bool]$directive

    $base = switch -Regex ($gemfile) {
        "gem\s+[`"']pg[`"']"               { 'postgresql'; break }
        "gem\s+[`"']sqlite3[`"']"          { 'sqlite3';    break }
        "gem\s+[`"'](mysql2|trilogy)[`"']" { 'mysql';      break }
        default                            { 'inconnue' }
    }

    $lignesSeeds = @(
        $Source.Seeds -split "`n" | Where-Object { $_.Trim() -and -not $_.Trim().StartsWith('#') }
    ).Count

    $externes = @()
    foreach ($paire in @(
            @('stripe',        "gem\s+[`"']stripe[`"']"),
            @('s3/aws',        "gem\s+[`"']aws-sdk"),
            @('oauth',         "gem\s+[`"']omniauth-"),
            @('elasticsearch', "gem\s+[`"'](elasticsearch|opensearch)")
        )) {
        if ($gemfile -match $paire[1]) { $externes += $paire[0] }
    }

    # --- Verdict ---------------------------------------------------------
    $bloquants = @()
    $reserves  = @()

    if (-not $Source.EstApp) { $bloquants += "pas une application Rails (ni config/application.rb ni bin/rails)" }
    if ($base -eq 'mysql')   { $bloquants += "MySQL absent de l'image de base" }
    if ($rubyImpose -and $serie -and ($SeriesPubliees -notcontains $serie)) {
        $bloquants += "exige Ruby $versionExigee : aucune base $serie publiée"
    }
    if (-not $rubyImpose -and $serie -and ($SeriesPubliees -notcontains $serie)) {
        $reserves += ".ruby-version demande $versionExigee, non imposé par Bundler : à vérifier"
    }
    if ($base -eq 'inconnue') { $reserves += "adaptateur de base non identifié" }
    if ($lignesSeeds -lt 1)   { $reserves += "aucune seed : la démonstration partirait d'une base vide" }
    if ($externes.Count)      { $reserves += "services sans réseau sortant : $($externes -join ', ')" }
    if ($Source.Licence -eq 'aucune') { $reserves += "aucune licence : la redistribution n'est pas autorisée" }

    $verdict = if ($bloquants.Count) { 'bloqué' } elseif ($reserves.Count) { 'sous réserve' } else { 'compatible' }

    [PSCustomObject]@{
        Application    = $Source.Nom
        Verdict        = $verdict
        Licence        = $Source.Licence
        Base           = $base
        RubyExige      = if ($versionExigee) { $versionExigee } else { 'non précisé' }
        RubyImpose     = $rubyImpose
        BaseRequise    = if ($serie) { "base $serie" } else { 'indifférente' }
        SeedsLignes    = $lignesSeeds
        Externes       = ($externes -join '+')
        Bloquants      = ($bloquants -join ' | ')
        Reserves       = ($reserves -join ' | ')
    }
}

if (-not (Get-Command gh -ErrorAction SilentlyContinue) -and $PSCmdlet.ParameterSetName -eq 'Depot') {
    throw "gh introuvable. Installez GitHub CLI et lancez 'gh auth login'."
}

$sources = @()
if ($PSCmdlet.ParameterSetName -eq 'Chemin') {
    foreach ($c in $Chemin) { $sources += Get-ContenuLocal -Racine $c }
} else {
    if (-not $Depot) { throw "Donnez au moins -Depot proprietaire/nom ou -Chemin dossier." }
    foreach ($d in $Depot) {
        try { $sources += Get-ContenuDepot -Depot $d }
        catch { Write-Warning "$d ignoré : $($_.Exception.Message)" }
    }
}

$analyses = $sources | ForEach-Object { Get-Analyse -Source $_ }

$analyses | Format-Table -AutoSize Application, Verdict, Licence, Base, RubyExige, BaseRequise, SeedsLignes, Externes
foreach ($a in $analyses | Where-Object { $_.Bloquants -or $_.Reserves }) {
    Write-Host ""
    Write-Host $a.Application -ForegroundColor Cyan
    foreach ($b in ($a.Bloquants -split ' \| ' | Where-Object { $_ })) { Write-Host "  bloquant : $b" }
    foreach ($r in ($a.Reserves  -split ' \| ' | Where-Object { $_ })) { Write-Host "  réserve  : $r" }
}

if ($Sortie) {
    $analyses | Export-Csv -Path $Sortie -NoTypeInformation -Encoding utf8
    Write-Host ""
    Write-Host "CSV écrit : $Sortie"
}
