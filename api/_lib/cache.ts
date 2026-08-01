import type { MarketplaceId, MarketplacePriceResult, SearchProviderId } from "./types.js";
import { getAdminDb } from "./firestoreAdmin.js";

const TTL_MS = 2 * 60 * 60 * 1000; // 2h — mesmo TTL do master prompt
const COLLECTION = "market_prices";

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
 * há credenciais reais).
 */
export async function getCachedPrices(
  provider: SearchProviderId,
  marketplace: MarketplaceId,
  skus: string[]
): Promise<{ hits: Record<string, MarketplacePriceResult>; misses: string[] }> {
  const db = getAdminDb();
  const now = Date.now();
  const hits: Record<string, MarketplacePriceResult> = {};
  const misses: string[] = [];

  const snaps = await Promise.all(
    skus.map((sku) => db.collection(COLLECTION).doc(docId(provider, marketplace, sku)).get())
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
  provider: SearchProviderId,
  marketplace: MarketplaceId,
  prices: Record<string, MarketplacePriceResult>
): Promise<void> {
  const entries = Object.entries(prices);
  if (entries.length === 0) return;

  const db = getAdminDb();
  const expiresAt = Date.now() + TTL_MS;
  const batch = db.batch();

  for (const [sku, value] of entries) {
    batch.set(db.collection(COLLECTION).doc(docId(provider, marketplace, sku)), {
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
