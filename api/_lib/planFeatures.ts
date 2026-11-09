import { getAdminDb } from "./firestoreAdmin.js";
import { isBillingEnabled } from "./billingMode.js";

/**
 * Espelho server-side de `features` em src/config/plans.ts — MANTER EM
 * SINCRONIA (tsconfig.api.json só enxerga api/, mesmo motivo do
 * PLAN_DAILY_LIMIT em searchQuota.ts). O cliente esconde a tela/botão,
 * mas quem garante é o servidor: sem isto, qualquer conta Free chamaria
 * o endpoint direto.
 */
export interface ServerPlanFeatures {
  productAssistant: boolean;
  autoWatchCheck: boolean;
}

const PLAN_FEATURES: Record<string, ServerPlanFeatures> = {
  free: { productAssistant: false, autoWatchCheck: false },
  starter: { productAssistant: false, autoWatchCheck: false },
  pro: { productAssistant: true, autoWatchCheck: true },
};

/**
 * Plano EFETIVO: com a cobrança desligada (modo gratuito, ver freeMode.ts)
 * todo mundo tem os recursos do plano "pro" — sem gravar nada e sem olhar o
 * plano salvo, então religar a cobrança devolve o comportamento original.
 */
export function featuresForPlan(
  plan: string | undefined,
  billingEnabled: boolean = isBillingEnabled()
): ServerPlanFeatures {
  if (!billingEnabled) return PLAN_FEATURES.pro;
  return PLAN_FEATURES[plan ?? ""] ?? PLAN_FEATURES.free;
}

export async function getUserPlanFeatures(uid: string): Promise<ServerPlanFeatures> {
  // Sem cobrança o plano salvo é irrelevante — nem lê o perfil.
  if (!isBillingEnabled()) return featuresForPlan(undefined, false);
  const snap = await getAdminDb().collection("users").doc(uid).get();
  return featuresForPlan(snap.data()?.plan as string | undefined, true);
}

export class FeatureNotInPlanError extends Error {}
