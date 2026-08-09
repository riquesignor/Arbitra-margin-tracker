import type { CatalogItemQuery, MarketplaceId, MarketplacePriceResult } from "../types.js";
import { mapWithConcurrency } from "../concurrency.js";
import { confidenceFromSimilarity, textSimilarity } from "../textSimilarity.js";

const ENDPOINT = "https://serpapi.com/search.json";
// Baixo de propósito: plano free da SerpApi tem 50 buscas/HORA de
// throughput, além das 250/mês (serpapi.com/pricing) — um catálogo de
// 20+ produtos já processa perto desse teto, e 5 chamadas simultâneas
// (valor anterior) só piorava o burst. 429 por throughput é sobre
// VELOCIDADE, não sobre cota restante — sobra mês, mas estoura hora.
const CONCURRENCY = 2;

interface SerpShoppingResult {
  title: string;
  source?: string;
  extracted_price?: number;
  product_link?: string;
  link?: string;
  thumbnail?: string;
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
 */
export const GOOGLE_SHOPPING_MATCHERS: MarketplaceMatcher[] = [
  { marketplace: "amazon", matchesSource: (s) => s.includes("amazon") },
  { marketplace: "mercadolivre", matchesSource: (s) => s.includes("mercado") },
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
 * critique de design). Entre os candidatos da mesma loja, escolhe o de
 * maior similaridade — não necessariamente o primeiro da lista.
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
      url.searchParams.set("q", name);
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

      // A MESMA resposta alimenta todos os marketplaces pedidos — cada
      // um filtra pelo próprio `matchesSource`, sem repetir a chamada.
      for (const { marketplace, matchesSource } of matchers) {
        const candidates = shoppingResults.filter(
          (r) => r.source && r.extracted_price != null && matchesSource(r.source.toLowerCase())
        );
        if (candidates.length === 0) continue;

        // Entre os candidatos da loja certa, pega o de título mais
        // parecido com o nome do catálogo — não necessariamente o
        // primeiro que o Google Shopping retornou.
        let best = candidates[0];
        let bestSimilarity = textSimilarity(name, best.title);
        for (const candidate of candidates.slice(1)) {
          const similarity = textSimilarity(name, candidate.title);
          if (similarity > bestSimilarity) {
            best = candidate;
            bestSimilarity = similarity;
          }
        }
        if (best.extracted_price == null) continue;

        results[marketplace][sku] = {
          marketplace,
          sku,
          price: best.extracted_price,
          competitorCount: Math.max(0, shoppingResults.length - 1),
          buyBoxEligible: true,
          confidence: confidenceFromSimilarity(bestSimilarity),
          link: best.product_link ?? best.link,
          matchedTitle: best.title,
          imageUrl: best.thumbnail,
        };
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
