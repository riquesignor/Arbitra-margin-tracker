import { firebaseConfigured, getFirebaseDb } from "./firebase";

/**
 * Chaves de API próprias do usuário (BYOK — bring your own key), todas no
 * doc único `users/{userId}/secrets/keys` (subcoleção, ver ADR-0003).
 *
 * Fica separado do doc de perfil de propósito: `users/{uid}` é legível por
 * admin (gestão de plano), mas credencial é segredo do próprio usuário — a
 * regra de `secrets` não tem override de admin (ver firestore.rules). O
 * servidor lê as mesmas chaves pelo uid do token (api/_lib/userSecrets.ts);
 * o navegador nunca as envia nas buscas.
 *
 * Pra quê serve cada uma:
 *   - serpApiKey      → busca por texto (Google Shopping) e por foto (Google Lens)
 *   - rapidApiKey     → "Amazon direto" (RapidAPI Real-Time Amazon Data)
 *   - searchApiKey    → 2ª fonte de busca por foto (SearchApi.io), redundância à SerpApi
 *   - unwrangleApiKey → alternativa paga ao Mercado Livre público, só no fallback de erro 403
 *   - geminiApiKey / mistralApiKey / nvidiaApiKey → IA do motor interno + IA (busca por foto)
 *   - scraperApiKey   → mecanismo "ScraperAPI" e reforço anti-bloqueio de outros mecanismos
 */
export const API_KEY_FIELDS = [
  "serpApiKey",
  "rapidApiKey",
  "searchApiKey",
  "unwrangleApiKey",
  "geminiApiKey",
  "mistralApiKey",
  "nvidiaApiKey",
  "scraperApiKey",
] as const;

export type ApiKeyField = (typeof API_KEY_FIELDS)[number];
export type UserApiKeys = Partial<Record<ApiKeyField, string>>;

const SUBCOLLECTION = "secrets";
const DOC_ID = "keys";

/**
 * Flag denormalizada no perfil (`users/{uid}.hasSerpApiKey` etc.) — NUNCA o
 * valor da chave. Permite ao Admin mostrar "tem chave: sim/não" sem ler os
 * secrets de outro uid (ADR-0002, Action Item 1).
 */
function profileFlag(field: ApiKeyField): string {
  return `has${field[0].toUpperCase()}${field.slice(1)}`;
}

/** Todas as chaves numa leitura só do doc (antes era uma leitura por chave). `{}` se deslogado, sem Firebase ou em erro. */
export async function getUserApiKeys(userId: string | null): Promise<UserApiKeys> {
  if (!userId || !firebaseConfigured) return {};

  try {
    const db = await getFirebaseDb();
    const { doc, getDoc } = await import("firebase/firestore");
    const snap = await getDoc(doc(db, "users", userId, SUBCOLLECTION, DOC_ID));
    if (!snap.exists()) return {};

    const data = snap.data();
    const keys: UserApiKeys = {};
    for (const field of API_KEY_FIELDS) {
      const value = (data[field] as string | undefined)?.trim();
      if (value) keys[field] = value;
    }
    return keys;
  } catch (err) {
    console.warn("Não consegui ler as chaves de API do usuário:", err);
    return {};
  }
}

/**
 * Grava (ou apaga, com `key = null`) uma chave e sincroniza a flag do perfil
 * no mesmo `writeBatch`, atômico. `merge: true` porque o doc guarda as oito
 * chaves: sem merge, salvar uma apagaria as outras.
 */
async function writeUserApiKey(userId: string, field: ApiKeyField, key: string | null): Promise<void> {
  const db = await getFirebaseDb();
  const { doc, writeBatch } = await import("firebase/firestore");
  const batch = writeBatch(db);
  batch.set(
    doc(db, "users", userId, SUBCOLLECTION, DOC_ID),
    key === null ? { [field]: null } : { [field]: key.trim(), updatedAt: Date.now() },
    { merge: true }
  );
  batch.set(doc(db, "users", userId), { [profileFlag(field)]: key !== null }, { merge: true });
  await batch.commit();
}

export function saveUserApiKey(userId: string, field: ApiKeyField, key: string): Promise<void> {
  return writeUserApiKey(userId, field, key);
}

export function deleteUserApiKey(userId: string, field: ApiKeyField): Promise<void> {
  return writeUserApiKey(userId, field, null);
}
