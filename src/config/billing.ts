/**
 * Chave geral da cobrança (nov/2026) — espelho client-side de
 * `BILLING_ENABLED` (api/_lib/billingMode.ts). O Arbitra roda como
 * projeto gratuito e beneficente: o código de assinatura e de planos fica
 * DORMENTE (mantido pra poder ser religado), e só `VITE_BILLING_ENABLED=true`
 * liga. Desligado por padrão.
 *
 * ⚠️ Variável `VITE_*` é lida NO BUILD (o Vite troca o valor no bundle) —
 * mudar na Vercel só vale depois de um novo deploy/build.
 */
export function parseBillingFlag(value: string | undefined): boolean {
  const normalized = value?.trim().toLowerCase();
  return normalized === "true" || normalized === "1";
}

export const BILLING_ENABLED = parseBillingFlag(import.meta.env.VITE_BILLING_ENABLED as string | undefined);
