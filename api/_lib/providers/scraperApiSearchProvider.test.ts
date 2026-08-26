import { afterEach, describe, expect, it, vi } from "vitest";
import type { MarketplaceMatcher } from "./googleShoppingProvider";
import { GOOGLE_SHOPPING_MATCHERS } from "./googleShoppingProvider";
import type { CatalogItemQuery } from "../types";

/**
 * SCRAPERAPI_KEY é lida uma vez no module-load (mesmo padrão de
 * internalSearchProvider.ts) — cada teste que precisa da chave presente
 * usa `vi.stubEnv` + `vi.resetModules()` + reimport dinâmico, igual ao
 * describe "fetchStoreHtmlOnce — proxy ScraperAPI" em
 * internalSearchProvider.test.ts.
 */

const MATCHERS_BOTH: MarketplaceMatcher[] = GOOGLE_SHOPPING_MATCHERS;
const MATCHERS_ML_ONLY: MarketplaceMatcher[] = GOOGLE_SHOPPING_MATCHERS.filter((m) => m.marketplace === "mercadolivre");

function items(): CatalogItemQuery[] {
  return [{ sku: "SKU1", name: "Fone de Ouvido Bluetooth XYZ" }];
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.resetModules();
});

describe("searchScraperApiShared — sem SCRAPERAPI_KEY", () => {
  it("lança erro claro (secret de servidor, não BYOK — nunca deve rodar sem a variável de ambiente)", async () => {
    const { searchScraperApiShared } = await import("./scraperApiSearchProvider");
    await expect(searchScraperApiShared(items(), MATCHERS_BOTH)).rejects.toThrow(/SCRAPERAPI_KEY/);
  });
});

describe("searchScraperApiShared — com SCRAPERAPI_KEY", () => {
  async function importWithKey() {
    vi.stubEnv("SCRAPERAPI_KEY", "chave-de-teste");
    vi.resetModules();
    return import("./scraperApiSearchProvider");
  }

  it("marketplace amazon: combina candidato nativo (Amazon Search API) com o do Google Shopping, nativo ganha por popularidade (rating/reviews reais)", async () => {
    const { searchScraperApiShared } = await importWithKey();

    vi.stubGlobal(
      "fetch",
      vi.fn(async (urlStr: string) => {
        const url = new URL(urlStr);
        if (url.hostname === "api.scraperapi.com" && url.pathname.includes("/structured/amazon/search")) {
          return {
            ok: true,
            json: async () => ({
              results: [
                {
                  // Título IDÊNTICO ao nome do catálogo de propósito — o objetivo
                  // deste teste é comparar o desempate por POPULARIDADE (rating/
                  // reviews reais do nativo vs 0 do Google Shopping), não o
                  // filtro de similaridade de pickBestCandidate (SIMILARITY_TOLERANCE,
                  // ver rankCandidates.ts) — um título com palavra a mais ("Preto")
                  // cai fora da tolerância de 0.1 e nunca chega a competir por
                  // popularidade, o que mascarava o comportamento sendo testado aqui.
                  name: "Fone de Ouvido Bluetooth XYZ",
                  price: 199.9,
                  url: "https://amazon.com.br/dp/B0X",
                  image: "https://img/amazon.jpg",
                  stars: 4.8,
                  total_reviews: 5000,
                },
              ],
            }),
          } as unknown as Response;
        }
        // Google Shopping estruturado — mesmo título, popularidade 0 (sem rating/reviews nesse endpoint).
        return {
          ok: true,
          json: async () => ({
            shopping_results: [
              {
                title: "Fone de Ouvido Bluetooth XYZ",
                source: "Amazon.com.br",
                extracted_price: 210.5,
                thumbnail: "https://img/google.jpg",
              },
            ],
          }),
        } as unknown as Response;
      })
    );

    const result = await searchScraperApiShared(items(), MATCHERS_BOTH);

    expect(result.amazon.SKU1).toBeDefined();
    expect(result.amazon.SKU1.price).toBe(199.9); // ganhou o candidato NATIVO (popularidade real > 0)
    expect(result.amazon.SKU1.matchedSource).toBe("Amazon");
  });

  it("marketplace mercadolivre: só usa candidato do Google Shopping (Amazon Search API não cobre ML)", async () => {
    const { searchScraperApiShared } = await importWithKey();

    let calledAmazonNative = false;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (urlStr: string) => {
        const url = new URL(urlStr);
        if (url.hostname === "api.scraperapi.com" && url.pathname.includes("/structured/amazon/search")) {
          calledAmazonNative = true;
          return { ok: true, json: async () => ({ results: [] }) } as unknown as Response;
        }
        return {
          ok: true,
          json: async () => ({
            shopping_results: [
              {
                title: "Fone de Ouvido Bluetooth XYZ",
                source: "Mercado Livre",
                extracted_price: 179.9,
              },
            ],
          }),
        } as unknown as Response;
      })
    );

    const result = await searchScraperApiShared(items(), MATCHERS_ML_ONLY);

    expect(calledAmazonNative).toBe(false); // não pediu amazon nos matchers, não chama o endpoint nativo — economiza crédito
    expect(result.mercadolivre.SKU1).toBeDefined();
    expect(result.mercadolivre.SKU1.price).toBe(179.9);
  });

  it("fallback aproximado: Google Shopping acha o produto fora das lojas pedidas, entra marcado approximate em vez de sumir", async () => {
    const { searchScraperApiShared } = await importWithKey();

    vi.stubGlobal(
      "fetch",
      vi.fn(async (urlStr: string) => {
        const url = new URL(urlStr);
        if (url.hostname === "api.scraperapi.com" && url.pathname.includes("/structured/amazon/search")) {
          return { ok: true, json: async () => ({ results: [] }) } as unknown as Response;
        }
        return {
          ok: true,
          json: async () => ({
            shopping_results: [
              { title: "Fone de Ouvido Bluetooth XYZ", source: "Magalu", extracted_price: 189.9 },
            ],
          }),
        } as unknown as Response;
      })
    );

    const result = await searchScraperApiShared(items(), MATCHERS_BOTH);

    const [{ marketplace: firstMarketplace }] = MATCHERS_BOTH;
    expect(result[firstMarketplace].SKU1).toBeDefined();
    expect(result[firstMarketplace].SKU1.approximate).toBe(true);
    expect(result[firstMarketplace].SKU1.matchedSource).toBe("Magalu");
    expect(result[firstMarketplace].SKU1.confidence).toBeLessThanOrEqual(0.45);
  });

  it("erro sistêmico: propaga exceção só quando NENHUM item achou candidato em NENHUMA das duas fontes", async () => {
    const { searchScraperApiShared } = await importWithKey();

    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: true, json: async () => ({ results: [], shopping_results: [] }) }) as unknown as Response)
    );

    await expect(searchScraperApiShared(items(), MATCHERS_BOTH)).rejects.toThrow();
  });

  it("não propaga exceção quando SÓ uma das duas fontes falha (a outra ainda pode achar match)", async () => {
    const { searchScraperApiShared } = await importWithKey();

    vi.stubGlobal(
      "fetch",
      vi.fn(async (urlStr: string) => {
        const url = new URL(urlStr);
        if (url.hostname === "api.scraperapi.com" && url.pathname.includes("/structured/amazon/search")) {
          return { ok: false, status: 500, json: async () => ({}) } as unknown as Response;
        }
        return {
          ok: true,
          json: async () => ({
            shopping_results: [
              { title: "Fone de Ouvido Bluetooth XYZ", source: "Amazon.com.br", extracted_price: 210.5 },
            ],
          }),
        } as unknown as Response;
      })
    );

    const result = await searchScraperApiShared(items(), MATCHERS_BOTH);
    expect(result.amazon.SKU1).toBeDefined();
    expect(result.amazon.SKU1.price).toBe(210.5);
  });
});
