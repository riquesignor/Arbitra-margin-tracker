import { getAdminDb } from "./firestoreAdmin.js";
import type { SearchProviderId } from "./types.js";

/**
 * ══════════════════════════════════════════════════════════════════════
 * COTA DE BUSCA — ENFORCEMENT NO SERVIDOR
 * ══════════════════════════════════════════════════════════════════════
 *
 * Brecha real corrigida (set/2026, ver docs/auditoria-2026-09.md > P0-3):
 * a cota diária existia SÓ no cliente (src/lib/usageQuota.ts + o gate em
 * Dashboard.tsx), e quem incrementava o contador era o próprio navegador
 * do usuário — que ainda por cima podia zerá-lo, já que a security rule
 * dá `write` do doc pro dono. Ou seja: nenhum teto real.
 *
 * Isso importa porque nem todo provider é BYOK. `scraperapi`,
 * `vision_internal` e `vision_mistral` consomem `SCRAPERAPI_KEY` —
 * crédito do DONO da plataforma (busca estruturada e/ou proxy anti-bloqueio
 * do motor interno, ver internalSearchProvider.ts e
 * scraperApiSearchProvider.ts). Sem teto no servidor, qualquer conta
 * criada gastava esse crédito sem limite.
 *
 * Dois tetos, por isso:
 *   - Provider que gasta crédito da PLATAFORMA → teto do plano do usuário
 *     (os mesmos números que a barra de cota já mostra na tela, pra não
 *     criar duas verdades diferentes).
 *   - Provider BYOK (usuário paga a própria chave) → teto alto, só como
 *     freio de abuso/loop infinito, não como regra de negócio.
 *
 * O contador é o MESMO doc que o cliente já lia
 * (`users/{uid}/usage_daily/{yyyymmdd}`, campo `searchCount`) — a barra de
 * cota continua funcionando sem mudança. A diferença é que agora quem
 * escreve é o servidor, dentro de uma transaction, e o cliente parou de
 * incrementar (senão contaria em dobro).
 */

export class QuotaExceededError extends Error {
  constructor(
    message: string,
    readonly used: number,
    readonly limit: number
  ) {
    super(message);
  }
}

/**
 * Providers cuja busca é paga pela PLATAFORMA (via `SCRAPERAPI_KEY`), não
 * pela chave do usuário:
 *   - "scraperapi"      → Structured Data Endpoints da ScraperAPI.
 *   - "vision_internal" / "vision_mistral" → a IA é BYOK, mas a raspagem
 *     Amazon/ML passa pelo proxy ScraperAPI (premium) e a busca geral usa
 *     o Google Shopping da ScraperAPI — os dois no crédito da plataforma.
 */
const PLATFORM_COST_PROVIDERS = new Set<SearchProviderId>([
  "scraperapi",
  "vision_internal",
  "vision_mistral",
]);

/** Espelha `dailySearchLimit` de src/config/plans.ts — MANTER EM SINCRONIA (arquivos duplicados de propósito: client e api têm tsconfigs separados, ver api/_lib/types.ts). */
const PLAN_DAILY_LIMIT: Record<string, number> = {
  free: 50,
  starter: 200,
  pro: 500,
};
const DEFAULT_PLAN_LIMIT = PLAN_DAILY_LIMIT.free;

/**
 * Teto pra provider BYOK: alto de propósito — quem paga a busca é o
 * usuário, então o papel deste número é só impedir loop/abuso automatizado
 * (um catálogo real grande, 4.500 produtos × 2 marketplaces, dá 9.000 —
 * ainda cabe, e um segundo catálogo do mesmo tamanho no mesmo dia também).
 */
const BYOK_DAILY_LIMIT = 25000;

/**
 * Chave do dia no fuso de São Paulo (não UTC nem fuso do servidor): o
 * cliente monta a mesma chave com a data LOCAL do navegador (ver
 * usageQuota.ts), e a base de usuários é BR — usar UTC faria a cota
 * "virar" às 21h pro usuário, o que pareceria bug.
 */
export function todayKeyBrazil(now = new Date()): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Sao_Paulo",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(now);
  return parts.replace(/-/g, ""); // "2026-09-03" -> "20260903"
}

async function getPlanLimit(uid: string, provider: SearchProviderId): Promise<number> {
  if (!PLATFORM_COST_PROVIDERS.has(provider)) return BYOK_DAILY_LIMIT;

  try {
    const snap = await getAdminDb().collection("users").doc(uid).get();
    const plan = snap.data()?.plan as string | undefined;
    return PLAN_DAILY_LIMIT[plan ?? ""] ?? DEFAULT_PLAN_LIMIT;
  } catch (err) {
    // Perfil ilegível (rede, doc ausente): assume o plano mais restritivo
    // em vez de liberar geral — falha fechada, não aberta.
    console.warn(`[quota] não consegui ler o plano de ${uid}, assumindo o teto do plano free:`, err);
    return DEFAULT_PLAN_LIMIT;
  }
}

export interface QuotaConsumption {
  used: number;
  limit: number;
}

/**
 * Reserva `amount` unidades de busca do dia e devolve o novo total.
 * Lança `QuotaExceededError` (traduzido pra HTTP 429 em fetch-prices.ts)
 * quando a reserva estouraria o teto — ANTES de gastar API nenhuma.
 *
 * A unidade é a mesma que a UI já usa: 1 produto × 1 marketplace (ver
 * `searchCost` em Dashboard.tsx), pra barra de cota e enforcement falarem
 * o mesmo idioma.
 *
 * Transaction (não `increment` solto) porque a decisão de bloquear depende
 * do valor lido: duas requisições simultâneas no limite precisam ser
 * serializadas, senão as duas leem "49/50" e as duas passam.
 */
export async function consumeSearchQuota(
  uid: string,
  provider: SearchProviderId,
  amount: number
): Promise<QuotaConsumption> {
  const limit = await getPlanLimit(uid, provider);
  const db = getAdminDb();
  const ref = db.collection("users").doc(uid).collection("usage_daily").doc(todayKeyBrazil());

  return db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    const current = (snap.data()?.searchCount as number | undefined) ?? 0;
    const next = current + amount;

    if (next > limit) {
      throw new QuotaExceededError(
        `Cota diária de buscas atingida (${current}/${limit}). ` +
          (PLATFORM_COST_PROVIDERS.has(provider)
            ? "Este mecanismo é pago pela plataforma — troque pra um mecanismo com chave própria (SerpApi/SearchApi.io em Conta) ou tente de novo amanhã."
            : "Tente de novo amanhã ou processe um intervalo menor do catálogo."),
        current,
        limit
      );
    }

    tx.set(ref, { searchCount: next, updatedAt: Date.now() }, { merge: true });
    return { used: next, limit };
  });
}
