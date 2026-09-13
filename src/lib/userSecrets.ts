import { firebaseConfigured, getFirebaseDb } from "./firebase";

/**
 * Subcoleção de `users/{userId}` (ver ADR-0003) — doc único
 * `users/{userId}/secrets/keys`. Antes era uma coleção de nível superior
 * `user_secrets/{userId}` (1:1); a mudança é só de path, a regra de
 * isolamento continua a mesma (só o dono lê/escreve, sem override de
 * admin — ver comentário mais abaixo).
 */
const SUBCOLLECTION = "secrets";
const DOC_ID = "keys";

function secretsDocPath(userId: string): [string, string, string, string] {
  return ["users", userId, SUBCOLLECTION, DOC_ID];
}

/**
 * Chave SerpApi própria do usuário (BYOK — bring your own key). Guardada
 * numa subcoleção separada do doc de perfil de propósito: `users/{uid}`
 * é legível por admin (pra gestão de plano no painel Admin), mas uma
 * credencial de API é segredo do próprio usuário —
 * `users/{uid}/secrets/keys` não tem override de admin na security rule
 * (ver firestore.rules).
 *
 * Por quê BYOK: a cota da SerpApi (env `SERPAPI_KEY`, ver
 * googleShoppingProvider.ts) seria compartilhada entre TODOS os
 * usuários sem chave própria — free tier é 250 buscas/mês E só 50/hora
 * de throughput (serpapi.com/pricing), e um catálogo de porte médio já
 * processa perto do teto por hora sozinho, mesmo com a busca
 * compartilhada entre marketplaces (1 chamada por produto, não por
 * produto×marketplace). Cada usuário com a própria chave passa a ter
 * cota isolada, dimensionada pela própria conta SerpApi dele — não pelo
 * limite arbitrário do app.
 */
export async function getUserSerpApiKey(userId: string | null): Promise<string | null> {
  if (!userId || !firebaseConfigured) return null;

  try {
    const db = await getFirebaseDb();
    const { doc, getDoc } = await import("firebase/firestore");
    const snap = await getDoc(doc(db, ...secretsDocPath(userId)));
    if (!snap.exists()) return null;
    const key = snap.data().serpApiKey as string | undefined;
    return key?.trim() || null;
  } catch (err) {
    console.warn("Não consegui ler a chave SerpApi do usuário:", err);
    return null;
  }
}

/**
 * Chave RapidAPI própria do usuário — mesmo padrão BYOK da SerpApi
 * acima, guardada no mesmo doc `users/{uid}/secrets/keys` (campo
 * separado, `rapidApiKey`), já que é o mesmo usuário/conta que autoriza
 * os dois. Usada hoje só pelo provider Amazon direto (ver
 * api/_lib/providers/rapidApiAmazonProvider.ts) — Mercado Livre direto
 * não precisa de chave (endpoint público).
 */
export async function getUserRapidApiKey(userId: string | null): Promise<string | null> {
  if (!userId || !firebaseConfigured) return null;

  try {
    const db = await getFirebaseDb();
    const { doc, getDoc } = await import("firebase/firestore");
    const snap = await getDoc(doc(db, ...secretsDocPath(userId)));
    if (!snap.exists()) return null;
    const key = snap.data().rapidApiKey as string | undefined;
    return key?.trim() || null;
  } catch (err) {
    console.warn("Não consegui ler a chave RapidAPI do usuário:", err);
    return null;
  }
}

/**
 * Grava a chave em `users/{uid}/secrets/keys` e, no mesmo `writeBatch`
 * (atômico), atualiza `users/{uid}.hasSerpApiKey = true` — uma flag
 * denormalizada, NUNCA o valor da chave. É o que permite ao Admin
 * mostrar "tem chave cadastrada: sim/não" na tela de detalhe do usuário
 * (ADR-0002, Action Item 1) sem jamais ler os secrets de outro uid (a
 * rule daquela subcoleção continua sem override de admin, de propósito).
 */
export async function saveUserSerpApiKey(userId: string, key: string): Promise<void> {
  const db = await getFirebaseDb();
  const { doc, writeBatch } = await import("firebase/firestore");
  const batch = writeBatch(db);
  // `merge: true` — o mesmo doc agora também pode ter `rapidApiKey`
  // (ver saveUserRapidApiKey abaixo); sem merge, salvar a chave SerpApi
  // apagaria a chave RapidAPI do usuário sem querer.
  batch.set(
    doc(db, ...secretsDocPath(userId)),
    { serpApiKey: key.trim(), updatedAt: Date.now() },
    { merge: true }
  );
  batch.set(doc(db, "users", userId), { hasSerpApiKey: true }, { merge: true });
  await batch.commit();
}

export async function deleteUserSerpApiKey(userId: string): Promise<void> {
  const db = await getFirebaseDb();
  const { doc, writeBatch } = await import("firebase/firestore");
  const batch = writeBatch(db);
  // `set` com `merge: true` (não `delete` do doc inteiro nem `update`,
  // que falharia se o doc ainda não existir) — o doc pode ter
  // `rapidApiKey` junto, então só zera o campo desta chave.
  batch.set(doc(db, ...secretsDocPath(userId)), { serpApiKey: null }, { merge: true });
  batch.set(doc(db, "users", userId), { hasSerpApiKey: false }, { merge: true });
  await batch.commit();
}

/**
 * Grava a chave RapidAPI em `users/{uid}/secrets/keys` (campo
 * `rapidApiKey`, preservando `serpApiKey` se já existir — `set` com
 * `merge` em vez de sobrescrever o doc inteiro) e sincroniza
 * `users/{uid}.hasRapidApiKey` no mesmo `writeBatch`, mesmo padrão de
 * `saveUserSerpApiKey` acima.
 */
export async function saveUserRapidApiKey(userId: string, key: string): Promise<void> {
  const db = await getFirebaseDb();
  const { doc, writeBatch } = await import("firebase/firestore");
  const batch = writeBatch(db);
  batch.set(
    doc(db, ...secretsDocPath(userId)),
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
  batch.set(doc(db, ...secretsDocPath(userId)), { rapidApiKey: null }, { merge: true });
  batch.set(doc(db, "users", userId), { hasRapidApiKey: false }, { merge: true });
  await batch.commit();
}

/**
 * Chave SearchApi.io própria do usuário — segunda fonte de busca por
 * IMAGEM (provider "searchapi_lens", ver searchApiLensProvider.ts),
 * vendor diferente da SerpApi só pra dar redundância (cota/downtime de
 * um não afeta o outro). Mesmo padrão BYOK e mesmo doc
 * `users/{uid}/secrets/keys` dos campos acima.
 */
export async function getUserSearchApiKey(userId: string | null): Promise<string | null> {
  if (!userId || !firebaseConfigured) return null;

  try {
    const db = await getFirebaseDb();
    const { doc, getDoc } = await import("firebase/firestore");
    const snap = await getDoc(doc(db, ...secretsDocPath(userId)));
    if (!snap.exists()) return null;
    const key = snap.data().searchApiKey as string | undefined;
    return key?.trim() || null;
  } catch (err) {
    console.warn("Não consegui ler a chave SearchApi.io do usuário:", err);
    return null;
  }
}

export async function saveUserSearchApiKey(userId: string, key: string): Promise<void> {
  const db = await getFirebaseDb();
  const { doc, writeBatch } = await import("firebase/firestore");
  const batch = writeBatch(db);
  batch.set(
    doc(db, ...secretsDocPath(userId)),
    { searchApiKey: key.trim(), updatedAt: Date.now() },
    { merge: true }
  );
  batch.set(doc(db, "users", userId), { hasSearchApiKey: true }, { merge: true });
  await batch.commit();
}

export async function deleteUserSearchApiKey(userId: string): Promise<void> {
  const db = await getFirebaseDb();
  const { doc, writeBatch } = await import("firebase/firestore");
  const batch = writeBatch(db);
  batch.set(doc(db, ...secretsDocPath(userId)), { searchApiKey: null }, { merge: true });
  batch.set(doc(db, "users", userId), { hasSearchApiKey: false }, { merge: true });
  await batch.commit();
}

/**
 * Chave Unwrangle própria do usuário — alternativa PAGA ao endpoint
 * público do Mercado Livre (provider "mercadolivre_alt", ver
 * unwrangleMercadoLivreProvider.ts). Diferente das chaves acima, esta
 * não aparece num seletor de provider normal — só é consultada pelo
 * fluxo de fallback em Dashboard.tsx quando a busca pública do Mercado
 * Livre falha (HTTP 403), oferecendo "tentar de novo com sua chave" só
 * se ela já estiver cadastrada.
 */
export async function getUserUnwrangleApiKey(userId: string | null): Promise<string | null> {
  if (!userId || !firebaseConfigured) return null;

  try {
    const db = await getFirebaseDb();
    const { doc, getDoc } = await import("firebase/firestore");
    const snap = await getDoc(doc(db, ...secretsDocPath(userId)));
    if (!snap.exists()) return null;
    const key = snap.data().unwrangleApiKey as string | undefined;
    return key?.trim() || null;
  } catch (err) {
    console.warn("Não consegui ler a chave Unwrangle do usuário:", err);
    return null;
  }
}

export async function saveUserUnwrangleApiKey(userId: string, key: string): Promise<void> {
  const db = await getFirebaseDb();
  const { doc, writeBatch } = await import("firebase/firestore");
  const batch = writeBatch(db);
  batch.set(
    doc(db, ...secretsDocPath(userId)),
    { unwrangleApiKey: key.trim(), updatedAt: Date.now() },
    { merge: true }
  );
  batch.set(doc(db, "users", userId), { hasUnwrangleApiKey: true }, { merge: true });
  await batch.commit();
}

export async function deleteUserUnwrangleApiKey(userId: string): Promise<void> {
  const db = await getFirebaseDb();
  const { doc, writeBatch } = await import("firebase/firestore");
  const batch = writeBatch(db);
  batch.set(doc(db, ...secretsDocPath(userId)), { unwrangleApiKey: null }, { merge: true });
  batch.set(doc(db, "users", userId), { hasUnwrangleApiKey: false }, { merge: true });
  await batch.commit();
}

/**
 * Chave Gemini (Google AI Studio) própria do usuário — motor da busca por
 * IMAGEM do provider "vision_internal" (motor interno + IA, ver
 * api/_lib/providers/visionInternalSearchProvider.ts e geminiVision.ts).
 * Mesmo padrão BYOK das chaves acima, mesmo doc `users/{uid}/secrets/keys`
 * (campo `geminiApiKey`).
 *
 * BYOK aqui não é só isolamento de cota (como nas outras chaves) — é o
 * que torna esse provider de busca por foto o único SEM custo de
 * assinatura embutido pro operador da plataforma: o free tier do Gemini
 * (aistudio.google.com/apikey, sem cartão) cobre um catálogo de porte
 * pequeno/médio sozinho, e o limite é da conta do PRÓPRIO usuário, não
 * de uma cota compartilhada que a Arbitra precisaria pagar.
 */
export async function getUserGeminiApiKey(userId: string | null): Promise<string | null> {
  if (!userId || !firebaseConfigured) return null;

  try {
    const db = await getFirebaseDb();
    const { doc, getDoc } = await import("firebase/firestore");
    const snap = await getDoc(doc(db, ...secretsDocPath(userId)));
    if (!snap.exists()) return null;
    const key = snap.data().geminiApiKey as string | undefined;
    return key?.trim() || null;
  } catch (err) {
    console.warn("Não consegui ler a chave Gemini do usuário:", err);
    return null;
  }
}

export async function saveUserGeminiApiKey(userId: string, key: string): Promise<void> {
  const db = await getFirebaseDb();
  const { doc, writeBatch } = await import("firebase/firestore");
  const batch = writeBatch(db);
  batch.set(
    doc(db, ...secretsDocPath(userId)),
    { geminiApiKey: key.trim(), updatedAt: Date.now() },
    { merge: true }
  );
  batch.set(doc(db, "users", userId), { hasGeminiApiKey: true }, { merge: true });
  await batch.commit();
}

export async function deleteUserGeminiApiKey(userId: string): Promise<void> {
  const db = await getFirebaseDb();
  const { doc, writeBatch } = await import("firebase/firestore");
  const batch = writeBatch(db);
  batch.set(doc(db, ...secretsDocPath(userId)), { geminiApiKey: null }, { merge: true });
  batch.set(doc(db, "users", userId), { hasGeminiApiKey: false }, { merge: true });
  await batch.commit();
}

/**
 * Chave Mistral própria do usuário — 2ª opção de backend de IA pro motor
 * interno + IA, ao lado da chave Gemini acima (provider "vision_mistral",
 * ver api/_lib/providers/visionInternalSearchProvider.ts e
 * mistralVision.ts). Campo SEPARADO (`mistralApiKey`, não reaproveita
 * `geminiApiKey`) porque são contas/vendors diferentes — o usuário pode
 * ter as duas cadastradas ao mesmo tempo e alternar entre "Motor interno +
 * IA (Gemini)" e "Motor interno + IA (Mistral)" no seletor sem recadastrar
 * nada. Mesmo padrão BYOK e mesmo doc `users/{uid}/secrets/keys` das
 * chaves acima.
 *
 * SUBSTITUIU a chave Groq (removido ago/2026 — free tier de 8.000
 * tokens/minuto zerava resultado mesmo com o batching implementado antes
 * da troca; ver mistralVision.ts pro raciocínio completo). Usuários com
 * `groqApiKey`/`hasGroqApiKey` salvos do backend antigo ficam com campo
 * órfão no Firestore — inofensivo (nada mais lê), sem migração necessária.
 */
export async function getUserMistralApiKey(userId: string | null): Promise<string | null> {
  if (!userId || !firebaseConfigured) return null;

  try {
    const db = await getFirebaseDb();
    const { doc, getDoc } = await import("firebase/firestore");
    const snap = await getDoc(doc(db, ...secretsDocPath(userId)));
    if (!snap.exists()) return null;
    const key = snap.data().mistralApiKey as string | undefined;
    return key?.trim() || null;
  } catch (err) {
    console.warn("Não consegui ler a chave Mistral do usuário:", err);
    return null;
  }
}

export async function saveUserMistralApiKey(userId: string, key: string): Promise<void> {
  const db = await getFirebaseDb();
  const { doc, writeBatch } = await import("firebase/firestore");
  const batch = writeBatch(db);
  batch.set(
    doc(db, ...secretsDocPath(userId)),
    { mistralApiKey: key.trim(), updatedAt: Date.now() },
    { merge: true }
  );
  batch.set(doc(db, "users", userId), { hasMistralApiKey: true }, { merge: true });
  await batch.commit();
}

export async function deleteUserMistralApiKey(userId: string): Promise<void> {
  const db = await getFirebaseDb();
  const { doc, writeBatch } = await import("firebase/firestore");
  const batch = writeBatch(db);
  batch.set(doc(db, ...secretsDocPath(userId)), { mistralApiKey: null }, { merge: true });
  batch.set(doc(db, "users", userId), { hasMistralApiKey: false }, { merge: true });
  await batch.commit();
}

/**
 * Chave NVIDIA própria do usuário (BETA, set/2026) — 3ª opção de backend
 * de IA pro motor interno + IA, ao lado de Gemini e Mistral (provider
 * "vision_nvidia", ver api/_lib/providers/visionInternalSearchProvider.ts
 * e nvidiaVision.ts). Campo SEPARADO (`nvidiaApiKey`) pelo mesmo motivo
 * das outras duas: contas/vendors diferentes, o usuário pode ter as três
 * cadastradas ao mesmo tempo e alternar entre os três no seletor sem
 * recadastrar nada. Mesmo padrão BYOK e mesmo doc `users/{uid}/secrets/keys`.
 *
 * Chave vem de build.nvidia.com (NVIDIA NIM) — conta grátis, só email,
 * sem cartão. Marcado como Beta na tela (Dashboard.tsx) até ter
 * validação de acurácia/latência num catálogo real.
 */
export async function getUserNvidiaApiKey(userId: string | null): Promise<string | null> {
  if (!userId || !firebaseConfigured) return null;

  try {
    const db = await getFirebaseDb();
    const { doc, getDoc } = await import("firebase/firestore");
    const snap = await getDoc(doc(db, ...secretsDocPath(userId)));
    if (!snap.exists()) return null;
    const key = snap.data().nvidiaApiKey as string | undefined;
    return key?.trim() || null;
  } catch (err) {
    console.warn("Não consegui ler a chave NVIDIA do usuário:", err);
    return null;
  }
}

export async function saveUserNvidiaApiKey(userId: string, key: string): Promise<void> {
  const db = await getFirebaseDb();
  const { doc, writeBatch } = await import("firebase/firestore");
  const batch = writeBatch(db);
  batch.set(
    doc(db, ...secretsDocPath(userId)),
    { nvidiaApiKey: key.trim(), updatedAt: Date.now() },
    { merge: true }
  );
  batch.set(doc(db, "users", userId), { hasNvidiaApiKey: true }, { merge: true });
  await batch.commit();
}

export async function deleteUserNvidiaApiKey(userId: string): Promise<void> {
  const db = await getFirebaseDb();
  const { doc, writeBatch } = await import("firebase/firestore");
  const batch = writeBatch(db);
  batch.set(doc(db, ...secretsDocPath(userId)), { nvidiaApiKey: null }, { merge: true });
  batch.set(doc(db, "users", userId), { hasNvidiaApiKey: false }, { merge: true });
  await batch.commit();
}

/**
 * Chave ScraperAPI própria do usuário (BYOK — set/2026, virou igual às
 * demais). Antes era secret de SERVIDOR (`SCRAPERAPI_KEY`, variável de
 * ambiente da Vercel, uma só pra toda a plataforma) — decisão revertida
 * porque não escala pra "qualquer pessoa comercializar": cada cliente
 * novo aumentaria o custo de infraestrutura do operador da Arbitra sem
 * receita correspondente. Agora cada usuário cadastra a própria chave
 * aqui, mesmo doc `users/{uid}/secrets/keys` das demais (campo
 * `scraperApiKey`).
 *
 * Usada em TRÊS pontos do servidor (ver api/_lib/userSecrets.ts >
 * getUserScraperApiKey, resolvida incondicionalmente, não só quando o
 * provider selecionado é "scraperapi"): o mecanismo "ScraperAPI" em si,
 * o fallback estruturado do motor interno + IA quando a raspagem direta
 * bloqueia (fetchCandidateOffers, visionInternalSearchProvider.ts), e o
 * retry de download de imagem bloqueada (safeImageUrl.ts).
 */
export async function getUserScraperApiKey(userId: string | null): Promise<string | null> {
  if (!userId || !firebaseConfigured) return null;

  try {
    const db = await getFirebaseDb();
    const { doc, getDoc } = await import("firebase/firestore");
    const snap = await getDoc(doc(db, ...secretsDocPath(userId)));
    if (!snap.exists()) return null;
    const key = snap.data().scraperApiKey as string | undefined;
    return key?.trim() || null;
  } catch (err) {
    console.warn("Não consegui ler a chave ScraperAPI do usuário:", err);
    return null;
  }
}

export async function saveUserScraperApiKey(userId: string, key: string): Promise<void> {
  const db = await getFirebaseDb();
  const { doc, writeBatch } = await import("firebase/firestore");
  const batch = writeBatch(db);
  batch.set(
    doc(db, ...secretsDocPath(userId)),
    { scraperApiKey: key.trim(), updatedAt: Date.now() },
    { merge: true }
  );
  batch.set(doc(db, "users", userId), { hasScraperApiKey: true }, { merge: true });
  await batch.commit();
}

export async function deleteUserScraperApiKey(userId: string): Promise<void> {
  const db = await getFirebaseDb();
  const { doc, writeBatch } = await import("firebase/firestore");
  const batch = writeBatch(db);
  batch.set(doc(db, ...secretsDocPath(userId)), { scraperApiKey: null }, { merge: true });
  batch.set(doc(db, "users", userId), { hasScraperApiKey: false }, { merge: true });
  await batch.commit();
}
