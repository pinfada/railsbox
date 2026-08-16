// Configuration ESLint (flat config). Trois environnements distincts :
// navigateur (public/), Service Worker (sw-proxy.js) et Node (serveur de
// dev, outils, tests). Les binaires vendorisés et artefacts sont ignorés.
import js from "@eslint/js";
import globals from "globals";

export default [
  {
    ignores: [
      "node_modules/**",
      // Worktrees d'agents et état de session : hors du périmètre du dépôt.
      ".claude/**",
      "public/vendor/**",
      "public/disks/**",
      "tools/build-v86-image/build.log",
      // Application Rails de démonstration : sources générées par `rails new`,
      // hors périmètre des conventions du dépôt.
      "tools/demo-app/**",
      // Clones des applications OSS de contrôle (tests/detect-oss.test.mjs).
      // Sans cette exclusion, ESLint charge LEUR eslint.config.mjs et échoue
      // sur des greffons qu'on n'installera jamais.
      ".oss/**",
    ],
  },
  js.configs.recommended,
  {
    linterOptions: {
      reportUnusedDisableDirectives: "error",
    },
    rules: {
      "no-unused-vars": ["error", { argsIgnorePattern: "^_", varsIgnorePattern: "^_" }],
      eqeqeq: ["error", "always"],
      "prefer-const": "error",
      "no-var": "error",
    },
  },
  {
    files: ["public/**/*.js"],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: "module",
      globals: { ...globals.browser },
    },
  },
  {
    files: ["public/sw-proxy.js"],
    languageOptions: {
      globals: { ...globals.serviceworker },
    },
  },
  {
    files: ["serve.mjs", "playwright*.config.mjs", "tests/**/*.mjs", "tools/**/*.mjs"],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: "module",
      globals: { ...globals.node },
    },
  },
];
