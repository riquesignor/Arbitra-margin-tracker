import type { MarketplaceId, MarketplacePriceResult, SearchProviderId } from "./types.js";
import { getAdminDb } from "./firestoreAdmin.js";

const TTL_MS = 2 * 60 * 60 * 1000; // 2h — mesmo TTL do master prompt

/**
 * TTL curto pra match APROXIMADO (set/2026, ver docs/auditoria-2026-09.md
 * > item 13). Um match aproximado é, por definição, um palpite: pode ser
 * outra loja, ou similaridade baixa demais pra afirmar que é o mesmo
 * produto (ver `approximate` em types.ts). Guardá-lo pelas mesmas 2h de um
 * match bom significa que um palpite ruim gruda no SKU e volta igual em
 * toda nova busca da tarde inteira — inclusive depois do usuário melhorar
 * a foto do catálogo ou trocar de mecanismo, que é justamente quando ele
 * está tentando corrigir o resultado. 15 minutos mantêm o benefício de
 * cache dentro da MESMA sessão de trabalho (reprocessar o catálogo logo em
 * seguida não gasta cota de novo) sem cravar o palpite pro resto do dia.
 */
const APPROXIMATE_TTL_MS = 15 * 60 * 1000;
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

/**
 * Quantos documentos por chamada de `getAll` (ver getCachedPrices). 300 é
 * folgado pro teto do request do Firestore e mantém o payload de resposta
 * num tamanho razoável — o app hoje manda no máximo 50 SKUs por
 * requisição (MAX_ITEMS_PER_REQUEST em fetch-prices.ts), então na prática
 * é sempre um bloco só; o laço existe pra não quebrar se esse teto subir.
 */
const CACHE_READ_CHUNK = 300;

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
  const refs = skus.map((sku) => collection.doc(docId(provider, marketplace, sku)));

  // `getAll` em blocos (set/2026, ver docs/auditoria-2026-09.md > item 14)
  // no lugar de um `.get()` por SKU dentro de Promise.all: era 1
  // round-trip por produto POR marketplace, por busca — num catálogo
  // grande isso vira milhares de idas ao Firestore só pra descobrir o que
  // já está em cache. `getAll` resolve o bloco inteiro numa chamada só,
  // devolvendo os snapshots NA MESMA ORDEM dos refs (é o que permite
  // casar índice com SKU logo abaixo).
  const snaps = [];
  for (let i = 0; i < refs.length; i += CACHE_READ_CHUNK) {
    snaps.push(...(await db.getAll(...refs.slice(i, i + CACHE_READ_CHUNK))));
  }

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
  const now = Date.now();
  const batch = db.batch();
  const collection = db.collection("users").doc(userId).collection(SUBCOLLECTION);

  for (const [sku, value] of entries) {
    batch.set(collection.doc(docId(provider, marketplace, sku)), {
      sku,
      marketplace,
      provider,
      value,
      lastSync: now,
      // TTL por ENTRADA, não por lote — match aproximado expira bem mais
      // rápido que match confiável (ver APPROXIMATE_TTL_MS acima).
      expiresAt: now + (value.approximate ? APPROXIMATE_TTL_MS : TTL_MS),
    });
  }

  await batch.commit();
}
