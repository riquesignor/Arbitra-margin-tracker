import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { MarketplaceMatcher } from "./googleShoppingProvider.js";

/**
 * Rede de segurança da fonte de candidatos (set/2026): a raspagem
 * continua sendo a fonte primária e o endpoint estruturado da Amazon só
 * entra quando ela não trouxe nada — cada chamada dele custa 5 créditos,
 * então "quando não trouxe nada" precisa ser verdade de verdade.
 */
vi.mock("./internalSearchProvider.js", () => ({
  fetchStoreOffers: vi.fn(),
}));
vi.mock("./scraperApiSearchProvider.js", () => ({
  fetchAmazonCandidatesForQuery: vi.fn(),
  fetchGoogleShoppingCandidatesForQuery: vi.fn(),
}));

import { fetchStoreOffers } from "./internalSearchProvider.js";
import {
  fetchAmazonCandidatesForQuery,
  fetchGoogleShoppingCandidatesForQuery,
} from "./scraperApiSearchProvider.js";
import { fetchCandidateOffers, resetCandidateSourceState } from "./visionInternalSearchProvider.js";

const ORIGINAL_SCRAPERAPI_KEY = process.env.SCRAPERAPI_KEY;

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
  // Chave presente por padrão: o cenário normal de produção é ter proxy
  // configurado. O caso "sem chave" tem teste próprio.
  process.env.SCRAPERAPI_KEY = "chave-de-teste";
  resetCandidateSourceState();
});

afterEach(() => {
  if (ORIGINAL_SCRAPERAPI_KEY === undefined) delete process.env.SCRAPERAPI_KEY;
  else process.env.SCRAPERAPI_KEY = ORIGINAL_SCRAPERAPI_KEY;
  vi.resetAllMocks();
  vi.restoreAllMocks();
});

describe("fetchCandidateOffers", () => {
  it("raspagem funcionando: NÃO gasta crédito com o endpoint estruturado", async () => {
    vi.mocked(fetchStoreOffers).mockResolvedValue([
      { marketplace: "amazon", label: "Amazon", offers: [SCRAPED_OFFER] },
    ]);

    const stores = await fetchCandidateOffers("furadeira", [AMAZON_MATCHER]);

    expect(stores[0].offers).toEqual([SCRAPED_OFFER]);
    expect(fetchAmazonCandidatesForQuery).not.toHaveBeenCalled();
  });

  it("raspagem devolve 0 ofertas (layout mudou): cai pro estruturado", async () => {
    vi.mocked(fetchStoreOffers).mockResolvedValue([{ marketplace: "amazon", label: "Amazon", offers: [] }]);
    vi.mocked(fetchAmazonCandidatesForQuery).mockResolvedValue(STRUCTURED);

    const stores = await fetchCandidateOffers("furadeira", [AMAZON_MATCHER]);

    expect(stores[0].offers).toEqual(STRUCTURED);
  });

  it("Amazon bloqueada mas ML ok: preenche só a Amazon, sem tocar no ML", async () => {
    vi.mocked(fetchStoreOffers).mockResolvedValue([
      { marketplace: "mercadolivre", label: "Mercado Livre", offers: [SCRAPED_OFFER] },
    ]);
    vi.mocked(fetchAmazonCandidatesForQuery).mockResolvedValue(STRUCTURED);

    const stores = await fetchCandidateOffers("furadeira", [AMAZON_MATCHER, ML_MATCHER]);

    expect(stores.find((s) => s.marketplace === "mercadolivre")?.offers).toEqual([SCRAPED_OFFER]);
    expect(stores.find((s) => s.marketplace === "amazon")?.offers).toEqual(STRUCTURED);
  });

  it("todas as lojas falharam, mas o estruturado respondeu: devolve o que deu, sem lançar", async () => {
    vi.mocked(fetchStoreOffers).mockRejectedValue(new Error("Amazon bloqueou a busca (403)"));
    vi.mocked(fetchAmazonCandidatesForQuery).mockResolvedValue(STRUCTURED);

    const stores = await fetchCandidateOffers("furadeira", [AMAZON_MATCHER]);

    expect(stores).toHaveLength(1);
    expect(stores[0].offers).toEqual(STRUCTURED);
  });

  it("tudo falhou e o estruturado também veio vazio: propaga o erro original da raspagem", async () => {
    vi.mocked(fetchStoreOffers).mockRejectedValue(new Error("Amazon bloqueou a busca (403)"));
    vi.mocked(fetchAmazonCandidatesForQuery).mockResolvedValue([]);

    await expect(fetchCandidateOffers("furadeira", [AMAZON_MATCHER])).rejects.toThrow(/bloqueou a busca/);
  });

  it("sem SCRAPERAPI_KEY, o erro diz o que CHECAR — não manda trocar de mecanismo", async () => {
    delete process.env.SCRAPERAPI_KEY;
    vi.mocked(fetchStoreOffers).mockRejectedValue(new Error("Amazon bloqueou a busca (403)"));

    await expect(fetchCandidateOffers("furadeira", [AMAZON_MATCHER])).rejects.toThrow(/SCRAPERAPI_KEY/);
  });

  it("sem Amazon entre os marketplaces pedidos, nunca chama o endpoint da Amazon", async () => {
    vi.mocked(fetchStoreOffers).mockResolvedValue([
      { marketplace: "mercadolivre", label: "Mercado Livre", offers: [SCRAPED_OFFER] },
    ]);

    await fetchCandidateOffers("furadeira", [ML_MATCHER]);

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

    const stores = await fetchCandidateOffers("furadeira", [ML_MATCHER]);
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

    await fetchCandidateOffers("furadeira", [AMAZON_MATCHER]);
    await fetchCandidateOffers("parafusadeira", [AMAZON_MATCHER]);

    // 1ª chamada tenta raspar e leva bloqueio; a 2ª já vai direto pra
    // fonte estruturada — é isso que devolve o tempo de timeout ao
    // orçamento da function.
    expect(fetchStoreOffers).toHaveBeenCalledTimes(1);
    expect(fetchAmazonCandidatesForQuery).toHaveBeenCalledTimes(2);
  });
});
