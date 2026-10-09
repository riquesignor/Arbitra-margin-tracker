import { timingSafeEqual } from "node:crypto";
import type { DocumentReference } from "firebase-admin/firestore";
import type { ApiRequest, ApiResponse } from "./_lib/httpTypes.js";
import { getAdminDb } from "./_lib/firestoreAdmin.js";
import { consumeSearchQuota, QuotaExceededError } from "./_lib/searchQuota.js";
import { featuresForPlan } from "./_lib/planFeatures.js";
import { checkAndPersistWatch, type WatchDoc } from "./_lib/watchCheck.js";
import { mapWithConcurrency } from "./_lib/concurrency.js";

/**
 * GET /api/cron-check-watches — Fase B do monitoramento (out/2026).
 * Chamado 1x/dia pelo Vercel Cron (vercel.json > crons), que manda
 * `Authorization: Bearer $CRON_SECRET` sozinho quando a variável existe
 * no projeto. Sem a variável configurada o endpoint RECUSA tudo — nunca
 * roda "aberto".
 *
 * Só checa watches de quem (a) está num plano com `autoWatchCheck` e
 * (b) ligou "Checar automaticamente todo dia" em Meus produtos — gasta a
 * cota BYOK do próprio usuário sem ele estar olhando, então é opt-in.
 * Mais antigos primeiro e com orçamento de tempo, pra caber no teto de
 * 300s da function; o que sobrar fica pra execução do dia seguinte.
 */

const TIME_BUDGET_MS = 240_000;
const RECHECK_AFTER_MS = 20 * 60 * 60 * 1000;
const CONCURRENCY = 4;

function authorized(req: ApiRequest): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret) return false;
  const header = req.headers?.authorization;
  const value = Array.isArray(header) ? header[0] : header;
  if (!value) return false;
  const expected = Buffer.from(`Bearer ${secret}`);
  const received = Buffer.from(value);
  return expected.length === received.length && timingSafeEqual(expected, received);
}

export default async function handler(req: ApiRequest, res: ApiResponse): Promise<void> {
  if (req.method !== "GET" && req.method !== "POST") {
    res.status(405).json({ error: "Método não permitido" });
    return;
  }
  if (!authorized(req)) {
    res.status(401).json({ error: "Não autorizado" });
    return;
  }

  const startedAt = Date.now();
  const db = getAdminDb();
  const snap = await db.collectionGroup("watches").where("active", "==", true).get();

  // Agrupa por dono e filtra quem tem direito + ligou a opção.
  const byUser = new Map<string, { ref: DocumentReference; watch: WatchDoc }[]>();
  for (const doc of snap.docs) {
    const uid = doc.ref.parent.parent?.id;
    if (!uid) continue;
    const watch = doc.data() as WatchDoc;
    if (startedAt - (watch.lastCheckedAt ?? 0) < RECHECK_AFTER_MS) continue;
    const list = byUser.get(uid) ?? [];
    list.push({ ref: doc.ref, watch });
    byUser.set(uid, list);
  }

  const eligible: { uid: string; ref: DocumentReference; watch: WatchDoc }[] = [];
  for (const [uid, items] of byUser) {
    const [profileSnap, prefsSnap] = await Promise.all([
      db.collection("users").doc(uid).get(),
      db.collection("users").doc(uid).collection("preferences").doc("config").get(),
    ]);
    if (!featuresForPlan(profileSnap.data()?.plan as string | undefined).autoWatchCheck) continue;
    if (prefsSnap.data()?.autoCheckWatches !== true) continue;
    for (const item of items) eligible.push({ uid, ...item });
  }
  eligible.sort((a, b) => (a.watch.lastCheckedAt ?? 0) - (b.watch.lastCheckedAt ?? 0));

  const quotaBlocked = new Set<string>();
  let checked = 0;
  let alerts = 0;
  let failed = 0;
  let skippedForTime = 0;

  await mapWithConcurrency(eligible, CONCURRENCY, async ({ uid, ref, watch }) => {
    if (Date.now() - startedAt > TIME_BUDGET_MS) {
      skippedForTime++;
      return;
    }
    if (quotaBlocked.has(uid)) return;
    try {
      await consumeSearchQuota(uid, watch.provider, 1);
    } catch (err) {
      if (err instanceof QuotaExceededError) {
        quotaBlocked.add(uid);
        return;
      }
      console.error(`[cron-check-watches] falha ao reservar cota de ${uid} (seguindo):`, err);
    }
    try {
      const { alertId } = await checkAndPersistWatch(db, uid, ref, watch);
      checked++;
      if (alertId) alerts++;
    } catch (err) {
      failed++;
      console.warn(`[cron-check-watches] falha no watch ${ref.path}:`, err instanceof Error ? err.message : err);
    }
  });

  res.status(200).json({
    candidates: eligible.length,
    checked,
    alerts,
    failed,
    skippedForTime,
    quotaBlockedUsers: quotaBlocked.size,
    ms: Date.now() - startedAt,
  });
}
