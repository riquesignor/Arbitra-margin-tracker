/**
 * Chave geral da cobrança (nov/2026): o Arbitra roda como projeto gratuito
 * e beneficente, e o código de assinatura (Mercado Pago) fica DORMENTE —
 * mantido de propósito pra poder ser religado depois. Desligado por
 * padrão: só `BILLING_ENABLED=true` (ou `1`) liga.
 *
 * Mora aqui (e não só em src/config) porque `tsconfig.api.json` só enxerga
 * `api/` — o espelho do cliente é `VITE_BILLING_ENABLED`, ver
 * src/config/billing.ts. MANTER AS DUAS SEMÂNTICAS EM SINCRONIA.
 */
export function isBillingEnabled(env: Record<string, string | undefined> = process.env): boolean {
  const value = env.BILLING_ENABLED?.trim().toLowerCase();
  return value === "true" || value === "1";
}

/** Resposta única das rotas de cobrança com a chave desligada — sem detalhe técnico nem nome de variável. */
export const BILLING_DISABLED_MESSAGE = "Cobrança indisponível nesta versão.";
