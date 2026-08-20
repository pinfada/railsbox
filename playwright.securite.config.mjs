// Configuration Playwright de la MATRICE DE SÉCURITÉ — les mêmes épreuves, sur
// les trois moteurs.
//
// Pourquoi une suite à part plutôt que `RAILSBOX_MOTEURS=tous npm run test:e2e`
// : les défenses qui comptent ici reposent EXPLICITEMENT sur des différences
// entre Chromium, Firefox et WebKit. La règle de provenance a d'ailleurs été
// réécrite pour cette raison — le premier correctif ne lisait que des signaux
// (`Sec-Fetch-Site`) absents de deux moteurs sur trois, et aucun test ne
// pouvait le voir. Un verdict rendu par Chromium seul ne dit donc rien de ces
// frontières.
//
// Et pourquoi pas la suite entière : le boot de VM la fait durer des minutes,
// pour un verdict que Chromium rend déjà. Seules les épreuves de FRONTIÈRE
// sont matricées.
//
//   npm run test:securite
//   RAILSBOX_MOTEURS=webkit npm run test:securite
import { defineConfig } from "@playwright/test";

import { projetsMoteurs } from "./tests/moteurs.mjs";

const PORT = Number(process.env.RAILSBOX_PORT ?? 8091);

// Les fichiers matricés, et ce que chacun garde. Cette liste est explicite
// plutôt que déduite d'un motif de nom : ce qui entre dans la matrice est une
// DÉCISION, et elle se relit ici.
//
//  - cookies-proxy : provenance des requêtes (403 des navigations et des
//    origines étrangères), bocal à cookies, CSRF, refus d'un bridge-port venu
//    de l'iframe applicative ;
//  - frontiere-coquille : l'attaque complète — script applicatif injecté dans
//    le DOM de la coquille, quatre commandes privilégiées, usurpation de canal ;
//  - relais-onglets : la reprise du canal quand l'onglet porteur disparaît, et
//    le fait qu'un intrus du nouvel onglet ne la gagne pas ;
//  - controle-service-worker : la coquille sans worker aux commandes, seul
//    état où le proxy ne protège plus rien.
const EPREUVES = [
  "tests/e2e/cookies-proxy.e2e.spec.mjs",
  "tests/e2e/frontiere-coquille.e2e.spec.mjs",
  "tests/e2e/relais-onglets.e2e.spec.mjs",
  "tests/e2e/controle-service-worker.e2e.spec.mjs",
];

export default defineConfig({
  testDir: ".",
  testMatch: EPREUVES,
  workers: 1,
  fullyParallel: false,
  timeout: 60_000,
  expect: { timeout: 15_000 },
  reporter: [["list"]],
  use: {
    baseURL: `http://localhost:${PORT}`,
    trace: "off",
    video: "off",
    screenshot: "only-on-failure",
  },
  // Les trois moteurs par DÉFAUT ici — c'est tout l'objet de cette suite.
  // `RAILSBOX_MOTEURS` reste utilisable pour n'en rejouer qu'un.
  projects: projetsMoteurs(process.env.RAILSBOX_MOTEURS ?? "tous"),
  webServer: {
    command: "node serve.mjs",
    port: PORT,
    env: { PORT: String(PORT) },
    reuseExistingServer: true,
    timeout: 30_000,
  },
});
