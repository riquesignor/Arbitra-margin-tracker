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
<<<<<<< HEAD
 * googleShoppingProvider.ts) seria compartilhada entre TODOS os
 * usuários sem chave própria — free tier é 250 buscas/mês E só 50/hora
 * de throughput (serpapi.com/pricing), e um catálogo de porte médio já
 * processa perto do teto por hora sozinho, mesmo com a busca
 * compartilhada entre marketplaces (1 chamada por produto, não por
 * produto×marketplace). Cada usuário com a própria chave passa a ter
 * cota isolada, dimensionada pela própria conta SerpApi dele — não pelo
=======
 * googleShoppingProvider.ts) é compartilhada entre TODOS os usuários
 * sem chave própria — free tier é ~250 buscas/mês, e um catálogo de
 * porte médio já consome isso sozinho (linhas × marketplaces
 * selecionados). Cada usuário com a própria chave passa a ter cota
 * isolada, dimensionada pela própria conta SerpApi dele — não pelo
>>>>>>> 876d06fbe516a280c102d8517ac760291de86799
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

<<<<<<< HEAD
/**
 * Chave RapidAPI própria do usuário — mesmo padrão BYOK da SerpApi
 * acima, guardada no mesmo doc `user_secrets/{uid}` (campo separado,
 * `rapidApiKey`), já que é o mesmo usuário/conta que autoriza os dois.
 * Usada hoje só pelo provider Amazon direto (ver
 * api/_lib/providers/rapidApiAmazonProvider.ts) — Mercado Livre direto
 * não precisa de chave (endpoint público).
 */
export async function getUserRapidApiKey(userId: string | null): Promise<string | null> {
  if (!userId || !firebaseConfigured) return null;

  try {
    const db = await getFirebaseDb();
    const { doc, getDoc } = await import("firebase/firestore");
    const snap = await getDoc(doc(db, COLLECTION, userId));
    if (!snap.exists()) return null;
    const key = snap.data().rapidApiKey as string | undefined;
    return key?.trim() || null;
  } catch (err) {
    console.warn("Não consegui ler a chave RapidAPI do usuário:", err);
    return null;
  }
}

/**
 * Grava a chave em `user_secrets/{uid}` e, no mesmo `writeBatch` (atômico),
 * atualiza `users/{uid}.hasSerpApiKey = true` — uma flag denormalizada,
 * NUNCA o valor da chave. É o que permite ao Admin mostrar "tem chave
 * cadastrada: sim/não" na tela de detalhe do usuário (ADR-0002) sem
 * jamais ler `user_secrets` de outro uid (a rule daquela coleção
 * continua sem override de admin, de propósito).
 */
export async function saveUserSerpApiKey(userId: string, key: string): Promise<void> {
  const db = await getFirebaseDb();
  const { doc, writeBatch } = await import("firebase/firestore");
  const batch = writeBatch(db);
  // `merge: true` — o mesmo doc agora também pode ter `rapidApiKey`
  // (ver saveUserRapidApiKey abaixo); sem merge, salvar a chave SerpApi
  // apagaria a chave RapidAPI do usuário sem querer.
  batch.set(
    doc(db, COLLECTION, userId),
    { serpApiKey: key.trim(), updatedAt: Date.now() },
    { merge: true }
  );
  batch.set(doc(db, "users", userId), { hasSerpApiKey: true }, { merge: true });
  await batch.commit();
=======
export async function saveUserSerpApiKey(userId: string, key: string): Promise<void> {
  const db = await getFirebaseDb();
  const { doc, setDoc } = await import("firebase/firestore");
  await setDoc(doc(db, COLLECTION, userId), { serpApiKey: key.trim(), updatedAt: Date.now() });
>>>>>>> 876d06fbe516a280c102d8517ac760291de86799
}

export async function deleteUserSerpApiKey(userId: string): Promise<void> {
  const db = await getFirebaseDb();
<<<<<<< HEAD
  const { doc, writeBatch } = await import("firebase/firestore");
  const batch = writeBatch(db);
  // `set` com `merge: true` (não `delete` do doc inteiro nem `update`,
  // que falharia se o doc ainda não existir) — o doc pode ter
  // `rapidApiKey` junto, então só zera o campo desta chave.
  batch.set(doc(db, COLLECTION, userId), { serpApiKey: null }, { merge: true });
  batch.set(doc(db, "users", userId), { hasSerpApiKey: false }, { merge: true });
  await batch.commit();
}

/**
 * Grava a chave RapidAPI em `user_secrets/{uid}` (campo `rapidApiKey`,
 * preservando `serpApiKey` se já existir — `set` com `merge` em vez de
 * sobrescrever o doc inteiro) e sincroniza `users/{uid}.hasRapidApiKey`
 * no mesmo `writeBatch`, mesmo padrão de `saveUserSerpApiKey` acima.
 */
export async function saveUserRapidApiKey(userId: string, key: string): Promise<void> {
  const db = await getFirebaseDb();
  const { doc, writeBatch } = await import("firebase/firestore");
  const batch = writeBatch(db);
  batch.set(
    doc(db, COLLECTION, userId),
    { rapidApiKey: key.trim(), updatedAt: Date.now() },
    { merge: true }
  );
  batch.set(doc(db, "users", userId), { hasRapidApiKey: true }, { merge: true });
  await batch.commit();
}

export async function deleteUserRapidApiKey(userId: string): Promise<void> {
  const db = await getFirebaseDb();
  const { doc, writeBatch } = await import("firebase/firestore");
  const batch = writeBatch(db);
  batch.set(doc(db, COLLECTION, userId), { rapidApiKey: null }, { merge: true });
  batch.set(doc(db, "users", userId), { hasRapidApiKey: false }, { merge: true });
  await batch.commit();
=======
  const { doc, deleteDoc } = await import("firebase/firestore");
  await deleteDoc(doc(db, COLLECTION, userId));
>>>>>>> 876d06fbe516a280c102d8517ac760291de86799
}
