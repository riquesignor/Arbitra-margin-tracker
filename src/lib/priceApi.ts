import type { CatalogItemQuery, MarketplaceId, MarketplacePriceResult, SearchProviderId } from "../types";
import { getProvider } from "./marketplaces/registry";
import { getCurrentIdToken } from "./auth";

/**
 * "server"  → veio do /api/fetch-prices (passou pelo cache Firestore)
 * "local"   → resolvido no client direto (provider local) — pode ser
 *             busca real (ex: Mercado Livre) ou simulada (ex: Amazon
 *             mock), depende do provider; não confundir com "fake".
 */
export type PriceSource = "server" | "local";

export interface FetchPricesResult {
  results: Record<string, MarketplacePriceResult>;
  source: PriceSource;
}

function emptyResult(marketplaces: MarketplaceId[]): Record<MarketplaceId, FetchPricesResult> {
  return Object.fromEntries(
    marketplaces.map((m) => [m, { results: {}, source: "local" as const }])
  ) as Record<MarketplaceId, FetchPricesResult>;
}

async function fallbackToLocalMock(
  marketplaces: MarketplaceId[],
  items: CatalogItemQuery[]
): Promise<Record<MarketplaceId, FetchPricesResult>> {
  const out = {} as Record<MarketplaceId, FetchPricesResult>;
  for (const marketplace of marketplaces) {
    try {
      const provider = getProvider(marketplace);
      const results = await provider.fetchPrices(items);
      out[marketplace] = { results, source: "local" };
    } catch (err) {
      console.error(`Provider local falhou pra "${marketplace}":`, err);
      out[marketplace] = { results: {}, source: "local" };
    }
  }
  return out;
}

/**
 * Busca preço pra vários marketplaces numa chamada HTTP só (contrato
 * mudou de singular pra plural — ver docs/architecture-review.md item
 * 15: Amazon + Mercado Livre compartilham a mesma busca no Google
 * Shopping/SerpApi no servidor, então uma chamada por produto já cobre
 * os dois, em vez de uma por produto POR marketplace).
 *
 * Tenta a Edge Function real (/api/fetch-prices) — só existe de verdade
 * rodando `vercel dev` ou deployado; `npm run dev` (Vite puro) não serve
 * essa rota.
 *
 * Duas falhas MUITO diferentes, tratadas diferente de propósito:
 * - `fetch()` em si falha (endpoint inalcançável — só acontece em
 *   `npm run dev` puro, sem `vercel dev`) → cai no provider mock local,
 *   só pra não travar o teste de UI sem servidor.
 * - `fetch()` responde, mas com erro (401 sem sessão válida, chave
 *   SerpApi/RapidAPI inválida/sem cota, validação) → PROPAGA o erro real
 *   pro chamador. Cair no mock aqui seria mostrar preço fabricado como
 *   se fosse real justamente quando a causa é a própria chave BYOK do
 *   usuário — o pior momento possível pra mascarar o problema.
 *
 * `provider` (default "serpapi" no servidor se omitido) escolhe qual API
 * resolve o preço — ver SearchProviderId em ../types e o comentário no
 * topo de api/fetch-prices.ts. `apiKey` é sempre a chave DO PROVIDER
 * escolhido (SerpApi ou RapidAPI) — Mercado Livre direto não usa chave.
 */
export async function fetchMultipleMarketplacePrices(
  marketplaces: MarketplaceId[],
  items: CatalogItemQuery[],
  apiKey?: string | null,
  provider?: SearchProviderId
): Promise<Record<MarketplaceId, FetchPricesResult>> {
  if (items.length === 0 || marketplaces.length === 0) {
    return emptyResult(marketplaces);
  }

  let response: Response;
  try {
    // Servidor exige Authorization: Bearer <idToken> (ver verifyAuth.ts).
    const idToken = await getCurrentIdToken();
    response = await fetch("/api/fetch-prices", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(idToken ? { Authorization: `Bearer ${idToken}` } : {}),
      },
      body: JSON.stringify({ marketplaces, items, apiKey: apiKey || undefined, provider }),
    });
  } catch {
    return fallbackToLocalMock(marketplaces, items);
  }

  if (!response.ok) {
    let detail = `Edge Function retornou ${response.status}`;
    try {
      const body = (await response.json()) as { error?: string; detail?: string };
      detail = body.detail || body.error || detail;
    } catch {
      // Resposta não veio como JSON — mantém a mensagem genérica acima.
    }
    throw new Error(detail);
  }

  const body = (await response.json()) as Record<string, Record<string, MarketplacePriceResult>>;
  const out = {} as Record<MarketplaceId, FetchPricesResult>;
  for (const marketplace of marketplaces) {
    out[marketplace] = { results: body[marketplace] ?? {}, source: "server" };
  }
  return out;
}
