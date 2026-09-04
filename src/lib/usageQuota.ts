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
 * `addTodayUsage` foi REMOVIDA (set/2026, ver api/_lib/searchQuota.ts e
 * docs/auditoria-2026-09.md > P0-3). O contador era escrito pelo próprio
 * navegador, o que tornava a "cota" puramente decorativa: o usuário podia
 * simplesmente não incrementar (ou zerar o doc, já que a security rule
 * dava write ao dono) e seguir gastando busca — inclusive nos mecanismos
 * pagos pela plataforma via SCRAPERAPI_KEY.
 *
 * Agora quem incrementa é o servidor, dentro de uma transaction e ANTES
 * de gastar API, no MESMO doc/campo que `getTodayUsage` acima lê — a
 * leitura client-side continua valendo pra desenhar a barra de cota. A
 * tela de busca também recebe o total atualizado direto na resposta de
 * /api/fetch-prices (`_usage`, ver priceApi.ts), sem precisar reler o
 * Firestore a cada lote.
 */
