// Le script de build de la fixture. Volontairement SANS dépendance : ce que
// l'épreuve vérifie est le CÂBLAGE (détection → arguments → Corepack → pnpm),
// pas la capacité d'esbuild à empaqueter. Une dépendance réelle n'ajouterait
// qu'une dépendance au registre npm, donc une source d'intermittence en CI.
import { mkdirSync, writeFileSync } from "node:fs";

mkdirSync("app/assets/builds", { recursive: true });
writeFileSync(
  "app/assets/builds/temoin.js",
  `// railsbox-temoin-pnpm ${process.env.npm_config_user_agent ?? "sans-agent"}\n`,
);
