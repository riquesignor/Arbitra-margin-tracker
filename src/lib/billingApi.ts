import { getCurrentIdToken } from "./auth";

/**
 * POST /api/billing-create-subscription (ver api/billing-create-subscription.ts
 * e api/_lib/mercadoPago.ts) — cria a assinatura recorrente no Mercado
 * Pago e devolve a URL de checkout hospedada. Chamador (Settings.tsx)
 * decide o redirect: `window.location.href = initPoint`.
 *
 * Lança erro (em vez de devolver `null`) de propósito — diferente de
 * `fetchAdminDiagnostics`, aqui o usuário está numa ação explícita
 * ("Assinar agora"), então a UI precisa mostrar o motivo da falha, não
 * silenciar.
 */
export async function createSubscriptionCheckout(): Promise<{ initPoint: string; preapprovalId: string }> {
  const idToken = await getCurrentIdToken();
  if (!idToken) {
    throw new Error("Sessão expirada — faça login novamente antes de assinar.");
  }

  const response = await fetch("/api/billing-create-subscription", {
    method: "POST",
    headers: { Authorization: `Bearer ${idToken}` },
  });

  const json = (await response.json().catch(() => ({}))) as { error?: string; detail?: string; initPoint?: string; preapprovalId?: string };
  if (!response.ok) {
    throw new Error(json.detail ?? json.error ?? `Falha ao criar assinatura (HTTP ${response.status})`);
  }
  if (!json.initPoint || !json.preapprovalId) {
    throw new Error("Resposta inesperada do servidor ao criar a assinatura.");
  }
  return { initPoint: json.initPoint, preapprovalId: json.preapprovalId };
}
