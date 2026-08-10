import type { CatalogItemQuery, MarketplacePriceResult } from "../types.js";
import { mapWithConcurrency } from "../concurrency.js";
import { confidenceFromSimilarity } from "../textSimilarity.js";
import { pickBestCandidate, popularityScore } from "../rankCandidates.js";
import { GOOGLE_SHOPPING_MATCHERS, type MarketplaceMatcher } from "./googleShoppingProvider.js";

const ENDPOINT = "https://www.searchapi.io/api/v1/search";
const CONCURRENCY = 2; // mesmo motivo de cautela de throughput da SerpApi — ver googleShoppingProvider.ts

interface SearchApiLensPrice {
  value?: string;
  extracted_value?: number;
  currency?: string;
}

interface SearchApiLensMatch {
  title?: string;
  link?: string;
  source?: string;
  price?: SearchApiLensPrice;
  in_stock?: boolean;
  rating?: number;
  reviews?: number;
  thumbnail?: string;
}

interface SearchApiLensResponse {
  visual_matches?: SearchApiLensMatch[];
  error?: string;
}

/**
 * Busca de preço por FOTO — SearchApi.io, `engine=google_lens` (mesmo
 * parâmetro da SerpApi, confirmado na doc pública searchapi.io/docs/
 * google-lens: `?engine=google_lens&url=<imagem>&api_key=<chave>`).
 * Existe como SEGUNDA fonte de busca por imagem, vendor diferente da
 * SerpApi (googleLensProvider.ts) — mesma ideia de redundância que
 * "rapidapi_amazon" dá pra Amazon: se a SerpApi estiver sem cota ou fora
 * do ar, esta aqui continua funcionando com uma chave/cota própria e
 * independente (BYOK, campo `searchApiKey`, ver userSecrets.ts).
 *
 * SearchApi.io espelha o mesmo motor (Google Lens) que a SerpApi, então
 * o shape de `visual_matches[]` documentado é equivalente — `rating` e
 * `reviews` foram confirmados presentes na doc pública ao lado de
 * `price`/`in_stock`, mas como qualquer integração de terceiro (mesma
 * ressalva já feita em rapidApiAmazonProvider.ts) vale conferir contra
 * uma resposta real assim que tiver uma chave e ajustar se algum campo
 * tiver mudado.
 *
 * Reaproveita os mesmos `GOOGLE_SHOPPING_MATCHERS` (amazon/mercado) pra
 * filtrar `source` — mesmo critério "essa loja é a Amazon/Mercado
 * Livre?" usado nos outros providers de busca por texto/imagem.
 */
export async function searchSearchApiLensShared(
  items: CatalogItemQuery[],
  matchers: MarketplaceMatcher[] = GOOGLE_SHOPPING_MATCHERS,
  userApiKey?: string
): Promise<Record<string, Record<string, MarketplacePriceResult>>> {
  const apiKey = userApiKey?.trim();
  if (!apiKey) {
    throw new Error(
      "Nenhuma chave SearchApi.io própria configurada. Cadastre a sua em Conta antes de buscar por imagem."
    );
  }

  const results = {} as Record<string, Record<string, MarketplacePriceResult>>;
  for (const { marketplace } of matchers) results[marketplace] = {};

  const itemsWithImage = items.filter((i) => i.imageUrl);
  if (itemsWithImage.length === 0) return results;

  let lastApiError: string | null = null;
  let errorCount = 0;

  await mapWithConcurrency(itemsWithImage, CONCURRENCY, async ({ sku, name, imageUrl }) => {
    try {
      const url = new URL(ENDPOINT);
      url.searchParams.set("engine", "google_lens");
      url.searchParams.set("url", imageUrl!);
      url.searchParams.set("hl", "pt-br");
      url.searchParams.set("gl", "br");
      url.searchParams.set("api_key", apiKey);

      const response = await fetch(url.toString());
      if (!response.ok) {
        errorCount++;
        lastApiError =
          response.status === 429
            ? "SearchApi.io sem cota disponível (HTTP 429) — confira o consumo em searchapi.io/dashboard."
            : `SearchApi.io (Google Lens) retornou HTTP ${response.status}`;
        console.warn(`SearchApi.io Lens "${name}" (${sku}) retornou ${response.status}`);
        return;
      }

      const data = (await response.json()) as SearchApiLensResponse;
      if (data.error) {
        errorCount++;
        lastApiError = data.error;
        console.warn(`SearchApi.io Lens "${name}" (${sku}): ${data.error}`);
        return;
      }

      const visualMatches = data.visual_matches ?? [];

      for (const { marketplace, matchesSource } of matchers) {
        const candidates = visualMatches.filter(
          (m) => m.source && m.price?.extracted_value != null && matchesSource(m.source.toLowerCase())
        );
        if (candidates.length === 0) continue;

        const ranked = pickBestCandidate(
          name,
          candidates,
          (c) => c.title ?? "",
          (c) => popularityScore(c.reviews, c.rating)
        );
        if (!ranked || ranked.candidate.price?.extracted_value == null) continue;

        results[marketplace][sku] = {
          marketplace,
          sku,
          price: ranked.candidate.price.extracted_value,
          competitorCount: Math.max(0, visualMatches.length - 1),
          buyBoxEligible: true,
          // Mesmo piso da busca por imagem via SerpApi — match visual,
          // não só similaridade de string (ver googleLensProvider.ts).
          confidence: Math.max(0.5, confidenceFromSimilarity(ranked.similarity)),
          link: ranked.candidate.link,
          matchedTitle: ranked.candidate.title,
          imageUrl: ranked.candidate.thumbnail,
        };
      }
    } catch (err) {
      errorCount++;
      lastApiError = err instanceof Error ? err.message : String(err);
      console.error(`SearchApi.io Lens falhou pra "${name}":`, err);
    }
  });

  if (itemsWithImage.length > 0 && errorCount === itemsWithImage.length && lastApiError) {
    throw new Error(lastApiError);
  }

  return results;
}
