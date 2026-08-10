import type { CatalogItemQuery, MarketplacePriceResult } from "../types.js";
import { mapWithConcurrency } from "../concurrency.js";
import { confidenceFromSimilarity, isUsableSearchTerm } from "../textSimilarity.js";
import { pickBestCandidate } from "../rankCandidates.js";
import { GOOGLE_SHOPPING_MATCHERS, type MarketplaceMatcher } from "./googleShoppingProvider.js";

const ENDPOINT = "https://www.searchapi.io/api/v1/search";
const CONCURRENCY = 2; // mesmo motivo de cautela de throughput da SerpApi — ver googleShoppingProvider.ts

/** Mesmo limiar e mesma justificativa de googleLensProvider.ts (busca por foto: similaridade de texto é sinal fraco). */
const APPROXIMATE_BELOW_SIMILARITY = 0.2;

/**
 * Shape CORRIGIDO em ago/2026 contra a doc real (searchapi.io/docs/
 * google-lens): diferente da SerpApi, aqui o preço NÃO vem aninhado —
 * `price` é a string de exibição ("$14*") e `extracted_price` é o
 * número, os dois soltos no mesmo nível do match. A versão anterior
 * deste arquivo assumia o formato aninhado da SerpApi (`price.extracted_value`)
 * por engano, o que fazia o filtro de candidatos nunca casar com nada —
 * o provider rodava sem erro mas nunca achava preço nenhum. `rating`/
 * `reviews` também foram removidos: não aparecem em nenhum exemplo da
 * doc oficial (nem no `search_type=all`, nem em `products`), só existem
 * de fato no engine `google_shopping` — ver mesma correção em
 * googleLensProvider.ts.
 */
interface SearchApiLensMatch {
  title?: string;
  link?: string;
  source?: string;
  price?: string;
  extracted_price?: number;
  currency?: string;
  stock_information?: string;
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
 * SearchApi.io espelha o mesmo motor (Google Lens) que a SerpApi, mas o
 * shape de `visual_matches[]` NÃO é idêntico — ver comentário em
 * `SearchApiLensMatch` acima pro schema real de preço (achatado, não
 * aninhado como na SerpApi) e a ausência de `rating`/`reviews` nesse
 * engine. `country` (não `gl`, que é convenção da SerpApi) e
 * `search_type=products` são os parâmetros corretos confirmados na doc
 * pública (searchapi.io/docs/google-lens) pra restringir a resultado de
 * produto/preço, em vez do default `search_type=all` (mistura visual
 * matches, exact matches e related searches).
 *
 * Reaproveita os mesmos `GOOGLE_SHOPPING_MATCHERS` (amazon/mercado) pra
 * filtrar `source` — mesmo critério "essa loja é a Amazon/Mercado
 * Livre?" usado nos outros providers de busca por texto/imagem.
 *
 * `q` (adicionado ago/2026): confirmado na doc pública (searchapi.io/
 * docs/google-lens, seção "Search Type - Products with Query") que o
 * parâmetro aceita texto combinado com `url` quando `search_type` é
 * `all`, `visual_matches` ou `products` — usa o NOME do catálogo como
 * sinal adicional, mesma motivação e mesmo trade-off documentado em
 * googleLensProvider.ts (pode reduzir resultado quando o nome do
 * catálogo é ruim/genérico, em troca de menos falso-positivo visual).
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
      url.searchParams.set("search_type", "products");
      url.searchParams.set("url", imageUrl!);
      // Sinal textual além da foto — mesma regra do googleLensProvider.ts:
      // nome degradado é omitido pra não filtrar resultado à toa.
      if (isUsableSearchTerm(name)) url.searchParams.set("q", name.trim());
      url.searchParams.set("hl", "pt-br");
      url.searchParams.set("country", "br");
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
      const priced = visualMatches.filter((m) => m.extracted_price != null);

      let matchedRequestedMarketplace = false;

      for (const { marketplace, matchesSource } of matchers) {
        const candidates = priced.filter((m) => m.source && matchesSource(m.source.toLowerCase()));
        if (candidates.length === 0) continue;

        // Sem sinal de popularidade neste engine (ver comentário no topo
        // do arquivo) — `getPopularity` sempre 0, desempate cai pra
        // similaridade de texto, igual googleLensProvider.ts.
        const ranked = pickBestCandidate(
          name,
          candidates,
          (c) => c.title ?? "",
          () => 0
        );
        if (!ranked || ranked.candidate.extracted_price == null) continue;

        matchedRequestedMarketplace = true;
        results[marketplace][sku] = {
          marketplace,
          sku,
          price: ranked.candidate.extracted_price,
          competitorCount: Math.max(0, visualMatches.length - 1),
          buyBoxEligible: true,
          // Mesmo piso da busca por imagem via SerpApi — match visual,
          // não só similaridade de string (ver googleLensProvider.ts).
          confidence: Math.max(0.5, confidenceFromSimilarity(ranked.similarity)),
          link: ranked.candidate.link,
          matchedTitle: ranked.candidate.title,
          imageUrl: ranked.candidate.thumbnail,
          approximate: ranked.similarity < APPROXIMATE_BELOW_SIMILARITY,
          matchedSource: ranked.candidate.source,
        };
      }

      // Fallback aproximado — mesma lógica e mesma justificativa
      // detalhada em googleLensProvider.ts: sem isso, todo produto que o
      // Lens acha numa loja fora de Amazon/Mercado Livre some da tela.
      if (!matchedRequestedMarketplace && priced.length > 0 && matchers.length > 0) {
        const ranked = pickBestCandidate(
          name,
          priced,
          (c) => c.title ?? "",
          () => 0
        );
        if (ranked && ranked.candidate.extracted_price != null) {
          const { marketplace } = matchers[0];
          results[marketplace][sku] = {
            marketplace,
            sku,
            price: ranked.candidate.extracted_price,
            competitorCount: Math.max(0, visualMatches.length - 1),
            buyBoxEligible: false,
            confidence: Math.min(0.45, confidenceFromSimilarity(ranked.similarity)),
            link: ranked.candidate.link,
            matchedTitle: ranked.candidate.title,
            imageUrl: ranked.candidate.thumbnail,
            approximate: true,
            matchedSource: ranked.candidate.source,
          };
        }
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
