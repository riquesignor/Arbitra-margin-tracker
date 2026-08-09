import type { PlanId } from "../types";

export interface PlanDefinition {
  id: PlanId;
  name: string;
  priceLabel: string;
  description: string;
  /**
   * Limite diário de buscas exibido na barra de cota (Nova busca, Conta)
   * — INFORMATIVO, não bloqueante. Cota real de cada usuário é a da
   * própria conta SerpApi dele (BYOK, ver userSecrets.ts); isto só dá
   * uma referência visual de ritmo de uso, na mesma linha do resto do
   * app: nunca trava a busca, só avisa (badge `!` a partir de 80%, ver
   * design-tokens.md § Regras de tela adicionadas).
   */
  dailySearchLimit: number;
}

export const DEFAULT_PLAN_ID: PlanId = "free";

/**
 * Definição dos planos (base do sistema — Fase Planos). Deliberadamente
 * simples pro MVP: sem billing, sem enforcement de "quantos PDFs" (isso
 * é consequência de quantos catálogos o admin atribuiu ao plano em
 * `shared_catalogs`, não uma regra codificada aqui). Atribuição de plano
 * por usuário é manual (painel Admin ou Firestore direto) — sem
 * assinatura automática nesta fase (ver Configurações → Pagamento, "em
 * preparação").
 *
 * 3 níveis (Free/Starter/Pro, ver design/Arbitra Refine.dc.html) — antes
 * eram 2 (Iniciante/Profissional); Starter é novo, cobre o meio do funil
 * entre o plano grátis e o plano sob consulta.
 */
export const PLANS: PlanDefinition[] = [
  {
    id: "free",
    name: "Free",
    priceLabel: "Grátis",
    description: "Acesso a uma seleção básica da biblioteca de catálogos.",
    dailySearchLimit: 50,
  },
  {
    id: "starter",
    name: "Starter",
    priceLabel: "Sob consulta",
    description: "Mais catálogos liberados e um teto diário de busca maior.",
    dailySearchLimit: 200,
  },
  {
    id: "pro",
    name: "Pro",
    priceLabel: "Sob consulta",
    description: "Biblioteca completa e o maior teto diário de busca.",
    dailySearchLimit: 500,
  },
];

export function getPlan(id: PlanId | null | undefined): PlanDefinition {
  return PLANS.find((p) => p.id === id) ?? PLANS[0];
}
