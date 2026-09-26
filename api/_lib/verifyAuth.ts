import { getAuth } from "firebase-admin/auth";
import { getAdminApp } from "./firestoreAdmin.js";
import type { ApiRequest } from "./httpTypes.js";

export class UnauthorizedError extends Error {}
export class EmailNotVerifiedError extends Error {}

function extractBearerToken(req: ApiRequest): string | null {
  const raw = req.headers?.authorization ?? req.headers?.Authorization;
  const header = Array.isArray(raw) ? raw[0] : raw;
  if (!header?.startsWith("Bearer ")) return null;
  const token = header.slice("Bearer ".length).trim();
  return token || null;
}

/**
 * Verifica o Firebase ID Token (`Authorization: Bearer <idToken>`) via
 * Admin SDK — `verifyIdToken` valida assinatura + expiração, lança se
 * ausente/expirado/adulterado. Compartilhado por requireAuth (só exige
 * login) e requireVerifiedAuth (exige login + email confirmado) abaixo,
 * pra não decodificar o mesmo token duas vezes.
 */
async function verifyToken(req: ApiRequest) {
  const token = extractBearerToken(req);
  if (!token) {
    throw new UnauthorizedError("Token de autenticação ausente (Authorization: Bearer <idToken>).");
  }
  try {
    return await getAuth(getAdminApp()).verifyIdToken(token);
  } catch (err) {
    throw new UnauthorizedError(
      `Token inválido ou expirado: ${err instanceof Error ? err.message : String(err)}`
    );
  }
}

/**
 * Exige login (qualquer conta, confirmada ou não). Antes deste check o
 * endpoint aceitava qualquer requisição que soubesse a URL, sem nenhuma
 * forma de saber QUEM estava chamando (ver docs/architecture-review.md >
 * Segurança). Retorna o uid pra quem chamou usar em log/telemetria.
 */
export async function requireAuth(req: ApiRequest): Promise<string> {
  const decoded = await verifyToken(req);
  return decoded.uid;
}

/**
 * Exige login E email confirmado (`email_verified` no ID token — contas
 * Google chegam aqui sempre `true`; email/senha só depois de clicar no
 * link enviado por sendEmailVerification, ver src/lib/auth.ts). Usado nos
 * endpoints que consomem cota/dados de verdade (busca de preço), pra uma
 * conta cadastrada e nunca confirmada ("conta fantasma") não conseguir
 * usar nada mesmo chamando a API direto, sem passar pela UI (que já
 * bloqueia isso em App.tsx > VerifyEmailGate).
 */
export async function requireVerifiedAuth(req: ApiRequest): Promise<string> {
  const decoded = await verifyToken(req);
  if (!decoded.email_verified) {
    throw new EmailNotVerifiedError("Confirme seu email antes de usar a busca de preço.");
  }
  return decoded.uid;
}
