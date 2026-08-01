import { getAuth } from "firebase-admin/auth";
import { getAdminApp } from "./firestoreAdmin.js";
import type { ApiRequest } from "./httpTypes.js";

export class UnauthorizedError extends Error {}

function extractBearerToken(req: ApiRequest): string | null {
  const raw = req.headers?.authorization ?? req.headers?.Authorization;
  const header = Array.isArray(raw) ? raw[0] : raw;
  if (!header?.startsWith("Bearer ")) return null;
  const token = header.slice("Bearer ".length).trim();
  return token || null;
}

/**
 * Verifica o Firebase ID Token do usuário (`Authorization: Bearer
 * <idToken>`, enviado por `src/lib/priceApi.ts`) via Admin SDK. Antes
 * disso o endpoint aceitava qualquer requisição que soubesse a URL, sem
 * nenhuma forma de saber QUEM estava chamando (ver
 * docs/architecture-review.md > Segurança). `verifyIdToken` valida
 * assinatura + expiração — lança se o token estiver ausente, expirado
 * ou adulterado. Retorna o uid pra quem chamou usar em log/telemetria.
 */
export async function requireAuth(req: ApiRequest): Promise<string> {
  const token = extractBearerToken(req);
  if (!token) {
    throw new UnauthorizedError("Token de autenticação ausente (Authorization: Bearer <idToken>).");
  }

  try {
    const decoded = await getAuth(getAdminApp()).verifyIdToken(token);
    return decoded.uid;
  } catch (err) {
    throw new UnauthorizedError(
      `Token inválido ou expirado: ${err instanceof Error ? err.message : String(err)}`
    );
  }
}
