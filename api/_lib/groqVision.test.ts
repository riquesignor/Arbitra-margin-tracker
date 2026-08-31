import { describe, it } from "vitest";

// DEPRECADO (ago/2026) — Groq foi removido como backend de IA de visão
// (ver comentário completo em groqVision.ts e no topo de mistralVision.ts).
// Este arquivo de teste não tem mais nada pra testar; existe só porque a
// ferramenta usada nesta mudança não tem como apagar arquivo do
// repositório — APAGUE groqVision.ts e groqVision.test.ts manualmente
// (`git rm`) na próxima limpeza. Teste único, pulado de propósito, só pra
// o vitest não reclamar de "arquivo de teste sem teste nenhum".
describe("groqVision (removido)", () => {
  it.skip("Groq foi removido — ver mistralVision.ts", () => {});
});
