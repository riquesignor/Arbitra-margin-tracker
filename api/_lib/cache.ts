import type { MarketplaceId, MarketplacePriceResult, SearchProviderId } from "./types.js";
import { getAdminDb } from "./firestoreAdmin.js";

const TTL_MS = 2 * 60 * 60 * 1000; // 2h — mesmo TTL do master prompt
// Subcoleção de `users/{userId}` (mesmo padrão de pricing_rules/secrets/
// preferences/catalog_uploads/usage_daily — ver ADR-0003), NÃO mais uma
// coleção de nível superior. Antes era global de propósito ("preço do
// SKU X é o mesmo pra todo mundo", economiza cota de API entre
// usuários) — mudou por pedido explícito: como a chave é
// `provider__marketplace__sku` e SKU é texto arbitrário do catálogo de
// cada fornecedor, dois usuários (ou dois catálogos do MESMO usuário)
// usando o mesmo texto de SKU pra produtos DIFERENTES colidiam e um
// herdava o preço errado do outro. Isolar por usuário elimina essa
// colisão por completo, ao custo de perder o compartilhamento de cache
// entre contas (cada usuário paga a própria busca, mesmo se outro já
// buscou o mesmo produto).
const SUBCOLLECTION = "market_prices";

// Chave inclui o provider: o mesmo marketplace pode ser resolvido por
// APIs diferentes (ver SearchProviderId em types.ts) e cada uma tem seu
// próprio critério de match/preço — misturar cache entre elas mostraria
// preço "amazon" que na verdade veio da RapidAPI quando o usuário pediu
// SerpApi (ou vice-versa). TTL de 2h já torna a mudança de formato de
// chave inofensiva (entradas antigas só expiram sem serem lidas de novo).
function docId(provider: SearchProviderId, marketplace: MarketplaceId, sku: string): string {
  return `${provider}__${marketplace}__${sku}`;
}

/**
 * Firestore-backed (substituiu o in-memory do primeiro scaffold agora que
 * há credenciais reais). `userId` escopa o cache — ver comentário acima
 * de `SUBCOLLECTION`.
 */
export async function getCachedPrices(
  userId: string,
  provider: SearchProviderId,
  marketplace: MarketplaceId,
  skus: string[]
): Promise<{ hits: Record<string, MarketplacePriceResult>; misses: string[] }> {
  const db = getAdminDb();
  const now = Date.now();
  const hits: Record<string, MarketplacePriceResult> = {};
  const misses: string[] = [];

  const collection = db.collection("users").doc(userId).collection(SUBCOLLECTION);
  const snaps = await Promise.all(
    skus.map((sku) => collection.doc(docId(provider, marketplace, sku)).get())
  );

  snaps.forEach((snap, i) => {
    const sku = skus[i];
    const data = snap.data();
    if (data && typeof data.expiresAt === "number" && data.expiresAt > now) {
      hits[sku] = data.value as MarketplacePriceResult;
    } else {
      misses.push(sku);
    }
  });

  return { hits, misses };
}

export async function writeCachedPrices(
  userId: string,
  provider: SearchProviderId,
  marketplace: MarketplaceId,
  prices: Record<string, MarketplacePriceResult>
): Promise<void> {
  const entries = Object.entries(prices);
  if (entries.length === 0) return;

  const db = getAdminDb();
  const expiresAt = Date.now() + TTL_MS;
  const batch = db.batch();
  const collection = db.collection("users").doc(userId).collection(SUBCOLLECTION);

  for (const [sku, value] of entries) {
    batch.set(collection.doc(docId(provider, marketplace, sku)), {
      sku,
      marketplace,
      provider,
      value,
      lastSync: Date.now(),
      expiresAt,
    });
  }

  await batch.commit();
}
