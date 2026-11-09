/**
 * Limite diário de buscas do modo gratuito (nov/2026, cobrança desligada —
 * ver src/config/billing.ts). Quem APLICA o limite é sempre o servidor
 * (api/_lib/searchQuota.ts); isto aqui só alimenta o que a interface
 * mostra ("X de 100 buscas hoje") quando o servidor ainda não respondeu.
 *
 * Espelho de `DEFAULT_DAILY_SEARCH_LIMIT` em api/_lib/freeMode.ts
 * (tsconfig.api.json só enxerga api/) — MANTER O PADRÃO (100) EM
 * SINCRONIA. O override opcional é `VITE_DAILY_SEARCH_LIMIT` (lido no
 * build) e deve ter o mesmo valor de `DAILY_SEARCH_LIMIT` do servidor.
 */
export const DEFAULT_DAILY_SEARCH_LIMIT = 100;

const MAX_DAILY_SEARCH_LIMIT = 100_000;

/** Mesmas regras do servidor: inteiro positivo dentro do teto de sanidade, senão o padrão — nunca "sem limite". */
export function parseDailySearchLimit(value: string | undefined): number {
  const raw = value?.trim();
  if (!raw || !/^\d+$/.test(raw)) return DEFAULT_DAILY_SEARCH_LIMIT;
  const parsed = Number(raw);
  return parsed >= 1 && parsed <= MAX_DAILY_SEARCH_LIMIT ? parsed : DEFAULT_DAILY_SEARCH_LIMIT;
}

export const DAILY_SEARCH_LIMIT = parseDailySearchLimit(import.meta.env.VITE_DAILY_SEARCH_LIMIT as string | undefined);
