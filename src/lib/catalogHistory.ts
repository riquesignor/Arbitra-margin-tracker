import type { CatalogRow, MarginResult, MarketplaceId, MarketplacePriceResult } from "../types";
import type { PageRange } from "./parsePdfCatalog";
import { firebaseConfigured, getFirebaseDb } from "./firebase";

const COLLECTION = "catalog_uploads";

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
      collection(db, COLLECTION),
      where("userId", "==", userId),
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
    await addDoc(collection(db, COLLECTION), { ...record, userId });
  } catch (err) {
    console.warn("Não consegui salvar histórico de upload (seguindo sem persistir):", err);
  }
}

const DEFAULT_HISTORY_LIMIT = 50;

/**
 * Lista o histórico do usuário, mais recente primeiro, limitado a
 * `limitCount` documentos. Antes buscava TUDO sem teto — cada doc carrega
 * linhas + preços + resultados completos, então o custo de leitura
 * crescia sem limite conforme o usuário acumulava catálogos (ver
 * docs/architecture-review.md > Performance). `orderBy` + `limit` no
 * próprio Firestore (não corte em memória) exige o índice composto
 * `userId ASC, uploadedAt DESC` — ver firestore.indexes.json.
 */
export async function listCatalogUploads(
  userId: string | null,
  limitCount = DEFAULT_HISTORY_LIMIT
): Promise<CatalogUploadRecord[]> {
  if (!userId || !firebaseConfigured) return [];

  try {
    const db = await getFirebaseDb();
    const { collection, query, where, orderBy, limit, getDocs } = await import(
      "firebase/firestore"
    );
    const q = query(
      collection(db, COLLECTION),
      where("userId", "==", userId),
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
