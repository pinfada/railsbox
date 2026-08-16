// Configuration Playwright de la RECETTE EN LIGNE : elle ne teste pas le code
// du dépôt, elle teste la sandbox déjà PUBLIÉE, à son URL réelle.
//
// C'est une suite à part pour une raison de fond : elle dépend du réseau et
// d'un déploiement, deux choses qu'une CI de dépôt ne doit jamais exiger. Elle
// ne tourne donc ni dans `npm test` ni dans `npm run test:e2e`, mais via
// `npm run test:live` et le workflow .github/workflows/verifier-sandbox.yml.
//
// Historique : ces vérifications existaient dans un script de travail jamais
// versionné. C'est pourtant lui — et lui seul — qui a trouvé les quatre défauts
// de portabilité de chemin invisibles en local (référence absolue /main.js,
// mauvais moteur par défaut, préfixe de dépôt transmis au guest, assets générés
// à la racine du domaine). Le voici versionné.
import { defineConfig } from "@playwright/test";

import { projetsMoteurs } from "./tests/moteurs.mjs";
import { urlSandbox } from "./tests/live/url-sandbox.mjs";

export default defineConfig({
  testDir: "tests/live",
  testMatch: "**/*.live.spec.mjs",
  // Un boot de VM sature le processeur : paralléliser ne ferait qu'inventer
  // des délais dépassés.
  workers: 1,
  fullyParallel: false,
  // Boot en ligne mesuré entre 25 et 80 s, téléchargement des morceaux compris.
  // La marge couvre un GitHub Pages lent sans masquer un blocage définitif :
  // les badges en erreur interrompent l'attente immédiatement.
  timeout: 300_000,
  expect: { timeout: 30_000 },
  reporter: [["list"]],
  // Une suite réseau échoue parfois pour la faute du réseau. Un seul nouvel
  // essai en CI, aucun en local où l'on veut voir l'échec tout de suite.
  retries: process.env.CI ? 1 : 0,
  use: {
    baseURL: urlSandbox(),
    // Le trace viewer capture les ressources : avec un instantané de plusieurs
    // centaines de Mo dans le flux, l'archive devient ingérable.
    trace: "off",
    video: "off",
    screenshot: "only-on-failure",
  },
  // Chromium par défaut ; `RAILSBOX_MOTEURS=tous` (ou une liste) élargit la
  // recette à Firefox et WebKit. Voir tests/moteurs.mjs.
  projects: projetsMoteurs(process.env.RAILSBOX_MOTEURS),
});
