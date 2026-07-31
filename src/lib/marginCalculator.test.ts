import { describe, expect, it } from "vitest";
import type { CatalogRow, MarketplacePriceResult, PricingRules } from "../types";
import { DEFAULT_PRICING_RULES, calculateMargin, calculateMargins, median, summarize } from "./marginCalculator";

function makeRow(overrides: Partial<CatalogRow> = {}): CatalogRow {
  return { sku: "SKU-1", name: "Produto Teste", supplierPrice: 100, ...overrides };
}

function makePrice(overrides: Partial<MarketplacePriceResult> = {}): MarketplacePriceResult {
  return {
    marketplace: "amazon",
    sku: "SKU-1",
    price: 200,
    competitorCount: 3,
    buyBoxEligible: true,
    confidence: 0.8,
    ...overrides,
  };
}

describe("calculateMargin", () => {
  it("soma taxas, frete e impostos habilitados no custo total e deriva a margem", () => {
    const rules: PricingRules = {
      marketplaceFees: [{ id: "f1", name: "Taxa", rate: 0.1, enabled: true }],
      shippingTiers: [{ id: "t1", label: "Único", maxPrice: Infinity, cost: 10 }],
      taxRates: [{ id: "tax1", state: "SP", label: "ICMS", rate: 0.05, enabled: true }],
      targetMarginPct: 0.2,
      priceFloor: 0,
    };

    const result = calculateMargin(makeRow({ supplierPrice: 100 }), makePrice({ price: 200 }), rules);

    expect(result.feesCost).toBe(20); // 200 * 0.10
    expect(result.taxesCost).toBe(10); // 200 * 0.05
    expect(result.shippingCost).toBe(10);
    expect(result.totalCost).toBe(140); // 100 + 20 + 10 + 10
    expect(result.marginPct).toBeCloseTo(0.6, 4); // (200 - 140) / 100
  });

  it("ignora taxa e imposto desabilitados", () => {
    const rules: PricingRules = {
      marketplaceFees: [{ id: "f1", name: "Taxa", rate: 0.5, enabled: false }],
      shippingTiers: [{ id: "t1", label: "Único", maxPrice: Infinity, cost: 0 }],
      taxRates: [{ id: "tax1", state: "SP", label: "ICMS", rate: 0.5, enabled: false }],
      targetMarginPct: 0.2,
      priceFloor: 0,
    };

    const result = calculateMargin(makeRow({ supplierPrice: 100 }), makePrice({ price: 200 }), rules);

    expect(result.feesCost).toBe(0);
    expect(result.taxesCost).toBe(0);
  });

  it("escolhe a faixa de frete certa pelo maxPrice do fornecedor", () => {
    const rules: PricingRules = {
      marketplaceFees: [],
      shippingTiers: [
        { id: "t1", label: "Até 50", maxPrice: 50, cost: 5 },
        { id: "t2", label: "Até 150", maxPrice: 150, cost: 15 },
        { id: "t3", label: "Acima", maxPrice: Infinity, cost: 30 },
      ],
      taxRates: [],
      targetMarginPct: 0.2,
      priceFloor: 0,
    };

    expect(calculateMargin(makeRow({ supplierPrice: 40 }), makePrice(), rules).shippingCost).toBe(5);
    expect(calculateMargin(makeRow({ supplierPrice: 120 }), makePrice(), rules).shippingCost).toBe(15);
    expect(calculateMargin(makeRow({ supplierPrice: 500 }), makePrice(), rules).shippingCost).toBe(30);
  });

  it.each([
    [0.25, "recomendado"],
    [0.2, "recomendado"], // igual à meta já conta como recomendado
    [0.05, "revisar"],
    [0, "revisar"],
    [-0.1, "evitar"],
  ] as const)("marginPct %s vira recommendation \"%s\"", (marginPctAlvo, esperado) => {
    const rules: PricingRules = {
      marketplaceFees: [],
      shippingTiers: [{ id: "t1", label: "Único", maxPrice: Infinity, cost: 0 }],
      taxRates: [],
      targetMarginPct: 0.2,
      priceFloor: 0,
    };
    const supplierPrice = 100;
    const marketplacePrice = supplierPrice * (1 + marginPctAlvo);

    const result = calculateMargin(makeRow({ supplierPrice }), makePrice({ price: marketplacePrice }), rules);

    expect(result.recommendation).toBe(esperado);
  });
});

describe("calculateMargins", () => {
  it("pula linhas sem preço encontrado no Record de preços", () => {
    const rows = [makeRow({ sku: "A" }), makeRow({ sku: "B" })];
    const prices: Record<string, MarketplacePriceResult> = { A: makePrice({ sku: "A" }) };

    const results = calculateMargins(rows, prices, DEFAULT_PRICING_RULES);

    expect(results).toHaveLength(1);
    expect(results[0].sku).toBe("A");
  });
});

describe("median", () => {
  it("retorna 0 pra lista vazia", () => {
    expect(median([])).toBe(0);
  });

  it("calcula corretamente com quantidade ímpar de valores", () => {
    expect(median([1, 3, 2])).toBe(2);
  });

  it("calcula a média dos dois valores centrais com quantidade par", () => {
    expect(median([1, 2, 3, 4])).toBe(2.5);
  });

  it("não é distorcida por um outlier extremo (motivo do fix da Session 3)", () => {
    const valoresComOutlier = [0.1, 0.12, 0.11, 0.13, 28.7]; // ex: linha com dado corrompido
    expect(median(valoresComOutlier)).toBeCloseTo(0.12, 2);
  });
});

describe("summarize", () => {
  it("mediana resiste a outlier de dado corrompido, média não", () => {
    const rows = [makeRow({ sku: "A" }), makeRow({ sku: "B" }), makeRow({ sku: "C" })];
    const prices: Record<string, MarketplacePriceResult> = {
      A: makePrice({ sku: "A", price: 150 }),
      B: makePrice({ sku: "B", price: 160 }),
      C: makePrice({ sku: "C", price: 100000 }), // simula um match de preço corrompido
    };

    const results = calculateMargins(rows, prices, DEFAULT_PRICING_RULES);
    const summary = summarize(results);

    expect(summary.totalSkus).toBe(3);
    expect(summary.medianMarginPct).toBeLessThan(summary.avgMarginPct);
  });
});
