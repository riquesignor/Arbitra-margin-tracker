import type { CatalogItemQuery, MarketplacePriceResult } from "../types";
import { mapWithConcurrency } from "../concurrency";
import { confidenceFromSimilarity, textSimilarity } from "../textSimilarity";

const ENDPOINT = "https://api.mercadolibre.com/sites/MLB/search";
const CONCURRENCY = 3;

interface MLSearchItem {
  id?: string;
  title?: string;
  price?: number;
  permalink?: string;
  available_quantity?: number;
  sold_quantity?: number;
}

interface MLSearchResponse {
  results?: MLSearchItem[];
  paging?: { total?: number };
  message?: string;
  error?: string;
}

/**
 * Busca de preço direto no Mercado Livre — endpoint PÚBLICO de busca
 * (`/sites/MLB/search`), sem chave, sem OAuth. É a via "grátis de
 * verdade" pedida pra Mercado Livre, mas com uma ressalva importante:
 *
 * A partir de fev/2026 há múltiplos relatos (Reclame Aqui) de HTTP 403
 * nesse endpoint especificamente — mesmo com token OAuth válido e outros
 * endpoints da API funcionando normalmente. Não há comunicação oficial
 * do Mercado Livre sobre o motivo (conta, escopo, IP, allowlist — não
 * está documentado). Por isso: NENHUM fallback silencioso pro mock
 * aqui — se vier 403, o erro é propagado com essa explicação, em vez de
 * mostrar "nenhum resultado" genérico como se o catálogo é que não
 * tivesse match. Ver também a via OAuth registrada (parked) em
 * mercadoLivreSearchProvider.ts e o comentário em registry.ts.
 */
export async function fetchMercadoLivreDirectPrices(
  items: CatalogItemQuery[]
): Promise<Record<string, MarketplacePriceResult>> {
  const results: Record<string, MarketplacePriceResult> = {};
  let lastApiError: string | null = null;
  let errorCount = 0;

  await mapWithConcurrency(items, CONCURRENCY, async ({ sku, name }) => {
    try {
      const url = new URL(ENDPOINT);
      url.searchParams.set("q", name);

      const response = await fetch(url.toString());

      if (!response.ok) {
        errorCount++;
        lastApiError =
          response.status === 403
            ? "Mercado Livre bloqueou a busca pública (HTTP 403) — instabilidade conhecida " +
              "desse endpoint específico desde fev/2026, sem explicação oficial do Mercado Livre " +
              "(afeta contas com e sem token OAuth). Não é um problema do seu catálogo nem da " +
              "sua chave — tente novamente mais tarde ou use SerpApi enquanto isso."
            : `Mercado Livre retornou HTTP ${response.status}`;
        console.warn(`Mercado Livre direto "${name}" (${sku}) retornou ${response.status}`);
        return;
      }

      const data = (await response.json()) as MLSearchResponse;
      if (data.error || data.message) {
        errorCount++;
        lastApiError = data.error || data.message || "Erro desconhecido do Mercado Livre";
        console.warn(`Mercado Livre direto "${name}" (${sku}): ${lastApiError}`);
        return;
      }

      const candidates = (data.results ?? []).filter((r) => r.title && typeof r.price === "number");
      if (candidates.length === 0) return;

      let best = candidates[0];
      let bestSimilarity = textSimilarity(name, best.title!);
      for (const candidate of candidates.slice(1)) {
        const similarity = textSimilarity(name, candidate.title!);
        if (similarity > bestSimilarity) {
          best = candidate;
          bestSimilarity = similarity;
        }
      }
      if (typeof best.price !== "number") return;

      results[sku] = {
        marketplace: "mercadolivre",
        sku,
        price: best.price,
        competitorCount: Math.max(0, candidates.length - 1),
        buyBoxEligible: true,
        confidence: confidenceFromSimilarity(bestSimilarity),
        link: best.permalink,
        matchedTitle: best.title,
      };
    } catch (err) {
      errorCount++;
      lastApiError = err instanceof Error ? err.message : String(err);
      console.error(`Mercado Livre direto falhou pra "${name}":`, err);
    }
  });

  if (items.length > 0 && errorCount === items.length && lastApiError) {
    throw new Error(lastApiError);
  }

  return results;
}
