/**
 * Modo gratuito (nov/2026): com a cobrança desligada (`BILLING_ENABLED`,
 * ver billingMode.ts) o Arbitra é um projeto gratuito e beneficente — todo
 * usuário tem todos os recursos e UM único limite, igual pra todos: buscas
 * por dia. Nada aqui grava no Firestore nem mexe no plano salvo de
 * ninguém: é só a regra que RESOLVE o plano efetivo na hora da checagem,
 * então religar a cobrança devolve o comportamento original.
 *
 * Espelho do cliente: src/config/limits.ts (tsconfig.api.json só enxerga
 * api/). MANTER O PADRÃO (100) EM SINCRONIA.
 */

export const DEFAULT_DAILY_SEARCH_LIMIT = 100;

/** Teto de sanidade do override por variável de ambiente — impede um valor absurdo (ou erro de digitação) de desligar o limite na prática. */
const MAX_DAILY_SEARCH_LIMIT = 100_000;

/**
 * Limite diário de buscas por usuário no modo gratuito: `DAILY_SEARCH_LIMIT`
 * (opcional) ou 100. Valor ausente, não numérico, não inteiro, zero,
 * negativo ou acima do teto de sanidade cai no padrão — nunca em "sem limite".
 */
export function getDailySearchLimit(env: Record<string, string | undefined> = process.env): number {
  const raw = env.DAILY_SEARCH_LIMIT?.trim();
  if (!raw || !/^\d+$/.test(raw)) return DEFAULT_DAILY_SEARCH_LIMIT;
  const parsed = Number(raw);
  return parsed >= 1 && parsed <= MAX_DAILY_SEARCH_LIMIT ? parsed : DEFAULT_DAILY_SEARCH_LIMIT;
}

/** Mensagem do 429 no modo gratuito. */
export function dailyLimitMessage(limit: number): string {
  return `Limite diário de ${limit} buscas atingido. Volta amanhã, a partir da meia-noite no horário de Brasília.`;
}
