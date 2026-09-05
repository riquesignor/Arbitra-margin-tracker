import type {
  CatalogItemQuery,
  MarketplaceId,
  MarketplacePriceResult,
  SearchProviderId,
  VisionCandidateSource,
} from "../types";
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
  /**
   * Contador de cota do dia devolvido pelo SERVIDOR (`_usage`, ver
   * api/_lib/searchQuota.ts, set/2026) — `used` já inclui o custo desta
   * requisição. Substituiu o incremento client-side (que era a única
   * contagem existente e, por isso, não valia como cota de verdade).
   * `undefined` quando o servidor não conseguiu reservar (falha de
   * infraestrutura no contador — a busca segue, só sem número novo).
   */
  usage?: { used: number; limit: number };
  /**
   * Aviso de cota/qualidade do motor interno + IA (ver
   * api/_lib/providers/visionInternalSearchProvider.ts) — só vem
   * preenchido quando `provider === "vision_internal"` E a cota do Gemini
   * esgotou no meio do lote, ou o lote inteiro terminou vazio por causa
   * diagnosticável (sem candidato / candidato rejeitado por nota visual
   * baixa). `undefined` no resto dos casos (comportamento comum). O mesmo
   * aviso, se existir, é replicado em TODOS os marketplaces desta chamada
   * (é um aviso global da busca, não por marketplace) — quem consome
   * (Dashboard.tsx) só precisa olhar um deles.
   */
  warning?: string;
  /**
   * Por que CADA produto voltou sem preço (`_reasons`, ver
   * api/_lib/searchMissReasons.ts, set/2026) — mapa SKU → razão. Antes
   * disso a explicação existia só no nível do lote e o produto sumia da
   * tela sem rastro. Repetido em todos os marketplaces do retorno (é um
   * diagnóstico global da requisição, igual `warning`).
   */
  reasons?: Record<string, MissReason>;
}

/** Ver api/_lib/searchMissReasons.ts — mantido em sincronia com o servidor. */
export type MissReason = "sem_foto" | "cota_ia" | "sem_candidato";

/**
 * Texto de cada razão na tela. Duplicado do servidor de propósito: o
 * bundle do cliente não importa de `api/` (contextos de build diferentes),
 * e é a mesma escolha já feita pros outros rótulos espelhados.
 */
export const MISS_REASON_LABEL: Record<MissReason, string> = {
  sem_foto: "sem foto no catálogo (o mecanismo escolhido busca por imagem)",
  cota_ia: "a cota de IA esgotou antes de chegar neles",
  sem_candidato: "nenhum anúncio parecido encontrado",
};

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
 * `provider` (default "scraperapi" no servidor se omitido) escolhe qual
 * API resolve o preço — ver SearchProviderId em ../types e o comentário
 * no topo de api/fetch-prices.ts.
 *
 * ⚠️ A chave BYOK NÃO trafega mais por aqui (set/2026, ver
 * api/_lib/userSecrets.ts e docs/auditoria-2026-09.md > P0-4): o servidor
 * lê a chave do usuário direto do Firestore, usando o uid do próprio
 * token. Antes o navegador lia as chaves em texto puro e as reenviava em
 * toda requisição — um XSS no app levava as seis de uma vez. Se você está
 * lendo isto pensando em "só passar a chave aqui", não passe: quebra
 * justamente a correção.
 */
export async function fetchMultipleMarketplacePrices(
  marketplaces: MarketplaceId[],
  items: CatalogItemQuery[],
  provider?: SearchProviderId,
  /**
   * Cancelamento da busca em andamento (set/2026, ver
   * docs/auditoria-2026-09.md > item 19). Catálogo grande roda por
   * minutos; até aqui a única saída era recarregar a página — e perder
   * tudo que já tinha sido encontrado.
   */
  signal?: AbortSignal,
  /**
   * Fonte de candidato pro motor interno + IA (set/2026, ver
   * VisionCandidateSource em ../types e o pop-up de seleção em
   * Dashboard.tsx) — só faz sentido junto de `provider` "vision_internal"/
   * "vision_mistral"; `undefined` (comportamento de sempre, cascata
   * automática) pros demais.
   */
  candidateSource?: VisionCandidateSource
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
      body: JSON.stringify({ marketplaces, items, provider, candidateSource }),
      signal,
    });
  } catch (err) {
    // Cancelamento NÃO é "endpoint inalcançável": cair no mock local aqui
    // devolveria preço fabricado justamente quando o usuário mandou parar.
    if (err instanceof DOMException && err.name === "AbortError") throw err;
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

  const body = (await response.json()) as Record<string, Record<string, MarketplacePriceResult>> & {
    _warning?: string;
    _usage?: { used: number; limit: number };
    _reasons?: Record<string, MissReason>;
  };
  const out = {} as Record<MarketplaceId, FetchPricesResult>;
  for (const marketplace of marketplaces) {
    out[marketplace] = {
      results: body[marketplace] ?? {},
      source: "server",
      warning: body._warning,
      usage: body._usage,
      reasons: body._reasons,
    };
  }
  return out;
}
