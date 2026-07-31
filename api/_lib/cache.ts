<<<<<<< HEAD
import type { MarketplaceId, MarketplacePriceResult, SearchProviderId } from "./types";
=======
import type { MarketplaceId, MarketplacePriceResult } from "./types";
>>>>>>> 876d06fbe516a280c102d8517ac760291de86799
import { getAdminDb } from "./firestoreAdmin";

const TTL_MS = 2 * 60 * 60 * 1000; // 2h — mesmo TTL do master prompt
const COLLECTION = "market_prices";

<<<<<<< HEAD
// Chave inclui o provider: o mesmo marketplace pode ser resolvido por
// APIs diferentes (ver SearchProviderId em types.ts) e cada uma tem seu
// próprio critério de match/preço — misturar cache entre elas mostraria
// preço "amazon" que na verdade veio da RapidAPI quando o usuário pediu
// SerpApi (ou vice-versa). TTL de 2h já torna a mudança de formato de
// chave inofensiva (entradas antigas só expiram sem serem lidas de novo).
function docId(provider: SearchProviderId, marketplace: MarketplaceId, sku: string): string {
  return `${provider}__${marketplace}__${sku}`;
=======
function docId(marketplace: MarketplaceId, sku: string): string {
  return `${marketplace}__${sku}`;
>>>>>>> 876d06fbe516a280c102d8517ac760291de86799
}

/**
 * Firestore-backed (substituiu o in-memory do primeiro scaffold agora que
<<<<<<< HEAD
 * há credenciais reais).
 */
export async function getCachedPrices(
  provider: SearchProviderId,
=======
 * há credenciais reais). Mesma assinatura de antes — fetch-prices.ts não
 * mudou por causa disso, só passou a `await`.
 */
export async function getCachedPrices(
>>>>>>> 876d06fbe516a280c102d8517ac760291de86799
  marketplace: MarketplaceId,
  skus: string[]
): Promise<{ hits: Record<string, MarketplacePriceResult>; misses: string[] }> {
  const db = getAdminDb();
  const now = Date.now();
  const hits: Record<string, MarketplacePriceResult> = {};
  const misses: string[] = [];

  const snaps = await Promise.all(
<<<<<<< HEAD
    skus.map((sku) => db.collection(COLLECTION).doc(docId(provider, marketplace, sku)).get())
=======
    skus.map((sku) => db.collection(COLLECTION).doc(docId(marketplace, sku)).get())
>>>>>>> 876d06fbe516a280c102d8517ac760291de86799
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
<<<<<<< HEAD
  provider: SearchProviderId,
=======
>>>>>>> 876d06fbe516a280c102d8517ac760291de86799
  marketplace: MarketplaceId,
  prices: Record<string, MarketplacePriceResult>
): Promise<void> {
  const entries = Object.entries(prices);
  if (entries.length === 0) return;

  const db = getAdminDb();
  const expiresAt = Date.now() + TTL_MS;
  const batch = db.batch();

  for (const [sku, value] of entries) {
<<<<<<< HEAD
    batch.set(db.collection(COLLECTION).doc(docId(provider, marketplace, sku)), {
      sku,
      marketplace,
      provider,
=======
    batch.set(db.collection(COLLECTION).doc(docId(marketplace, sku)), {
      sku,
      marketplace,
>>>>>>> 876d06fbe516a280c102d8517ac760291de86799
      value,
      lastSync: Date.now(),
      expiresAt,
    });
  }

  await batch.commit();
}
