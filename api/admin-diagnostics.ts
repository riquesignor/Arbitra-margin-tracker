import type { ApiRequest, ApiResponse } from "./_lib/httpTypes.js";
import { requireAdmin, ForbiddenError } from "./_lib/adminAuth.js";
import { UnauthorizedError } from "./_lib/verifyAuth.js";

/**
 * GET /api/admin-diagnostics — só booleano de "a variável de ambiente
 * está presente e não-vazia", NUNCA o valor. Existe pra responder, de
 * dentro do próprio app, uma pergunta que só dava pra checar abrindo o
 * dashboard da Vercel: "a chave que eu configurei está valendo na
 * implantação atual?" (motivo concreto real, antes da conversão BYOK: uma
 * env var configurada numa máquina, "Vercel não reconheceu" — sem isso, a
 * única forma de depurar era adivinhar entre variável ausente / no
 * ambiente errado (Preview vs Production) / sem redeploy depois de
 * adicionar).
 *
 * `VERCEL_ENV` (var automática da própria Vercel, sempre presente em
 * deploy — "production"/"preview"/"development") é o dado que mais
 * rápido explica esse tipo de caso: variável setada só em Production
 * não aparece numa Preview deployment, e vice-versa.
 *
 * `scraperApiConfigured` REMOVIDO (set/2026, mesma sessão da conversão
 * BYOK da chave ScraperAPI — ver comentário no topo de
 * src/lib/userSecrets.ts): não existe mais `process.env.SCRAPERAPI_KEY`
 * pra checar, a chave é por usuário. "ScraperAPI" entrou em
 * `byokOnlyProviders` no lugar.
 */
interface DiagnosticsResponse {
  environment: string;
  /** OAuth Mercado Livre em nome da plataforma (mlAuth.ts) — hoje parked por pendência de verificação no DevCenter deles, ver providers/registry.ts. */
  mercadoLivreOAuthConfigured: boolean;
  firebaseAdminConfigured: boolean;
  /** BYOK: nunca configurável pela plataforma — só documentativo, pra deixar claro que "não configurado" aqui é o estado NORMAL, não um erro. */
  byokOnlyProviders: string[];
}

function nonEmpty(value: string | undefined): boolean {
  return typeof value === "string" && value.trim().length > 0;
}

export default async function handler(req: ApiRequest, res: ApiResponse): Promise<void> {
  if (req.method !== "GET") {
    res.status(405).json({ error: "Método não permitido" });
    return;
  }

  try {
    await requireAdmin(req);
  } catch (err) {
    if (err instanceof UnauthorizedError) {
      res.status(401).json({ error: err.message });
      return;
    }
    if (err instanceof ForbiddenError) {
      res.status(403).json({ error: err.message });
      return;
    }
    throw err;
  }

  const body: DiagnosticsResponse = {
    environment: process.env.VERCEL_ENV ?? "desconhecido (sem VERCEL_ENV — provável dev local)",
    mercadoLivreOAuthConfigured: nonEmpty(process.env.ML_CLIENT_ID) && nonEmpty(process.env.ML_CLIENT_SECRET),
    firebaseAdminConfigured:
      nonEmpty(process.env.FIREBASE_PROJECT_ID) &&
      nonEmpty(process.env.FIREBASE_CLIENT_EMAIL) &&
      nonEmpty(process.env.FIREBASE_PRIVATE_KEY),
    byokOnlyProviders: [
      "SerpApi",
      "RapidAPI (Amazon)",
      "SearchApi.io",
      "Gemini (motor interno + IA)",
      "Mistral (motor interno + IA)",
      "ScraperAPI",
      "Unwrangle",
    ],
  };

  res.status(200).json(body);
}
