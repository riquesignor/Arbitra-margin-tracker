import { describe, expect, it } from "vitest";
import type { CatalogItemQuery, MarketplacePriceResult } from "./types.js";
import { dedupeItemsByQuery, fanOutDuplicates } from "./dedupeItems.js";

function result(sku: string, price: number): MarketplacePriceResult {
  return {
    marketplace: "amazon",
    sku,
    price,
    competitorCount: 0,
    buyBoxEligible: true,
    confidence: 0.9,
  } as MarketplacePriceResult;
}

describe("dedupeItemsByQuery", () => {
  it("agrupa nomes iguais ignorando caixa, acento e espaços", () => {
    const items: CatalogItemQuery[] = [
      { sku: "A", name: "Fone Bluetooth  Preto" },
      { sku: "B", name: "fone bluetooth preto" },
      { sku: "C", name: "Fône Bluetooth Preto" },
      { sku: "D", name: "Carregador USB" },
    ];
    const { unique, duplicatesOf } = dedupeItemsByQuery(items);
    expect(unique.map((i) => i.sku)).toEqual(["A", "D"]);
    expect(duplicatesOf.get("A")).toEqual(["B", "C"]);
  });

  it("EAN válido igual agrupa mesmo com nomes diferentes; EAN diferente não agrupa", () => {
    const items: CatalogItemQuery[] = [
      { sku: "A", name: "Caneca azul", ean: "7891234567895" },
      { sku: "B", name: "Caneca vermelha", ean: "7891234567895" },
      { sku: "C", name: "Caneca azul", ean: "7890000000017" },
    ];
    const { unique, duplicatesOf } = dedupeItemsByQuery(items);
    expect(unique.map((i) => i.sku)).toEqual(["A", "C"]);
    expect(duplicatesOf.get("A")).toEqual(["B"]);
  });

  it("EAN inválido cai pro nome", () => {
    const items: CatalogItemQuery[] = [
      { sku: "A", name: "Caneca", ean: "123" },
      { sku: "B", name: "Caneca", ean: "456" },
    ];
    expect(dedupeItemsByQuery(items).unique).toHaveLength(1);
  });

  it("SKU repetido não vira duplicata de si mesmo", () => {
    const items: CatalogItemQuery[] = [
      { sku: "A", name: "Caneca" },
      { sku: "A", name: "Caneca" },
    ];
    const { unique, duplicatesOf } = dedupeItemsByQuery(items);
    expect(unique).toHaveLength(1);
    expect(duplicatesOf.size).toBe(0);
  });
});

describe("fanOutDuplicates", () => {
  it("copia o resultado do representante pros duplicados trocando o sku", () => {
    const duplicatesOf = new Map([["A", ["B", "C"]]]);
    const out = fanOutDuplicates({ A: result("A", 10) }, duplicatesOf);
    expect(out.B).toMatchObject({ sku: "B", price: 10 });
    expect(out.C).toMatchObject({ sku: "C", price: 10 });
    expect(out.A.sku).toBe("A");
  });

  it("não inventa resultado quando o representante não achou nada", () => {
    const out = fanOutDuplicates({}, new Map([["A", ["B"]]]));
    expect(out.B).toBeUndefined();
  });

  it("sem duplicatas devolve o mesmo objeto", () => {
    const results = { A: result("A", 10) };
    expect(fanOutDuplicates(results, new Map())).toBe(results);
  });
});
