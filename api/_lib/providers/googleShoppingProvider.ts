import type { CatalogItemQuery, MarketplaceId, MarketplacePriceResult } from "../types";
import { mapWithConcurrency } from "../concurrency";
import { confidenceFromSimilarity, textSimilarity } from "../textSimilarity";

const ENDPOINT = "https://serpapi.com/search.json";
const CONCURRENCY = 5;

interface SerpShoppingResult {
  title: string;
  source?: string;
  extracted_price?: number;
  product_link?: string;
  link?: string;
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
 * ~250 buscas/mês — e cobre QUALQUER loja que apareça no Google
 * Shopping numa única chamada, não só uma.
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
        console.warn(`SerpApi "${name}" (${sku}) retornou ${response.status}`);
        return;
      }

      const data = (await response.json()) as SerpShoppingResponse;
      if (data.error) {
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
        };
      }
    } catch (err) {
      console.error(`SerpApi (Google Shopping) falhou pra "${name}":`, err);
    }
  });

  return results;
}
