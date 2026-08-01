import { describe, expect, it } from "vitest";
import { extractRows } from "./parsePdfCatalog";

describe("extractRows", () => {
  it("extrai sku, nome e preço de uma linha simples", () => {
    const { rows, skippedAmbiguous } = extractRows(["SKU-001 Caneta Azul BIC R$ 12,50"]);

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ sku: "SKU-001", name: "Caneta Azul BIC", supplierPrice: 12.5 });
    expect(skippedAmbiguous).toBe(0);
  });

  it("le preco de 4+ digitos SEM separador de milhar, sem truncar (BR, sem R$) — regressão: 'Produto 3800,00' virava 800,00", () => {
    const { rows } = extractRows(["Videogame Sony PS5 3800,00"]);

    expect(rows).toHaveLength(1);
    expect(rows[0].supplierPrice).toBe(3800);
    expect(rows[0].name).toBe("Videogame Sony PS5");
  });

  it("le preco de 5 digitos sem separador de milhar, sem truncar", () => {
    const { rows } = extractRows(["Bicicleta Aro 29 12345,00"]);

    expect(rows[0].supplierPrice).toBe(12345);
  });

  it("continua lendo preco BR com separador de milhar normalmente (sem regressão)", () => {
    const { rows } = extractRows(["Notebook Dell 3.800,00"]);

    expect(rows[0].supplierPrice).toBe(3800);
  });

  it("gera sku sintético quando não acha um padrão de SKU na linha", () => {
    const { rows } = extractRows(["Caneta Azul BIC R$ 12,50"]);

    expect(rows[0].sku).toMatch(/^PDF-/);
    expect(rows[0].name).toBe("Caneta Azul BIC");
  });

  it("sku sintético é determinístico por CONTEÚDO, não por posição — regressão: cache global colidia entre catálogos diferentes", () => {
    // Mesmo produto, catálogos (chamadas) diferentes -> mesmo sku sintético
    // (cache de preço deve ser reaproveitado, é o mesmo texto de produto).
    const a = extractRows(["Caneta Azul BIC R$ 12,50"]);
    const b = extractRows(["Lapis Preto Faber R$ 3,00", "Caneta Azul BIC R$ 12,50"]);
    expect(a.rows[0].sku).toBe(b.rows[1].sku);

    // Produtos DIFERENTES no mesmo catálogo -> skus diferentes (antes,
    // ambos virariam "PDF-1"/"PDF-2" por posição e colidiriam entre
    // uploads distintos).
    expect(b.rows[0].sku).not.toBe(b.rows[1].sku);
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

  it("aceita preço inteiro sem centavos quando prefixado por R$ (regressão: catálogo real sem decimais)", () => {
    const { rows } = extractRows(["VIDEOGAME SONY POR R$ 3800"]);

    expect(rows).toHaveLength(1);
    expect(rows[0].supplierPrice).toBe(3800);
    expect(rows[0].name).toBe("VIDEOGAME SONY POR");
  });

  it("aceita preço inteiro com milhar (ponto) e sem centavos, prefixado por R$", () => {
    const { rows } = extractRows(["Bicicleta aro 29 R$ 1.200"]);

    expect(rows[0].supplierPrice).toBe(1200);
  });

  it("NÃO trata número solto sem R$ e sem decimal como preço (evita falso positivo com SKU/quantidade)", () => {
    const { rows, skippedAmbiguous } = extractRows(["BICICLETA POR 1200"]);

    expect(rows).toHaveLength(0);
    expect(skippedAmbiguous).toBe(0);
  });
});
