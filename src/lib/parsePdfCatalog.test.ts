import { describe, expect, it } from "vitest";
import { extractRows } from "./parsePdfCatalog";

describe("extractRows", () => {
  it("extrai sku, nome e preço de uma linha simples", () => {
    const { rows, skippedAmbiguous } = extractRows(["SKU-001 Caneta Azul BIC R$ 12,50"]);

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ sku: "SKU-001", name: "Caneta Azul BIC", supplierPrice: 12.5 });
    expect(skippedAmbiguous).toBe(0);
  });

  it("gera sku sintético quando não acha um padrão de SKU na linha", () => {
    const { rows } = extractRows(["Caneta Azul BIC R$ 12,50"]);

    expect(rows[0].sku).toBe("PDF-1");
    expect(rows[0].name).toBe("Caneta Azul BIC");
  });

  it("ignora linha sem nenhum preço reconhecível (sem contar como ambígua)", () => {
    const { rows, skippedAmbiguous } = extractRows(["Só um texto qualquer sem preço nenhum"]);

    expect(rows).toHaveLength(0);
    expect(skippedAmbiguous).toBe(0);
  });

  it("descarta (não corrompe) linha com mais de um preço — regressão crítica da Session 3", () => {
    // Exemplo real que motivou o fix: célula de tabela multi-coluna colada
    // numa linha só pelo agrupamento por Y — dois preços, nenhum jeito
    // seguro de saber qual pertence a qual produto.
    const linhaCorrompida = "30PCS/CX Unid.CX: 24PCS/CX Unid.CX: 32,00 5 0PCS/CX Unid.CX:23,00";

    const { rows, skippedAmbiguous } = extractRows([linhaCorrompida]);

    expect(rows).toHaveLength(0);
    expect(skippedAmbiguous).toBe(1);
  });

  it("descarta linha cujo 'nome' restante é implausivelmente longo", () => {
    const nomeGigante = "X".repeat(150);

    const { rows, skippedAmbiguous } = extractRows([`${nomeGigante} R$ 10,00`]);

    expect(rows).toHaveLength(0);
    expect(skippedAmbiguous).toBe(1);
  });

  it("processa linhas independentemente, acumulando skippedAmbiguous só nas ruins", () => {
    const { rows, skippedAmbiguous } = extractRows([
      "SKU-001 Produto A R$ 10,00",
      "30PCS/CX Unid.CX: 24PCS/CX Unid.CX: 32,00 preco2 23,00", // ambígua — 2 preços
      "SKU-002 Produto B R$ 20,00",
    ]);

    expect(rows).toHaveLength(2);
    expect(skippedAmbiguous).toBe(1);
    expect(rows.map((r) => r.sku)).toEqual(["SKU-001", "SKU-002"]);
  });

  it("aceita formato de preço US (ponto decimal) além do BR (vírgula)", () => {
    const { rows } = extractRows(["SKU-010 Produto C 199.99"]);

    expect(rows[0].supplierPrice).toBeCloseTo(199.99, 2);
  });
});
