// Configuration Playwright de la MESURE SOUS BRIDAGE PROCESSEUR.
//
// Troisième suite du dépôt, après l'E2E locale et la recette en ligne, et la
// seule dont le verdict soit un CHIFFRE plutôt qu'un booléen : elle répond à
// « combien de temps ce visiteur attend-il sur une machine lente ? ».
//
// Séparée pour trois raisons cumulées : elle dépend du réseau, elle dépend d'un
// déploiement, et elle dure des dizaines de minutes. Aucune CI de dépôt ne doit
// exiger cela. Elle se lance à la main :
//
//   npm run test:bridage
//   RAILSBOX_BRIDAGE_TAUX=1,8 RAILSBOX_BRIDAGE_REPETITIONS=2 npm run test:bridage
//   RAILSBOX_SANDBOX_URL=https://exemple.github.io/ma-sandbox/ npm run test:bridage
import { defineConfig } from "@playwright/test";

import { urlSandbox } from "./tests/live/url-sandbox.mjs";

export default defineConfig({
  testDir: "tests/bridage",
  testMatch: "**/*.spec.mjs",
  // Un boot de VM sature déjà le processeur ; bridé, il le sature encore plus.
  // Paralléliser fausserait la mesure elle-même.
  workers: 1,
  fullyParallel: false,
  // Un boot bridé 8× se compte en minutes. Le détail des délais vit dans la
  // spécification, qui appelle test.setTimeout() taux par taux.
  timeout: 1_800_000,
  expect: { timeout: 30_000 },
  reporter: [["list"]],
  // Aucune reprise : une mesure rejouée automatiquement après un échec ne
  // serait plus une mesure, ce serait le meilleur de deux tirages.
  retries: 0,
  use: {
    baseURL: urlSandbox(),
    trace: "off",
    video: "off",
    screenshot: "only-on-failure",
  },
  // Chromium uniquement : Emulation.setCPUThrottlingRate est une commande CDP.
  projects: [{ name: "chromium", use: { browserName: "chromium" } }],
});
