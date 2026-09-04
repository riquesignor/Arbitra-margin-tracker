import { getAdminDb } from "./firestoreAdmin.js";
import type { SearchProviderId } from "./types.js";

/**
 * ══════════════════════════════════════════════════════════════════════
 * LEITURA DE CHAVE BYOK NO SERVIDOR
 * ══════════════════════════════════════════════════════════════════════
 *
 * Brecha real corrigida (set/2026, ver docs/auditoria-2026-09.md > P0-4):
 * até aqui a chave do usuário fazia um caminho desnecessário e perigoso —
 * o NAVEGADOR lia o valor em texto puro do Firestore
 * (src/lib/userSecrets.ts) e reenviava em `body.apiKey` a cada chamada de
 * /api/fetch-prices. Consequência: um único XSS no app exfiltrava as seis
 * chaves do usuário (SerpApi, RapidAPI, SearchApi.io, Unwrangle, Gemini,
 * Mistral) de uma vez, e nada além da boa fé impedia isso.
 *
 * Não havia motivo técnico: o servidor já tem o `uid` verificado
 * (verifyAuth.ts) e o Admin SDK. Agora é ele quem lê
 * `users/{uid}/secrets/keys` — o mesmo doc de sempre, mesmo formato, sem
 * migração — e escolhe o campo certo conforme o provider da requisição.
 * O cliente parou de ler e de enviar a chave.
 *
 * O Admin SDK ignora Security Rules, então a subcoleção `secrets/`
 * continua sem override de admin lá (firestore.rules) — quem lê aqui é o
 * servidor agindo em nome do PRÓPRIO dono da chave, com o uid tirado do
 * token que ele mesmo assinou, nunca de um parâmetro da requisição.
 */

const SECRETS_SUBCOLLECTION = "secrets";
const SECRETS_DOC_ID = "keys";

/**
 * Qual campo de `users/{uid}/secrets/keys` cada provider usa. Espelha
 * src/lib/userSecrets.ts (mesmos nomes de campo) — MANTER EM SINCRONIA.
 *
 * Providers ausentes deste mapa não são BYOK:
 *   - "scraperapi" → `SCRAPERAPI_KEY`, secret de servidor (plataforma paga).
 *   - "mercadolivre_direct" → endpoint público, sem chave.
 */
const PROVIDER_SECRET_FIELD: Partial<Record<SearchProviderId, string>> = {
  serpapi: "serpApiKey",
  google_lens_products: "serpApiKey", // mesma conta SerpApi da busca por texto
  searchapi_lens: "searchApiKey",
  rapidapi_amazon: "rapidApiKey",
  mercadolivre_alt: "unwrangleApiKey",
  vision_internal: "geminiApiKey",
  vision_mistral: "mistralApiKey",
};

/**
 * Devolve a chave BYOK do usuário pro provider pedido, ou `undefined`
 * quando o provider não é BYOK, o usuário não cadastrou chave, ou a
 * leitura falhou.
 *
 * Falha de leitura NÃO derruba a busca de propósito: o provider já sabe
 * responder "chave ausente/inválida" com mensagem própria e acionável
 * (ver cada provider) — melhor esse erro específico do que um 502 genérico
 * de infraestrutura no meio do lote.
 */
export async function getUserApiKeyForProvider(
  uid: string,
  provider: SearchProviderId
): Promise<string | undefined> {
  const field = PROVIDER_SECRET_FIELD[provider];
  if (!field) return undefined;

  try {
    const snap = await getAdminDb()
      .collection("users")
      .doc(uid)
      .collection(SECRETS_SUBCOLLECTION)
      .doc(SECRETS_DOC_ID)
      .get();

    const value = snap.data()?.[field] as string | undefined;
    return value?.trim() || undefined;
  } catch (err) {
    console.warn(`[secrets] não consegui ler a chave "${field}" de ${uid}:`, err);
    return undefined;
  }
}
