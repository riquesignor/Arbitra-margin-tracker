import { getAdminDb } from "./firestoreAdmin.js";

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

export function featuresForPlan(plan: string | undefined): ServerPlanFeatures {
  return PLAN_FEATURES[plan ?? ""] ?? PLAN_FEATURES.free;
}

export async function getUserPlanFeatures(uid: string): Promise<ServerPlanFeatures> {
  const snap = await getAdminDb().collection("users").doc(uid).get();
  return featuresForPlan(snap.data()?.plan as string | undefined);
}

export class FeatureNotInPlanError extends Error {}
