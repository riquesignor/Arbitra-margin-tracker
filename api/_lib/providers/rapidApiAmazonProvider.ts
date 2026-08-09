import type { CatalogItemQuery, MarketplacePriceResult } from "../types.js";
import { mapWithConcurrency } from "../concurrency.js";
import { confidenceFromSimilarity, textSimilarity } from "../textSimilarity.js";

const HOST = "real-time-amazon-data.p.rapidapi.com";
const ENDPOINT = `https://${HOST}/search`;

// Plano free ("Basic") dessa API na RapidAPI é limitado por REQUISIÇÕES
// TOTAIS no mês (100/mês, bem mais apertado que os 50/hora da SerpApi),
// não por throughput — concorrência baixa aqui é só pra não estourar o
// limite por segundo que a própria RapidAPI aplica a qualquer plano,
// não pra economizar cota mensal (isso a concorrência não muda).
const CONCURRENCY = 3;

interface RapidApiAmazonProduct {
  asin?: string;
  product_title?: string;
  product_price?: string | null;
  product_url?: string;
  product_photo?: string;
  product_star_rating?: string;
  product_num_ratings?: number;
}

interface RapidApiAmazonResponse {
  status?: string;
  data?: {
    products?: RapidApiAmazonProduct[];
    total_products?: number;
  };
  error?: string;
  message?: string;
}

/**
 * Converte string de preço em número — a API devolve o preço já
 * formatado com símbolo de moeda (ex: "R$99,90" pra country=BR, ou
 * "$19.99" pra country=US), não um número cru. Heurística: o ÚLTIMO
 * separador (vírgula ou ponto) encontrado é tratado como decimal, os
 * anteriores como separador de milhar — cobre tanto pt-BR (1.234,56)
 * quanto en-US (1,234.56) sem precisar saber o `country` de antemão.
 */
function parseMoney(raw: string | null | undefined): number | null {
  if (!raw) return null;
  const cleaned = raw.replace(/[^\d.,]/g, "");
  if (!cleaned) return null;

  const lastComma = cleaned.lastIndexOf(",");
  const lastDot = cleaned.lastIndexOf(".");
  let normalized = cleaned;
  if (lastComma > lastDot) {
    normalized = cleaned.replace(/\./g, "").replace(",", ".");
  } else if (lastDot > lastComma) {
    normalized = cleaned.replace(/,/g, "");
  }

  const value = Number(normalized);
  return Number.isFinite(value) ? value : null;
}

/**
 * Busca de preço na Amazon via RapidAPI ("Real-Time Amazon Data", by
 * letscrape) — alternativa à SerpApi quando o usuário quer buscar SÓ
 * Amazon (não passa pelo Google Shopping). BYOK: usa a `X-RapidAPI-Key`
 * própria do usuário (ver src/lib/userSecrets.ts, campo `rapidApiKey`),
 * cadastrada em Conta. Plano free documentado: 100 requisições/mês, sem
 * cartão de crédito (rapidapi.com/letscrape-6bRBa3QguO5/api/real-time-amazon-data).
 *
 * Como cada requisição já cobre 1 produto (retorna vários candidatos),
 * o custo é 1 chamada por item do catálogo — igual ao padrão da SerpApi.
 * Confiança calculada por similaridade de texto entre o nome do catálogo
 * e o título do anúncio, mesmo critério de googleShoppingProvider.ts.
 *
 * Nota: os nomes de campo abaixo (`product_title`, `product_price`,
 * etc.) seguem a documentação pública dessa API — like qualquer
 * integração de terceiro, vale conferir contra uma resposta real assim
 * que tiver uma chave, e ajustar aqui se algum campo tiver mudado.
 */
export async function fetchRapidApiAmazonPrices(
  items: CatalogItemQuery[],
  userApiKey?: string
): Promise<Record<string, MarketplacePriceResult>> {
  const apiKey = userApiKey?.trim();
  if (!apiKey) {
    throw new Error(
      "Nenhuma chave RapidAPI própria configurada. Cadastre a sua em Conta antes de buscar preço na Amazon direto."
    );
  }

  const results: Record<string, MarketplacePriceResult> = {};
  let lastApiError: string | null = null;
  let errorCount = 0;

  await mapWithConcurrency(items, CONCURRENCY, async ({ sku, name }) => {
    try {
      const url = new URL(ENDPOINT);
      url.searchParams.set("query", name);
      url.searchParams.set("page", "1");
      url.searchParams.set("country", "BR");
      url.searchParams.set("sort_by", "RELEVANCE");

      const response = await fetch(url.toString(), {
        headers: {
          "X-RapidAPI-Key": apiKey,
          "X-RapidAPI-Host": HOST,
        },
      });

      if (!response.ok) {
        errorCount++;
        lastApiError =
          response.status === 429
            ? "RapidAPI sem cota disponível (HTTP 429) — plano free costuma ser 100 buscas/mês. " +
              "Confira o consumo no painel da RapidAPI (My Apps → Real-Time Amazon Data)."
            : response.status === 403
              ? "RapidAPI recusou a chave (HTTP 403) — confira se ela está correta e se sua conta " +
                "está inscrita (\"subscribed\") na API Real-Time Amazon Data, mesmo no plano free."
              : `RapidAPI (Amazon) retornou HTTP ${response.status}`;
        console.warn(`RapidAPI Amazon "${name}" (${sku}) retornou ${response.status}`);
        return;
      }

      const data = (await response.json()) as RapidApiAmazonResponse;
      if (data.error || data.message) {
        errorCount++;
        lastApiError = data.error || data.message || "Erro desconhecido da RapidAPI (Amazon)";
        console.warn(`RapidAPI Amazon "${name}" (${sku}): ${lastApiError}`);
        return;
      }

      const products = data.data?.products ?? [];
      const candidates = products.filter((p) => p.product_title && parseMoney(p.product_price) != null);
      if (candidates.length === 0) return;

      let best = candidates[0];
      let bestSimilarity = textSimilarity(name, best.product_title!);
      for (const candidate of candidates.slice(1)) {
        const similarity = textSimilarity(name, candidate.product_title!);
        if (similarity > bestSimilarity) {
          best = candidate;
          bestSimilarity = similarity;
        }
      }

      const price = parseMoney(best.product_price);
      if (price == null) return;

      results[sku] = {
        marketplace: "amazon",
        sku,
        price,
        competitorCount: Math.max(0, products.length - 1),
        buyBoxEligible: true,
        confidence: confidenceFromSimilarity(bestSimilarity),
        // `product_url` normalmente vem preenchido (ver amostra pública da
        // API), mas não é documentado como garantido em 100% dos
        // resultados — cai pro `asin` (chave primária do produto,
        // praticamente sempre presente num item de busca) construindo o
        // link direto pro domínio BR, já que a busca já pede
        // `country=BR` acima. Sem esse fallback, um resultado sem
        // `product_url` mostrava foto (via imageUrl/row.imageUrl) mas
        // ficava sem o botão "Ver anúncio" — o bug relatado.
        link: best.product_url ?? (best.asin ? `https://www.amazon.com.br/dp/${best.asin}` : undefined),
        matchedTitle: best.product_title,
        imageUrl: best.product_photo,
      };
    } catch (err) {
      errorCount++;
      lastApiError = err instanceof Error ? err.message : String(err);
      console.error(`RapidAPI (Amazon) falhou pra "${name}":`, err);
    }
  });

  // Mesmo critério de propagação de erro sistêmico do googleShoppingProvider.ts:
  // só lança se TODOS os itens do lote falharam (chave inválida/sem
  // assinatura/sem cota) — um produto isolado sem match fica silencioso.
  if (items.length > 0 && errorCount === items.length && lastApiError) {
    throw new Error(lastApiError);
  }

  return results;
}
