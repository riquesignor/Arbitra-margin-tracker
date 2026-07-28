import type { PlanId } from "../types";

export interface PlanDefinition {
  id: PlanId;
  name: string;
  priceLabel: string;
  description: string;
}

export const DEFAULT_PLAN_ID: PlanId = "iniciante";

/**
 * Definição dos planos (base do sistema — Fase Planos). Deliberadamente
 * simples pro MVP: sem billing, sem enforcement de "quantos PDFs" (isso
 * é consequência de quantos catálogos o admin atribuiu ao plano em
 * `shared_catalogs`, não uma regra codificada aqui). Atribuição de plano
 * por usuário é manual (painel Admin ou Firestore direto) — sem
 * assinatura automática nesta fase.
 *
 * Sem `dailySearchLimit`: cota de busca deixou de ser responsabilidade
 * do plano depois que o modelo virou BYOK obrigatório (cada usuário usa
 * a própria chave SerpApi, cadastrada em Conta — ver userSecrets.ts).
 * Não existe mais chave compartilhada do servidor pra proteger com um
 * limite arbitrário; a cota real de cada usuário é a da própria conta
 * SerpApi dele. `usageQuota.ts` continua existindo só como contador
 * informativo ("N buscas hoje"), sem bloquear nada.
 */
export const PLANS: PlanDefinition[] = [
  {
    id: "iniciante",
    name: "Iniciante",
    priceLabel: "Grátis",
    description: "Acesso a uma seleção básica da biblioteca de catálogos.",
  },
  {
    id: "profissional",
    name: "Profissional",
    priceLabel: "Sob consulta",
    description: "Mais catálogos liberados na biblioteca de compartilhados.",
  },
];

export function getPlan(id: PlanId | null | undefined): PlanDefinition {
  return PLANS.find((p) => p.id === id) ?? PLANS[0];
}
