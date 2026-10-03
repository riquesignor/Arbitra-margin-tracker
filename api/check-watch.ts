import type { ApiRequest, ApiResponse } from "./_lib/httpTypes.js";
import type { MarketplaceId } from "./_lib/types.js";
import { requireVerifiedAuth, UnauthorizedError, EmailNotVerifiedError } from "./_lib/verifyAuth.js";
import { consumeSearchQuota, QuotaExceededError } from "./_lib/searchQuota.js";
import { getAdminDb } from "./_lib/firestoreAdmin.js";
import { checkWatch, watchId, buildAlertDoc, type WatchDoc } from "./_lib/watchCheck.js";
import { FetchPricesValidationError } from "./_lib/fetchPricesCore.js";

const VALID_MARKETPLACES: MarketplaceId[] = ["amazon", "shopee", "mercadolivre", "geral"];
function isValidMarketplace(value: unknown): value is MarketplaceId {
  return typeof value === "string" && (VALID_MARKETPLACES as string[]).includes(value);
}

interface RequestBody {
  sku?: string;
  marketplace?: string;
}

/**
 * POST /api/check-watch
 * Body: { sku: string, marketplace: MarketplaceId }
 *
 * Checagem MANUAL de monitoramento (Fase A — out/2026, ver
 * docs/design-critique-log.md): o botão "checar agora" num produto
 * monitorado (Meus produtos/Resultados) chama este endpoint. Existe
 * pra validar o fluxo inteiro (reler preço, comparar, gravar alerta)
 * com um usuário de verdade apertando um botão, ANTES de automatizar
 * via cron (Fase B, api/cron-check-watches.ts) — não quero ligar
 * checagem desacompanhada sem ver isso funcionar direito primeiro.
 *
 * Reaproveita tudo de `api/_lib/watchCheck.ts` (mesma função `checkWatch`
 * que o cron vai usar) e `api/_lib/fetchPricesCore.ts` (mesma busca de
 * preço de `fetch-prices.ts`) — zero lógica de busca duplicada aqui,
 * só o fio que liga "pedido HTTP" a "atualizar o watch no Firestore".
 */
export default async function handler(req: ApiRequest, res: ApiResponse): Promise<void> {
  if (req.method !== "POST") {
    res.status(405).json({ error: "Método não permitido" });
    return;
  }

  let uid: string;
  try {
    uid = await requireVerifiedAuth(req);
  } catch (err) {
    if (err instanceof UnauthorizedError) {
      res.status(401).json({ error: err.message });
      return;
    }
    if (err instanceof EmailNotVerifiedError) {
      res.status(403).json({ error: err.message });
      return;
    }
    throw err;
  }

  const body = req.body as RequestBody;
  if (typeof body?.sku !== "string" || !body.sku.trim()) {
    res.status(400).json({ error: "sku é obrigatório" });
    return;
  }
  if (!isValidMarketplace(body.marketplace)) {
    res.status(400).json({ error: `marketplace inválido: ${VALID_MARKETPLACES.join(" | ")}` });
    return;
  }

  const db = getAdminDb();
  const ref = db.collection("users").doc(uid).collection("watches").doc(watchId(body.sku, body.marketplace));
  const snap = await ref.get();
  if (!snap.exists || snap.data()?.active !== true) {
    res.status(404).json({ error: "Este produto não está sendo monitorado." });
    return;
  }
  const watch = snap.data() as WatchDoc;

  // Mesma reserva de cota de fetch-prices.ts, custo 1 (1 item × 1
  // marketplace) — ANTES de qualquer chamada externa.
  try {
    await consumeSearchQuota(uid, watch.provider, 1);
  } catch (err) {
    if (err instanceof QuotaExceededError) {
      res.status(429).json({ error: err.message, used: err.used, limit: err.limit });
      return;
    }
    // Mesma filosofia de fetch-prices.ts: falha ABERTA no contador (não
    // no provider em si) não pode travar uma checagem que o usuário
    // pediu na hora.
    console.error("[check-watch] falha ao reservar cota (seguindo sem bloquear):", err);
  }

  try {
    const outcome = await checkWatch(uid, watch);

    const updates: Partial<WatchDoc> = outcome.found
      ? { lastPrice: outcome.newPrice!, lastMarginPct: outcome.newMarginPct, lastStatus: "disponivel", lastCheckedAt: Date.now() }
      : { lastStatus: "esgotado", lastCheckedAt: Date.now() };
    await ref.set(updates, { merge: true });

    let alertId: string | null = null;
    if (outcome.alertKind) {
      const alertRef = db.collection("users").doc(uid).collection("watch_alerts").doc();
      await alertRef.set(buildAlertDoc(ref.id, watch, outcome));
      alertId = alertRef.id;
    }

    res.status(200).json({
      checked: true,
      alert: alertId ? { id: alertId, kind: outcome.alertKind } : null,
      lastPrice: outcome.found ? outcome.newPrice : watch.lastPrice,
      lastStatus: outcome.found ? "disponivel" : "esgotado",
    });
  } catch (err) {
    if (err instanceof FetchPricesValidationError) {
      res.status(400).json({ error: err.message });
      return;
    }
    res.status(502).json({
      error: "Checagem indisponível",
      detail: err instanceof Error ? err.message : String(err),
    });
  }
}
