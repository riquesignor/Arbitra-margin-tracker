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
import { searchSearchApiLensShared } from "./_lib/providers/searchApiLensProvider.js";
import { searchInternalShared } from "./_lib/providers/internalSearchProvider.js";
import { searchVisionInternalShared } from "./_lib/providers/visionInternalSearchProvider.js";
import { fetchRapidApiAmazonPrices } from "./_lib/providers/rapidApiAmazonProvider.js";
import { fetchMercadoLivreDirectPrices } from "./_lib/providers/mercadoLivreDirectProvider.js";
import { fetchUnwrangleMercadoLivrePrices } from "./_lib/providers/unwrangleMercadoLivreProvider.js";
import { requireAuth, UnauthorizedError } from "./_lib/verifyAuth.js";

const VALID_MARKETPLACES: MarketplaceId[] = ["amazon", "shopee", "mercadolivre"];
const VALID_PROVIDERS: SearchProviderId[] = [
  "internal_search",
  "serpapi",
  "rapidapi_amazon",
  "mercadolivre_direct",
  "mercadolivre_alt",
  "google_lens_products",
  "searchapi_lens",
  "vision_internal",
];

// Providers que só cobrem UM marketplace fixo cada — ver
// SearchProviderId em _lib/types.ts. "serpapi", "google_lens_products" e
// "searchapi_lens" NÃO entram aqui: os três cobrem amazon+mercadolivre
// numa busca só (dois insumos possíveis — nome em texto ou foto do
// produto — e dois vendors pro insumo foto) — ver branch "shared" mais
// abaixo. "mercadolivre_alt" é a alternativa PAGA (Unwrangle) ao
// endpoint público — mesmo grupo "direto" que "mercadolivre_direct",
// só muda o vendor por trás; não aparece no seletor normal (ver
// Dashboard.tsx), só no fluxo de fallback quando o público falha.
type DirectProvider = "rapidapi_amazon" | "mercadolivre_direct" | "mercadolivre_alt";
const DIRECT_PROVIDER_MARKETPLACE: Record<DirectProvider, MarketplaceId> = {
  rapidapi_amazon: "amazon",
  mercadolivre_direct: "mercadolivre",
  mercadolivre_alt: "mercadolivre",
};
function isDirectProvider(p: SearchProviderId): p is DirectProvider {
  return p === "rapidapi_amazon" || p === "mercadolivre_direct" || p === "mercadolivre_alt";
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
 *   - "serpapi", "internal_search", "google_lens_products",
 *     "searchapi_lens" e "vision_internal" aceitam VÁRIOS marketplaces
 *     numa chamada só (contrato mudou de `marketplace: string` singular
 *     pra `marketplaces: string[]` — ver docs/architecture-review.md item
 *     15): amazon + mercadolivre numa busca só por produto, em vez de uma
 *     busca por produto POR marketplace. Os cinco só diferem no
 *     INSUMO/vendor — nome em texto (SerpApi/Google Shopping ou motor
 *     interno) ou foto do produto via `item.imageUrl` (Google Lens por
 *     SerpApi, por SearchApi.io, ou motor interno + IA via Gemini —
 *     `apiKey` muda de significado conforme o provider: chave
 *     SerpApi/SearchApi.io nos dois primeiros, chave Gemini em
 *     "vision_internal") — não em quantos marketplaces cobrem.
 *   - "rapidapi_amazon", "mercadolivre_direct" e "mercadolivre_alt" só
 *     cobrem UM marketplace fixo cada (ver DIRECT_PROVIDER_MARKETPLACE) —
 *     branch separado logo no início do handler, mais simples que o
 *     caminho compartilhado. "mercadolivre_alt" (Unwrangle, BYOK) é a
 *     alternativa paga oferecida só quando "mercadolivre_direct" falha —
 *     ver fluxo de fallback em Dashboard.tsx.
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
  // Default virou o motor interno (ago/2026): é o único sem custo por
  // busca e sem chave, então é o comportamento certo pra quem não
  // escolheu nada explicitamente. Antes era "serpapi", que falhava de
  // cara sem BYOK configurado.
  const provider: SearchProviderId = isValidProvider(body.provider) ? body.provider : "internal_search";

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
            : provider === "mercadolivre_alt"
              ? await fetchUnwrangleMercadoLivrePrices(missItems, body.apiKey)
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

    // Aviso de bloqueio PARCIAL do motor interno (ver
    // internalSearchProvider.ts > BLOCK_WARNING_RATIO) — só o
    // "internal_search" preenche isto; fica `undefined` pros demais
    // providers. Declarado no escopo da função pra sobreviver até o
    // `res.status(200).json(...)` final, mesmo sendo atribuído dentro do
    // bloco de busca compartilhada mais abaixo.
    let internalSearchWarning: string | undefined;

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
        // texto (SerpApi/Shopping) ou por foto — e por foto ainda tem 2
        // vendors possíveis (SerpApi vs SearchApi.io, ver
        // IMAGE_SEARCH_PROVIDERS acima) — ver comentário no topo do arquivo.
        const fresh =
          provider === "internal_search"
            ? // Motor próprio: sem `apiKey` de propósito — não existe
              // chave, é a característica que justifica ele existir (ver
              // internalSearchProvider.ts). Devolve `{results, warning}`
              // (ago/2026) — bloqueio PARCIAL de uma loja (nem todo
              // produto falhou, então não vira exceção) precisa chegar
              // até a UI, senão fica indistinguível de "sem match".
              await searchInternalShared(missItems, matchers).then((outcome) => {
                internalSearchWarning = outcome.warning;
                return outcome.results;
              })
            : provider === "vision_internal"
              ? // Motor interno + IA: `apiKey` aqui é a chave GEMINI do
                // usuário (BYOK), não SerpApi/SearchApi.io — ver
                // visionInternalSearchProvider.ts. `.then(...)` extrai o
                // warning de cota esgotada (ago/2026) pro mesmo canal
                // `internalSearchWarning` usado pelo motor interno puro —
                // mesmo formato de saída, `_warning` não distingue a origem
                // porque a UI só precisa mostrar o aviso, não a causa exata.
                await searchVisionInternalShared(missItems, matchers, body.apiKey).then((outcome) => {
                  internalSearchWarning = outcome.warning;
                  return outcome.results;
                })
              : provider === "google_lens_products"
                ? await searchGoogleLensProductsShared(missItems, matchers, body.apiKey)
                : provider === "searchapi_lens"
                  ? await searchSearchApiLensShared(missItems, matchers, body.apiKey)
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

    // `_warning` é aditivo — não é um marketplace, então o cliente antigo
    // (que só lê chaves de marketplace conhecidas, ver priceApi.ts)
    // ignora sem quebrar; o cliente novo lê e mostra no banner de aviso
    // (ver Dashboard.tsx > finishWithRows).
    res.status(200).json(
      internalSearchWarning
        ? { ...responseByMarketplace, _warning: internalSearchWarning }
        : responseByMarketplace
    );
  } catch (err) {
    res.status(502).json({
      error: "Busca de preço indisponível",
      detail: err instanceof Error ? err.message : String(err),
    });
  }
}
