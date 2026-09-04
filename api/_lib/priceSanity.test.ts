import { describe, expect, it } from "vitest";
import { assessPriceSanity, flagPriceSanity } from "./priceSanity";
import type { MarketplacePriceResult } from "./types";

function makeResult(overrides: Partial<MarketplacePriceResult> = {}): MarketplacePriceResult {
  return {
    marketplace: "amazon",
    sku: "SKU-1",
    price: 100,
    competitorCount: 3,
    buyBoxEligible: true,
    confidence: 0.8,
    ...overrides,
  };
}

describe("assessPriceSanity", () => {
  it("não acusa nada numa margem de revenda normal", () => {
    // Custo 50, mercado entre 60 e 400 — faixa plausível de revenda.
    for (const price of [60, 100, 150, 400]) {
      expect(assessPriceSanity(price, 50), `preço ${price}`).toBeUndefined();
    }
  });

  it(
    "acusa preço bem abaixo do custo — o padrão do ACESSÓRIO passando por produto (capa de R$ 19 num " +
      "produto de R$ 80 de custo), que era exatamente o buraco: preço nunca entrava na decisão",
    () => {
      expect(assessPriceSanity(19, 80)).toBe("abaixo_do_custo");
      expect(assessPriceSanity(5, 50)).toBe("abaixo_do_custo");
    }
  );

  it("tolera mercado apertado (preço um pouco abaixo do custo ainda passa)", () => {
    // 0.6x é o piso — 35 num custo de 50 (0.7x) é apertado mas plausível.
    expect(assessPriceSanity(35, 50)).toBeUndefined();
    expect(assessPriceSanity(29, 50)).toBe("abaixo_do_custo"); // 0.58x
  });

  it("acusa preço absurdamente acima do custo (lote não declarado ou produto errado)", () => {
    expect(assessPriceSanity(3000, 10)).toBe("muito_acima_do_custo");
  });

  it("não roda sem âncora — catálogo vitrine (sem custo) não pode gerar aviso nenhum", () => {
    expect(assessPriceSanity(100, undefined)).toBeUndefined();
    expect(assessPriceSanity(100, 0)).toBeUndefined();
    expect(assessPriceSanity(100, Number.NaN)).toBeUndefined();
  });

  it("ignora preço de mercado inválido em vez de classificar lixo", () => {
    expect(assessPriceSanity(0, 50)).toBeUndefined();
    expect(assessPriceSanity(Number.NaN, 50)).toBeUndefined();
  });
});

describe("flagPriceSanity", () => {
  it("marca como aproximado e carrega o motivo quando o preço não fecha com o custo", () => {
    const flagged = flagPriceSanity(makeResult({ price: 12 }), 100);

    expect(flagged.priceSanityFlag).toBe("abaixo_do_custo");
    expect(flagged.approximate).toBe(true);
  });

  it("devolve o MESMO objeto quando está tudo certo — zero efeito no caso comum", () => {
    const result = makeResult({ price: 150 });

    expect(flagPriceSanity(result, 100)).toBe(result);
  });

  it(
    "usa o preço UNITÁRIO quando o anúncio é lote — senão um kit legítimo de 12 seria reprovado por " +
      "'preço alto demais' com o preço por peça perfeitamente coerente",
    () => {
      const lote = makeResult({ price: 120, packQuantity: 12, unitPrice: 10 });

      // Custo 8/un: o lote inteiro (120) seria 15x o custo, mas o unitário
      // (10) está a 1,25x — perfeitamente normal.
      expect(flagPriceSanity(lote, 8).priceSanityFlag).toBeUndefined();
    }
  );

  it("preserva `approximate: true` que já vinha por outro motivo (outra loja, similaridade baixa)", () => {
    const jaAproximado = makeResult({ price: 12, approximate: true, matchedSource: "Shopee" });
    const flagged = flagPriceSanity(jaAproximado, 100);

    expect(flagged.approximate).toBe(true);
    expect(flagged.matchedSource).toBe("Shopee");
    expect(flagged.priceSanityFlag).toBe("abaixo_do_custo");
  });
});
