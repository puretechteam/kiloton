// ESLint flat config (ESM). Scoped to the project's own code so node_modules
// is never linted. Keeps the codebase consistent and guards against the
// duplication/drift class of bugs this release set out to remove.
import js from "@eslint/js";

export default [
  js.configs.recommended,
  {
    files: ["server.js", "lib/**/*.js", "public/app.js", "test/**/*.mjs"],
    languageOptions: {
      ecmaVersion: 2024,
      sourceType: "module",
      globals: {
        console: "readonly",
        process: "readonly",
        // browser globals used by public/app.js
        document: "readonly",
        window: "readonly",
        navigator: "readonly",
        location: "readonly",
        URL: "readonly",
        WebSocket: "readonly",
        ResizeObserver: "readonly",
        getComputedStyle: "readonly",
        fetch: "readonly",
        setTimeout: "readonly",
        clearTimeout: "readonly",
        setInterval: "readonly",
        clearInterval: "readonly",
        requestAnimationFrame: "readonly",
        confirm: "readonly",
        // test/DOM helpers
        structuredClone: "readonly",
      },
    },
    rules: {
      "no-unused-vars": ["error", { argsIgnorePattern: "^_" }],
      "no-empty": ["error", { allowEmptyCatch: true }],
      "no-console": "off",
    },
  },
  {
    ignores: ["node_modules/**", "data/**", "config.json"],
  },
];
