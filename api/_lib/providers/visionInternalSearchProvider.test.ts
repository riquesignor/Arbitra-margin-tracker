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

// Mock irmão do Gemini acima, pro backend Mistral (ver MISTRAL_BACKEND em
// visionInternalSearchProvider.ts) — usado só no describe "MISTRAL_BACKEND"
// mais abaixo, que testa especificamente o caminho de comparação EM
// LOTE (compareProductImagesBatch), a mesma técnica implementada primeiro
// pro Groq (removido ago/2026 — ver mistralVision.ts pro porquê da troca).
const describeProductImageMistral = vi.fn();
const compareProductImagesMistral = vi.fn();
const compareProductImagesBatchMistral = vi.fn();
vi.mock("../mistralVision.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../mistralVision")>();
  return {
    ...actual,
    describeProductImage: (...args: unknown[]) => describeProductImageMistral(...args),
    compareProductImages: (...args: unknown[]) => compareProductImagesMistral(...args),
    compareProductImagesBatch: (...args: unknown[]) => compareProductImagesBatchMistral(...args),
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
// Fonte estruturada da Amazon (set/2026, ver fetchCandidateOffers) —
// padrão vazio: nestes testes quem manda é o mock de `fetchStoreOffers`,
// e o fallback só deve entrar quando a raspagem não trouxe nada.
const fetchAmazonCandidatesForQuery = vi.fn(async (..._args: unknown[]) => [] as unknown[]);
vi.mock("./scraperApiSearchProvider.js", () => ({
  fetchGoogleShoppingCandidatesForQuery: (...args: unknown[]) => fetchGoogleShoppingCandidatesForQuery(...args),
  fetchAmazonCandidatesForQuery: (...args: unknown[]) => fetchAmazonCandidatesForQuery(...args),
}));

// Fontes OFICIAIS/grátis (set/2026, ver fetchCandidateOffers — agora
// degrau 1 do fallback, antes das duas estruturadas de terceiro acima).
// Padrão vazio nos dois: mockam "não configurado" (sem env vars/OAuth),
// que é o estado padrão de um ambiente de teste — mantém todos os testes
// existentes deste arquivo exercitando o caminho de sempre (raspagem →
// estruturado de terceiro) sem precisar saber que os degraus oficiais
// existem.
const fetchAmazonPaApiCandidatesForQuery = vi.fn(async (..._args: unknown[]) => [] as unknown[]);
vi.mock("./amazonPaApi.js", () => ({
  fetchAmazonPaApiCandidatesForQuery: (...args: unknown[]) => fetchAmazonPaApiCandidatesForQuery(...args),
}));
const fetchMlOfficialCandidatesForQuery = vi.fn(async (..._args: unknown[]) => [] as unknown[]);
vi.mock("./mercadoLivreSearchProvider.js", () => ({
  fetchMlOfficialCandidatesForQuery: (...args: unknown[]) => fetchMlOfficialCandidatesForQuery(...args),
}));

// Import dinâmico (não estático) de propósito: import ES é hoisted acima de
// qualquer outro código do arquivo, o que rodaria a resolução deste módulo
// (e por tabela, a factory de vi.mock acima) ANTES de `describeProductImage`/
// `compareProductImages`/`fetchStoreOffers` serem inicializados — TDZ. Fazer
// o import dentro de `beforeAll` garante que ele só roda depois que os
// `vi.fn()` acima já existem, sem precisar de top-level `await` (que o
// target/module do tsconfig.api.json não suporta).
let searchVisionInternalShared: typeof import("./visionInternalSearchProvider").searchVisionInternalShared;
let GEMINI_BACKEND: typeof import("./visionInternalSearchProvider").GEMINI_BACKEND;
let MISTRAL_BACKEND: typeof import("./visionInternalSearchProvider").MISTRAL_BACKEND;
let GeminiVisionError: typeof import("../geminiVision").GeminiVisionError;
let GeminiQuotaExhaustedError: typeof import("../geminiVision").GeminiQuotaExhaustedError;
let MistralQuotaExhaustedError: typeof import("../mistralVision").MistralQuotaExhaustedError;
let resetCandidateSourceState: typeof import("./visionInternalSearchProvider").resetCandidateSourceState;

beforeAll(async () => {
  ({ searchVisionInternalShared, GEMINI_BACKEND, MISTRAL_BACKEND, resetCandidateSourceState } = await import(
    "./visionInternalSearchProvider"
  ));
  ({ GeminiVisionError, GeminiQuotaExhaustedError } = await import("../geminiVision"));
  ({ MistralQuotaExhaustedError } = await import("../mistralVision"));
});

const MATCHERS: MarketplaceMatcher[] = [
  { marketplace: "amazon", matchesSource: () => true },
  { marketplace: "mercadolivre", matchesSource: () => true },
];

const ITEM_WITH_PHOTO: CatalogItemQuery = {
  sku: "SKU-1",
  // nome = o próprio SKU de propósito — é o sinal que `hasReliableName`
  // (visionInternalSearchProvider.ts) usa pra "sem nome de texto usável"
  // (ver extractGridBlocks/extractProductBlocksWithoutPriceIndexed,
  // parsePdfCatalog.ts: "cai pro SKU" é o mesmo fallback de lá). Mantém
  // TODOS os testes existentes deste arquivo exercitando o caminho de
  // sempre (IA descreve a foto) sem precisar mockar `describeProductImage`
  // em cada um — os testes do texto-como-query-primária usam fixtures
  // próprias (ver describe "usa o nome do catálogo como query" abaixo).
  name: "SKU-1",
  imageUrl: "https://catalogo/sku-1.jpg",
};

function offer(overrides: Partial<ScrapedOffer>): ScrapedOffer {
  return { title: "Fone Bluetooth Preto Over-ear XYZ", price: 100, ...overrides };
}

beforeEach(() => {
  describeProductImage.mockReset();
  compareProductImages.mockReset();
  describeProductImageMistral.mockReset();
  compareProductImagesMistral.mockReset();
  compareProductImagesBatchMistral.mockReset();
  fetchStoreOffers.mockReset();
  fetchGoogleShoppingCandidatesForQuery.mockReset().mockResolvedValue([]);
  fetchAmazonCandidatesForQuery.mockReset().mockResolvedValue([]);
  fetchAmazonPaApiCandidatesForQuery.mockReset().mockResolvedValue([]);
  fetchMlOfficialCandidatesForQuery.mockReset().mockResolvedValue([]);
  // Disjuntor de raspagem + memória do Google Shopping são estado de
  // MÓDULO (ver resetCandidateSourceState) — sem zerar, um caso que põe
  // a Amazon em cooldown contamina os seguintes.
  resetCandidateSourceState();
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("searchVisionInternalShared", () => {
  it("exige chave Gemini própria — sem BYOK, nem tenta chamar a IA", async () => {
    await expect(searchVisionInternalShared([ITEM_WITH_PHOTO], MATCHERS, "", GEMINI_BACKEND)).rejects.toThrow(
      /gemini/i
    );
    expect(describeProductImage).not.toHaveBeenCalled();
  });

  it("pula silenciosamente item sem foto de catálogo — não é erro sistêmico", async () => {
    const semFoto: CatalogItemQuery = { sku: "SKU-2", name: "Sem imagem" };

    const result = await searchVisionInternalShared([semFoto], MATCHERS, "fake-gemini-key", GEMINI_BACKEND);

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

      const result = await searchVisionInternalShared([ITEM_WITH_PHOTO], MATCHERS, "fake-gemini-key", GEMINI_BACKEND);

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

      const result = await searchVisionInternalShared([ITEM_WITH_PHOTO], MATCHERS, "fake-gemini-key", GEMINI_BACKEND);

      expect(result.results.amazon["SKU-1"]).toMatchObject({ confidence: 0.3, approximate: true });
    }
  );

  it(
    "corte antecipado (set/2026): nota ≥ 0.95 no 1º candidato evita comparar os outros 2 — " +
      "economiza chamada de Gemini sem trocar o vencedor (todos os 3 empatam em 0.97 aqui de propósito, " +
      "então SÓ dá pra saber que parou cedo pelo nº de chamadas, não pelo resultado)",
    async () => {
      describeProductImage.mockResolvedValue("query");
      fetchStoreOffers.mockResolvedValue([
        {
          marketplace: "amazon",
          label: "Amazon",
          offers: [
            offer({ thumbnail: "https://loja/a.jpg", link: "la", reviewCount: 10 }),
            offer({ thumbnail: "https://loja/b.jpg", link: "lb", reviewCount: 20 }),
            offer({ thumbnail: "https://loja/c.jpg", link: "lc", reviewCount: 30 }),
          ],
        },
      ] satisfies StoreOffers[]);
      compareProductImages.mockResolvedValue(0.97);

      const result = await searchVisionInternalShared([ITEM_WITH_PHOTO], MATCHERS, "fake-gemini-key", GEMINI_BACKEND);

      expect(compareProductImages).toHaveBeenCalledTimes(1);
      expect(result.results.amazon["SKU-1"]).toMatchObject({ confidence: 0.97 });
    }
  );

  it("SEM corte antecipado quando nenhuma nota chega em 0.95 — os 3 candidatos são comparados normalmente", async () => {
    describeProductImage.mockResolvedValue("query");
    fetchStoreOffers.mockResolvedValue([
      {
        marketplace: "amazon",
        label: "Amazon",
        offers: [
          offer({ thumbnail: "https://loja/a.jpg", link: "la", reviewCount: 10 }),
          offer({ thumbnail: "https://loja/b.jpg", link: "lb", reviewCount: 20 }),
          offer({ thumbnail: "https://loja/c.jpg", link: "lc", reviewCount: 30 }),
        ],
      },
    ] satisfies StoreOffers[]);
    compareProductImages.mockResolvedValue(0.6); // aceito, mas abaixo do EARLY_EXIT_SCORE (0.95)

    await searchVisionInternalShared([ITEM_WITH_PHOTO], MATCHERS, "fake-gemini-key", GEMINI_BACKEND);

    expect(compareProductImages).toHaveBeenCalledTimes(3);
  });

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

    const result = await searchVisionInternalShared([ITEM_WITH_PHOTO], MATCHERS, "fake-gemini-key", GEMINI_BACKEND);

    expect(result.results.amazon["SKU-1"]).toMatchObject({ confidence: 0.6, approximate: true });
  });

  it("propaga erro só quando TODOS os itens com foto falharem (falha sistêmica, ex.: chave inválida)", async () => {
    describeProductImage.mockRejectedValue(new GeminiVisionError("Gemini retornou HTTP 400: chave inválida"));

    await expect(
      searchVisionInternalShared([ITEM_WITH_PHOTO], MATCHERS, "chave-invalida", GEMINI_BACKEND)
    ).rejects.toThrow(/chave inválida/i);
  });

  it("não derruba o lote inteiro quando só ALGUNS itens falham", async () => {
    const item2: CatalogItemQuery = { sku: "SKU-3", name: "SKU-3", imageUrl: "https://catalogo/sku-3.jpg" };

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

    const result = await searchVisionInternalShared([ITEM_WITH_PHOTO, item2], MATCHERS, "fake-gemini-key", GEMINI_BACKEND);

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

      const result = await searchVisionInternalShared([ITEM_WITH_PHOTO], MATCHERS, "fake-gemini-key", GEMINI_BACKEND);

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

      const result = await searchVisionInternalShared([ITEM_WITH_PHOTO], MATCHERS, "fake-gemini-key", GEMINI_BACKEND);

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

      const result = await searchVisionInternalShared([ITEM_WITH_PHOTO], MATCHERS, "fake-gemini-key", GEMINI_BACKEND);

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

    await searchVisionInternalShared([ITEM_WITH_PHOTO], MATCHERS, "fake-gemini-key", GEMINI_BACKEND);

    expect(warnSpy).not.toHaveBeenCalledWith(expect.stringMatching(/nota visual abaixo do piso/i));
    warnSpy.mockRestore();
  });

  it(
    "corta o resto do lote assim que a cota do Gemini esgota — não insiste item por item " +
      "batendo na mesma parede (ver comentário de quotaExhausted em visionInternalSearchProvider.ts)",
    async () => {
      const item2: CatalogItemQuery = { sku: "SKU-3", name: "SKU-3", imageUrl: "https://catalogo/sku-3.jpg" };

      describeProductImage.mockRejectedValue(new GeminiQuotaExhaustedError("Gemini sem cota disponível agora"));

      await expect(
        searchVisionInternalShared([ITEM_WITH_PHOTO, item2], MATCHERS, "fake-gemini-key", GEMINI_BACKEND)
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
      const item2: CatalogItemQuery = { sku: "SKU-3", name: "SKU-3", imageUrl: "https://catalogo/sku-3.jpg" };
      const item3: CatalogItemQuery = { sku: "SKU-4", name: "SKU-4", imageUrl: "https://catalogo/sku-4.jpg" };

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
        "fake-gemini-key",
        GEMINI_BACKEND
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

  describe("Passo 1/2 — nome do catálogo como REFORÇO (auxílio), nunca no lugar da IA", () => {
    it(
      "a IA sempre roda primeiro, mesmo quando o catálogo tem nome de texto confiável — e quando ela já " +
        "confirma com confiança alta, o reforço de texto NEM RODA (evita 2ª raspagem desnecessária)",
      async () => {
        const itemComNome: CatalogItemQuery = {
          sku: "SKU-9",
          name: "Prato bebê plástico redondo rosa",
          imageUrl: "https://catalogo/sku-9.jpg",
        };
        describeProductImage.mockResolvedValue("prato de plástico redondo");
        fetchStoreOffers.mockResolvedValue([
          { marketplace: "amazon", label: "Amazon", offers: [offer({ thumbnail: "https://loja/prato.jpg", link: "l1" })] },
        ] satisfies StoreOffers[]);
        compareProductImages.mockResolvedValue(0.9); // confiança alta (>= APPROXIMATE_BELOW_SCORE)

        const result = await searchVisionInternalShared([itemComNome], MATCHERS, "fake-gemini-key", GEMINI_BACKEND);

        expect(describeProductImage).toHaveBeenCalledTimes(1);
        expect(fetchStoreOffers).toHaveBeenCalledTimes(1);
        expect(fetchStoreOffers).toHaveBeenCalledWith("prato de plástico redondo", expect.anything());
        expect(result.results.amazon["SKU-9"]).toMatchObject({ confidence: 0.9 });
      }
    );

    it("item sem nome confiável (nome = sku) continua chamando describeProductImage como sempre — sem mudança de comportamento", async () => {
      describeProductImage.mockResolvedValue("descrição gerada pela ia");
      fetchStoreOffers.mockResolvedValue([
        { marketplace: "amazon", label: "Amazon", offers: [offer({ thumbnail: "https://loja/x.jpg", link: "l1" })] },
      ] satisfies StoreOffers[]);
      compareProductImages.mockResolvedValue(0.9);

      await searchVisionInternalShared([ITEM_WITH_PHOTO], MATCHERS, "fake-gemini-key", GEMINI_BACKEND);

      expect(describeProductImage).toHaveBeenCalledTimes(1);
      expect(fetchStoreOffers).toHaveBeenCalledTimes(1);
      expect(fetchStoreOffers).toHaveBeenCalledWith("descrição gerada pela ia", expect.anything());
    });

    it(
      "sem nome confiável, NÃO tenta reforço nenhum mesmo quando a IA acha só um candidato aproximado — " +
        "não há texto de catálogo pra reforçar com",
      async () => {
        describeProductImage.mockResolvedValue("descrição genérica demais");
        fetchStoreOffers.mockResolvedValue([
          { marketplace: "amazon", label: "Amazon", offers: [offer({ thumbnail: "https://loja/x.jpg", link: "l1" })] },
        ] satisfies StoreOffers[]);
        compareProductImages.mockResolvedValue(0.3); // achou, aproximado

        const result = await searchVisionInternalShared([ITEM_WITH_PHOTO], MATCHERS, "fake-gemini-key", GEMINI_BACKEND);

        expect(fetchStoreOffers).toHaveBeenCalledTimes(1);
        expect(result.results.amazon["SKU-1"]).toMatchObject({ confidence: 0.3, approximate: true });
      }
    );

    it(
      "quando a IA já ACEITA um candidato como APROXIMADO (nota baixa, mas não rejeitado), o reforço de " +
        "texto NÃO RODA — só dispara quando a IA não achou NADA aceitável, não quando só ficou incerta. " +
        "Gatilho deliberadamente raro (ago/2026): a versão anterior disparava pra qualquer 'aproximado' " +
        "(a faixa mais comum na prática) e isso dobrou a raspagem a ponto de Amazon E Mercado Livre " +
        "bloquearem juntos num catálogo real (antes só o ML bloqueava)",
      async () => {
        const itemComNome: CatalogItemQuery = {
          sku: "SKU-9",
          name: "Prato bebê plástico redondo rosa",
          imageUrl: "https://catalogo/sku-9.jpg",
        };
        describeProductImage.mockResolvedValue("prato de plástico redondo");
        fetchStoreOffers.mockResolvedValue([
          { marketplace: "amazon", label: "Amazon", offers: [offer({ thumbnail: "https://loja/prato-generico.jpg", link: "l1" })] },
        ] satisfies StoreOffers[]);
        compareProductImages.mockResolvedValue(0.3); // aproximado — aceito, mas não confiante

        const result = await searchVisionInternalShared([itemComNome], MATCHERS, "fake-gemini-key", GEMINI_BACKEND);

        expect(fetchStoreOffers).toHaveBeenCalledTimes(1); // reforço NÃO rodou
        expect(result.results.amazon["SKU-9"]).toMatchObject({ confidence: 0.3, link: "l1", approximate: true });
      }
    );

    it(
      "nome do catálogo entra como REFORÇO quando a IA REJEITA tudo (nem aproximado) em loja nenhuma — " +
        "e o resultado final usa o candidato achado pelo texto, é a comparação visual quem confirma, " +
        "nunca o texto sozinho",
      async () => {
        const itemComNome: CatalogItemQuery = {
          sku: "SKU-9",
          name: "Prato bebê plástico redondo rosa",
          imageUrl: "https://catalogo/sku-9.jpg",
        };
        describeProductImage.mockResolvedValue("prato de plástico redondo");
        fetchStoreOffers
          .mockResolvedValueOnce([
            // 1ª rodada (IA): achou candidato, mas a IA rejeitou como produto diferente.
            { marketplace: "amazon", label: "Amazon", offers: [offer({ thumbnail: "https://loja/prato-errado.jpg", link: "l1" })] },
          ] satisfies StoreOffers[])
          .mockResolvedValueOnce([
            // 2ª rodada (reforço por texto): candidato certo.
            { marketplace: "amazon", label: "Amazon", offers: [offer({ thumbnail: "https://loja/prato-bebe.jpg", link: "l2" })] },
          ] satisfies StoreOffers[]);
        compareProductImages.mockResolvedValueOnce(0.1).mockResolvedValueOnce(0.9); // 0.1 < MIN_APPROXIMATE_SCORE (0.2) = rejeitado

        const result = await searchVisionInternalShared([itemComNome], MATCHERS, "fake-gemini-key", GEMINI_BACKEND);

        // IA roda 1x só (o reforço reaproveita a mesma descrição já gerada,
        // só troca a query de busca — não descreve a foto de novo).
        expect(describeProductImage).toHaveBeenCalledTimes(1);
        expect(fetchStoreOffers).toHaveBeenNthCalledWith(1, "prato de plástico redondo", expect.anything());
        expect(fetchStoreOffers).toHaveBeenNthCalledWith(2, "Prato bebê plástico redondo rosa", expect.anything());
        expect(result.results.amazon["SKU-9"]).toMatchObject({ confidence: 0.9, link: "l2", approximate: false });
      }
    );

    it(
      "quando a IA rejeita tudo e o reforço por texto só acha algo fraco também, ainda assim usa o " +
        "resultado do texto — a IA não tinha nada aceito pra competir com ele",
      async () => {
        const itemComNome: CatalogItemQuery = {
          sku: "SKU-9",
          name: "Prato bebê plástico redondo rosa",
          imageUrl: "https://catalogo/sku-9.jpg",
        };
        describeProductImage.mockResolvedValue("prato de plástico redondo");
        fetchStoreOffers
          .mockResolvedValueOnce([
            { marketplace: "amazon", label: "Amazon", offers: [offer({ thumbnail: "https://loja/prato-errado.jpg", link: "l-ia" })] },
          ] satisfies StoreOffers[])
          .mockResolvedValueOnce([
            { marketplace: "amazon", label: "Amazon", offers: [offer({ thumbnail: "https://loja/prato-talvez.jpg", link: "l-texto" })] },
          ] satisfies StoreOffers[]);
        compareProductImages.mockResolvedValueOnce(0.1).mockResolvedValueOnce(0.25); // IA rejeitada, texto só aproximado

        const result = await searchVisionInternalShared([itemComNome], MATCHERS, "fake-gemini-key", GEMINI_BACKEND);

        expect(fetchStoreOffers).toHaveBeenCalledTimes(2); // reforço rodou (IA rejeitou tudo)
        expect(result.results.amazon["SKU-9"]).toMatchObject({ confidence: 0.25, link: "l-texto", approximate: true });
      }
    );
  });

  describe("busca geral (outras lojas, Passo 4 — opt-in via marketplace \"geral\")", () => {
    // Matchers realistas (não "sempre true" como MATCHERS acima) — o
    // filtro de "loja de fora" do Passo 4 depende de `matchesSource`
    // saber diferenciar Amazon/ML de qualquer outra fonte. Inclui
    // "geral" — sem essa entrada o Passo 4 nem tenta (ver teste do
    // opt-in logo abaixo).
    const MATCHERS_COM_GERAL: MarketplaceMatcher[] = [
      { marketplace: "amazon", matchesSource: (s) => s.includes("amazon") },
      { marketplace: "mercadolivre", matchesSource: (s) => s.includes("mercado") },
      { marketplace: "geral", matchesSource: () => false }, // mesmo shape de GOOGLE_SHOPPING_MATCHERS (googleShoppingProvider.ts)
    ];
    const MATCHERS_SEM_GERAL: MarketplaceMatcher[] = [
      { marketplace: "amazon", matchesSource: (s) => s.includes("amazon") },
      { marketplace: "mercadolivre", matchesSource: (s) => s.includes("mercado") },
    ];

    it(
      "NÃO dispara quando o usuário NÃO marcou \"geral\" — mesmo com Amazon/ML falhando pra este item, " +
        "opt-in explícito é obrigatório (regressão: antes rodava automático, sem controle do usuário)",
      async () => {
        describeProductImage.mockResolvedValue("query");
        fetchStoreOffers.mockResolvedValue([
          { marketplace: "amazon", label: "Amazon", offers: [] },
          { marketplace: "mercadolivre", label: "Mercado Livre", offers: [] },
        ] satisfies StoreOffers[]);

        const result = await searchVisionInternalShared([ITEM_WITH_PHOTO], MATCHERS_SEM_GERAL, "fake-gemini-key", GEMINI_BACKEND);

        // A asserção NÃO é mais "o Google Shopping não foi chamado":
        // desde set/2026 essa mesma fonte também é o substituto do
        // Mercado Livre quando a raspagem dele volta vazia (ver
        // fetchCandidateOffers). O que o opt-in controla é o RESULTADO
        // "geral" — é isso que continua tendo que ficar de fora.
        expect(result.results.geral?.["SKU-1"]).toBeUndefined();
        expect(result.results.amazon?.["SKU-1"]).toBeUndefined();
      }
    );

    it("NÃO dispara quando uma loja focada já confirmou o item — Passo 4 é só fallback de último recurso, mesmo com \"geral\" marcado", async () => {
      describeProductImage.mockResolvedValue("query");
      fetchStoreOffers.mockResolvedValue([
        { marketplace: "amazon", label: "Amazon", offers: [offer({ thumbnail: "https://loja/bom.jpg", link: "l1" })] },
      ] satisfies StoreOffers[]);
      compareProductImages.mockResolvedValue(0.95);

      const result = await searchVisionInternalShared(
        [ITEM_WITH_PHOTO],
        MATCHERS_COM_GERAL,
        "fake-gemini-key",
        GEMINI_BACKEND
      );

      // Ver comentário do teste anterior: a fonte pode ser consultada
      // como substituta do ML, mas o Passo 4 (resultado "geral") não roda
      // quando uma loja focada já confirmou o item.
      expect(result.results.geral?.["SKU-1"]).toBeUndefined();
      expect(result.results.amazon["SKU-1"]).toMatchObject({ confidence: 0.95 });
    });

    it(
      "dispara e aceita candidato de OUTRA loja como aproximado quando \"geral\" está marcado e Amazon/ML " +
        "não confirmam nada — produto que só existe fora das duas lojas focadas não fica mais sem preço nenhum",
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

        const result = await searchVisionInternalShared([ITEM_WITH_PHOTO], MATCHERS_COM_GERAL, "fake-gemini-key", GEMINI_BACKEND);

        expect(fetchGoogleShoppingCandidatesForQuery).toHaveBeenCalledWith("fone bluetooth preto");
        // Chave PRÓPRIA "geral" — não empresta o slot de amazon/mercadolivre
        // (diferente do fallback aproximado dos outros mecanismos, que não
        // têm um marketplace "geral" de verdade pra usar).
        expect(result.results.geral["SKU-1"]).toMatchObject({
          marketplace: "geral",
          price: 87.5,
          confidence: 0.6,
          approximate: true,
          matchedSource: "Shopee",
        });
        // Amazon/ML continuam vazios — o achado NÃO é de nenhum dos dois.
        expect(result.results.amazon["SKU-1"]).toBeUndefined();
        expect(result.results.mercadolivre["SKU-1"]).toBeUndefined();
        // Sem link — Google Shopping estruturado não devolve link direto usável (ver
        // fetchGoogleShoppingCandidatesForQuery em scraperApiSearchProvider.ts).
        expect(result.results.geral["SKU-1"].link).toBeUndefined();
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

      const result = await searchVisionInternalShared([ITEM_WITH_PHOTO], MATCHERS_COM_GERAL, "fake-gemini-key", GEMINI_BACKEND);

      // Só o candidato "Magazine Luiza" (fora das lojas focadas) chega a ser comparado visualmente.
      expect(compareProductImages).toHaveBeenCalledTimes(1);
      expect(compareProductImages).toHaveBeenCalledWith(expect.anything(), "https://loja/magalu.jpg", expect.anything());
      expect(result.results.geral["SKU-1"]).toMatchObject({ price: 60, matchedSource: "Magazine Luiza" });
    });

    it("não derruba o item quando a busca geral falha (rede/ScraperAPI fora do ar) — fonte extra é best-effort", async () => {
      describeProductImage.mockResolvedValue("query");
      fetchStoreOffers.mockResolvedValue([
        { marketplace: "amazon", label: "Amazon", offers: [] },
      ] satisfies StoreOffers[]);
      fetchGoogleShoppingCandidatesForQuery.mockRejectedValue(new Error("ScraperAPI fora do ar"));

      const result = await searchVisionInternalShared([ITEM_WITH_PHOTO], MATCHERS_COM_GERAL, "fake-gemini-key", GEMINI_BACKEND);

      expect(fetchGoogleShoppingCandidatesForQuery).toHaveBeenCalled();
      expect(result.results.geral["SKU-1"]).toBeUndefined();
      expect(result.results.amazon["SKU-1"]).toBeUndefined();
      // Não é falha sistêmica do item (nem erro Gemini) — o item só fica sem preço, sem exceção.
    });
  });
});

/**
 * Backend Mistral (ver MISTRAL_BACKEND em visionInternalSearchProvider.ts)
 * — testa especificamente o caminho de comparação EM LOTE
 * (`compareProductImagesBatch`), a mesma técnica implementada primeiro pro
 * Groq (removido ago/2026, ver comentário grande em mistralVision.ts pro
 * porquê da troca): cada candidato NÃO vira uma chamada separada
 * reenviando a foto do catálogo — vai tudo numa chamada por loja. Os
 * testes do describe "searchVisionInternalShared" acima cobrem
 * GEMINI_BACKEND (sem `compareProductImagesBatch`, laço 1-a-1 de sempre)
 * — este describe cobre só o que MUDA quando o backend tem lote.
 */
describe("searchVisionInternalShared — MISTRAL_BACKEND (comparação em lote)", () => {
  it(
    "usa compareProductImagesBatch (NÃO o laço 1-a-1) quando o backend suporta — 1 chamada por loja, " +
      "não 1 por candidato",
    async () => {
      describeProductImageMistral.mockResolvedValue("fone bluetooth preto");
      fetchStoreOffers.mockResolvedValue([
        {
          marketplace: "amazon",
          label: "Amazon",
          offers: [
            offer({ thumbnail: "https://loja/c1.jpg", link: "l1" }),
            offer({ thumbnail: "https://loja/c2.jpg", link: "l2" }),
          ],
        },
      ] satisfies StoreOffers[]);
      compareProductImagesBatchMistral.mockResolvedValue([0.3, 0.95]); // candidato 2 (l2) vence

      const result = await searchVisionInternalShared([ITEM_WITH_PHOTO], MATCHERS, "fake-mistral-key", MISTRAL_BACKEND);

      expect(compareProductImagesMistral).not.toHaveBeenCalled(); // laço 1-a-1 NÃO rodou
      expect(compareProductImagesBatchMistral).toHaveBeenCalledTimes(1);
      expect(compareProductImagesBatchMistral).toHaveBeenCalledWith(
        ITEM_WITH_PHOTO.imageUrl,
        ["https://loja/c1.jpg", "https://loja/c2.jpg"],
        "fake-mistral-key"
      );
      expect(result.results.amazon["SKU-1"]).toMatchObject({ confidence: 0.95, link: "l2" });
    }
  );

  it("respeita o piso de aceite (MIN_APPROXIMATE_SCORE) e o piso de confiança alta (APPROXIMATE_BELOW_SCORE) igual ao laço 1-a-1", async () => {
    describeProductImageMistral.mockResolvedValue("query");
    fetchStoreOffers.mockResolvedValue([
      { marketplace: "amazon", label: "Amazon", offers: [offer({ thumbnail: "https://loja/x.jpg", link: "lx" })] },
    ] satisfies StoreOffers[]);
    compareProductImagesBatchMistral.mockResolvedValue([0.3]); // acima do piso mínimo (0.2), abaixo do de confiança alta (0.8)

    const result = await searchVisionInternalShared([ITEM_WITH_PHOTO], MATCHERS, "fake-mistral-key", MISTRAL_BACKEND);

    expect(result.results.amazon["SKU-1"]).toMatchObject({ confidence: 0.3, approximate: true });
  });

  it("trata nota `null` numa posição do lote como candidato NÃO comparável — não vira o vencedor por engano", async () => {
    describeProductImageMistral.mockResolvedValue("query");
    fetchStoreOffers.mockResolvedValue([
      {
        marketplace: "amazon",
        label: "Amazon",
        offers: [
          offer({ thumbnail: "https://loja/c1.jpg", link: "l1" }),
          offer({ thumbnail: "https://loja/c2.jpg", link: "l2" }),
        ],
      },
    ] satisfies StoreOffers[]);
    // c1 veio null (ver "descarta o chunk inteiro" em mistralVision.test.ts) — só c2 é candidato válido.
    compareProductImagesBatchMistral.mockResolvedValue([null, 0.6]);

    const result = await searchVisionInternalShared([ITEM_WITH_PHOTO], MATCHERS, "fake-mistral-key", MISTRAL_BACKEND);

    expect(result.results.amazon["SKU-1"]).toMatchObject({ confidence: 0.6, link: "l2" });
  });

  it(
    "corta o resto do lote quando a chamada em lote esgota a cota — mesmo comportamento do laço 1-a-1 " +
      "(ver teste equivalente em GEMINI_BACKEND acima)",
    async () => {
      const item2: CatalogItemQuery = { sku: "SKU-3", name: "SKU-3", imageUrl: "https://catalogo/sku-3.jpg" };

      describeProductImageMistral.mockResolvedValue("query");
      fetchStoreOffers.mockResolvedValue([
        { marketplace: "amazon", label: "Amazon", offers: [offer({ thumbnail: "https://loja/c1.jpg", link: "l1" })] },
      ] satisfies StoreOffers[]);
      compareProductImagesBatchMistral.mockRejectedValue(
        new MistralQuotaExhaustedError("Mistral sem cota disponível agora", null)
      );

      const result = await searchVisionInternalShared(
        [ITEM_WITH_PHOTO, item2],
        MATCHERS,
        "fake-mistral-key",
        MISTRAL_BACKEND
      );

      expect(result.results.amazon["SKU-1"]).toBeUndefined();
      expect(result.warning).toMatch(/cota.*mistral/i);
      // Item 2 nem chegou a tentar describeProductImage — a flag de cota
      // esgotada, setada já na comparação em lote do item 1, pulou ele.
      expect(describeProductImageMistral).toHaveBeenCalledTimes(1);
    }
  );

  it("não avisa erro de cota (console.warn genérico) quando o lote falha por motivo QUALQUER outro que não cota", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    describeProductImageMistral.mockResolvedValue("query");
    fetchStoreOffers.mockResolvedValue([
      { marketplace: "amazon", label: "Amazon", offers: [offer({ thumbnail: "https://loja/c1.jpg", link: "l1" })] },
    ] satisfies StoreOffers[]);
    compareProductImagesBatchMistral.mockRejectedValue(new Error("timeout"));

    const result = await searchVisionInternalShared([ITEM_WITH_PHOTO], MATCHERS, "fake-mistral-key", MISTRAL_BACKEND);

    expect(result.results.amazon["SKU-1"]).toBeUndefined();
    expect(warnSpy).toHaveBeenCalledWith(expect.stringMatching(/comparação visual em lote falhou/i), expect.anything());
    warnSpy.mockRestore();
  });
});
