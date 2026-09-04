import type { CatalogItemQuery, MarketplaceId, MarketplacePriceResult } from "../types.js";
import { mapWithConcurrency } from "../concurrency.js";
import { confidenceFromSimilarity } from "../textSimilarity.js";
import { pickBestCandidate, popularityScore } from "../rankCandidates.js";
import { buildSearchQuery } from "../searchQuery.js";

const ENDPOINT = "https://serpapi.com/search.json";
// Baixo de propósito: plano free da SerpApi tem 50 buscas/HORA de
// throughput, além das 250/mês (serpapi.com/pricing) — um catálogo de
// 20+ produtos já processa perto desse teto, e 5 chamadas simultâneas
// (valor anterior) só piorava o burst. 429 por throughput é sobre
// VELOCIDADE, não sobre cota restante — sobra mês, mas estoura hora.
const CONCURRENCY = 2;

/**
 * Abaixo disso o match entra marcado como aproximado (ver `approximate`
 * em types.ts). Mais alto que o dos providers de FOTO (0.2, ver
 * googleLensProvider.ts) porque aqui a busca foi feita PELO NOME: se o
 * título do anúncio mal se parece com o que foi buscado, o Google
 * devolveu categoria parecida, não o produto — exatamente o caso que
 * merece aviso.
 */
const APPROXIMATE_BELOW_SIMILARITY = 0.35;

interface SerpShoppingResult {
  title: string;
  source?: string;
  extracted_price?: number;
  product_link?: string;
  link?: string;
  thumbnail?: string;
  /** Confirmado na doc pública da SerpApi (shopping_results) — usado pro ranking por popularidade, ver rankCandidates.ts. */
  rating?: number;
  /** Idem — contagem de avaliações. */
  reviews?: number;
}

interface SerpShoppingResponse {
  shopping_results?: SerpShoppingResult[];
  error?: string;
}

export interface MarketplaceMatcher {
  marketplace: MarketplaceId;
  matchesSource: (sourceLower: string) => boolean;
}

/**
 * Marketplaces resolvidos via Google Shopping/SerpApi hoje — cada um só
 * difere no `matchesSource` usado pra filtrar o campo `source` do
 * resultado. Adicionar um marketplace novo nesse grupo (ex: Shopee) é só
 * uma entrada nova aqui — `searchGoogleShoppingShared` já cobre
 * qualquer quantidade de marketplaces na mesma busca.
 *
 * "geral" (ago/2026) — `matchesSource: () => false` DE PROPÓSITO: pra
 * este provider (e searchApiLensProvider.ts/scraperApiSearchProvider.ts/
 * googleLensProvider.ts, que também consomem este array) "geral" nunca
 * casa com um candidato de verdade — o marketplace existe aqui só pra
 * `isGoogleShoppingMarketplace` (registry.ts) deixar o pedido passar até
 * `matchers` sem 400 na validação, e pra `results["geral"]` já sair
 * inicializado (vazio) na resposta desses 4 mecanismos. Quem trata
 * "geral" de verdade é só `searchVisionInternalShared`
 * (visionInternalSearchProvider.ts > Passo 4), com sua própria fonte
 * (Google Shopping estruturado da ScraperAPI) — os outros 4 simplesmente
 * não têm esse passo, então marcar "geral" com um deles não traz produto
 * nenhum por essa via, sem lançar erro nem quebrar nada.
 */
export const GOOGLE_SHOPPING_MATCHERS: MarketplaceMatcher[] = [
  { marketplace: "amazon", matchesSource: (s) => s.includes("amazon") },
  { marketplace: "mercadolivre", matchesSource: (s) => s.includes("mercado") },
  { marketplace: "geral", matchesSource: () => false },
];

/**
 * Busca de preço via Google Shopping (SerpApi) — alternativa às APIs
 * proprietárias de cada marketplace, que empacaram: Amazon SP-API só
 * resolve SKU já cadastrado na sua conta (não busca por nome), PA-API
 * exige aprovação como Amazon Associate; Mercado Livre passou a exigir
 * app OAuth com validação de titularidade (fricção tipo KYC via Mercado
 * Pago no DevCenter). SerpApi (ou a chave própria do usuário via BYOK,
 * ver userSecrets.ts): cadastro só com email, sem cartão, free tier
 * 250 buscas/mês **e 50 buscas/hora** (throughput, os dois limites são
 * independentes — confirmado em serpapi.com/pricing) — e cobre QUALQUER
 * loja que apareça no Google Shopping numa única chamada, não só uma.
 * O throughput por hora é o mais fácil de estourar sem perceber: um
 * catálogo de 20+ produtos processado de uma vez já pode chegar perto
 * do teto, mesmo com cota mensal sobrando — por isso `CONCURRENCY`
 * abaixo é conservador, e por isso HTTP 429 não significa necessariamente
 * "acabou o mês" (ver tratamento de erro mais abaixo).
 *
 * **Busca compartilhada entre marketplaces** (ver
 * docs/architecture-review.md, item 15): uma mesma busca
 * (`q=<nome do produto>`) já retorna resultados de várias lojas ao
 * mesmo tempo, então esta função faz UMA chamada por produto — não uma
 * por produto POR marketplace — e reparte o mesmo `shopping_results`
 * entre todos os `matchers` pedidos. Antes, selecionar Amazon + Mercado
 * Livre juntos buscava o MESMO produto duas vezes na SerpApi; agora é
 * uma vez só, custando a mesma cota que selecionar um único marketplace.
 *
 * Confiança é calculada por similaridade de texto entre o nome do
 * catálogo e o título do anúncio (`textSimilarity.ts`), não um valor
 * fixo — um valor travado (ex: sempre 50%) não carrega informação
 * nenhuma e passa a impressão de número fabricado (ver Session 3 do
 * critique de design). Entre os candidatos da mesma loja com
 * similaridade próxima (ver `pickBestCandidate`, rankCandidates.ts),
 * escolhe o mais "famoso" (mais avaliações, rating maior) — não
 * necessariamente o primeiro nem o de maior similaridade bruta.
 * `matchedTitle` sempre volta junto pra conferência manual.
 */
export async function searchGoogleShoppingShared(
  items: CatalogItemQuery[],
  matchers: MarketplaceMatcher[],
  userApiKey?: string
): Promise<Record<MarketplaceId, Record<string, MarketplacePriceResult>>> {
  // BYOK obrigatório — ver comentário em requireAuth/verifyAuth.ts e
  // README > BYOK. Sem fallback pra uma SERPAPI_KEY compartilhada do
  // servidor.
  const apiKey = userApiKey?.trim();
  if (!apiKey) {
    throw new Error(
      "Nenhuma chave SerpApi própria configurada. Cadastre a sua em Conta antes de buscar preço."
    );
  }

  const results = {} as Record<MarketplaceId, Record<string, MarketplacePriceResult>>;
  for (const { marketplace } of matchers) results[marketplace] = {};

  // Rastreia falha SISTÊMICA (chave inválida, cota estourada, SerpApi
  // fora do ar) separado de "esse produto específico não achou match" —
  // a segunda é normal e fica silenciosa (só reduz taxa de match); a
  // primeira, se acontecer em TODOS os itens do lote, é propagada como
  // erro de verdade lá embaixo — ver motivação no comentário antes do
  // `if (errorCount === items.length...)`.
  let lastApiError: string | null = null;
  let errorCount = 0;

  await mapWithConcurrency(items, CONCURRENCY, async ({ sku, name }) => {
    try {
      const url = new URL(ENDPOINT);
      url.searchParams.set("engine", "google_shopping");
      // Query limpa (ver searchQuery.ts) — ranking abaixo compara contra
      // `name` original, só a busca em si usa a versão sem ruído.
      url.searchParams.set("q", buildSearchQuery(name));
      url.searchParams.set("google_domain", "google.com.br");
      url.searchParams.set("gl", "br");
      url.searchParams.set("hl", "pt-br");
      url.searchParams.set("api_key", apiKey);

      const response = await fetch(url.toString());
      if (!response.ok) {
        errorCount++;
        // 429 na SerpApi especificamente é documentado como "sem busca
        // disponível" — cota mensal OU throughput por hora, os dois
        // retornam o mesmo status (ver serpapi.com/api-status-and-error-codes).
        // Não dá pra saber qual dos dois daqui, então aponta pro painel
        // da conta em vez de adivinhar.
        lastApiError =
          response.status === 429
            ? "SerpApi sem cota disponível (HTTP 429) — pode ser o limite mensal de buscas OU o " +
              "limite de 50 buscas/hora do plano free (os dois retornam o mesmo status). " +
              "Confira o consumo em serpapi.com/manage-api-key."
            : `SerpApi retornou HTTP ${response.status}`;
        console.warn(`SerpApi "${name}" (${sku}) retornou ${response.status}`);
        return;
      }

      const data = (await response.json()) as SerpShoppingResponse;
      if (data.error) {
        errorCount++;
        lastApiError = data.error;
        console.warn(`SerpApi "${name}" (${sku}): ${data.error}`);
        return;
      }

      const shoppingResults = data.shopping_results ?? [];
      const priced = shoppingResults.filter((r) => r.extracted_price != null);

      let matchedRequestedMarketplace = false;

      // A MESMA resposta alimenta todos os marketplaces pedidos — cada
      // um filtra pelo próprio `matchesSource`, sem repetir a chamada.
      for (const { marketplace, matchesSource } of matchers) {
        const candidates = priced.filter((r) => r.source && matchesSource(r.source.toLowerCase()));
        if (candidates.length === 0) continue;

        // Entre os candidatos da loja certa com similaridade próxima do
        // melhor match, prioriza o mais "famoso" (rating/reviews) — ver
        // rankCandidates.ts.
        const ranked = pickBestCandidate(
          name,
          candidates,
          (c) => c.title,
          (c) => popularityScore(c.reviews, c.rating)
        );
        if (!ranked || ranked.candidate.extracted_price == null) continue;

        matchedRequestedMarketplace = true;
        results[marketplace][sku] = {
          marketplace,
          sku,
          price: ranked.candidate.extracted_price,
          competitorCount: Math.max(0, shoppingResults.length - 1),
          buyBoxEligible: true,
          confidence: confidenceFromSimilarity(ranked.similarity),
          link: ranked.candidate.product_link ?? ranked.candidate.link,
          matchedTitle: ranked.candidate.title,
          imageUrl: ranked.candidate.thumbnail,
          approximate: ranked.similarity < APPROXIMATE_BELOW_SIMILARITY,
          matchedSource: ranked.candidate.source,
          reviewCount: ranked.candidate.reviews,
          rating: ranked.candidate.rating,
        };
      }

      // Fallback aproximado: o Google Shopping achou o produto, mas em
      // loja fora da lista pedida (Shopee, Magalu, loja própria...). Sem
      // isto o item era descartado em silêncio e sumia da tela inteira
      // (marginCalculator.ts corta linha sem preço) — ver a justificativa
      // completa em googleLensProvider.ts. Entra marcado `approximate`,
      // com a loja real em `matchedSource` e confiança reduzida.
      if (!matchedRequestedMarketplace && priced.length > 0 && matchers.length > 0) {
        const ranked = pickBestCandidate(
          name,
          priced,
          (c) => c.title,
          (c) => popularityScore(c.reviews, c.rating)
        );
        if (ranked && ranked.candidate.extracted_price != null) {
          // Só no primeiro marketplace pedido — o preço não é de nenhum
          // deles, replicá-lo em todos inventaria ofertas inexistentes.
          const { marketplace } = matchers[0];
          results[marketplace][sku] = {
            marketplace,
            sku,
            price: ranked.candidate.extracted_price,
            competitorCount: Math.max(0, shoppingResults.length - 1),
            buyBoxEligible: false,
            confidence: Math.min(0.45, confidenceFromSimilarity(ranked.similarity)),
            link: ranked.candidate.product_link ?? ranked.candidate.link,
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
      console.error(`SerpApi (Google Shopping) falhou pra "${name}":`, err);
    }
  });

  // Se TODO item do lote falhou por erro da própria SerpApi (chave
  // inválida, cota estourada, serviço fora do ar) — não "esse produto
  // específico não tem match em loja nenhuma", que é normal e fica
  // silencioso — propaga o erro de verdade. Sem isso, `fetch-prices.ts`
  // devolvia 200 com um objeto vazio pra QUALQUER causa, e a UI só
  // mostrava "Nenhum resultado" sem nenhuma pista de que a causa era a
  // própria chave BYOK, não o catálogo ou o parser.
  if (items.length > 0 && errorCount === items.length && lastApiError) {
    throw new Error(lastApiError);
  }

  return results;
}
