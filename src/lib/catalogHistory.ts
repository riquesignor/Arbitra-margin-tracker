import type { CatalogRow, MarginResult, MarketplaceId, MarketplacePriceResult } from "../types";
import type { PageRange } from "./parsePdfCatalog";
import { firebaseConfigured, getFirebaseDb } from "./firebase";

/**
 * Subcoleção de `users/{userId}` (ver ADR-0003) — cada busca do usuário
 * vira um doc em `users/{userId}/catalog_uploads/{autoId}`. Antes era uma
 * coleção de nível superior com campo `userId` + índice composto
 * (`userId ASC, uploadedAt DESC`, ver firestore.indexes.json antigo); a
 * subcoleção já escopa por usuário via path, então some tanto o campo
 * quanto o índice — sobra só um `orderBy` simples.
 */
const SUBCOLLECTION = "catalog_uploads";

export interface CatalogUploadRecord {
  id: string;
  fileName: string;
  fileHash: string;
  sourceType: "csv" | "pdf";
  pageRange: PageRange | null;
  marketplaces: MarketplaceId[];
  uploadedAt: number;
  rows: CatalogRow[];
  pricesByMarket: Partial<Record<MarketplaceId, Record<string, MarketplacePriceResult>>>;
  results: MarginResult[];
  source: "server" | "local";
}

/** SHA-256 do conteúdo do arquivo — usado como chave pra "já processei isso antes?". */
export async function computeFileHash(file: File): Promise<string> {
  const buffer = await file.arrayBuffer();
  const digest = await crypto.subtle.digest("SHA-256", buffer);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

function samePageRange(a: PageRange | null, b: PageRange | null): boolean {
  if (!a || !b) return a === b;
  return a.from === b.from && a.to === b.to;
}

function sameMarketplaces(a: MarketplaceId[], b: MarketplaceId[]): boolean {
  if (a.length !== b.length) return false;
  const sortedA = [...a].sort();
  const sortedB = [...b].sort();
  return sortedA.every((m, i) => m === sortedB[i]);
}

/**
 * Procura um upload já processado (mesmo arquivo + mesmo intervalo de
 * página) pro usuário logado. Sem login ou Firebase não configurado:
 * sempre null — histórico persistente exige as duas coisas. Consulta só
 * com `where` de igualdade (sem orderBy) de propósito, pra não exigir
 * índice composto no Firestore; ordenação por data é feita em memória.
 * Sem filtro de `userId` — a subcoleção `users/{userId}/catalog_uploads`
 * já escopa isso pelo path (ver ADR-0003).
 *
 * Só considera "cache hit" registros com `results.length > 0` — um
 * processamento anterior que não achou preço nenhum (SerpApi fora do
 * ar, chave errada, catálogo com nomes ruins etc.) não deve ser servido
 * pra sempre no lugar de tentar de novo. Sem isso, um upload que falhou
 * uma vez fica "preso" mostrando resultado vazio indefinidamente.
 */
export async function findExistingUpload(
  userId: string | null,
  fileHash: string,
  pageRange: PageRange | null,
  marketplaces: MarketplaceId[]
): Promise<CatalogUploadRecord | null> {
  if (!userId || !firebaseConfigured) return null;

  try {
    const db = await getFirebaseDb();
    const { collection, query, where, getDocs } = await import("firebase/firestore");

    const q = query(
      collection(db, "users", userId, SUBCOLLECTION),
      where("fileHash", "==", fileHash)
    );

    const snap = await getDocs(q);
    if (snap.empty) return null;

    const candidates = snap.docs
      .map((d) => ({ id: d.id, ...(d.data() as Omit<CatalogUploadRecord, "id">) }))
      .filter(
        (c) =>
          samePageRange(c.pageRange, pageRange) &&
          sameMarketplaces(c.marketplaces ?? [], marketplaces) &&
          c.results.length > 0
      )
      .sort((a, b) => b.uploadedAt - a.uploadedAt);

    return candidates[0] ?? null;
  } catch (err) {
    console.warn("Não consegui checar histórico de uploads (seguindo sem cache):", err);
    return null;
  }
}

/** Salva o resultado de um processamento. Best-effort: falha aqui não deve travar o fluxo principal. */
export async function saveCatalogUpload(
  userId: string | null,
  record: Omit<CatalogUploadRecord, "id">
): Promise<void> {
  if (!userId || !firebaseConfigured) return;

  try {
    const db = await getFirebaseDb();
    const { collection, addDoc } = await import("firebase/firestore");
    await addDoc(collection(db, "users", userId, SUBCOLLECTION), record);
  } catch (err) {
    console.warn("Não consegui salvar histórico de upload (seguindo sem persistir):", err);
  }
}

const DEFAULT_HISTORY_LIMIT = 50;

/**
 * Lista o histórico do usuário, mais recente primeiro, limitado a
 * `limitCount` documentos. `orderBy` + `limit` direto na subcoleção
 * `users/{userId}/catalog_uploads` — sem índice composto (ver ADR-0003):
 * o path já escopa por usuário, então só sobra um índice de campo único
 * (automático no Firestore).
 */
export async function listCatalogUploads(
  userId: string | null,
  limitCount = DEFAULT_HISTORY_LIMIT
): Promise<CatalogUploadRecord[]> {
  if (!userId || !firebaseConfigured) return [];

  try {
    const db = await getFirebaseDb();
    const { collection, query, orderBy, limit, getDocs } = await import("firebase/firestore");
    const q = query(
      collection(db, "users", userId, SUBCOLLECTION),
      orderBy("uploadedAt", "desc"),
      limit(limitCount)
    );
    const snap = await getDocs(q);

    return snap.docs.map((d) => ({ id: d.id, ...(d.data() as Omit<CatalogUploadRecord, "id">) }));
  } catch (err) {
    console.warn("Não consegui listar histórico de uploads:", err);
    return [];
  }
}

/**
 * Exclui um registro de busca do histórico (Dashboard, seção "Catálogos
 * processados"). Precisa de `userId` porque o doc mora numa subcoleção
 * (`users/{userId}/catalog_uploads/{id}`, ver ADR-0003) — Firestore
 * exige o path completo pra apagar, não dá pra endereçar só pelo ID como
 * antes (coleção de nível superior). Só remove o documento em
 * `catalog_uploads` — não mexe em `catalog_images` (fotos ligadas a essa
 * busca seguem seu próprio TTL normalmente, ver catalogImages.ts) nem em
 * `market_prices` (cache de preço é global por SKU, não por busca, então
 * outra busca do mesmo produto continua se beneficiando dele). Ownership
 * é garantida pela security rule do Firestore (só o dono do documento
 * pode apagar), não checada aqui no client.
 */
export async function deleteCatalogUpload(userId: string, id: string): Promise<void> {
  if (!firebaseConfigured) return;
  const db = await getFirebaseDb();
  const { doc, deleteDoc } = await import("firebase/firestore");
  await deleteDoc(doc(db, "users", userId, SUBCOLLECTION, id));
}
