import type { CatalogItemQuery, MarketplacePriceResult } from "../types.js";
import { mapWithConcurrency } from "../concurrency.js";
import { confidenceFromSimilarity } from "../textSimilarity.js";
import { pickBestCandidate, popularityScore } from "../rankCandidates.js";
import { buildSearchQuery } from "../searchQuery.js";

const ENDPOINT = "https://data.unwrangle.com/api/getter/";
/** Abaixo disso o match entra marcado como aproximado — mesmo critério usado nos demais providers de busca por texto. Faltava aqui antes (ago/2026). */
const APPROXIMATE_BELOW_SIMILARITY = 0.35;
// Cada busca custa 10 créditos (confirmado na doc pública,
// docs.unwrangle.com/mercado-livre-search-api) — plano mais barato é
// $99/mês por 100.000 créditos (~10.000 buscas/mês). Concorrência baixa
// só por cautela, a doc não documenta limite de taxa por segundo.
const CONCURRENCY = 3;

interface UnwrangleMlItem {
  name?: string;
  url?: string;
  thumbnail?: string;
  brand?: string;
  rating?: number;
  total_ratings?: number;
  price?: number;
  listing_price?: number | null;
  currency?: string;
}

interface UnwrangleMlResponse {
  success?: boolean;
  results?: UnwrangleMlItem[];
  total_results?: number;
  message?: string;
  error?: string;
}

/**
 * Busca de preço no Mercado Livre via Unwrangle ("Mercado Livre Search
 * API") — alternativa PAGA ao endpoint público
 * (mercadoLivreDirectProvider.ts), que vem apresentando HTTP 403
 * intermitente desde fev/2026 sem explicação oficial do Mercado Livre.
 *
 * Diferente dos outros providers "diretos" (não aparece no seletor
 * normal de API em Dashboard.tsx): só é oferecida como "tentar de novo
 * com sua chave" quando a busca pública falha E o usuário já cadastrou
 * a própria chave Unwrangle em Conta (BYOK, campo `unwrangleApiKey`,
 * ver userSecrets.ts) — ver fluxo de fallback em Dashboard.tsx.
 *
 * Shape da resposta confirmado direto na documentação pública
 * (docs.unwrangle.com/mercado-livre-search-api, com exemplo real de
 * resposta): `results[]` com `name`, `price`, `rating`, `total_ratings`,
 * `thumbnail`, `url`. Sem token/OAuth — só `api_key` na query string,
 * bem mais simples que a via oficial (mlAuth.ts), que esbarra em
 * validação de titularidade no DevCenter do Mercado Livre.
 */
export async function fetchUnwrangleMercadoLivrePrices(
  items: CatalogItemQuery[],
  userApiKey?: string
): Promise<Record<string, MarketplacePriceResult>> {
  const apiKey = userApiKey?.trim();
  if (!apiKey) {
    throw new Error(
      "Nenhuma chave Unwrangle própria configurada. Cadastre a sua em Conta antes de usar a alternativa ao Mercado Livre público."
    );
  }

  const results: Record<string, MarketplacePriceResult> = {};
  let lastApiError: string | null = null;
  let errorCount = 0;

  await mapWithConcurrency(items, CONCURRENCY, async ({ sku, name }) => {
    try {
      const url = new URL(ENDPOINT);
      url.searchParams.set("platform", "mercado_search");
      // Query limpa (ver searchQuery.ts) — ranking abaixo compara contra
      // `name` original, só a busca em si usa a versão sem ruído.
      url.searchParams.set("search", buildSearchQuery(name));
      url.searchParams.set("api_key", apiKey);

      const response = await fetch(url.toString());
      if (!response.ok) {
        errorCount++;
        lastApiError =
          response.status === 401 || response.status === 403
            ? "Unwrangle recusou a chave (HTTP " +
              response.status +
              ") — confira se ela está correta em console.unwrangle.com."
            : `Unwrangle retornou HTTP ${response.status}`;
        console.warn(`Unwrangle ML "${name}" (${sku}) retornou ${response.status}`);
        return;
      }

      const data = (await response.json()) as UnwrangleMlResponse;
      if (data.error || data.success === false) {
        errorCount++;
        lastApiError = data.error || data.message || "Erro desconhecido da Unwrangle";
        console.warn(`Unwrangle ML "${name}" (${sku}): ${lastApiError}`);
        return;
      }

      const candidates = (data.results ?? []).filter(
        (r) => r.name && typeof r.price === "number"
      );
      if (candidates.length === 0) return;

      const ranked = pickBestCandidate(
        name,
        candidates,
        (c) => c.name ?? "",
        (c) => popularityScore(c.total_ratings, c.rating)
      );
      if (!ranked || typeof ranked.candidate.price !== "number") return;

      results[sku] = {
        marketplace: "mercadolivre",
        sku,
        price: ranked.candidate.price,
        competitorCount: Math.max(0, candidates.length - 1),
        buyBoxEligible: true,
        confidence: confidenceFromSimilarity(ranked.similarity),
        link: ranked.candidate.url,
        matchedTitle: ranked.candidate.name,
        imageUrl: ranked.candidate.thumbnail,
        approximate: ranked.similarity < APPROXIMATE_BELOW_SIMILARITY,
        // Popularidade do anúncio escolhido — já pesava no desempate
        // (popularityScore acima), agora também chega à tela.
        reviewCount: ranked.candidate.total_ratings,
        rating: ranked.candidate.rating,
      };
    } catch (err) {
      errorCount++;
      lastApiError = err instanceof Error ? err.message : String(err);
      console.error(`Unwrangle ML falhou pra "${name}":`, err);
    }
  });

  if (items.length > 0 && errorCount === items.length && lastApiError) {
    throw new Error(lastApiError);
  }

  return results;
}
