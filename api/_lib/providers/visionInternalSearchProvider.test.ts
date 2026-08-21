import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { CatalogItemQuery } from "../types";
import type { MarketplaceMatcher } from "./googleShoppingProvider";
import type { ScrapedOffer, StoreOffers } from "./internalSearchProvider";

// Mocka só as duas peças externas da orquestração — a IA (geminiVision.ts)
// e a raspagem (internalSearchProvider.ts) — mantendo REAIS o ranking
// (rankCandidates.ts, via getTopCandidates) e a similaridade de texto
// (textSimilarity.ts) que `searchVisionInternalShared` usa por baixo. É a
// combinação que testa a lógica de ORQUESTRAÇÃO (quem vence a comparação
// visual, quem fica de fora do piso de aceite) sem depender de rede nem
// de resposta real de IA.
const describeProductImage = vi.fn();
const compareProductImages = vi.fn();
vi.mock("../geminiVision.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../geminiVision")>();
  return {
    ...actual,
    describeProductImage: (...args: unknown[]) => describeProductImage(...args),
    compareProductImages: (...args: unknown[]) => compareProductImages(...args),
  };
});

const fetchStoreOffers = vi.fn();
vi.mock("./internalSearchProvider.js", () => ({
  fetchStoreOffers: (...args: unknown[]) => fetchStoreOffers(...args),
}));

// Import dinâmico (não estático) de propósito: import ES é hoisted acima de
// qualquer outro código do arquivo, o que rodaria a resolução deste módulo
// (e por tabela, a factory de vi.mock acima) ANTES de `describeProductImage`/
// `compareProductImages`/`fetchStoreOffers` serem inicializados — TDZ. Fazer
// o import dentro de `beforeAll` garante que ele só roda depois que os
// `vi.fn()` acima já existem, sem precisar de top-level `await` (que o
// target/module do tsconfig.api.json não suporta).
let searchVisionInternalShared: typeof import("./visionInternalSearchProvider").searchVisionInternalShared;
let GeminiVisionError: typeof import("../geminiVision").GeminiVisionError;
let GeminiQuotaExhaustedError: typeof import("../geminiVision").GeminiQuotaExhaustedError;

beforeAll(async () => {
  ({ searchVisionInternalShared } = await import("./visionInternalSearchProvider"));
  ({ GeminiVisionError, GeminiQuotaExhaustedError } = await import("../geminiVision"));
});

const MATCHERS: MarketplaceMatcher[] = [
  { marketplace: "amazon", matchesSource: () => true },
  { marketplace: "mercadolivre", matchesSource: () => true },
];

const ITEM_WITH_PHOTO: CatalogItemQuery = {
  sku: "SKU-1",
  name: "Item 42", // nome ruim de propósito — é justamente o caso que o pipeline existe pra cobrir
  imageUrl: "https://catalogo/sku-1.jpg",
};

function offer(overrides: Partial<ScrapedOffer>): ScrapedOffer {
  return { title: "Fone Bluetooth Preto Over-ear XYZ", price: 100, ...overrides };
}

beforeEach(() => {
  describeProductImage.mockReset();
  compareProductImages.mockReset();
  fetchStoreOffers.mockReset();
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("searchVisionInternalShared", () => {
  it("exige chave Gemini própria — sem BYOK, nem tenta chamar a IA", async () => {
    await expect(searchVisionInternalShared([ITEM_WITH_PHOTO], MATCHERS, "")).rejects.toThrow(/gemini/i);
    expect(describeProductImage).not.toHaveBeenCalled();
  });

  it("pula silenciosamente item sem foto de catálogo — não é erro sistêmico", async () => {
    const semFoto: CatalogItemQuery = { sku: "SKU-2", name: "Sem imagem" };

    const result = await searchVisionInternalShared([semFoto], MATCHERS, "fake-gemini-key");

    expect(result).toEqual({ amazon: {}, mercadolivre: {} });
    expect(describeProductImage).not.toHaveBeenCalled();
  });

  it(
    "confirma o candidato de MAIOR similaridade visual por loja, e descarta o candidato cuja " +
      "nota fica abaixo do piso de aceite (mesma categoria não é confiança suficiente)",
    async () => {
      describeProductImage.mockResolvedValue("fone bluetooth preto over-ear");

      const amazonOffers: ScrapedOffer[] = [
        offer({ thumbnail: "https://loja/amazon-menos-parecido.jpg", price: 120, reviewCount: 5, link: "l2" }),
        offer({ thumbnail: "https://loja/amazon-mais-parecido.jpg", price: 100, reviewCount: 10, link: "l1" }),
      ];
      const mercadolivreOffers: ScrapedOffer[] = [
        offer({ thumbnail: "https://loja/ml-produto-diferente.jpg", price: 90, reviewCount: 50, link: "l3" }),
      ];
      const storeOffers: StoreOffers[] = [
        { marketplace: "amazon", label: "Amazon", offers: amazonOffers },
        { marketplace: "mercadolivre", label: "Mercado Livre", offers: mercadolivreOffers },
      ];
      fetchStoreOffers.mockResolvedValue(storeOffers);

      compareProductImages.mockImplementation((_catalogUrl: string, candidateUrl: string) => {
        if (candidateUrl === "https://loja/amazon-mais-parecido.jpg") return Promise.resolve(0.9);
        if (candidateUrl === "https://loja/amazon-menos-parecido.jpg") return Promise.resolve(0.6);
        if (candidateUrl === "https://loja/ml-produto-diferente.jpg") return Promise.resolve(0.3);
        return Promise.resolve(0);
      });

      const result = await searchVisionInternalShared([ITEM_WITH_PHOTO], MATCHERS, "fake-gemini-key");

      // Amazon: venceu o candidato de nota 0.9 (não o mais popular/primeiro da lista).
      expect(result.amazon["SKU-1"]).toMatchObject({
        marketplace: "amazon",
        price: 100,
        confidence: 0.9,
        link: "l1",
        approximate: false, // 0.9 >= piso de "aproximado" (0.8)
        matchedSource: "Amazon",
      });

      // Mercado Livre: único candidato ficou com nota 0.3 (< piso de aceite 0.5) — sem resultado.
      expect(result.mercadolivre["SKU-1"]).toBeUndefined();
    }
  );

  it("marca como aproximado um match aceito mas com nota abaixo do piso de confiança alta", async () => {
    describeProductImage.mockResolvedValue("query");
    fetchStoreOffers.mockResolvedValue([
      {
        marketplace: "amazon",
        label: "Amazon",
        offers: [offer({ thumbnail: "https://loja/x.jpg", link: "lx" })],
      },
    ] satisfies StoreOffers[]);
    compareProductImages.mockResolvedValue(0.6); // aceito (>=0.5) mas não confiante (<0.8)

    const result = await searchVisionInternalShared([ITEM_WITH_PHOTO], MATCHERS, "fake-gemini-key");

    expect(result.amazon["SKU-1"]).toMatchObject({ confidence: 0.6, approximate: true });
  });

  it("propaga erro só quando TODOS os itens com foto falharem (falha sistêmica, ex.: chave inválida)", async () => {
    describeProductImage.mockRejectedValue(new GeminiVisionError("Gemini retornou HTTP 400: chave inválida"));

    await expect(
      searchVisionInternalShared([ITEM_WITH_PHOTO], MATCHERS, "chave-invalida")
    ).rejects.toThrow(/chave inválida/i);
  });

  it("não derruba o lote inteiro quando só ALGUNS itens falham", async () => {
    const item2: CatalogItemQuery = { sku: "SKU-3", name: "Item 99", imageUrl: "https://catalogo/sku-3.jpg" };

    describeProductImage.mockImplementation((url: string) =>
      url.includes("sku-1") ? Promise.reject(new GeminiVisionError("timeout")) : Promise.resolve("query ok")
    );
    fetchStoreOffers.mockResolvedValue([
      {
        marketplace: "amazon",
        label: "Amazon",
        offers: [offer({ thumbnail: "https://loja/ok.jpg", link: "ok" })],
      },
    ] satisfies StoreOffers[]);
    compareProductImages.mockResolvedValue(0.95);

    const result = await searchVisionInternalShared([ITEM_WITH_PHOTO, item2], MATCHERS, "fake-gemini-key");

    expect(result.amazon["SKU-1"]).toBeUndefined();
    expect(result.amazon["SKU-3"]).toMatchObject({ confidence: 0.95 });
  });

  it(
    "avisa (console.warn, resumo agregado) quando um candidato é descartado por nota visual " +
      "abaixo do piso — antes disso era 100% silencioso, indistinguível de bloqueio ou de sem match",
    async () => {
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
      describeProductImage.mockResolvedValue("query");
      fetchStoreOffers.mockResolvedValue([
        {
          marketplace: "amazon",
          label: "Amazon",
          offers: [offer({ thumbnail: "https://loja/fraco.jpg", link: "l1" })],
        },
      ] satisfies StoreOffers[]);
      compareProductImages.mockResolvedValue(0.3); // < piso de aceite (0.5)

      const result = await searchVisionInternalShared([ITEM_WITH_PHOTO], MATCHERS, "fake-gemini-key");

      expect(result.amazon["SKU-1"]).toBeUndefined();
      expect(warnSpy).toHaveBeenCalledWith(expect.stringMatching(/1 candidato.*nota visual abaixo do piso/i));
      warnSpy.mockRestore();
    }
  );

  it("NÃO avisa sobre nota visual quando nenhum candidato foi descartado por esse motivo", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    describeProductImage.mockResolvedValue("query");
    fetchStoreOffers.mockResolvedValue([
      {
        marketplace: "amazon",
        label: "Amazon",
        offers: [offer({ thumbnail: "https://loja/bom.jpg", link: "l1" })],
      },
    ] satisfies StoreOffers[]);
    compareProductImages.mockResolvedValue(0.95); // aceito de sobra

    await searchVisionInternalShared([ITEM_WITH_PHOTO], MATCHERS, "fake-gemini-key");

    expect(warnSpy).not.toHaveBeenCalledWith(expect.stringMatching(/nota visual abaixo do piso/i));
    warnSpy.mockRestore();
  });

  it(
    "corta o resto do lote assim que a cota do Gemini esgota — não insiste item por item " +
      "batendo na mesma parede (ver comentário de quotaExhausted em visionInternalSearchProvider.ts)",
    async () => {
      const item2: CatalogItemQuery = { sku: "SKU-3", name: "Item 99", imageUrl: "https://catalogo/sku-3.jpg" };

      describeProductImage.mockRejectedValue(new GeminiQuotaExhaustedError("Gemini sem cota disponível agora"));

      await expect(
        searchVisionInternalShared([ITEM_WITH_PHOTO, item2], MATCHERS, "fake-gemini-key")
      ).rejects.toThrow(/cota/i);

      // Item 2 nem chegou a tentar — a flag de cota esgotada, setada já na
      // falha do item 1, pulou ele antes de chamar describeProductImage.
      expect(describeProductImage).toHaveBeenCalledTimes(1);
    }
  );
});
