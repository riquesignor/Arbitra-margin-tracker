import { defineConfig } from "vitest/config";

/**
 * Config separado de vite.config.ts de propósito — evita misturar o
 * plugin do React (só serve o frontend) com a config de teste, que
 * também cobre módulos server-side puros em api/_lib (ver
 * docs/architecture-review.md > Qualidade/manutenção: os módulos mais
 * críticos pra testar são os de cálculo financeiro e parsing heurístico,
 * nenhum dos dois precisa de DOM).
 */
export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.test.ts", "api/**/*.test.ts"],
  },
});

