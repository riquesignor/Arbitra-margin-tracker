import type { CatalogRow, PlanId } from "../types";
import { firebaseConfigured, getFirebaseDb } from "./firebase";

const COLLECTION = "shared_catalogs";

/**
 * Catálogo curado pelo admin e liberado pra um ou mais planos. Guarda os
 * produtos JÁ EXTRAÍDOS (`rows`), não o PDF bruto — decisão deliberada
 * pra não depender de Firebase Storage (que nesse projeto exigiria
 * plano Blaze só pra guardar arquivo). O parsing acontece uma vez, no
 * upload pelo admin (reaproveita `parsePdfCatalogFile`); usuários do
 * plano só consomem os dados já prontos.
 */
export interface SharedCatalog {
  id: string;
  fileName: string;
  uploadedAt: number;
  uploadedBy: string;
  plans: PlanId[];
  rows: CatalogRow[];
  skippedAmbiguous: number;
}

export async function createSharedCatalog(data: Omit<SharedCatalog, "id">): Promise<void> {
  if (!firebaseConfigured) throw new Error("Firebase não configurado.");
  const db = await getFirebaseDb();
  const { collection, addDoc } = await import("firebase/firestore");
  await addDoc(collection(db, COLLECTION), data);
}

/** Todos os catálogos da biblioteca — só admin (ver firestore.rules). */
export async function listAllSharedCatalogs(): Promise<SharedCatalog[]> {
  if (!firebaseConfigured) return [];

  try {
    const db = await getFirebaseDb();
    const { collection, getDocs } = await import("firebase/firestore");
    const snap = await getDocs(collection(db, COLLECTION));
    return snap.docs
      .map((d) => ({ id: d.id, ...(d.data() as Omit<SharedCatalog, "id">) }))
      .sort((a, b) => b.uploadedAt - a.uploadedAt);
  } catch (err) {
    console.warn("Não consegui listar a biblioteca (precisa ser admin):", err);
    return [];
  }
}

/** Catálogos liberados pra um plano específico — o que o usuário final vê no Dashboard. */
export async function listSharedCatalogsForPlan(plan: PlanId): Promise<SharedCatalog[]> {
  if (!firebaseConfigured) return [];

  try {
    const db = await getFirebaseDb();
    const { collection, query, where, getDocs } = await import("firebase/firestore");
    const q = query(collection(db, COLLECTION), where("plans", "array-contains", plan));
    const snap = await getDocs(q);
    return snap.docs
      .map((d) => ({ id: d.id, ...(d.data() as Omit<SharedCatalog, "id">) }))
      .sort((a, b) => b.uploadedAt - a.uploadedAt);
  } catch (err) {
    console.warn("Não consegui carregar a biblioteca do plano:", err);
    return [];
  }
}

export async function updateSharedCatalogPlans(id: string, plans: PlanId[]): Promise<void> {
  const db = await getFirebaseDb();
  const { doc, updateDoc } = await import("firebase/firestore");
  await updateDoc(doc(db, COLLECTION, id), { plans });
}

export async function deleteSharedCatalog(id: string): Promise<void> {
  const db = await getFirebaseDb();
  const { doc, deleteDoc } = await import("firebase/firestore");
  await deleteDoc(doc(db, COLLECTION, id));
}
