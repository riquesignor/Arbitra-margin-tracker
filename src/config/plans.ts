import type { PlanId } from "../types";
import { BILLING_ENABLED } from "./billing";
import { DAILY_SEARCH_LIMIT } from "./limits";

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
  /**
   * Quantos produtos o plano pode ter em monitoramento contínuo ao mesmo
   * tempo (out/2026, ver src/lib/watchlist.ts). Este SIM é enforcement de
   * verdade (checado em startWatching e de novo no cron) — diferente de
   * `dailySearchLimit`: cada watch ativo gasta a cota BYOK do dono todo
   * dia sozinho, sem o usuário pedir, então o teto existe pra isso não
   * crescer sem controle, não só como referência visual.
   */
  maxWatches: number;
  /**
   * Recursos de plano pago (out/2026) — um lugar só pra decidir quem tem
   * o quê. `api/_lib/planFeatures.ts` espelha estes valores no servidor
   * (tsconfig.api.json não enxerga src/) — MANTER EM SINCRONIA.
   */
  features: PlanFeatures;
}

export interface PlanFeatures {
  /** Tela "Assistente": foto de um produto → preço de mercado + preço sugerido + conversa com IA. */
  productAssistant: boolean;
  /** Checagem diária automática dos produtos monitorados (cron), opt-in em Configurações. */
  autoWatchCheck: boolean;
  /** Relatório imprimível/PDF dos resultados. */
  printableReport: boolean;
  /** Quantos registros de busca a lista de histórico carrega. */
  historyLimit: number;
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
    maxWatches: 10,
    features: { productAssistant: false, autoWatchCheck: false, printableReport: false, historyLimit: 50 },
  },
  {
    id: "starter",
    name: "Starter",
    priceLabel: "Sob consulta",
    description: "Mais catálogos liberados e um teto diário de busca maior.",
    dailySearchLimit: 200,
    maxWatches: 50,
    features: { productAssistant: false, autoWatchCheck: false, printableReport: true, historyLimit: 100 },
  },
  {
    id: "pro",
    name: "Pro",
    priceLabel: "Sob consulta",
    description: "Biblioteca completa e o maior teto diário de busca.",
    dailySearchLimit: 500,
    maxWatches: 200,
    features: { productAssistant: true, autoWatchCheck: true, printableReport: true, historyLimit: 200 },
  },
];

export function getPlan(id: PlanId | null | undefined): PlanDefinition {
  return PLANS.find((p) => p.id === id) ?? PLANS[0];
}

/**
 * Plano EFETIVO — é este que a interface (e, no servidor, as rotas) deve
 * consultar pra saber o que o usuário pode fazer. Com a cobrança ligada é
 * o plano salvo, igual sempre foi. Com a cobrança desligada (modo
 * gratuito, nov/2026) todo mundo tem TODOS os recursos: recursos, teto de
 * monitorados e de histórico do plano "pro" (nada ilimitado) e o limite
 * diário único de buscas.
 *
 * Só resolve na hora: NÃO grava nada e NÃO mexe no plano salvo, então
 * religar a cobrança devolve o comportamento original pra todo mundo.
 * `id` segue sendo o do plano salvo (a biblioteca de catálogos continua
 * liberada por ele). Espelho no servidor: api/_lib/planFeatures.ts +
 * api/_lib/freeMode.ts.
 */
export function getEffectivePlan(
  id: PlanId | null | undefined,
  billingEnabled: boolean = BILLING_ENABLED,
  dailySearchLimit: number = DAILY_SEARCH_LIMIT
): PlanDefinition {
  const saved = getPlan(id);
  if (billingEnabled) return saved;
  const pro = PLANS.find((p) => p.id === "pro")!;
  return {
    ...pro,
    id: saved.id,
    name: "Gratuito",
    priceLabel: "Grátis",
    description: "Projeto gratuito: todos os recursos, com um limite diário de buscas igual pra todo mundo.",
    dailySearchLimit,
  };
}
