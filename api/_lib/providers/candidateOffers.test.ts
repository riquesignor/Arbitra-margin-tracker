import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { MarketplaceMatcher } from "./googleShoppingProvider.js";

/**
 * Rede de segurança da fonte de candidatos (set/2026): a raspagem
 * continua sendo a fonte primária e o endpoint estruturado da Amazon só
 * entra quando ela não trouxe nada — cada chamada dele custa 5 créditos,
 * então "quando não trouxe nada" precisa ser verdade de verdade.
 *
 * `scraperApiKey` é BYOK (set/2026) — passada por parâmetro em
 * `fetchCandidateOffers`, não lida de `process.env`. `KEY` abaixo é a
 * chave de teste usada em todo teste que representa "usuário com chave
 * cadastrada"; o teste "sem chave" passa `undefined` explicitamente.
 */
vi.mock("./internalSearchProvider.js", () => ({
  fetchStoreOffers: vi.fn(),
}));
vi.mock("./scraperApiSearchProvider.js", () => ({
  fetchAmazonCandidatesForQuery: vi.fn(),
  fetchGoogleShoppingCandidatesForQuery: vi.fn(),
}));
vi.mock("./amazonPaApi.js", () => ({
  fetchAmazonPaApiCandidatesForQuery: vi.fn(),
}));
vi.mock("./mercadoLivreSearchProvider.js", () => ({
  fetchMlOfficialCandidatesForQuery: vi.fn(),
}));

import { fetchStoreOffers } from "./internalSearchProvider.js";
import {
  fetchAmazonCandidatesForQuery,
  fetchGoogleShoppingCandidatesForQuery,
} from "./scraperApiSearchProvider.js";
import { fetchAmazonPaApiCandidatesForQuery } from "./amazonPaApi.js";
import { fetchMlOfficialCandidatesForQuery } from "./mercadoLivreSearchProvider.js";
import { fetchCandidateOffers, resetCandidateSourceState } from "./visionInternalSearchProvider.js";

const KEY = "chave-de-teste";

const AMAZON_MATCHER = { marketplace: "amazon", matchesSource: () => true } as unknown as MarketplaceMatcher;
// `matchesSource` realista (não "sempre true"): é ele que separa o
// candidato do ML dos de outras lojas quando a fonte é o Google Shopping.
const ML_MATCHER = {
  marketplace: "mercadolivre",
  matchesSource: (s: string) => s.includes("mercado"),
} as unknown as MarketplaceMatcher;

const SCRAPED_OFFER = { title: "Furadeira 500W", price: 199.9, thumbnail: "https://img/x.jpg" };
const STRUCTURED = [
  { title: "Furadeira 500W (estruturado)", price: 210, thumbnail: "https://img/y.jpg", reviewCount: 120, rating: 4.6 },
];

beforeEach(() => {
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.mocked(fetchAmazonCandidatesForQuery).mockResolvedValue([]);
  vi.mocked(fetchGoogleShoppingCandidatesForQuery).mockResolvedValue([]);
  // Fontes oficiais/grátis vazias por padrão (equivalente a "não
  // configurado") — cada teste que quer exercitar o degrau oficial
  // sobrescreve o mock explicitamente.
  vi.mocked(fetchAmazonPaApiCandidatesForQuery).mockResolvedValue([]);
  vi.mocked(fetchMlOfficialCandidatesForQuery).mockResolvedValue([]);
  resetCandidateSourceState();
});

afterEach(() => {
  vi.resetAllMocks();
  vi.restoreAllMocks();
});

describe("fetchCandidateOffers", () => {
  it("raspagem funcionando: NÃO gasta crédito com o endpoint estruturado", async () => {
    vi.mocked(fetchStoreOffers).mockResolvedValue([
      { marketplace: "amazon", label: "Amazon", offers: [SCRAPED_OFFER] },
    ]);

    const stores = await fetchCandidateOffers("furadeira", [AMAZON_MATCHER], KEY);

    expect(stores[0].offers).toEqual([SCRAPED_OFFER]);
    expect(fetchAmazonCandidatesForQuery).not.toHaveBeenCalled();
  });

  it("raspagem devolve 0 ofertas (layout mudou): cai pro estruturado", async () => {
    vi.mocked(fetchStoreOffers).mockResolvedValue([{ marketplace: "amazon", label: "Amazon", offers: [] }]);
    vi.mocked(fetchAmazonCandidatesForQuery).mockResolvedValue(STRUCTURED);

    const stores = await fetchCandidateOffers("furadeira", [AMAZON_MATCHER], KEY);

    expect(stores[0].offers).toEqual(STRUCTURED);
  });

  it("Amazon bloqueada mas ML ok: preenche só a Amazon, sem tocar no ML", async () => {
    vi.mocked(fetchStoreOffers).mockResolvedValue([
      { marketplace: "mercadolivre", label: "Mercado Livre", offers: [SCRAPED_OFFER] },
    ]);
    vi.mocked(fetchAmazonCandidatesForQuery).mockResolvedValue(STRUCTURED);

    const stores = await fetchCandidateOffers("furadeira", [AMAZON_MATCHER, ML_MATCHER], KEY);

    expect(stores.find((s) => s.marketplace === "mercadolivre")?.offers).toEqual([SCRAPED_OFFER]);
    expect(stores.find((s) => s.marketplace === "amazon")?.offers).toEqual(STRUCTURED);
  });

  it("todas as lojas falharam, mas o estruturado respondeu: devolve o que deu, sem lançar", async () => {
    vi.mocked(fetchStoreOffers).mockRejectedValue(new Error("Amazon bloqueou a busca (403)"));
    vi.mocked(fetchAmazonCandidatesForQuery).mockResolvedValue(STRUCTURED);

    const stores = await fetchCandidateOffers("furadeira", [AMAZON_MATCHER], KEY);

    expect(stores).toHaveLength(1);
    expect(stores[0].offers).toEqual(STRUCTURED);
  });

  it("tudo falhou e o estruturado também veio vazio: propaga o erro original da raspagem", async () => {
    vi.mocked(fetchStoreOffers).mockRejectedValue(new Error("Amazon bloqueou a busca (403)"));
    vi.mocked(fetchAmazonCandidatesForQuery).mockResolvedValue([]);

    await expect(fetchCandidateOffers("furadeira", [AMAZON_MATCHER], KEY)).rejects.toThrow(/bloqueou a busca/);
  });

  it("sem chave ScraperAPI (BYOK ausente), o erro manda cadastrar em Conta — não confunde com falha de infra", async () => {
    vi.mocked(fetchStoreOffers).mockRejectedValue(new Error("Amazon bloqueou a busca (403)"));

    await expect(fetchCandidateOffers("furadeira", [AMAZON_MATCHER], undefined)).rejects.toThrow(/ScraperAPI/);
  });

  it("sem Amazon entre os marketplaces pedidos, nunca chama o endpoint da Amazon", async () => {
    vi.mocked(fetchStoreOffers).mockResolvedValue([
      { marketplace: "mercadolivre", label: "Mercado Livre", offers: [SCRAPED_OFFER] },
    ]);

    await fetchCandidateOffers("furadeira", [ML_MATCHER], KEY);

    expect(fetchAmazonCandidatesForQuery).not.toHaveBeenCalled();
  });

  it("ML raspado vazio: cai pro Google Shopping filtrado pela origem, sem link e sem vendas", async () => {
    vi.mocked(fetchStoreOffers).mockResolvedValue([
      { marketplace: "mercadolivre", label: "Mercado Livre", offers: [] },
    ]);
    vi.mocked(fetchGoogleShoppingCandidatesForQuery).mockResolvedValue([
      { title: "Furadeira no ML", price: 205, thumbnail: "https://img/ml.jpg", source: "Mercado Livre" },
      { title: "Furadeira na Shopee", price: 190, thumbnail: "https://img/sh.jpg", source: "Shopee" },
    ]);

    const stores = await fetchCandidateOffers("furadeira", [ML_MATCHER], KEY);
    const ml = stores.find((s) => s.marketplace === "mercadolivre")!;

    // Só o candidato do ML entra — o da Shopee é de outra loja.
    expect(ml.offers).toEqual([
      { title: "Furadeira no ML", price: 205, thumbnail: "https://img/ml.jpg" },
    ]);
    expect(ml.offers[0]).not.toHaveProperty("link");
  });

  it("disjuntor: depois de a loja bloquear, a raspagem não é tentada de novo no mesmo processo", async () => {
    vi.mocked(fetchStoreOffers).mockRejectedValue(new Error("Amazon bloqueou a busca (403)"));
    vi.mocked(fetchAmazonCandidatesForQuery).mockResolvedValue(STRUCTURED);

    await fetchCandidateOffers("furadeira", [AMAZON_MATCHER], KEY);
    await fetchCandidateOffers("parafusadeira", [AMAZON_MATCHER], KEY);

    // 1ª chamada tenta raspar e leva bloqueio; a 2ª já vai direto pra
    // fonte estruturada — é isso que devolve o tempo de timeout ao
    // orçamento da function.
    expect(fetchStoreOffers).toHaveBeenCalledTimes(1);
    expect(fetchAmazonCandidatesForQuery).toHaveBeenCalledTimes(2);
  });

  it("Amazon: PA-API oficial respondeu — usa direto, sem gastar crédito no estruturado de terceiro", async () => {
    vi.mocked(fetchStoreOffers).mockResolvedValue([{ marketplace: "amazon", label: "Amazon", offers: [] }]);
    vi.mocked(fetchAmazonPaApiCandidatesForQuery).mockResolvedValue(STRUCTURED);

    const stores = await fetchCandidateOffers("furadeira", [AMAZON_MATCHER], KEY);

    expect(stores[0].offers).toEqual(STRUCTURED);
    expect(fetchAmazonCandidatesForQuery).not.toHaveBeenCalled();
  });

  it("Amazon: PA-API oficial vazia (sem conta Associates configurada) — cai pro estruturado de terceiro", async () => {
    vi.mocked(fetchStoreOffers).mockResolvedValue([{ marketplace: "amazon", label: "Amazon", offers: [] }]);
    vi.mocked(fetchAmazonPaApiCandidatesForQuery).mockResolvedValue([]);
    vi.mocked(fetchAmazonCandidatesForQuery).mockResolvedValue(STRUCTURED);

    const stores = await fetchCandidateOffers("furadeira", [AMAZON_MATCHER], KEY);

    expect(stores[0].offers).toEqual(STRUCTURED);
  });

  it("ML: API oficial OAuth respondeu — usa direto, sem gastar crédito no Google Shopping estruturado", async () => {
    vi.mocked(fetchStoreOffers).mockResolvedValue([
      { marketplace: "mercadolivre", label: "Mercado Livre", offers: [] },
    ]);
    vi.mocked(fetchMlOfficialCandidatesForQuery).mockResolvedValue([STRUCTURED[0]]);

    const stores = await fetchCandidateOffers("furadeira", [ML_MATCHER], KEY);
    const ml = stores.find((s) => s.marketplace === "mercadolivre")!;

    expect(ml.offers).toEqual([STRUCTURED[0]]);
    expect(fetchGoogleShoppingCandidatesForQuery).not.toHaveBeenCalled();
  });

  it("ML: API oficial OAuth vazia (setup pendente/403 conhecido) — cai pro Google Shopping estruturado", async () => {
    vi.mocked(fetchStoreOffers).mockResolvedValue([
      { marketplace: "mercadolivre", label: "Mercado Livre", offers: [] },
    ]);
    vi.mocked(fetchMlOfficialCandidatesForQuery).mockResolvedValue([]);
    vi.mocked(fetchGoogleShoppingCandidatesForQuery).mockResolvedValue([
      { title: "Furadeira no ML", price: 205, thumbnail: "https://img/ml.jpg", source: "Mercado Livre" },
    ]);

    const stores = await fetchCandidateOffers("furadeira", [ML_MATCHER], KEY);
    const ml = stores.find((s) => s.marketplace === "mercadolivre")!;

    expect(ml.offers).toEqual([{ title: "Furadeira no ML", price: 205, thumbnail: "https://img/ml.jpg" }]);
  });

  it("candidatos do Google Shopping (fallback ML) são cacheados POR CHAVE — chave diferente não reaproveita o resultado de outra", async () => {
    vi.mocked(fetchStoreOffers).mockResolvedValue([
      { marketplace: "mercadolivre", label: "Mercado Livre", offers: [] },
    ]);
    vi.mocked(fetchGoogleShoppingCandidatesForQuery).mockResolvedValue([
      { title: "Furadeira no ML", price: 205, thumbnail: "https://img/ml.jpg", source: "Mercado Livre" },
    ]);

    await fetchCandidateOffers("furadeira", [ML_MATCHER], "chave-do-usuario-A");
    await fetchCandidateOffers("furadeira", [ML_MATCHER], "chave-do-usuario-B");

    // Mesma query, chaves DIFERENTES — sem isolar por chave, o 2º usuário
    // receberia de graça o resultado pago pelo 1º (ver comentário em
    // fetchGoogleShoppingCandidatesMemo, visionInternalSearchProvider.ts).
    expect(fetchGoogleShoppingCandidatesForQuery).toHaveBeenCalledTimes(2);
  });
});
