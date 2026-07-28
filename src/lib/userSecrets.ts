import { firebaseConfigured, getFirebaseDb } from "./firebase";

const COLLECTION = "user_secrets";

/**
 * Chave SerpApi própria do usuário (BYOK — bring your own key). Guardada
 * numa coleção separada de `users/{uid}` de propósito: `users` é
 * legível por admin (pra gestão de plano no painel Admin), mas uma
 * credencial de API é segredo do próprio usuário — `user_secrets` não
 * tem override de admin na security rule (ver firestore.rules).
 *
 * Por quê BYOK: a cota da SerpApi (env `SERPAPI_KEY`, ver
 * googleShoppingProvider.ts) é compartilhada entre TODOS os usuários
 * sem chave própria — free tier é ~250 buscas/mês, e um catálogo de
 * porte médio já consome isso sozinho (linhas × marketplaces
 * selecionados). Cada usuário com a própria chave passa a ter cota
 * isolada, dimensionada pela própria conta SerpApi dele — não pelo
 * limite arbitrário do app.
 */
export async function getUserSerpApiKey(userId: string | null): Promise<string | null> {
  if (!userId || !firebaseConfigured) return null;

  try {
    const db = await getFirebaseDb();
    const { doc, getDoc } = await import("firebase/firestore");
    const snap = await getDoc(doc(db, COLLECTION, userId));
    if (!snap.exists()) return null;
    const key = snap.data().serpApiKey as string | undefined;
    return key?.trim() || null;
  } catch (err) {
    console.warn("Não consegui ler a chave SerpApi do usuário:", err);
    return null;
  }
}

export async function saveUserSerpApiKey(userId: string, key: string): Promise<void> {
  const db = await getFirebaseDb();
  const { doc, setDoc } = await import("firebase/firestore");
  await setDoc(doc(db, COLLECTION, userId), { serpApiKey: key.trim(), updatedAt: Date.now() });
}

export async function deleteUserSerpApiKey(userId: string): Promise<void> {
  const db = await getFirebaseDb();
  const { doc, deleteDoc } = await import("firebase/firestore");
  await deleteDoc(doc(db, COLLECTION, userId));
}
