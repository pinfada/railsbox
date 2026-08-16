#!/usr/bin/env node
// Écrit la page d'accueil du dépôt d'artefacts railsbox sur la sortie standard.
//
//   node tools/build-v86-image/ecrire-index-assets.mjs <racine> > <racine>/index.html
//
// Le dépôt d'artefacts est un hébergement statique consommé par des machines,
// mais un humain finit toujours par ouvrir son URL — un mainteneur qui cherche
// quelle version épingler, ou quelqu'un qui tombe dessus. La page recense les
// versions présentes et les adresses exactes à utiliser, sans dépendance
// externe (aucun script, aucune police distante).
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const PREFIX = "base-";

/**
 * Recense les versions publiées et ce qu'on peut en dire.
 * @param {string} root racine du dépôt d'artefacts
 * @returns {{name: string, totalBytes: number|null, partCount: number|null, publishedBytes: number|null}[]}
 */
export function listVersions(root) {
  return readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && entry.name.startsWith(PREFIX))
    .map((entry) => {
      const manifestPath = join(root, entry.name, `${entry.name}.ext2-parts.json`);
      try {
        const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
        return {
          name: entry.name,
          totalBytes: manifest.totalBytes ?? null,
          partCount: manifest.partCount ?? null,
          publishedBytes: manifest.publishedBytes ?? null,
        };
      } catch {
        return { name: entry.name, totalBytes: null, partCount: null, publishedBytes: null };
      }
    })
    .sort((a, b) => a.name.localeCompare(b.name));
}

const escapeHtml = (value) =>
  String(value).replace(
    /[&<>"']/g,
    (character) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character],
  );

const megabytes = (bytes) => (bytes === null ? "—" : `${Math.round(bytes / 1048576)} Mo`);

/**
 * @param {ReturnType<typeof listVersions>} versions
 * @returns {string} document HTML complet
 */
export function renderIndex(versions) {
  const rows = versions
    .map(
      (version) => `      <tr>
        <td><code>${escapeHtml(version.name)}</code></td>
        <td>${megabytes(version.totalBytes)}</td>
        <td>${version.partCount ?? "—"}</td>
        <td>${megabytes(version.publishedBytes)}</td>
        <td><a href="${escapeHtml(version.name)}/${escapeHtml(version.name)}.ext2-parts.json">inventaire</a></td>
      </tr>`,
    )
    .join("\n");

  const premiere = versions[0]?.name ?? "base-3.3";

  return `<!doctype html>
<html lang="fr">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Artefacts railsbox</title>
    <style>
      :root { color-scheme: light dark; }
      body { font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
             max-width: 52rem; margin: 3rem auto; padding: 0 1.5rem; line-height: 1.6; }
      h1 { font-size: 1.5rem; }
      table { border-collapse: collapse; width: 100%; margin: 1.5rem 0; }
      th, td { text-align: left; padding: .4rem .8rem; border-bottom: 1px solid #8884; }
      code { background: #8882; padding: .1rem .3rem; border-radius: 3px; }
      pre { background: #8881; padding: 1rem; border-radius: 6px; overflow-x: auto; }
      .note { color: #8889; }
    </style>
  </head>
  <body>
    <h1>Artefacts railsbox</h1>
    <p>
      Hébergement statique des rootfs de base mutualisés. Chaque version est
      <strong>immuable</strong> : elle n'est jamais réécrite, une correction produit
      une nouvelle version. Les sandboxes épinglent la leur.
    </p>

    <table>
      <thead>
        <tr><th>Version</th><th>Rootfs</th><th>Morceaux</th><th>Publié</th><th></th></tr>
      </thead>
      <tbody>
${rows || '        <tr><td colspan="5">Aucune version publiée.</td></tr>'}
      </tbody>
    </table>

    <h2>Utilisation</h2>
    <p>
      Le rootfs est découpé en fichiers-parties compressés en zstd, que v86 lit
      nativement : il calcule le nom du morceau contenant l'offset demandé et ne
      télécharge que celui-là. Il n'y a rien à réassembler côté navigateur.
    </p>
    <pre>hda: {
  url: "${escapeHtml(premiere)}/${escapeHtml(premiere)}.ext2.zst",
  async: true,
  size: &lt;totalBytes de l'inventaire&gt;,
  use_parts: true,
  fixed_chunk_size: &lt;chunkBytes de l'inventaire&gt;,
}</pre>
    <p class="note">
      L'instantané <code>-state.bin.gz</code> ne sert pas au visiteur : il permet à
      la CI d'un mainteneur de capturer le delta de son application.
    </p>
    <p class="note">
      Produit automatiquement par le workflow « Publier la base » de railsbox.
      Ne pas modifier à la main : la branche est réécrite à chaque publication.
    </p>
  </body>
</html>
`;
}

const root = process.argv[2];
if (!root) {
  process.stderr.write("Usage : node ecrire-index-assets.mjs <racine>\n");
  process.exitCode = 2;
} else if (!statSync(root).isDirectory()) {
  process.stderr.write(`Pas un répertoire : ${root}\n`);
  process.exitCode = 2;
} else {
  process.stdout.write(renderIndex(listVersions(root)));
}
