// Configuration Playwright des tests de bout en bout. Ils pilotent un vrai
// Chromium contre le serveur de dev (serve.mjs), seul moyen de vérifier ce
// qui n'existe que dans le navigateur : Service Worker, isolation
// cross-origin, pont série vers la VM.
//
// Port 8091 plutôt que 8080 : un serveur de dev ouvert par le développeur ne
// doit ni être confondu avec celui des tests, ni entrer en conflit avec lui.
//
// `reuseExistingServer` réutilise un serveur déjà à l'écoute sur ce port. C'est
// un piège dès qu'on travaille sur DEUX copies du dépôt (arbres de travail
// git) : la seconde suite se branche sur le serveur de la première et teste le
// `sw-proxy.js` DE L'AUTRE COPIE, en silence. `RAILSBOX_PORT` donne à chaque
// copie son port privé — le défaut, lui, ne change pas.
import { defineConfig } from "@playwright/test";

import { projetsMoteurs } from "./tests/moteurs.mjs";

const PORT = Number(process.env.RAILSBOX_PORT ?? 8091);

export default defineConfig({
  testDir: "tests/e2e",
  // Un boot de VM sature déjà le processeur : paralléliser ferait tomber les
  // tests sur des délais dépassés, pas sur des régressions.
  workers: 1,
  fullyParallel: false,
  timeout: 60_000,
  expect: { timeout: 15_000 },
  reporter: [["list"]],
  use: {
    baseURL: `http://localhost:${PORT}`,
    // Le trace viewer capture les ressources réseau : avec un instantané
    // mémoire de ~650 Mo dans le flux, l'archive devient ingérable.
    trace: "off",
    video: "off",
    screenshot: "only-on-failure",
  },
  // Chromium par défaut ; `RAILSBOX_MOTEURS=tous` élargit à Firefox et WebKit,
  // ce qui permet de distinguer un défaut de moteur d'un défaut d'hébergement
  // quand la recette en ligne diverge. Voir tests/moteurs.mjs.
  projects: projetsMoteurs(process.env.RAILSBOX_MOTEURS),
  webServer: {
    command: "node serve.mjs",
    port: PORT,
    env: { PORT: String(PORT) },
    reuseExistingServer: true,
    timeout: 30_000,
  },
});
