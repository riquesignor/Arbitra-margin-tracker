import type { CatalogItemQuery, MarketplacePriceResult } from "../types.js";
import { mapWithConcurrency } from "../concurrency.js";
import { confidenceFromSimilarity, isUsableSearchTerm } from "../textSimilarity.js";
import { pickBestCandidate } from "../rankCandidates.js";
import { GOOGLE_SHOPPING_MATCHERS, type MarketplaceMatcher } from "./googleShoppingProvider.js";

const ENDPOINT = "https://serpapi.com/search.json";
const CONCURRENCY = 2; // mesma cota SerpApi da busca por texto — ver googleShoppingProvider.ts

/**
 * Abaixo disso, o match da loja certa ainda entra no resultado, mas
 * marcado como aproximado (ver `approximate` em types.ts). Limiar BAIXO
 * de propósito neste provider: aqui quem casa o produto é a IMAGEM, e o
 * nome do catálogo costuma ser ruim (é justamente por isso que se usa
 * busca por foto) — então similaridade de texto é um sinal fraco, e um
 * limiar alto marcaria praticamente tudo como aproximado, virando ruído
 * em vez de aviso. Ver o valor mais alto usado em googleShoppingProvider.ts,
 * onde a busca foi FEITA pelo nome e os títulos têm que bater mesmo.
 */
const APPROXIMATE_BELOW_SIMILARITY = 0.2;

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
 *
 * IMPORTANTE (corrigido — release anterior afirmava o contrário): o
 * engine `google_lens` NÃO expõe `rating`/`reviews` na doc pública da
 * SerpApi (só o `google_shopping` expõe, ver googleShoppingProvider.ts).
 * Conferido direto contra a documentação (serpapi.com/google-lens-api,
 * nenhum exemplo de `visual_matches[]` traz esses campos) — por isso o
 * ranking aqui usa só similaridade de texto (`getPopularity` sempre 0),
 * SEM fingir um sinal de popularidade que a API não entrega.
 *
 * `q` (adicionado ago/2026): SerpApi documenta explicitamente que o
 * parâmetro de busca por texto pode ser combinado com `url` quando
 * `type` é `all`, `visual_matches` ou `products` — usa o NOME do
 * catálogo como sinal textual adicional além da foto, pra reduzir o
 * caso "match visualmente parecido mas produto errado" (mesma
 * categoria/formato, modelo diferente) relatado em uso real. Trade-off
 * consciente: combinar texto pode também FILTRAR candidatos que um
 * match puramente visual acharia (nome do catálogo ruim/genérico vira
 * ruído em vez de sinal) — requer validação empírica de taxa de acerto
 * antes/depois, não é garantia unilateral de melhora.
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
      // Sinal textual além da foto (ver comentário no topo do arquivo).
      // Nome degradado NÃO é enviado: como `q` funciona de filtro, um
      // fragmento de OCR reduziria os resultados em vez de refiná-los —
      // ver isUsableSearchTerm em textSimilarity.ts.
      if (isUsableSearchTerm(name)) url.searchParams.set("q", name.trim());
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
      // Qualquer match com preço, de QUALQUER loja — base tanto do
      // filtro por marketplace (abaixo) quanto do fallback aproximado.
      const priced = visualMatches.filter((m) => m.price?.extracted_value != null);

      let matchedRequestedMarketplace = false;

      for (const { marketplace, matchesSource } of matchers) {
        const candidates = priced.filter((m) => m.source && matchesSource(m.source.toLowerCase()));
        if (candidates.length === 0) continue;

        // Sem sinal de popularidade neste engine (ver comentário no topo
        // do arquivo) — `getPopularity` sempre 0, então o desempate cai
        // inteiro pra similaridade de texto (`pickBestCandidate` já cobre
        // isso sozinho). Mantém a mesma função de ranking dos outros
        // providers só por consistência de código, não por sinal real.
        const ranked = pickBestCandidate(
          name,
          candidates,
          (c) => c.title ?? "",
          () => 0
        );
        if (!ranked || ranked.candidate.price?.extracted_value == null) continue;

        matchedRequestedMarketplace = true;
        results[marketplace][sku] = {
          marketplace,
          sku,
          price: ranked.candidate.price.extracted_value,
          competitorCount: Math.max(0, visualMatches.length - 1),
          buyBoxEligible: true,
          // Piso mais alto que a busca por texto: veio de match VISUAL
          // (a mesma foto do catálogo), não só similaridade de string —
          // mas ainda não é 1.0, porque o recorte da foto é heurístico
          // (pode ter pego texto/vizinho junto, ver parsePdfCatalog.ts).
          confidence: Math.max(0.5, confidenceFromSimilarity(ranked.similarity)),
          link: ranked.candidate.link,
          matchedTitle: ranked.candidate.title,
          imageUrl: ranked.candidate.thumbnail,
          approximate: ranked.similarity < APPROXIMATE_BELOW_SIMILARITY,
          matchedSource: ranked.candidate.source,
        };
      }

      // ── Fallback aproximado ────────────────────────────────────────
      // O Google Lens devolve match de QUALQUER loja da web (Shopee,
      // AliExpress, Magalu, loja própria do fabricante...), mas o filtro
      // acima só aceita Amazon/Mercado Livre. Resultado do comportamento
      // antigo: o produto que o Lens ACHOU, mas em loja fora da lista,
      // era descartado em silêncio — e como marginCalculator.ts corta
      // linha sem preço, ele sumia da tela inteira. Catálogo de dezenas
      // de itens voltava com 2 linhas e nenhuma explicação.
      //
      // Agora, quando nenhum marketplace pedido tem oferta, o melhor
      // match COM preço de qualquer loja entra assim mesmo — marcado
      // `approximate` e com `matchedSource` dizendo de onde veio, e com
      // confiança abaixo do piso dos matches "de verdade" (0.5), pra
      // nunca se confundir com um match do marketplace pedido. É uma
      // referência de preço de mercado pra conferência manual, não uma
      // oferta do marketplace — a tag na UI deixa isso explícito.
      if (!matchedRequestedMarketplace && priced.length > 0 && matchers.length > 0) {
        const ranked = pickBestCandidate(
          name,
          priced,
          (c) => c.title ?? "",
          () => 0
        );
        if (ranked && ranked.candidate.price?.extracted_value != null) {
          // Atribuído a UM marketplace só (o primeiro pedido) de
          // propósito — o preço não é de nenhum deles, e duplicá-lo em
          // todos inventaria ofertas que não existem.
          const { marketplace } = matchers[0];
          results[marketplace][sku] = {
            marketplace,
            sku,
            price: ranked.candidate.price.extracted_value,
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
      console.error(`Google Lens falhou pra "${name}":`, err);
    }
  });

  if (itemsWithImage.length > 0 && errorCount === itemsWithImage.length && lastApiError) {
    throw new Error(lastApiError);
  }

  return results;
}
