import type { CatalogItemQuery, MarketplaceId, MarketplacePriceResult } from "../types.js";
import { mapWithConcurrency } from "../concurrency.js";
import { confidenceFromSimilarity } from "../textSimilarity.js";
import { pickBestCandidate, popularityScore } from "../rankCandidates.js";
import { buildSearchQuery } from "../searchQuery.js";
import { type MarketplaceMatcher } from "./googleShoppingProvider.js";

/**
 * BYOK (set/2026 — antes era secret de servidor, ver git blame). Cada
 * função abaixo recebe `scraperApiKey` já resolvida pelo chamador
 * (fetch-prices.ts, a partir do uid autenticado — ver
 * api/_lib/userSecrets.ts) em vez de ler `process.env` direto: mesma
 * chave/campo (`scraperApiKey`, `users/{uid}/secrets/keys`) que
 * internalSearchProvider.ts usa pro transporte (proxy de HTML cru), só
 * que aqui é os endpoints de DADO ESTRUTURADO (JSON pronto, sem parser
 * próprio) — arquivos diferentes, mesma chave do usuário, passada por
 * parâmetro em vez de lida duas vezes do ambiente.
 */
const AMAZON_SEARCH_ENDPOINT = "https://api.scraperapi.com/structured/amazon/search";
const GOOGLE_SHOPPING_ENDPOINT = "https://api.scraperapi.com/structured/google/shopping";

/**
 * TETO DE TEMPO NAS CHAMADAS DA SCRAPERAPI (set/2026)
 * ══════════════════════════════════════════════════════════════════════
 * Bug real corrigido: nenhuma das 4 chamadas `fetch` deste arquivo tinha
 * `AbortController`/timeout — dependiam só do teto da function inteira
 * (300s, vercel.json). Relato real: catálogo de 9 produtos levando ~10
 * minutos no mecanismo "ScraperAPI" (contra ~1min no motor interno puro),
 * consistente com o endpoint de Google Shopping sendo lento sem teto
 * nenhum represando o lote inteiro atrás de UMA chamada.
 *
 * Mais crítico ainda depois de set/2026: essas mesmas funções também são
 * o FALLBACK do motor interno + IA quando a raspagem direta falha (ver
 * `fetchCandidateOffers` em visionInternalSearchProvider.ts) — sem teto,
 * um fallback lento arrastava o motor rápido pro mesmo horário de
 * espera do mecanismo "ScraperAPI" standalone, o oposto do que o
 * fallback deveria fazer (ele é opcional, uma fonte a menos não pode
 * pesar mais que a fonte principal).
 *
 * 8s — mesmo valor de REQUEST_TIMEOUT_MS em internalSearchProvider.ts
 * (raspagem direta): se a raspagem direta já teria desistido em 8s, o
 * fallback estruturado não tem motivo pra ter paciência maior.
 */
const SCRAPERAPI_TIMEOUT_MS = 8000;

/** `fetch` com teto de tempo — usado nas 4 chamadas deste arquivo. AbortError vira erro comum (mensagem clara), pego pelo try/catch de quem chama, igual qualquer outra falha de rede. */
async function fetchWithTimeout(url: string): Promise<Response> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), SCRAPERAPI_TIMEOUT_MS);
  try {
    return await fetch(url, { signal: controller.signal });
  } catch (err) {
    if (err instanceof Error && err.name === "AbortError") {
      throw new Error(`ScraperAPI não respondeu em ${SCRAPERAPI_TIMEOUT_MS / 1000}s (timeout).`);
    }
    throw err;
  } finally {
    clearTimeout(timeout);
  }
}

// Mesma cautela de concorrência dos outros providers de terceiro
// (googleShoppingProvider.ts, searchApiLensProvider.ts) — a ScraperAPI não
// documenta publicamente um teto de throughput por hora feito o da SerpApi,
// mas o plano trial roda sobre a mesma infra dos planos pagos (limite de
// conexões simultâneas por conta), então mantém o mesmo valor conservador
// até termos dado real de rate-limit em produção.
const CONCURRENCY = 2;

/** Mesmo racional/valor de googleShoppingProvider.ts — busca por NOME, título muito diferente do buscado é sinal de categoria errada, não produto errado. */
const APPROXIMATE_BELOW_SIMILARITY = 0.35;

/**
 * Shape confirmado em docs.scraperapi.com/structured-data-endpoints/
 * e-commerce/amazon/amazon-search-api (ago/2026) — `results[]`, preço já
 * vem NUMÉRICO em `price` (não string, diferente do Google Shopping
 * estruturado abaixo). `stars`/`total_reviews` existem de verdade nessa
 * doc (usados pro ranking por popularidade, ver rankCandidates.ts) —
 * diferente do que aconteceu com searchApiLensProvider.ts, aqui a doc
 * pública já mostra os dois campos no exemplo de resposta.
 */
interface AmazonSearchResult {
  type?: string;
  asin?: string;
  name: string;
  url?: string;
  image?: string;
  price?: number;
  stars?: number;
  total_reviews?: number;
}

interface AmazonSearchResponse {
  results?: AmazonSearchResult[];
  error?: string;
}

/**
 * Shape confirmado em docs.scraperapi.com/structured-data-endpoints/
 * search-and-insights/google/google-shopping-api (ago/2026) —
 * `shopping_results[]`. `rating`/`reviews` NÃO aparecem no exemplo oficial
 * de resposta desse endpoint (diferente da doc da SerpApi, que documenta os
 * dois em `shopping_results`) — por segurança contra o mesmo erro corrigido
 * em searchApiLensProvider.ts (campo assumido que não existe de verdade),
 * este endpoint NÃO declara `rating`/`reviews` na interface e o desempate de
 * popularidade cai pra similaridade de texto (`getPopularity` sempre 0),
 * igual searchApiLensProvider.ts.
 */
interface GoogleShoppingStructuredResult {
  title: string;
  source?: string;
  price?: string;
  extracted_price?: number;
  thumbnail?: string;
}

interface GoogleShoppingStructuredResponse {
  shopping_results?: GoogleShoppingStructuredResult[];
  error?: string;
}

/** Candidato cru do Google Shopping estruturado — sem `link` (ver `fetchGoogleShoppingCandidatesForQuery` abaixo pro motivo). */
export interface GoogleShoppingCandidate {
  title: string;
  price?: number;
  thumbnail?: string;
  source?: string;
}

/**
 * Busca "geral" (ago/2026) — candidatos do Google Shopping estruturado
 * pra QUALQUER loja, sem restringir por `matcher`. Extraída da mesma
 * chamada usada em `searchScraperApiShared` (mesmo endpoint) pra ficar
 * reutilizável fora do mecanismo "scraperapi": é a mesma fonte multi-loja
 * que já alimenta o fallback "aproximado" de serpapi/searchapi_lens/
 * google_lens_products/scraperapi (achar o produto fora das duas lojas
 * focadas) — só o motor interno + IA (visionInternalSearchProvider.ts)
 * ainda não tinha acesso a essa fonte, porque a busca dele é direto na
 * Amazon/Mercado Livre (`fetchStoreOffers`, internalSearchProvider.ts,
 * sem agregador nenhum no meio).
 *
 * Devolve `[]` (não lança) quando a chave não está configurada ou a
 * chamada falha — é um enriquecimento OPCIONAL, uma fonte a menos não
 * pode derrubar o item inteiro.
 *
 * Sem `link`/`product_link` de propósito: a doc oficial (ago/2026,
 * docs.scraperapi.com/structured-data-endpoints/search-and-insights/
 * google/google-shopping-api) confirma que o Google descontinuou o
 * endpoint de produto individual — o `link` que a Google Shopping SDE
 * devolve hoje aponta pra uma URL da própria ScraperAPI que precisa de
 * OUTRA chamada autenticada pra resolver em oferta de verdade, não pra
 * página da loja. Devolver isso como "link" enganaria o usuário (parece
 * clicável, mas não leva a lugar nenhum sem uma 2ª chamada paga) — por
 * isso nem a interface acima nem esta função carregam o campo.
 */
export async function fetchGoogleShoppingCandidatesForQuery(
  query: string,
  scraperApiKey: string | undefined
): Promise<GoogleShoppingCandidate[]> {
  const apiKey = scraperApiKey?.trim();
  if (!apiKey) return [];

  try {
    const url = new URL(GOOGLE_SHOPPING_ENDPOINT);
    url.searchParams.set("api_key", apiKey);
    url.searchParams.set("query", query);
    url.searchParams.set("tld", "com.br");
    url.searchParams.set("country_code", "br");
    url.searchParams.set("gl", "br");
    url.searchParams.set("hl", "pt-br");

    const response = await fetchWithTimeout(url.toString());
    if (!response.ok) {
      console.warn(`ScraperAPI (Google Shopping, busca geral) "${query}" retornou ${response.status}`);
      return [];
    }
    const data = (await response.json()) as GoogleShoppingStructuredResponse;
    if (data.error) {
      console.warn(`ScraperAPI (Google Shopping, busca geral) "${query}": ${data.error}`);
      return [];
    }

    return (data.shopping_results ?? [])
      .filter((r) => r.extracted_price != null)
      .map((r) => ({ title: r.title, price: r.extracted_price, thumbnail: r.thumbnail, source: r.source }));
  } catch (err) {
    console.warn(`ScraperAPI (Google Shopping, busca geral) falhou pra "${query}":`, err);
    return [];
  }
}

/**
 * Candidato da Amazon vindo do endpoint ESTRUTURADO (set/2026). Tem tudo
 * que a raspagem de HTML tem — título, preço, link, foto — e mais
 * `reviewCount`/`rating` nativos, com a vantagem de não quebrar quando a
 * Amazon muda o layout da página nem levar 403 de anti-bot.
 *
 * Mesmo formato de campo do `ScrapedOffer` (internalSearchProvider.ts) de
 * propósito: é o que permite trocar a fonte de candidatos do motor
 * interno sem tocar em nada do ranqueamento nem da comparação visual.
 */
export interface AmazonStructuredCandidate {
  title: string;
  price: number;
  link?: string;
  thumbnail?: string;
  reviewCount?: number;
  rating?: number;
}

/**
 * Candidatos NATIVOS da Amazon pra uma consulta (set/2026) — irmã da
 * `fetchGoogleShoppingCandidatesForQuery` acima, extraída da chamada que
 * já existia embutida em `searchScraperApiShared` pra poder ser usada
 * fora do mecanismo "scraperapi".
 *
 * Motivo de existir: o motor interno + IA busca candidato raspando o HTML
 * da página de busca da Amazon (`fetchStoreOffers`), e essa raspagem é o
 * ponto que leva bloqueio e que quebra quando o layout muda. Esta função
 * é a fonte alternativa — mesmo dado, sem HTML no meio.
 *
 * Custa 5 créditos por chamada (ver tabela de custo no bloco abaixo).
 * Devolve `[]` (não lança) quando não há chave ou a chamada falha: quem
 * chama decide se cai pra raspagem.
 */
export async function fetchAmazonCandidatesForQuery(
  query: string,
  scraperApiKey: string | undefined
): Promise<AmazonStructuredCandidate[]> {
  const apiKey = scraperApiKey?.trim();
  if (!apiKey) return [];

  try {
    const url = new URL(AMAZON_SEARCH_ENDPOINT);
    url.searchParams.set("api_key", apiKey);
    url.searchParams.set("query", query);
    url.searchParams.set("tld", "com.br");
    url.searchParams.set("country_code", "br");

    const response = await fetchWithTimeout(url.toString());
    if (!response.ok) {
      console.warn(`ScraperAPI (Amazon Search, candidatos) "${query}" retornou ${response.status}`);
      return [];
    }
    const data = (await response.json()) as AmazonSearchResponse;
    if (data.error) {
      console.warn(`ScraperAPI (Amazon Search, candidatos) "${query}": ${data.error}`);
      return [];
    }

    return (data.results ?? [])
      .filter((r): r is AmazonSearchResult & { price: number } => r.price != null)
      .map((r) => ({
        title: r.name,
        price: r.price,
        // `url` normalmente vem, mas a doc não garante — cai pro link
        // direto por ASIN, mesmo fallback já usado em
        // rapidApiAmazonProvider.ts, pra não perder o "Ver anúncio".
        link: r.url ?? (r.asin ? `https://www.amazon.com.br/dp/${r.asin}` : undefined),
        thumbnail: r.image,
        reviewCount: r.total_reviews,
        rating: r.stars,
      }));
  } catch (err) {
    console.warn(`ScraperAPI (Amazon Search, candidatos) falhou pra "${query}":`, err);
    return [];
  }
}

/**
 * Terceiro mecanismo do teste A/B (ago/2026) — ScraperAPI ISOLADA como
 * mecanismo de BUSCA de verdade, não só transporte. Diferente do uso já
 * existente em internalSearchProvider.ts (proxy de HTML cru, o motor
 * interno continua fazendo o parsing), aqui usamos os "Structured Data
 * Endpoints" da ScraperAPI — a própria ScraperAPI faz o parsing e devolve
 * JSON pronto, papel equivalente ao da SerpApi/SearchApi.io.
 *
 * Dois endpoints, cada um chamado só quando de fato precisa (ago/2026,
 * revisado após estouro real de créditos — plano trial tem 5.000 créditos
 * e uma busca de 20 produtos com os dois marketplaces marcados consumiu
 * ~400: cada endpoint estruturado da ScraperAPI tem multiplicador de custo
 * PRÓPRIO por domínio, bem acima de "1 crédito por request" —
 * confirmado em docs.scraperapi.com/getting-started/quick-start/
 * credits-and-requests-costs: **Amazon = 5 créditos/request**, **Google
 * (SERP, cobre todos os subdomínios incl. Google Shopping) = 25
 * créditos/request**. Disparar os dois sempre, incondicionalmente, custava
 * até 30 créditos por produto mesmo quando só um dos dois tinha alguma
 * chance de mudar o resultado):
 *   1) Amazon Search API (`/structured/amazon/search`, 5 créditos) — dado
 *      NATIVO da Amazon, com rating/reviews reais. Só dispara quando
 *      "amazon" está entre os marketplaces pedidos (`needsAmazonNative`,
 *      já era condicional antes desta revisão).
 *   2) Google Shopping API (`/structured/google/shopping`, 25 créditos) —
 *      mesma fonte de dado que SerpApi/SearchApi.io já usam. É a ÚNICA
 *      fonte pra "mercadolivre" e pro fallback "geral" (não existe
 *      endpoint nativo estruturado da ScraperAPI pra nenhum dos dois) —
 *      mas quando o pedido é EXCLUSIVAMENTE "amazon", ela só serve de
 *      candidato supletivo pro que a Amazon Search API nativa já cobre
 *      sozinha; nesse caso específico (`needsGoogleShopping` abaixo)
 *      ela é PULADA, cortando o custo de 30 pra 5 créditos/produto sem
 *      perder marketplace nenhum — só abre mão de um segundo candidato
 *      supletivo que raramente muda o vencedor (a Amazon nativa já
 *      desempata por rating/reviews reais).
 *
 * Pro marketplace "amazon" com AMBAS as fontes ativas (mercadolivre/geral
 * também pedidos, então o Google Shopping já ia disparar mesmo), os
 * candidatos das DUAS entram na mesma disputa de `pickBestCandidate` — o
 * nativo tende a ganhar no desempate por popularidade, mas o do Google
 * Shopping continua disponível como candidato caso o nativo não tenha
 * achado nada ou tenha similaridade pior. Pro marketplace "mercadolivre",
 * só o Google Shopping cobre (a Amazon Search API é exclusiva da Amazon,
 * ScraperAPI não expõe endpoint estruturado equivalente pro Mercado Livre
 * até a data desta implementação).
 */
export async function searchScraperApiShared(
  items: CatalogItemQuery[],
  matchers: MarketplaceMatcher[],
  scraperApiKey: string | undefined
): Promise<Record<MarketplaceId, Record<string, MarketplacePriceResult>>> {
  const apiKey = scraperApiKey?.trim();
  if (!apiKey) {
    throw new Error(
      "Nenhuma chave ScraperAPI própria configurada. Cadastre a sua em Conta antes de buscar com este mecanismo."
    );
  }

  const results = {} as Record<MarketplaceId, Record<string, MarketplacePriceResult>>;
  for (const { marketplace } of matchers) results[marketplace] = {};

  const needsAmazonNative = matchers.some((m) => m.marketplace === "amazon");
  // Google Shopping é a ÚNICA fonte pra qualquer marketplace que não seja
  // "amazon" (mercadolivre, geral) — se algum deles foi pedido, a chamada é
  // obrigatória. Se o pedido for EXCLUSIVAMENTE "amazon", ela vira supletiva
  // (a Amazon Search API nativa já cobre sozinha) e é pulada — ver
  // justificativa completa de custo no comentário no topo do arquivo.
  const needsGoogleShopping = matchers.some((m) => m.marketplace !== "amazon");

  // Mesma separação de erro SISTÊMICO vs "esse produto não achou match" dos
  // outros providers — ver googleShoppingProvider.ts pra motivação completa.
  let lastApiError: string | null = null;
  let errorCount = 0;

  await mapWithConcurrency(items, CONCURRENCY, async ({ sku, name }) => {
    try {
      const query = buildSearchQuery(name);

      // Candidatos comuns pro ranking — cada um carrega a própria origem
      // (`__source`) só pra diagnóstico/logs, não usado no matching.
      interface Candidate {
        title: string;
        price?: number;
        link?: string;
        thumbnail?: string;
        source?: string;
        rating?: number;
        reviews?: number;
      }
      let amazonNativeCandidates: Candidate[] = [];
      let googleShoppingCandidates: Candidate[] = [];

      const fetches: Promise<void>[] = [];

      if (needsAmazonNative) {
        fetches.push(
          (async () => {
            const url = new URL(AMAZON_SEARCH_ENDPOINT);
            url.searchParams.set("api_key", apiKey);
            url.searchParams.set("query", query);
            url.searchParams.set("tld", "com.br");
            url.searchParams.set("country_code", "br");

            const response = await fetchWithTimeout(url.toString());
            if (!response.ok) {
              console.warn(`ScraperAPI (Amazon Search) "${name}" (${sku}) retornou ${response.status}`);
              return;
            }
            const data = (await response.json()) as AmazonSearchResponse;
            if (data.error) {
              console.warn(`ScraperAPI (Amazon Search) "${name}" (${sku}): ${data.error}`);
              return;
            }
            amazonNativeCandidates = (data.results ?? [])
              .filter((r) => r.price != null)
              .map((r) => ({
                title: r.name,
                price: r.price,
                link: r.url,
                thumbnail: r.image,
                source: "Amazon",
                rating: r.stars,
                reviews: r.total_reviews,
              }));
          })()
        );
      }

      if (needsGoogleShopping) {
        fetches.push(
          (async () => {
            const url = new URL(GOOGLE_SHOPPING_ENDPOINT);
            url.searchParams.set("api_key", apiKey);
            url.searchParams.set("query", query);
            url.searchParams.set("tld", "com.br");
            url.searchParams.set("country_code", "br");
            url.searchParams.set("gl", "br");
            url.searchParams.set("hl", "pt-br");

            const response = await fetchWithTimeout(url.toString());
            if (!response.ok) {
              console.warn(`ScraperAPI (Google Shopping) "${name}" (${sku}) retornou ${response.status}`);
              return;
            }
            const data = (await response.json()) as GoogleShoppingStructuredResponse;
            if (data.error) {
              console.warn(`ScraperAPI (Google Shopping) "${name}" (${sku}): ${data.error}`);
              return;
            }
            googleShoppingCandidates = (data.shopping_results ?? [])
              .filter((r) => r.extracted_price != null)
              .map((r) => ({
                title: r.title,
                price: r.extracted_price,
                thumbnail: r.thumbnail,
                source: r.source,
              }));
          })()
        );
      }

      await Promise.all(fetches);

      // Erro sistêmico só conta se NENHUMA fonte disparada pra este item
      // trouxe candidato — quando `needsGoogleShopping` é false (só "amazon"
      // pedido), a única fonte disparada é a nativa, então o critério
      // naturalmente vira "amazonNativeCandidates vazio" sozinho (o
      // `googleShoppingCandidates` fica `[]` de propósito, nunca foi
      // chamado, e não deve contar como "fonte que falhou").
      if (amazonNativeCandidates.length === 0 && googleShoppingCandidates.length === 0) {
        errorCount++;
        lastApiError = lastApiError ?? "ScraperAPI (Amazon Search + Google Shopping) sem resultado pra nenhum item.";
      }

      let matchedRequestedMarketplace = false;

      for (const { marketplace, matchesSource } of matchers) {
        const candidates =
          marketplace === "amazon"
            ? [...amazonNativeCandidates, ...googleShoppingCandidates.filter((c) => c.source && matchesSource(c.source.toLowerCase()))]
            : googleShoppingCandidates.filter((c) => c.source && matchesSource(c.source.toLowerCase()));
        if (candidates.length === 0) continue;

        const ranked = pickBestCandidate(
          name,
          candidates,
          (c) => c.title,
          (c) => popularityScore(c.reviews, c.rating)
        );
        if (!ranked || ranked.candidate.price == null) continue;

        matchedRequestedMarketplace = true;
        results[marketplace][sku] = {
          marketplace,
          sku,
          price: ranked.candidate.price,
          competitorCount: Math.max(0, amazonNativeCandidates.length + googleShoppingCandidates.length - 1),
          buyBoxEligible: true,
          confidence: confidenceFromSimilarity(ranked.similarity),
          link: ranked.candidate.link,
          matchedTitle: ranked.candidate.title,
          imageUrl: ranked.candidate.thumbnail,
          approximate: ranked.similarity < APPROXIMATE_BELOW_SIMILARITY,
          matchedSource: ranked.candidate.source,
          // Só a fonte nativa da Amazon traz esses dois (o Google
          // Shopping estruturado não devolve avaliação de forma
          // confiável) — ficam `undefined` no resto, e a UI simplesmente
          // não mostra o badge. Ver reviewCount em types.ts.
          reviewCount: ranked.candidate.reviews,
          rating: ranked.candidate.rating,
        };
      }

      // Fallback aproximado — mesma lógica/justificativa de
      // googleShoppingProvider.ts: Google Shopping achou o produto fora das
      // lojas pedidas, entra marcado em vez de sumir da tela.
      if (!matchedRequestedMarketplace && googleShoppingCandidates.length > 0 && matchers.length > 0) {
        const ranked = pickBestCandidate(
          name,
          googleShoppingCandidates,
          (c) => c.title,
          () => 0
        );
        if (ranked && ranked.candidate.price != null) {
          const { marketplace } = matchers[0];
          results[marketplace][sku] = {
            marketplace,
            sku,
            price: ranked.candidate.price,
            competitorCount: Math.max(0, googleShoppingCandidates.length - 1),
            buyBoxEligible: false,
            confidence: Math.min(0.45, confidenceFromSimilarity(ranked.similarity)),
            link: ranked.candidate.link,
            matchedTitle: ranked.candidate.title,
            imageUrl: ranked.candidate.thumbnail,
            approximate: true,
            matchedSource: ranked.candidate.source,
            reviewCount: ranked.candidate.reviews,
            rating: ranked.candidate.rating,
          };
        }
      }
    } catch (err) {
      errorCount++;
      lastApiError = err instanceof Error ? err.message : String(err);
      console.error(`ScraperAPI (busca estruturada) falhou pra "${name}":`, err);
    }
  });

  if (items.length > 0 && errorCount === items.length && lastApiError) {
    throw new Error(lastApiError);
  }

  return results;
}
