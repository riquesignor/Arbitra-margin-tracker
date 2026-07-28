import type { CatalogItemQuery, MarketplaceId, MarketplacePriceResult } from "../types";
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

/**
 * Busca preço pra vários marketplaces numa chamada HTTP só (contrato
 * mudou de singular pra plural — ver docs/architecture-review.md item
 * 15: Amazon + Mercado Livre compartilham a mesma busca no Google
 * Shopping/SerpApi no servidor, então uma chamada por produto já cobre
 * os dois, em vez de uma por produto POR marketplace).
 *
 * Tenta a Edge Function real (/api/fetch-prices) — só existe de verdade
 * rodando `vercel dev` ou deployado; `npm run dev` (Vite puro) não serve
 * essa rota, então localmente isso SEMPRE cai no catch abaixo, resolvendo
 * cada marketplace via provider mock registrado no client (mesmo
 * contrato de dados, sem chamada de rede real).
 *
 * A chamada ao servidor é atômica: ou responde 200 com todos os
 * marketplaces pedidos (source "server" pra todos), ou falha e cai no
 * fallback local pra todos — não existe hoje um cenário de sucesso
 * parcial dentro da mesma requisição.
 */
export async function fetchMultipleMarketplacePrices(
  marketplaces: MarketplaceId[],
  items: CatalogItemQuery[],
  apiKey?: string | null
): Promise<Record<MarketplaceId, FetchPricesResult>> {
  if (items.length === 0 || marketplaces.length === 0) {
    return emptyResult(marketplaces);
  }

  try {
    // Servidor exige Authorization: Bearer <idToken> (ver verifyAuth.ts) —
    // sem token válido, responde 401 e cai no catch abaixo (provider
    // local). Ver docs/architecture-review.md > Segurança.
    const idToken = await getCurrentIdToken();
    const response = await fetch("/api/fetch-prices", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(idToken ? { Authorization: `Bearer ${idToken}` } : {}),
      },
      body: JSON.stringify({ marketplaces, items, apiKey: apiKey || undefined }),
    });

    if (!response.ok) {
      throw new Error(`Edge Function retornou ${response.status}`);
    }

    const body = (await response.json()) as Record<string, Record<string, MarketplacePriceResult>>;
    const out = {} as Record<MarketplaceId, FetchPricesResult>;
    for (const marketplace of marketplaces) {
      out[marketplace] = { results: body[marketplace] ?? {}, source: "server" };
    }
    return out;
  } catch {
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
}
