import { readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * A Vercel transforma em Serverless Function CADA arquivo `.ts` que fica
 * direto em `api/` (só o que começa com `_` é ignorado). O plano Hobby aceita
 * no máximo 12 por deploy, e passar disso derruba o deploy inteiro. Por isso
 * os testes das rotas ficam em `api/_tests/` e a lógica compartilhada em
 * `api/_lib/` — nunca solto em `api/`.
 */
const MAX_FUNCTIONS_HOBBY = 12;
const files = readdirSync(join(process.cwd(), "api"), { withFileTypes: true })
  .filter((entry) => entry.isFile() && /\.(ts|js|mjs|cjs)$/.test(entry.name))
  .map((entry) => entry.name);

describe("arquivos diretamente em api/ (cada um vira uma Serverless Function)", () => {
  it("nenhum arquivo de teste ou de apoio vaza pra fora de api/_tests e api/_lib", () => {
    expect(files.filter((name) => /\.(test|spec)\./.test(name))).toEqual([]);
  });

  it(`cabe no limite de ${MAX_FUNCTIONS_HOBBY} funções do plano Hobby da Vercel`, () => {
    expect(files.length).toBeLessThanOrEqual(MAX_FUNCTIONS_HOBBY);
  });
});
