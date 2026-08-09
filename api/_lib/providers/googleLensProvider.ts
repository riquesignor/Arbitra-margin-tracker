import type { CatalogItemQuery, MarketplacePriceResult } from "../types.js";
import { mapWithConcurrency } from "../concurrency.js";
import { confidenceFromSimilarity, textSimilarity } from "../textSimilarity.js";
import { GOOGLE_SHOPPING_MATCHERS, type MarketplaceMatcher } from "./googleShoppingProvider.js";

const ENDPOINT = "https://serpapi.com/search.json";
const CONCURRENCY = 2; // mesma cota SerpApi da busca por texto — ver googleShoppingProvider.ts

interface LensPrice {
  value?: string;
  extracted_value?: number;
  currency?: string;
}

interface LensVisualMatch {
  title?: string;
  link?: string;
  source?: string;
  price?: LensPrice;
  in_stock?: boolean;
  thumbnail?: string;
}

interface LensResponse {
  visual_matches?: LensVisualMatch[];
  error?: string;
}

/**
 * Busca de preço por FOTO do produto — Google Lens (`engine=google_lens`,
 * `type=products`), via SerpApi (mesma chave/cota da busca por texto em
 * googleShoppingProvider.ts, é a mesma conta SerpApi, só um engine
 * diferente). Existe pra catálogos com nome genérico demais ("Faca de
 * corte", sem marca/modelo) onde busca por TEXTO acha qualquer coisa
 * parecida — a foto do catálogo é o critério de match, não o nome.
 *
 * Precisa de uma URL PÚBLICA de imagem por item (`item.imageUrl`, ver
 * src/lib/catalogImages.ts + api/catalog-image.ts) — item sem foto é
 * pulado silenciosamente (fica de fora do resultado, não conta como
 * erro sistêmico). O shape da resposta (`visual_matches[]` com `title`,
 * `source`, `price.extracted_value`, `link`) já veio confirmado direto
 * da documentação pública da SerpApi (google-lens-products-api),
 * inclusive com `type=products` — não é um campo adivinhado.
 *
 * Reaproveita os MESMOS `GOOGLE_SHOPPING_MATCHERS` (amazon/mercado) pra
 * filtrar `source` — é o mesmo critério "essa loja é a Amazon/Mercado
 * Livre?" usado na busca por texto, só aplicado a um payload diferente.
 */
export async function searchGoogleLensProductsShared(
  items: CatalogItemQuery[],
  matchers: MarketplaceMatcher[] = GOOGLE_SHOPPING_MATCHERS,
  userApiKey?: string
): Promise<Record<string, Record<string, MarketplacePriceResult>>> {
  const apiKey = userApiKey?.trim();
  if (!apiKey) {
    throw new Error(
      "Nenhuma chave SerpApi própria configurada. Cadastre a sua em Conta antes de buscar por imagem."
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
      url.searchParams.set("type", "products");
      url.searchParams.set("url", imageUrl!);
      url.searchParams.set("hl", "pt-br");
      url.searchParams.set("country", "br");
      url.searchParams.set("api_key", apiKey);

      const response = await fetch(url.toString());
      if (!response.ok) {
        errorCount++;
        lastApiError =
          response.status === 429
            ? "SerpApi sem cota disponível (HTTP 429) — mesma cota da busca por texto, ver Conta."
            : `SerpApi (Google Lens) retornou HTTP ${response.status}`;
        console.warn(`Google Lens "${name}" (${sku}) retornou ${response.status}`);
        return;
      }

      const data = (await response.json()) as LensResponse;
      if (data.error) {
        errorCount++;
        lastApiError = data.error;
        console.warn(`Google Lens "${name}" (${sku}): ${data.error}`);
        return;
      }

      const visualMatches = data.visual_matches ?? [];

      for (const { marketplace, matchesSource } of matchers) {
        const candidates = visualMatches.filter(
          (m) => m.source && m.price?.extracted_value != null && matchesSource(m.source.toLowerCase())
        );
        if (candidates.length === 0) continue;

        // Entre os candidatos da loja certa, ainda desempata por
        // similaridade de texto com o nome do catálogo (mesmo que
        // genérico) — melhor critério disponível quando há mais de um
        // resultado da mesma loja pra essa imagem.
        let best = candidates[0];
        let bestSimilarity = textSimilarity(name, best.title ?? "");
        for (const candidate of candidates.slice(1)) {
          const similarity = textSimilarity(name, candidate.title ?? "");
          if (similarity > bestSimilarity) {
            best = candidate;
            bestSimilarity = similarity;
          }
        }
        if (best.price?.extracted_value == null) continue;

        results[marketplace][sku] = {
          marketplace,
          sku,
          price: best.price.extracted_value,
          competitorCount: Math.max(0, visualMatches.length - 1),
          buyBoxEligible: true,
          // Piso mais alto que a busca por texto: veio de match VISUAL
          // (a mesma foto do catálogo), não só similaridade de string —
          // mas ainda não é 1.0, porque o recorte da foto é heurístico
          // (pode ter pego texto/vizinho junto, ver parsePdfCatalog.ts).
          confidence: Math.max(0.5, confidenceFromSimilarity(bestSimilarity)),
          link: best.link,
          matchedTitle: best.title,
          imageUrl: best.thumbnail,
        };
      }
    } catch (err) {
      errorCount++;
      lastApiError = err instanceof Error ? err.message : String(err);
      console.error(`Google Lens falhou pra "${name}":`, err);
    }
  });

  if (itemsWithImage.length > 0 && errorCount === itemsWithImage.length && lastApiError) {
    throw new Error(lastApiError);
  }

  return results;
}
