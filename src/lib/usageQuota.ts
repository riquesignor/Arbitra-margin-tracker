import { firebaseConfigured, getFirebaseDb } from "./firebase";

// Subcoleção de `users/{userId}` (ver ADR-0003) —
// `users/{userId}/usage_daily/{yyyymmdd}`. Antes era uma coleção de
// nível superior com ID composto `{uid}_{yyyymmdd}` (o prefixo existia
// só pra security rule conseguir isolar por usuário sem campo extra);
// a subcoleção já escopa por usuário via path, então o doc ID volta a
// ser só a data.
const SUBCOLLECTION = "usage_daily";

/** Chave do dia em UTC-agnóstico simples (fuso do navegador do usuário). */
function todayKey(): string {
  const d = new Date();
  return `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, "0")}${String(d.getDate()).padStart(2, "0")}`;
}

/** Quantas "buscas" (1 busca = 1 chamada à SerpApi, ver config/plans.ts) o usuário já gastou hoje. */
export async function getTodayUsage(userId: string | null): Promise<number> {
  if (!userId || !firebaseConfigured) return 0;

  try {
    const db = await getFirebaseDb();
    const { doc, getDoc } = await import("firebase/firestore");
    const snap = await getDoc(doc(db, "users", userId, SUBCOLLECTION, todayKey()));
    if (!snap.exists()) return 0;
    return (snap.data().searchCount as number) ?? 0;
  } catch (err) {
    console.warn("Não consegui checar uso diário (seguindo sem bloquear):", err);
    return 0;
  }
}

/**
 * Incrementa o contador do dia. Best-effort e otimista: se isso falhar
 * (rede, regra), a busca já foi feita (a chamada à SerpApi já aconteceu)
 * — não faz sentido reverter nada, só logamos e seguimos. Enforcement
 * real de cota (bloquear ANTES de gastar SerpApi) é feito por quem
 * chama `getTodayUsage` antes de disparar a busca (ver Dashboard.tsx).
 */
export async function addTodayUsage(userId: string | null, amount: number): Promise<void> {
  if (!userId || !firebaseConfigured || amount <= 0) return;

  try {
    const db = await getFirebaseDb();
    const { doc, setDoc, increment } = await import("firebase/firestore");
    await setDoc(
      doc(db, "users", userId, SUBCOLLECTION, todayKey()),
      { searchCount: increment(amount), updatedAt: Date.now() },
      { merge: true }
    );
  } catch (err) {
    console.warn("Não consegui registrar uso diário:", err);
  }
}
