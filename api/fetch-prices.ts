import type { ApiRequest, ApiResponse } from "./_lib/httpTypes";
import type { CatalogItemQuery, MarketplaceId, MarketplacePriceResult } from "./_lib/types";
import { getCachedPrices, writeCachedPrices } from "./_lib/cache";
import { getProvider, isGoogleShoppingMarketplace } from "./_lib/providers/registry";
import { GOOGLE_SHOPPING_MATCHERS, searchGoogleShoppingShared } from "./_lib/providers/googleShoppingProvider";
import { requireAuth, UnauthorizedError } from "./_lib/verifyAuth";

const VALID_MARKETPLACES: MarketplaceId[] = ["amazon", "shopee", "mercadolivre"];

interface RequestBody {
  marketplaces?: string[];
  items?: CatalogItemQuery[];
  /** BYOK — chave SerpApi própria do usuário, ver src/lib/userSecrets.ts. */
  apiKey?: string;
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

/**
 * POST /api/fetch-prices
 * Body: { marketplaces: MarketplaceId[], items: {sku, name}[], apiKey? }
 * Resposta: { [marketplace]: { [sku]: MarketplacePriceResult } }
 *
 * Aceita VÁRIOS marketplaces numa chamada só (contrato mudou de
 * `marketplace: string` singular pra `marketplaces: string[]` — ver
 * docs/architecture-review.md item 15). Marketplaces que compartilham o
 * provider Google Shopping/SerpApi (hoje: amazon + mercadolivre) fazem
 * UMA busca por produto cobrindo todos eles de uma vez, em vez de uma
 * busca por produto POR marketplace — selecionar os dois já buscava o
 * MESMO produto duas vezes na SerpApi antes desse fix, dobrando a cota
 * gasta à toa. Cache (`market_prices`) continua por marketplace: o
 * mesmo SKU pode estar em cache pra Amazon e não pra Mercado Livre (ou
 * vice-versa), então hits/misses são calculados independentemente antes
 * de decidir o que precisa buscar de novo.
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

  const marketplaces = body.marketplaces;
  const items = body.items;

  console.log(`[fetch-prices] uid=${uid} marketplaces=${marketplaces.join("+")} items=${items.length}`);

  try {
    // 1) Cache por marketplace — hits/misses independentes (ver doc acima).
    const cacheByMarketplace = new Map<
      MarketplaceId,
      { hits: Record<string, MarketplacePriceResult>; misses: string[] }
    >();
    await Promise.all(
      marketplaces.map(async (marketplace) => {
        const cached = await getCachedPrices(
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
        const fresh = await searchGoogleShoppingShared(missItems, matchers, body.apiKey);

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
            await writeCachedPrices(marketplace, fresh[marketplace] ?? {});
          } catch (cacheErr) {
            console.error(`writeCachedPrices(${marketplace}) falhou (ignorando, best-effort):`, cacheErr);
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
      const provider = getProvider(marketplace);
      const fresh = await provider.fetchPrices(missItems, body.apiKey);
      responseByMarketplace[marketplace] = { ...responseByMarketplace[marketplace], ...fresh };

      try {
        await writeCachedPrices(marketplace, fresh);
      } catch (cacheErr) {
        console.error(`writeCachedPrices(${marketplace}) falhou (ignorando, best-effort):`, cacheErr);
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
