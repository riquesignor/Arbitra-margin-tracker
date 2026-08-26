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

// Fonte da "busca geral" (Passo 4, ago/2026) — mockada separado de
// `fetchStoreOffers` porque representa uma fonte DIFERENTE (Google
// Shopping estruturado via ScraperAPI, várias lojas, não só Amazon/ML).
// Default [] no beforeEach abaixo: a maioria dos testes deste arquivo
// testa o pipeline Amazon/ML (passos 1-3) e não deve disparar nem
// depender do Passo 4 — só os testes do describe "busca geral" configuram
// um retorno próprio.
const fetchGoogleShoppingCandidatesForQuery = vi.fn();
vi.mock("./scraperApiSearchProvider.js", () => ({
  fetchGoogleShoppingCandidatesForQuery: (...args: unknown[]) => fetchGoogleShoppingCandidatesForQuery(...args),
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
  fetchGoogleShoppingCandidatesForQuery.mockReset().mockResolvedValue([]);
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

    expect(result.results).toEqual({ amazon: {}, mercadolivre: {} });
    expect(result.warning).toBeUndefined();
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
        if (candidateUrl === "https://loja/ml-produto-diferente.jpg") return Promise.resolve(0.1);
        return Promise.resolve(0);
      });

      const result = await searchVisionInternalShared([ITEM_WITH_PHOTO], MATCHERS, "fake-gemini-key");

      // Amazon: venceu o candidato de nota 0.9 (não o mais popular/primeiro da lista).
      expect(result.results.amazon["SKU-1"]).toMatchObject({
        marketplace: "amazon",
        price: 100,
        confidence: 0.9,
        link: "l1",
        approximate: false, // 0.9 >= piso de "aproximado" (0.8)
        matchedSource: "Amazon",
      });

      // Mercado Livre: único candidato ficou com nota 0.1 (< piso mínimo 0.2, ver MIN_APPROXIMATE_SCORE) — sem resultado mesmo assim.
      expect(result.results.mercadolivre["SKU-1"]).toBeUndefined();
    }
  );

  it(
    "aceita candidato com nota BAIXA (mas acima do piso mínimo) como APROXIMADO, em vez de descartar — " +
      "regressão do teste real Issam_completo (12 produtos, 0 voltaram com preço, sem nenhuma pista): " +
      "antes qualquer nota < 0.5 sumia da tela igual 'sem match'; agora só < 0.2 some de vez",
    async () => {
      describeProductImage.mockResolvedValue("query");
      fetchStoreOffers.mockResolvedValue([
        { marketplace: "amazon", label: "Amazon", offers: [offer({ thumbnail: "https://loja/x.jpg", link: "lx" })] },
      ] satisfies StoreOffers[]);
      compareProductImages.mockResolvedValue(0.3); // abaixo do antigo piso (0.5), acima do novo piso mínimo (0.2)

      const result = await searchVisionInternalShared([ITEM_WITH_PHOTO], MATCHERS, "fake-gemini-key");

      expect(result.results.amazon["SKU-1"]).toMatchObject({ confidence: 0.3, approximate: true });
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

    expect(result.results.amazon["SKU-1"]).toMatchObject({ confidence: 0.6, approximate: true });
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

    expect(result.results.amazon["SKU-1"]).toBeUndefined();
    expect(result.results.amazon["SKU-3"]).toMatchObject({ confidence: 0.95 });
  });

  it(
    "avisa (console.warn, resumo agregado) quando um candidato é descartado por nota visual " +
      "abaixo do piso mínimo — antes disso era 100% silencioso, indistinguível de bloqueio ou de sem match",
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
      compareProductImages.mockResolvedValue(0.1); // < piso mínimo (0.2, MIN_APPROXIMATE_SCORE)

      const result = await searchVisionInternalShared([ITEM_WITH_PHOTO], MATCHERS, "fake-gemini-key");

      expect(result.results.amazon["SKU-1"]).toBeUndefined();
      expect(warnSpy).toHaveBeenCalledWith(expect.stringMatching(/1 candidato.*nota visual abaixo do piso/i));
      warnSpy.mockRestore();
    }
  );

  it(
    "warning explicando o motivo quando o lote termina TOTALMENTE vazio por nota visual baixa (não cota) — " +
      "regressão do Issam_completo: 0 de 12 sem nenhuma pista de causa na UI",
    async () => {
      fetchStoreOffers.mockResolvedValue([
        { marketplace: "amazon", label: "Amazon", offers: [offer({ thumbnail: "https://loja/fraco.jpg", link: "l1" })] },
      ] satisfies StoreOffers[]);
      describeProductImage.mockResolvedValue("query");
      compareProductImages.mockResolvedValue(0.1); // abaixo até do piso de aproximado — item some de vez

      const result = await searchVisionInternalShared([ITEM_WITH_PHOTO], MATCHERS, "fake-gemini-key");

      expect(result.results.amazon["SKU-1"]).toBeUndefined();
      expect(result.warning).toMatch(/produto diferente/i);
    }
  );

  it(
    "warning explicando o motivo quando o lote termina vazio porque a busca por texto não achou " +
      "candidato NENHUM (descrição da IA não bateu com nada na loja) — causa diferente de nota visual baixa",
    async () => {
      describeProductImage.mockResolvedValue("query genérica demais");
      fetchStoreOffers.mockResolvedValue([
        { marketplace: "amazon", label: "Amazon", offers: [] }, // busca não achou candidato nenhum
      ] satisfies StoreOffers[]);

      const result = await searchVisionInternalShared([ITEM_WITH_PHOTO], MATCHERS, "fake-gemini-key");

      expect(result.results.amazon["SKU-1"]).toBeUndefined();
      expect(compareProductImages).not.toHaveBeenCalled();
      expect(result.warning).toMatch(/não achou candidato/i);
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

  it(
    "quando a cota esgota DEPOIS de alguns itens já terem sucesso, devolve os resultados obtidos " +
      "MAIS um warning explicando o corte — regressão do relato real 'catálogo de 48, só 2 com preço, " +
      "sem explicação' (ago/2026): antes o warning simplesmente não existia nesse provider",
    async () => {
      const item2: CatalogItemQuery = { sku: "SKU-3", name: "Item 99", imageUrl: "https://catalogo/sku-3.jpg" };
      const item3: CatalogItemQuery = { sku: "SKU-4", name: "Item 100", imageUrl: "https://catalogo/sku-4.jpg" };

      // Item 1 (SKU-1) tem sucesso normal; item 2 (SKU-3) estoura cota;
      // item 3 (SKU-4) nem chega a tentar (flag já ligada antes da vez dele).
      describeProductImage.mockImplementation((url: string) => {
        if (url.includes("sku-1")) return Promise.resolve("query ok");
        if (url.includes("sku-3")) return Promise.reject(new GeminiQuotaExhaustedError("Gemini sem cota disponível agora"));
        return Promise.resolve("nao deveria chegar aqui");
      });
      fetchStoreOffers.mockResolvedValue([
        { marketplace: "amazon", label: "Amazon", offers: [offer({ thumbnail: "https://loja/ok.jpg", link: "ok" })] },
      ] satisfies StoreOffers[]);
      compareProductImages.mockResolvedValue(0.95);

      const result = await searchVisionInternalShared(
        [ITEM_WITH_PHOTO, item2, item3],
        MATCHERS,
        "fake-gemini-key"
      );

      // O que já deu certo antes da cota estourar continua no resultado —
      // corte de cota não é motivo pra jogar fora sucesso anterior.
      expect(result.results.amazon["SKU-1"]).toMatchObject({ confidence: 0.95 });

      // E agora existe um warning explicando POR QUE os outros 2 (SKU-3
      // que tentou e falhou, SKU-4 que nem tentou) não vieram — não é
      // "produto não encontrado", é cota.
      expect(result.warning).toMatch(/cota.*gemini/i);
      // Cota bateu NA tentativa do 2º item (o 1º deu certo, o 2º foi quem
      // esbarrou na parede) — "2 de 3" é o ponto exato do corte, não uma
      // estimativa.
      expect(result.warning).toMatch(/2 de 3/);

      // Item 3 nunca chegou a chamar describeProductImage (pulado pela flag).
      expect(describeProductImage).toHaveBeenCalledTimes(2);
    }
  );

  describe("busca geral (outras lojas, Passo 4)", () => {
    // Matchers realistas (não "sempre true" como MATCHERS acima) — o
    // filtro de "loja de fora" do Passo 4 depende de `matchesSource`
    // saber diferenciar Amazon/ML de qualquer outra fonte.
    const REALISTIC_MATCHERS: MarketplaceMatcher[] = [
      { marketplace: "amazon", matchesSource: (s) => s.includes("amazon") },
      { marketplace: "mercadolivre", matchesSource: (s) => s.includes("mercado") },
    ];

    it("NÃO dispara quando uma loja focada já confirmou o item — Passo 4 é só fallback de último recurso", async () => {
      describeProductImage.mockResolvedValue("query");
      fetchStoreOffers.mockResolvedValue([
        { marketplace: "amazon", label: "Amazon", offers: [offer({ thumbnail: "https://loja/bom.jpg", link: "l1" })] },
      ] satisfies StoreOffers[]);
      compareProductImages.mockResolvedValue(0.95);

      await searchVisionInternalShared([ITEM_WITH_PHOTO], REALISTIC_MATCHERS, "fake-gemini-key");

      expect(fetchGoogleShoppingCandidatesForQuery).not.toHaveBeenCalled();
    });

    it(
      "dispara e aceita candidato de OUTRA loja como aproximado quando Amazon/ML não confirmam nada — " +
        "produto que só existe fora das duas lojas focadas não fica mais sem preço nenhum",
      async () => {
        describeProductImage.mockResolvedValue("fone bluetooth preto");
        fetchStoreOffers.mockResolvedValue([
          { marketplace: "amazon", label: "Amazon", offers: [] },
          { marketplace: "mercadolivre", label: "Mercado Livre", offers: [] },
        ] satisfies StoreOffers[]);
        fetchGoogleShoppingCandidatesForQuery.mockResolvedValue([
          { title: "Fone Bluetooth Preto Over-ear XYZ", price: 87.5, thumbnail: "https://loja/shopee.jpg", source: "Shopee" },
        ]);
        compareProductImages.mockResolvedValue(0.6);

        const result = await searchVisionInternalShared([ITEM_WITH_PHOTO], REALISTIC_MATCHERS, "fake-gemini-key");

        expect(fetchGoogleShoppingCandidatesForQuery).toHaveBeenCalledWith("fone bluetooth preto");
        // Entra no PRIMEIRO marketplace pedido (amazon, ordem de REALISTIC_MATCHERS) — mesmo racional do
        // fallback aproximado nos outros providers (o preço não é de nenhum marketplace focado de verdade).
        expect(result.results.amazon["SKU-1"]).toMatchObject({
          marketplace: "amazon",
          price: 87.5,
          confidence: 0.6,
          approximate: true,
          matchedSource: "Shopee",
        });
        // Sem link — Google Shopping estruturado não devolve link direto usável (ver
        // fetchGoogleShoppingCandidatesForQuery em scraperApiSearchProvider.ts).
        expect(result.results.amazon["SKU-1"].link).toBeUndefined();
      }
    );

    it("filtra candidatos cuja fonte já pertence a uma loja focada — Passo 4 é só pra lojas DE FORA", async () => {
      describeProductImage.mockResolvedValue("query");
      fetchStoreOffers.mockResolvedValue([
        { marketplace: "amazon", label: "Amazon", offers: [] },
        { marketplace: "mercadolivre", label: "Mercado Livre", offers: [] },
      ] satisfies StoreOffers[]);
      // Duas fontes: uma "Amazon" (já focada, deveria ser IGNORADA aqui) e uma "Magazine Luiza" (de fora).
      fetchGoogleShoppingCandidatesForQuery.mockResolvedValue([
        { title: "Produto via Amazon (Google Shopping)", price: 50, thumbnail: "https://loja/amz.jpg", source: "Amazon" },
        { title: "Produto Magalu", price: 60, thumbnail: "https://loja/magalu.jpg", source: "Magazine Luiza" },
      ]);
      compareProductImages.mockResolvedValue(0.9);

      const result = await searchVisionInternalShared([ITEM_WITH_PHOTO], REALISTIC_MATCHERS, "fake-gemini-key");

      // Só o candidato "Magazine Luiza" (fora das lojas focadas) chega a ser comparado visualmente.
      expect(compareProductImages).toHaveBeenCalledTimes(1);
      expect(compareProductImages).toHaveBeenCalledWith(expect.anything(), "https://loja/magalu.jpg", expect.anything());
      expect(result.results.amazon["SKU-1"]).toMatchObject({ price: 60, matchedSource: "Magazine Luiza" });
    });

    it("não derruba o item quando a busca geral falha (rede/ScraperAPI fora do ar) — fonte extra é best-effort", async () => {
      describeProductImage.mockResolvedValue("query");
      fetchStoreOffers.mockResolvedValue([
        { marketplace: "amazon", label: "Amazon", offers: [] },
      ] satisfies StoreOffers[]);
      fetchGoogleShoppingCandidatesForQuery.mockRejectedValue(new Error("ScraperAPI fora do ar"));

      const result = await searchVisionInternalShared([ITEM_WITH_PHOTO], REALISTIC_MATCHERS, "fake-gemini-key");

      expect(result.results.amazon["SKU-1"]).toBeUndefined();
      // Não é falha sistêmica do item (nem erro Gemini) — o item só fica sem preço, sem exceção.
    });
  });
});
