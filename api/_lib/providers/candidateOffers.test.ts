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
import { fetchAmazonCandidatesForQuery } from "./scraperApiSearchProvider.js";
import { fetchCandidateOffers } from "./visionInternalSearchProvider.js";

const AMAZON_MATCHER = { marketplace: "amazon", matchesSource: () => true } as unknown as MarketplaceMatcher;
const ML_MATCHER = { marketplace: "mercadolivre", matchesSource: () => true } as unknown as MarketplaceMatcher;

const SCRAPED_OFFER = { title: "Furadeira 500W", price: 199.9, thumbnail: "https://img/x.jpg" };
const STRUCTURED = [
  { title: "Furadeira 500W (estruturado)", price: 210, thumbnail: "https://img/y.jpg", reviewCount: 120, rating: 4.6 },
];

beforeEach(() => {
  vi.spyOn(console, "warn").mockImplementation(() => {});
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

  it("sem Amazon entre os marketplaces pedidos, nunca chama o endpoint da Amazon", async () => {
    vi.mocked(fetchStoreOffers).mockResolvedValue([
      { marketplace: "mercadolivre", label: "Mercado Livre", offers: [] },
    ]);

    await fetchCandidateOffers("furadeira", [ML_MATCHER]);

    expect(fetchAmazonCandidatesForQuery).not.toHaveBeenCalled();
  });
});
