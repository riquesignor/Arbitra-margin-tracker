import { getAdminDb } from "./firestoreAdmin.js";
import { requireAuth } from "./verifyAuth.js";
import type { ApiRequest } from "./httpTypes.js";

/** Autenticado, mas sem `isAdmin` — diferente de `UnauthorizedError` (sem token nenhum). */
export class ForbiddenError extends Error {}

/**
 * `requireAuth` + checagem de `users/{uid}.isAdmin` (mesmo campo que
 * Admin.tsx já lê via SDK client — ver userProfile.ts). Faltava um
 * equivalente SERVER-SIDE: hoje o "gate" de admin existe só na UI
 * (`profile?.isAdmin` em App.tsx) e nas regras do Firestore — nenhum
 * endpoint em api/ tinha como recusar um usuário comum que descobrisse
 * a URL. Primeiro consumidor: api/admin-diagnostics.ts.
 */
export async function requireAdmin(req: ApiRequest): Promise<string> {
  const uid = await requireAuth(req);
  const snap = await getAdminDb().collection("users").doc(uid).get();
  if (!snap.exists || snap.data()?.isAdmin !== true) {
    throw new ForbiddenError("Conta autenticada, mas sem permissão de admin.");
  }
  return uid;
}
