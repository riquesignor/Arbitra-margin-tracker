import type { CatalogItemQuery, MarketplacePriceResult } from "../types.js";
import { mapWithConcurrency } from "../concurrency.js";
import { confidenceFromSimilarity } from "../textSimilarity.js";
import { pickBestCandidate, popularityScore } from "../rankCandidates.js";
import { resolveSearchQuery } from "../searchQuery.js";

const ENDPOINT = "https://api.mercadolibre.com/sites/MLB/search";
const CONCURRENCY = 3;

/** Abaixo disso o match entra marcado como aproximado — mesmo critério usado em internalSearchProvider.ts/googleShoppingProvider.ts (a busca foi feita PELO NOME, então o título tem que bater de verdade). Faltava aqui antes (ago/2026): este provider era o único devolvendo resultado sem NUNCA marcar aproximado, mesmo quando o match era fraco. */
const APPROXIMATE_BELOW_SIMILARITY = 0.35;

interface MLSearchItem {
  id?: string;
  title?: string;
  price?: number;
  permalink?: string;
  available_quantity?: number;
  sold_quantity?: number;
  thumbnail?: string;
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

  await mapWithConcurrency(items, CONCURRENCY, async ({ sku, name, ean }) => {
    try {
      const url = new URL(ENDPOINT);
      // EAN/GTIN quando disponível e válido, senão nome limpo (ver
      // searchQuery.ts) — ranking abaixo compara contra `name` original
      // sempre, só a busca em si usa EAN/versão sem ruído.
      url.searchParams.set("q", resolveSearchQuery({ name, ean }));

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

      // Entre os candidatos com similaridade próxima do melhor match,
      // prioriza o mais "famoso" — pra Mercado Livre o sinal de fama
      // disponível é `sold_quantity` (vendas), não avaliações. Ver
      // rankCandidates.ts.
      const ranked = pickBestCandidate(
        name,
        candidates,
        (c) => c.title!,
        (c) => popularityScore(c.sold_quantity, null)
      );
      if (!ranked || typeof ranked.candidate.price !== "number") return;
      const best = ranked.candidate;
      const price = ranked.candidate.price;

      results[sku] = {
        marketplace: "mercadolivre",
        sku,
        price,
        competitorCount: Math.max(0, candidates.length - 1),
        buyBoxEligible: true,
        confidence: confidenceFromSimilarity(ranked.similarity),
        link: best.permalink,
        matchedTitle: best.title,
        imageUrl: best.thumbnail,
        approximate: ranked.similarity < APPROXIMATE_BELOW_SIMILARITY,
        // No ML o sinal disponível é VENDA, não avaliação (ver
        // popularityScore acima) — vai no mesmo campo `reviewCount`, e a
        // UI rotula por marketplace ("vendidos" x "avaliações").
        reviewCount: best.sold_quantity,
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
