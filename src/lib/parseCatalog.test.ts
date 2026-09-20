import { describe, expect, it } from "vitest";
import { CatalogParseError, parseCatalogFile, parseCurrency } from "./parseCatalog";

/**
 * Helper: monta um `File` de CSV puro (sem passar por .xlsx) — mais
 * simples que codificar um ZIP pra testar `rowsFromMatrix`/
 * `resolveColumns`/`findHeaderRowIndex`, já que `parseCatalogFile` usa o
 * MESMO caminho pros dois formatos (ver comentário em rowsFromMatrix).
 */
function csvFile(content: string, name = "catalogo.csv"): File {
  return new File([content], name, { type: "text/csv" });
}

describe("parseCatalogFile — CSV", () => {
  it("reconhece cabeçalho exato (SKU, Nome, Custo, EAN) — comportamento de sempre, sem regressão", async () => {
    const csv = "SKU,Nome,Custo,EAN\nTOP-1,Mesa,120.50,7891234567895\nTOP-2,Cadeira,80,\n";

    const rows = await parseCatalogFile(csvFile(csv));

    expect(rows).toEqual([
      { sku: "TOP-1", name: "Mesa", supplierPrice: 120.5, ean: "7891234567895" },
      { sku: "TOP-2", name: "Cadeira", supplierPrice: 80 },
    ]);
  });

  it(
    "reconhece cabeçalho DECORADO ('Custo (R$)') via fallback fuzzy — caso real (set/2026): fornecedor " +
      "exporta com essa coluna e o app recusava o catálogo com as colunas certas na tela, porque a detecção " +
      "só aceitava o header inteiro igual ao alias",
    async () => {
      const csv = "Título,SKU,Custo (R$)\nMesa de Escritório,TOP-1,120.50\n";

      const rows = await parseCatalogFile(csvFile(csv));

      expect(rows).toEqual([{ sku: "TOP-1", name: "Mesa de Escritório", supplierPrice: 120.5 }]);
    }
  );

  it("reconhece 'Nome do Produto' e 'Preço de Custo' (decorados) ao mesmo tempo", async () => {
    const csv = "Código,Nome do Produto,Preço de Custo\nTOP-1,Mesa,120.50\n";

    const rows = await parseCatalogFile(csvFile(csv));

    expect(rows).toEqual([{ sku: "TOP-1", name: "Mesa", supplierPrice: 120.5 }]);
  });

  it(
    "não deixa o alias curto/genérico de SKU ('cod') roubar a coluna de código de barras já mais específica " +
      "('Cód. de Barras EAN-13') — mesma proteção contra colisão já existente pro match exato, agora também " +
      "válida pro fallback fuzzy",
    async () => {
      const csv = "Código,Nome,Custo,Cód. de Barras EAN-13\nTOP-1,Mesa,120.50,7891234567895\n";

      const rows = await parseCatalogFile(csvFile(csv));

      expect(rows).toEqual([{ sku: "TOP-1", name: "Mesa", supplierPrice: 120.5, ean: "7891234567895" }]);
    }
  );

  it(
    "pula linha de TÍTULO/instrução antes do cabeçalho de verdade — regressão real pega no próprio " +
      "modelo-catalogo.xlsx que este app distribui (linha 1 era um texto de instrução, cabeçalho só na linha 2)",
    async () => {
      const csv =
        "Modelo de catálogo — preencha uma linha por produto\nSKU,Nome,Custo,EAN\nTOP-1,Mesa,120.50,\n";

      const rows = await parseCatalogFile(csvFile(csv));

      expect(rows).toEqual([{ sku: "TOP-1", name: "Mesa", supplierPrice: 120.5 }]);
    }
  );

  it("continua recusando com erro claro quando não há cabeçalho reconhecível em nenhuma das primeiras linhas", async () => {
    const csv = "Alguma coisa,Qualquer,Sem sentido nenhum\nx,y,z\n";

    await expect(parseCatalogFile(csvFile(csv))).rejects.toThrow(CatalogParseError);
    await expect(parseCatalogFile(csvFile(csv))).rejects.toThrow(/Não encontrei colunas de SKU e\/ou custo/);
  });

  it("não escaneia além de MAX_HEADER_SCAN_ROWS (5) — título longo demais continua dando erro claro, não trava o app", async () => {
    // Linhas do preâmbulo em formato CSV de verdade (com vírgula) — sem
    // isso o Papa Parse falha antes mesmo de chegar no nosso código (não
    // consegue nem detectar o delimitador), o que testaria outra coisa.
    const preamble = Array.from({ length: 6 }, (_, i) => `linha,de,preambulo,${i}`).join("\n");
    const csv = `${preamble}\nSKU,Nome,Custo,EAN\nTOP-1,Mesa,120.50,\n`;

    await expect(parseCatalogFile(csvFile(csv))).rejects.toThrow(CatalogParseError);
    await expect(parseCatalogFile(csvFile(csv))).rejects.toThrow(/Não encontrei colunas de SKU e\/ou custo/);
  });
});

describe("parseCurrency", () => {
  it("converte formato BR (milhar com ponto, decimal com vírgula)", () => {
    expect(parseCurrency("R$ 1.234,56")).toBe(1234.56);
  });

  it("converte formato US (decimal com ponto)", () => {
    expect(parseCurrency("1234.56")).toBe(1234.56);
  });

  it("repassa number como está", () => {
    expect(parseCurrency(99.9)).toBe(99.9);
  });
});
