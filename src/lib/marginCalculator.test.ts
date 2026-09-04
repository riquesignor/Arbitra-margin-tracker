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

  it(
    "usa o preço POR UNIDADE quando o anúncio é lote — regressão estrutural (set/2026): comparar o preço " +
      "de um kit de 12 com o custo de UMA peça gerava margem fantasiosa justamente nos anúncios de atacado",
    () => {
      const rules: PricingRules = {
        marketplaceFees: [{ id: "f1", name: "Taxa", rate: 0.1, enabled: true }],
        shippingTiers: [{ id: "t1", label: "Único", maxPrice: Infinity, cost: 5 }],
        taxRates: [],
        targetMarginPct: 0.2,
        priceFloor: 0,
      };

      const result = calculateMargin(
        makeRow({ supplierPrice: 8 }),
        makePrice({ price: 120, packQuantity: 12, unitPrice: 10, matchedTitle: "Produto Kit com 12 unidades" }),
        rules
      );

      // Margem calculada em cima de R$10 (unitário), não de R$120 (lote).
      expect(result.marketplacePrice).toBe(10);
      expect(result.feesCost).toBe(1); // 10 * 0.10 — não 12
      expect(result.totalCost).toBe(14); // 8 + 1 + 5
      expect(result.marginPct).toBeCloseTo(-0.5, 4); // (10 - 14) / 8 — prejuízo real, exposto
      // O preço do anúncio continua disponível pra tela mostrar o número
      // que o usuário vai ver ao abrir o link.
      expect(result.listingPrice).toBe(120);
      expect(result.packQuantity).toBe(12);
    }
  );

  it("anúncio unitário (sem lote detectado) mantém exatamente o comportamento antigo", () => {
    const rules: PricingRules = {
      marketplaceFees: [{ id: "f1", name: "Taxa", rate: 0.1, enabled: true }],
      shippingTiers: [{ id: "t1", label: "Único", maxPrice: Infinity, cost: 10 }],
      taxRates: [],
      targetMarginPct: 0.2,
      priceFloor: 0,
    };

    const result = calculateMargin(makeRow({ supplierPrice: 100 }), makePrice({ price: 200 }), rules);

    expect(result.marketplacePrice).toBe(200);
    expect(result.listingPrice).toBeUndefined();
    expect(result.packQuantity).toBeUndefined();
    expect(result.feesCost).toBe(20);
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

describe("calculateMargin — catálogo sem preço de custo (sem_custo)", () => {
  it("devolve recommendation 'sem_custo' e nenhum campo de custo/margem quando supplierPrice é undefined", () => {
    const row = makeRow({ supplierPrice: undefined });
    const price = makePrice({ price: 199.9, matchedTitle: "Achado no Mercado Livre" });

    const result = calculateMargin(row, price, DEFAULT_PRICING_RULES);

    expect(result.recommendation).toBe("sem_custo");
    expect(result.supplierPrice).toBeUndefined();
    expect(result.feesCost).toBeUndefined();
    expect(result.shippingCost).toBeUndefined();
    expect(result.taxesCost).toBeUndefined();
    expect(result.totalCost).toBeUndefined();
    expect(result.marginPct).toBeUndefined();
    // Preço de mercado e o resto dos dados encontrados continuam presentes
    // — só falta o que depende de custo, não o produto inteiro.
    expect(result.marketplacePrice).toBe(199.9);
    expect(result.matchedTitle).toBe("Achado no Mercado Livre");
    expect(result.sku).toBe("SKU-1");
  });
});

describe("summarize — exclui sem_custo da média/mediana", () => {
  it("não deixa uma linha sem_custo puxar a média/mediana de margem pra baixo", () => {
    const results = [
      calculateMargin(makeRow({ sku: "A", supplierPrice: 100 }), makePrice({ sku: "A", price: 150 }), DEFAULT_PRICING_RULES),
      calculateMargin(makeRow({ sku: "B", supplierPrice: 100 }), makePrice({ sku: "B", price: 150 }), DEFAULT_PRICING_RULES),
      calculateMargin(makeRow({ sku: "C", supplierPrice: undefined }), makePrice({ sku: "C", price: 150 }), DEFAULT_PRICING_RULES),
    ];

    const summary = summarize(results);

    expect(results[2].recommendation).toBe("sem_custo");
    expect(summary.totalSkus).toBe(3); // conta as 3 linhas...
    // ...mas a média/mediana só considera as 2 com margem calculável, não
    // as 3 (senão a linha sem custo distorceria o número pra baixo).
    expect(summary.avgMarginPct).toBe(results[0].marginPct);
    expect(summary.medianMarginPct).toBe(results[0].marginPct);
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
