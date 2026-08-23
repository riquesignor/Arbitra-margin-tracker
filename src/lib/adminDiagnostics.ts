import { getCurrentIdToken } from "./auth";

export interface AdminDiagnostics {
  environment: string;
  scraperApiConfigured: boolean;
  mercadoLivreOAuthConfigured: boolean;
  firebaseAdminConfigured: boolean;
  byokOnlyProviders: string[];
}

/**
 * GET /api/admin-diagnostics (ver api/admin-diagnostics.ts) — status de
 * config server-side que só dava pra checar no dashboard da Vercel.
 * `null` de volta = endpoint falhou (rede, 401, 403) — Admin.tsx trata
 * como "não consegui checar agora", não como "nada configurado".
 */
export async function fetchAdminDiagnostics(): Promise<AdminDiagnostics | null> {
  try {
    const idToken = await getCurrentIdToken();
    if (!idToken) return null;

    const response = await fetch("/api/admin-diagnostics", {
      headers: { Authorization: `Bearer ${idToken}` },
    });
    if (!response.ok) return null;

    return (await response.json()) as AdminDiagnostics;
  } catch (err) {
    console.warn("Não consegui buscar diagnóstico de configuração:", err);
    return null;
  }
}
