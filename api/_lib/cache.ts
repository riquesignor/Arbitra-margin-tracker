import type { MarketplaceId, MarketplacePriceResult } from "./types";
import { getAdminDb } from "./firestoreAdmin";

const TTL_MS = 2 * 60 * 60 * 1000; // 2h — mesmo TTL do master prompt
const COLLECTION = "market_prices";

function docId(marketplace: MarketplaceId, sku: string): string {
  return `${marketplace}__${sku}`;
}

/**
 * Firestore-backed (substituiu o in-memory do primeiro scaffold agora que
 * há credenciais reais). Mesma assinatura de antes — fetch-prices.ts não
 * mudou por causa disso, só passou a `await`.
 */
export async function getCachedPrices(
  marketplace: MarketplaceId,
  skus: string[]
): Promise<{ hits: Record<string, MarketplacePriceResult>; misses: string[] }> {
  const db = getAdminDb();
  const now = Date.now();
  const hits: Record<string, MarketplacePriceResult> = {};
  const misses: string[] = [];

  const snaps = await Promise.all(
    skus.map((sku) => db.collection(COLLECTION).doc(docId(marketplace, sku)).get())
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
  marketplace: MarketplaceId,
  prices: Record<string, MarketplacePriceResult>
): Promise<void> {
  const entries = Object.entries(prices);
  if (entries.length === 0) return;

  const db = getAdminDb();
  const expiresAt = Date.now() + TTL_MS;
  const batch = db.batch();

  for (const [sku, value] of entries) {
    batch.set(db.collection(COLLECTION).doc(docId(marketplace, sku)), {
      sku,
      marketplace,
      value,
      lastSync: Date.now(),
      expiresAt,
    });
  }

  await batch.commit();
}
