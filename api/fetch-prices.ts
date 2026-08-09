import type { ApiRequest, ApiResponse } from "./_lib/httpTypes.js";
import type {
  CatalogItemQuery,
  MarketplaceId,
  MarketplacePriceResult,
  SearchProviderId,
} from "./_lib/types.js";
import { getCachedPrices, writeCachedPrices } from "./_lib/cache.js";
import { getProvider, isGoogleShoppingMarketplace } from "./_lib/providers/registry.js";
import { GOOGLE_SHOPPING_MATCHERS, searchGoogleShoppingShared } from "./_lib/providers/googleShoppingProvider.js";
import { searchGoogleLensProductsShared } from "./_lib/providers/googleLensProvider.js";
import { fetchRapidApiAmazonPrices } from "./_lib/providers/rapidApiAmazonProvider.js";
import { fetchMercadoLivreDirectPrices } from "./_lib/providers/mercadoLivreDirectProvider.js";
import { requireAuth, UnauthorizedError } from "./_lib/verifyAuth.js";

const VALID_MARKETPLACES: MarketplaceId[] = ["amazon", "shopee", "mercadolivre"];
const VALID_PROVIDERS: SearchProviderId[] = [
  "serpapi",
  "rapidapi_amazon",
  "mercadolivre_direct",
  "google_lens_products",
];

// Providers que só cobrem UM marketplace fixo cada — ver
// SearchProviderId em _lib/types.ts. "serpapi" e "google_lens_products"
// NÃO entram aqui: os dois cobrem amazon+mercadolivre numa busca só,
// só mudando o insumo (nome em texto vs. foto do produto) — ver branch
// "shared" mais abaixo.
type DirectProvider = "rapidapi_amazon" | "mercadolivre_direct";
const DIRECT_PROVIDER_MARKETPLACE: Record<DirectProvider, MarketplaceId> = {
  rapidapi_amazon: "amazon",
  mercadolivre_direct: "mercadolivre",
};
function isDirectProvider(p: SearchProviderId): p is DirectProvider {
  return p === "rapidapi_amazon" || p === "mercadolivre_direct";
}

interface RequestBody {
  marketplaces?: string[];
  items?: CatalogItemQuery[];
  /** BYOK — chave própria do usuário (SerpApi OU RapidAPI, depende de `provider`). */
  apiKey?: string;
  /** Qual API de busca usar — default "serpapi" pra manter compatibilidade. */
  provider?: string;
}

function isValidMarketplaces(value: unknown): value is MarketplaceId[] {
  return (
    Array.isArray(value) &&
    value.length > 0 &&
    value.every((v) => typeof v === "string" && (VALID_MARKETPLACES as string[]).includes(v))
  );
}

function isValidItems(value: unknown): value is CatalogItemQuery[] {
  return (
    Array.isArray(value) &&
    value.length > 0 &&
    value.every((v) => typeof v?.sku === "string" && typeof v?.name === "string")
  );
}

function isValidProvider(value: unknown): value is SearchProviderId {
  return typeof value === "string" && (VALID_PROVIDERS as string[]).includes(value);
}

/**
 * POST /api/fetch-prices
 * Body: { marketplaces: MarketplaceId[], items: {sku, name}[], apiKey?, provider? }
 * Resposta: { [marketplace]: { [sku]: MarketplacePriceResult } }
 *
 * `provider` (default "serpapi", ver SearchProviderId em _lib/types.ts)
 * escolhe QUAL API resolve o preço, eixo independente de `marketplaces`:
 *   - "serpapi" e "google_lens_products" aceitam VÁRIOS marketplaces
 *     numa chamada só (contrato mudou de `marketplace: string` singular
 *     pra `marketplaces: string[]` — ver docs/architecture-review.md
 *     item 15): amazon + mercadolivre numa busca só por produto, em vez
 *     de uma busca por produto POR marketplace. Os dois só diferem no
 *     INSUMO — nome em texto (SerpApi/Google Shopping) ou foto do
 *     produto (Google Lens, via `item.imageUrl`) — não em quantos
 *     marketplaces cobrem.
 *   - "rapidapi_amazon" e "mercadolivre_direct" só cobrem UM marketplace
 *     fixo cada (ver DIRECT_PROVIDER_MARKETPLACE) — branch separado logo
 *     no início do handler, mais simples que o caminho compartilhado.
 * Cache (`market_prices`) é por provider+marketplace: o mesmo SKU pode
 * estar em cache pra "serpapi/amazon" e não pra "rapidapi_amazon/amazon"
 * (fontes diferentes, preços podem divergir) — ver cache.ts.
 */
export default async function handler(req: ApiRequest, res: ApiResponse): Promise<void> {
  if (req.method !== "POST") {
    res.status(405).json({ error: "Método não permitido" });
    return;
  }

  // Autenticação obrigatória — ver docs/architecture-review.md > Segurança.
  let uid: string;
  try {
    uid = await requireAuth(req);
  } catch (err) {
    if (err instanceof UnauthorizedError) {
      res.status(401).json({ error: err.message });
      return;
    }
    throw err;
  }

  const body = req.body as RequestBody;

  if (!isValidMarketplaces(body?.marketplaces)) {
    res.status(400).json({ error: "marketplaces deve ser um array não vazio de marketplaces válidos" });
    return;
  }
  if (!isValidItems(body.items)) {
    res.status(400).json({ error: "items deve ser um array não vazio de {sku, name}" });
    return;
  }
  if (body.provider !== undefined && !isValidProvider(body.provider)) {
    res.status(400).json({ error: `provider inválido: ${VALID_PROVIDERS.join(" | ")}` });
    return;
  }

  const marketplaces = body.marketplaces;
  const items = body.items;
  const provider: SearchProviderId = isValidProvider(body.provider) ? body.provider : "serpapi";

  console.log(
    `[fetch-prices] uid=${uid} provider=${provider} marketplaces=${marketplaces.join("+")} items=${items.length}`
  );

  // Providers "diretos" só cobrem 1 marketplace fixo — branch isolado,
  // sem passar pela lógica de busca compartilhada abaixo (que serve
  // "serpapi" e "google_lens_products", os dois multi-marketplace).
  if (isDirectProvider(provider)) {
    const expectedMarketplace = DIRECT_PROVIDER_MARKETPLACE[provider];
    if (marketplaces.length !== 1 || marketplaces[0] !== expectedMarketplace) {
      res.status(400).json({
        error:
          `O provider "${provider}" só busca o marketplace "${expectedMarketplace}" — ` +
          `envie marketplaces: ["${expectedMarketplace}"]`,
      });
      return;
    }

    try {
      const cached = await getCachedPrices(
        uid,
        provider,
        expectedMarketplace,
        items.map((i) => i.sku)
      );
      const missItems = items.filter((i) => cached.misses.includes(i.sku));

      let fresh: Record<string, MarketplacePriceResult> = {};
      if (missItems.length > 0) {
        fresh =
          provider === "rapidapi_amazon"
            ? await fetchRapidApiAmazonPrices(missItems, body.apiKey)
            : await fetchMercadoLivreDirectPrices(missItems);

        try {
          await writeCachedPrices(uid, provider, expectedMarketplace, fresh);
        } catch (cacheErr) {
          console.error(
            `writeCachedPrices(${provider}/${expectedMarketplace}) falhou (ignorando, best-effort):`,
            cacheErr
          );
        }
      }

      res.status(200).json({ [expectedMarketplace]: { ...cached.hits, ...fresh } });
    } catch (err) {
      res.status(502).json({
        error: "Busca de preço indisponível",
        detail: err instanceof Error ? err.message : String(err),
      });
    }
    return;
  }

  try {
    // 1) Cache por marketplace — hits/misses independentes (ver doc acima).
    const cacheByMarketplace = new Map<
      MarketplaceId,
      { hits: Record<string, MarketplacePriceResult>; misses: string[] }
    >();
    await Promise.all(
      marketplaces.map(async (marketplace) => {
        const cached = await getCachedPrices(
          uid,
          provider,
          marketplace,
          items.map((i) => i.sku)
        );
        cacheByMarketplace.set(marketplace, cached);
      })
    );

    const responseByMarketplace: Record<string, Record<string, MarketplacePriceResult>> = {};
    for (const marketplace of marketplaces) {
      responseByMarketplace[marketplace] = { ...cacheByMarketplace.get(marketplace)!.hits };
    }

    // 2) Marketplaces do grupo Google Shopping: 1 busca por produto
    // cobrindo a UNIÃO dos misses de todos eles.
    const sharedMarketplaces = marketplaces.filter(isGoogleShoppingMarketplace);
    if (sharedMarketplaces.length > 0) {
      const missedSkus = new Set<string>();
      for (const m of sharedMarketplaces) {
        for (const sku of cacheByMarketplace.get(m)!.misses) missedSkus.add(sku);
      }
      const missItems = items.filter((i) => missedSkus.has(i.sku));

      if (missItems.length > 0) {
        const matchers = GOOGLE_SHOPPING_MATCHERS.filter((g) => sharedMarketplaces.includes(g.marketplace));
        // Mesmo grupo de marketplaces, upstream diferente: busca por
        // texto (SerpApi/Shopping) ou por foto (Google Lens) — ver
        // comentário no topo do arquivo.
        const fresh =
          provider === "google_lens_products"
            ? await searchGoogleLensProductsShared(missItems, matchers, body.apiKey)
            : await searchGoogleShoppingShared(missItems, matchers, body.apiKey);

        for (const marketplace of sharedMarketplaces) {
          const misses = new Set(cacheByMarketplace.get(marketplace)!.misses);
          const freshForThisMarketplace: Record<string, MarketplacePriceResult> = {};
          for (const [sku, value] of Object.entries(fresh[marketplace] ?? {})) {
            if (misses.has(sku)) freshForThisMarketplace[sku] = value;
          }
          responseByMarketplace[marketplace] = {
            ...responseByMarketplace[marketplace],
            ...freshForThisMarketplace,
          };

          // Best-effort: grava tudo que a busca compartilhada achou pra
          // esse marketplace, mesmo o que não era miss dele agora — só
          // adianta cache pra próxima consulta.
          try {
            await writeCachedPrices(uid, provider, marketplace, fresh[marketplace] ?? {});
          } catch (cacheErr) {
            console.error(`writeCachedPrices(${provider}/${marketplace}) falhou (ignorando, best-effort):`, cacheErr);
          }
        }
      }
    }

    // 3) Marketplaces fora do grupo Google Shopping — caminho antigo,
    // um ServerPriceProvider próprio por marketplace (nenhum registrado
    // hoje, mas a extensibilidade da ADR-0001 continua valendo).
    const otherMarketplaces = marketplaces.filter((m) => !sharedMarketplaces.includes(m));
    for (const marketplace of otherMarketplaces) {
      const misses = cacheByMarketplace.get(marketplace)!.misses;
      if (misses.length === 0) continue;

      const missItems = items.filter((i) => misses.includes(i.sku));
      const registeredProvider = getProvider(marketplace);
      const fresh = await registeredProvider.fetchPrices(missItems, body.apiKey);
      responseByMarketplace[marketplace] = { ...responseByMarketplace[marketplace], ...fresh };

      try {
        await writeCachedPrices(uid, provider, marketplace, fresh);
      } catch (cacheErr) {
        console.error(`writeCachedPrices(${provider}/${marketplace}) falhou (ignorando, best-effort):`, cacheErr);
      }
    }

    res.status(200).json(responseByMarketplace);
  } catch (err) {
    res.status(502).json({
      error: "Busca de preço indisponível",
      detail: err instanceof Error ? err.message : String(err),
    });
  }
}
