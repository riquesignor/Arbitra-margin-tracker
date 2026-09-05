// Config flat (ESLint 9) — primeira vez que este projeto ganha lint
// automatizado (ver docs/auditoria-2026-09.md e a revisão pós-auditoria de
// set/2026: o TypeScript estrito já pega bug de tipo, mas não pega
// `useEffect` com dependência faltando, promise sem `await`/`.catch`, nem
// variável nunca lida — classes de bug que só um linter cobre). Os
// comentários `eslint-disable-next-line react-hooks/exhaustive-deps` que já
// existiam em Dashboard.tsx antes deste arquivo existir são o sinal mais
// claro de que o projeto sempre assumiu essa regra ativa — só faltava o
// config de verdade.
import js from "@eslint/js";
import tseslint from "typescript-eslint";
import reactHooks from "eslint-plugin-react-hooks";
import reactRefresh from "eslint-plugin-react-refresh";
import globals from "globals";

export default tseslint.config(
  {
    ignores: ["dist", "dist-verify", "node_modules", ".vercel", "public/**"],
  },

  // --- Cliente (src/) — React, browser, type-aware contra tsconfig.json ---
  {
    files: ["src/**/*.{ts,tsx}"],
    extends: [js.configs.recommended, ...tseslint.configs.recommendedTypeChecked],
    languageOptions: {
      ecmaVersion: 2020,
      globals: globals.browser,
      parserOptions: {
        // `projectService` (typescript-eslint v8) resolve o tsconfig certo
        // por arquivo automaticamente — não precisa apontar pro
        // tsconfig.json na mão nem manter em sincronia com o "include" dele.
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    plugins: {
      "react-hooks": reactHooks,
      "react-refresh": reactRefresh,
    },
    rules: {
      ...reactHooks.configs.recommended.rules,
      "react-refresh/only-export-components": ["warn", { allowConstantExport: true }],
      "@typescript-eslint/no-unused-vars": ["warn", { argsIgnorePattern: "^_" }],
      // Muitos providers devolvem `Promise<T>` e o chamador decide se
      // espera ou dispara-e-esquece (ex.: best-effort de cache) — regra
      // fica em "warn" pra não brigar com esse padrão já estabelecido,
      // mas ainda sinaliza o caso comum de esquecimento real.
      "@typescript-eslint/no-floating-promises": "warn",
    },
  },

  // --- Backend (api/) — Node, sem React, type-aware contra tsconfig.api.json ---
  {
    files: ["api/**/*.ts"],
    extends: [js.configs.recommended, ...tseslint.configs.recommendedTypeChecked],
    languageOptions: {
      ecmaVersion: 2020,
      globals: globals.node,
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      "@typescript-eslint/no-unused-vars": ["warn", { argsIgnorePattern: "^_" }],
      "@typescript-eslint/no-floating-promises": "warn",
    },
  },

  // --- Scripts utilitários (scripts/*.mjs, ex.: ml-oauth-setup.mjs) ---
  // Fora do "include" dos dois tsconfig acima — sem info de tipo aqui, só
  // regras JS puras, pra não quebrar o lint por falta de projeto TS.
  {
    files: ["scripts/**/*.mjs"],
    extends: [js.configs.recommended],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: "module",
      globals: globals.node,
    },
  }
);
