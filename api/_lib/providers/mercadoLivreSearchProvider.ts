import type { CatalogItemQuery, MarketplacePriceResult } from "../types.js";
import type { ServerPriceProvider } from "./types.js";
import type { ScrapedOffer } from "./internalSearchProvider.js";
import { getMlAccessToken } from "../mlAuth.js";

const SEARCH_URL = "https://api.mercadolibre.com/sites/MLB/search";
const CONCURRENCY = 5;

interface MLSearchItem {
  id: string;
  title: string;
  price: number;
  permalink: string;
  thumbnail?: string;
  /** Sinal de popularidade do ML — vendas, não avaliação (ver mercadoLivreDirectProvider.ts, mesmo mapeamento pra `reviewCount`). */
  sold_quantity?: number;
}

interface MLSearchResponse {
  results?: MLSearchItem[];
  paging?: { total?: number };
}

/** Roda no máximo `limit` chamadas em paralelo, pra não estourar rate limit da API. */
async function mapWithConcurrency<T, R>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<R>
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let cursor = 0;

  async function worker() {
    while (cursor < items.length) {
      const i = cursor++;
      results[i] = await fn(items[i]);
    }
  }

  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

/**
 * Busca real na API do Mercado Livre — AUTENTICADA via OAuth (ver
 * `api/_lib/mlAuth.ts`). Confirmado na documentação oficial
 * (developers.mercadolivre.com.br/en_us/items-and-searches) que
 * `/sites/$SITE_ID/search?q=...` exige `Authorization: Bearer
 * $ACCESS_TOKEN` — chamada sem esse header retorna 403 hoje em dia
 * (era pública antes; a Amazon nunca teve esse mock com token, ver
 * mockProvider). Setup do token: `scripts/ml-oauth-setup.mjs` (ver
 * README).
 *
 * Confiança fica em 0.55: é match por texto (nome do catálogo → título
 * do anúncio), não garantia de ser o mesmo produto — por isso o
 * `matchedTitle` sempre volta junto, pra conferência manual.
 */
export function createMercadoLivreSearchProvider(): ServerPriceProvider {
  return {
    id: "mercadolivre",
    async fetchPrices(items: CatalogItemQuery[]) {
      const accessToken = await getMlAccessToken();
      const results: Record<string, MarketplacePriceResult> = {};

      await mapWithConcurrency(items, CONCURRENCY, async ({ sku, name }) => {
        try {
          const url = `${SEARCH_URL}?q=${encodeURIComponent(name)}&limit=1`;
          const response = await fetch(url, {
            headers: { Authorization: `Bearer ${accessToken}` },
          });

          if (!response.ok) {
            console.warn(`Busca ML "${name}" (${sku}) retornou ${response.status}`);
            return;
          }

          const data = (await response.json()) as MLSearchResponse;
          const match = data.results?.[0];
          if (!match) return;

          results[sku] = {
            marketplace: "mercadolivre",
            sku,
            price: match.price,
            competitorCount: Math.max(0, (data.paging?.total ?? 1) - 1),
            buyBoxEligible: true,
            confidence: 0.55,
            link: match.permalink,
            matchedTitle: match.title,
            imageUrl: match.thumbnail,
          };
        } catch (err) {
          console.error(`Busca Mercado Livre falhou pra "${name}":`, err);
        }
      });

      return results;
    },
  };
}

/**
 * CANDIDATOS OFICIAIS DO ML PRA DENTRO DO MOTOR INTERNO (set/2026)
 * ══════════════════════════════════════════════════════════════════════
 * Reaproveita EXATAMENTE a mesma chamada autenticada de
 * `createMercadoLivreSearchProvider` acima — só devolve no formato
 * `ScrapedOffer` (mesmo shape da raspagem, ver internalSearchProvider.ts)
 * em vez de já montar `MarketplacePriceResult`, pra plugar como fonte de
 * candidato em `fetchCandidateOffers` (visionInternalSearchProvider.ts),
 * do jeito que `fetchAmazonCandidatesForQuery`
 * (scraperApiSearchProvider.ts) já faz pro lado Amazon.
 *
 * Fonte OFICIAL e GRATUITA — sem custo por chamada, diferente do
 * substituto atual (Google Shopping estruturado, 25 créditos ScraperAPI).
 * Mas ainda ATRÁS de dois gates que não são deste arquivo:
 *
 *   1. `getMlAccessToken()` lança se o OAuth nunca foi configurado
 *      (`scripts/ml-oauth-setup.mjs`) — e a ativação esbarra em
 *      "validação de titularidade" no DevCenter do Mercado Livre, um
 *      passo humano/de negócio, não algo que este código resolve. Por
 *      isso o try/catch abaixo: OAuth ausente vira `[]`, igual "chave não
 *      configurada" nas outras fontes opcionais — quem chama cai pro
 *      próximo degrau (hoje, Google Shopping estruturado).
 *   2. Mesmo com token válido, há relatos reais (Reclame Aqui, desde
 *      fev/2026) de HTTP 403 nesse endpoint específico SEM explicação
 *      oficial do Mercado Livre — ver mercadoLivreDirectProvider.ts. Por
 *      isso qualquer erro aqui (403 incluso) também vira `[]`: não dá pra
 *      distinguir com certeza "problema de conta" de "instabilidade
 *      conhecida do endpoint", e travar o fallback esperando resolver
 *      isso quebraria a promessa de "fonte opcional, uma a menos não
 *      derruba o item".
 */
export async function fetchMlOfficialCandidatesForQuery(query: string): Promise<ScrapedOffer[]> {
  let accessToken: string;
  try {
    accessToken = await getMlAccessToken();
  } catch (err) {
    console.warn(`Mercado Livre (API oficial OAuth) indisponível pra "${query}":`, err);
    return [];
  }

  try {
    const url = `${SEARCH_URL}?q=${encodeURIComponent(query)}&limit=5`;
    const response = await fetch(url, { headers: { Authorization: `Bearer ${accessToken}` } });
    if (!response.ok) {
      console.warn(`Mercado Livre (API oficial OAuth, candidatos) "${query}" retornou ${response.status}`);
      return [];
    }

    const data = (await response.json()) as MLSearchResponse;
    return (data.results ?? [])
      .filter((r): r is MLSearchItem & { price: number } => r.price != null)
      .map((r) => ({
        title: r.title,
        price: r.price,
        link: r.permalink,
        thumbnail: r.thumbnail,
        reviewCount: r.sold_quantity,
      }));
  } catch (err) {
    console.warn(`Mercado Livre (API oficial OAuth, candidatos) falhou pra "${query}":`, err);
    return [];
  }
}
