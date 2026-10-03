import type { MarginResult, MarketplaceId, PlanId, Recommendation, SearchProviderId } from "../types";
import { getPlan } from "../config/plans";
import { firebaseConfigured, getFirebaseDb } from "./firebase";
import { getCurrentIdToken } from "./auth";

/**
 * Monitoramento contínuo (out/2026, inspirado na JoomPulse — ver
 * docs/design-critique-log.md): o dono marca um produto de Resultados/
 * Meus produtos como "monitorado" e uma checagem diária (Fase A: botão
 * "checar agora", api/check-watch.ts; Fase B: cron, api/cron-check-
 * watches.ts) rebusca o preço sozinha e grava um alerta quando ele muda.
 * Subcoleções de `users/{userId}` (ver firestore.rules): `watches` (o
 * que está sendo monitorado) e `watch_alerts` (o que já mudou).
 */
const WATCHES_SUBCOLLECTION = "watches";
const ALERTS_SUBCOLLECTION = "watch_alerts";

/**
 * ID determinístico (sku+marketplace, não autoId) — evita duplicar
 * watch do mesmo produto se o usuário clicar "monitorar" duas vezes, e
 * deixa `stopWatching` endereçar o doc direto, sem precisar de query.
 * SKU vira parte do ID do documento, então passa por um saneamento básico
 * (Firestore não aceita "/" no ID); colisão entre dois SKUs bem diferentes
 * que saneiam pro mesmo texto é teoricamente possível mas não esperada no
 * padrão de SKU visto nos catálogos reais (alfanumérico + hífen).
 */
export function watchId(sku: string, marketplace: MarketplaceId): string {
  const safeSku = sku.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 200) || "sku";
  return `${safeSku}__${marketplace}`;
}

/**
 * Disponibilidade da ÚLTIMA checagem — não é a recomendação (Recomendado/
 * Revisar/Evitar) de Resultados: essa vem do motor de regras completo
 * (marginCalculator.ts, taxa/frete/imposto), que o cron NÃO tem acesso
 * (ver approxMarginPct abaixo). "sem_chave" = provider precisa de BYOK e
 * o usuário removeu a chave depois de começar a monitorar — a checagem
 * pula o watch (não é erro do produto) e avisa assim em vez de falhar
 * calado. A recomendação de quando o watch foi criado fica congelada em
 * `recommendationAtCreation`, só pra contexto ("era Recomendado quando
 * comecei a monitorar"), nunca recalculada depois.
 */
export type WatchStatus = "disponivel" | "esgotado" | "sem_chave";

export interface WatchItem {
  id: string;
  sku: string;
  name: string;
  marketplace: MarketplaceId;
  provider: SearchProviderId;
  supplierPrice?: number;
  imageUrl?: string;
  link?: string;
  /** Recomendação de Resultados no momento em que o watch foi criado — congelada, nunca recalculada. */
  recommendationAtCreation: Recommendation;
  lastPrice: number;
  lastMarginPct?: number;
  lastStatus: WatchStatus;
  lastCheckedAt: number;
  createdAt: number;
  active: boolean;
}

export type WatchAlertKind = "price_down" | "price_up" | "out_of_stock" | "back_in_stock";

export interface WatchAlert {
  id: string;
  watchId: string;
  sku: string;
  name: string;
  kind: WatchAlertKind;
  oldPrice: number | null;
  newPrice: number | null;
  oldMarginPct?: number;
  newMarginPct?: number;
  createdAt: number;
  read: boolean;
}

export class WatchLimitError extends Error {}

/**
 * Margem aproximada: só preço vs. custo, SEM taxa de marketplace/frete/
 * imposto (essas regras completas moram em `marginCalculator.ts`,
 * client-only — portar o motor inteiro pro cron é desproporcional pra
 * v1 do monitoramento). Calculada do MESMO jeito na criação do watch e
 * em toda checagem depois, de propósito — comparar "era X%, agora é Y%"
 * só faz sentido com a mesma fórmula nas duas pontas; a margem EXATA
 * (com todas as regras) continua em Resultados/Precificação, onde já
 * funciona. Exportada pra `api/check-watch.ts`/`api/cron-check-
 * watches.ts` usarem a mesma conta.
 */
export function approxMarginPct(price: number, supplierPrice: number | undefined): number | undefined {
  if (supplierPrice == null || supplierPrice <= 0) return undefined;
  return (price - supplierPrice) / supplierPrice;
}

/**
 * Começa a monitorar um produto (botão de sino em Resultados/Meus
 * produtos). `planId` decide o teto (`maxWatches`, config/plans.ts) —
 * checagem do lado do app, mesmo espírito de `dailySearchLimit`: guia uso
 * normal, não é barreira à prova de acesso direto ao Firestore (ver
 * comentário em firestore.rules > watches).
 */
export async function startWatching(
  userId: string,
  planId: PlanId | null | undefined,
  item: MarginResult,
  provider: SearchProviderId
): Promise<void> {
  if (!firebaseConfigured) return;
  const db = await getFirebaseDb();
  const { collection, doc, getDocs, query, setDoc, where } = await import("firebase/firestore");

  const existing = await getDocs(
    query(collection(db, "users", userId, WATCHES_SUBCOLLECTION), where("active", "==", true))
  );
  const id = watchId(item.sku, item.marketplace);
  const alreadyWatchingThis = existing.docs.some((d) => d.id === id);
  if (!alreadyWatchingThis && existing.size >= getPlan(planId).maxWatches) {
    throw new WatchLimitError(
      `Seu plano permite monitorar até ${getPlan(planId).maxWatches} produto(s) ao mesmo tempo. ` +
        "Pare de monitorar algum produto antes de adicionar um novo."
    );
  }

  const watch: Omit<WatchItem, "id"> = {
    sku: item.sku,
    name: item.name,
    marketplace: item.marketplace,
    provider,
    supplierPrice: item.supplierPrice,
    imageUrl: item.imageUrl,
    link: item.link,
    recommendationAtCreation: item.recommendation,
    lastPrice: item.marketplacePrice,
    lastMarginPct: approxMarginPct(item.marketplacePrice, item.supplierPrice),
    lastStatus: "disponivel",
    lastCheckedAt: Date.now(),
    createdAt: Date.now(),
    active: true,
  };
  await setDoc(doc(db, "users", userId, WATCHES_SUBCOLLECTION, id), watch);
}

export async function stopWatching(userId: string, sku: string, marketplace: MarketplaceId): Promise<void> {
  if (!firebaseConfigured) return;
  const db = await getFirebaseDb();
  const { doc, deleteDoc } = await import("firebase/firestore");
  await deleteDoc(doc(db, "users", userId, WATCHES_SUBCOLLECTION, watchId(sku, marketplace)));
}

export async function listWatches(userId: string | null): Promise<WatchItem[]> {
  if (!userId || !firebaseConfigured) return [];
  try {
    const db = await getFirebaseDb();
    const { collection, getDocs, orderBy, query, where } = await import("firebase/firestore");
    const snap = await getDocs(
      query(
        collection(db, "users", userId, WATCHES_SUBCOLLECTION),
        where("active", "==", true),
        orderBy("createdAt", "desc")
      )
    );
    return snap.docs.map((d) => ({ id: d.id, ...(d.data() as Omit<WatchItem, "id">) }));
  } catch (err) {
    console.warn("Não consegui listar produtos monitorados:", err);
    return [];
  }
}

/** Sino de notificação (TopNav) — alertas não lidos, mais recentes primeiro. */
export async function listUnreadAlerts(userId: string | null, limitCount = 20): Promise<WatchAlert[]> {
  if (!userId || !firebaseConfigured) return [];
  try {
    const db = await getFirebaseDb();
    const { collection, getDocs, limit, orderBy, query, where } = await import("firebase/firestore");
    const snap = await getDocs(
      query(
        collection(db, "users", userId, ALERTS_SUBCOLLECTION),
        where("read", "==", false),
        orderBy("createdAt", "desc"),
        limit(limitCount)
      )
    );
    return snap.docs.map((d) => ({ id: d.id, ...(d.data() as Omit<WatchAlert, "id">) }));
  } catch (err) {
    console.warn("Não consegui listar alertas de monitoramento:", err);
    return [];
  }
}

export async function markAlertRead(userId: string, alertId: string): Promise<void> {
  if (!firebaseConfigured) return;
  const db = await getFirebaseDb();
  const { doc, updateDoc } = await import("firebase/firestore");
  await updateDoc(doc(db, "users", userId, ALERTS_SUBCOLLECTION, alertId), { read: true });
}

export interface CheckWatchResult {
  checked: boolean;
  alert: { id: string; kind: WatchAlertKind } | null;
  lastPrice: number | null;
  lastStatus: WatchStatus;
}

/**
 * Botão "checar agora" (Fase A — out/2026, ver api/check-watch.ts).
 * Mesmo padrão de autenticação de `src/lib/priceApi.ts` (Authorization:
 * Bearer idToken) — mesmo endpoint-família, mesma forma de chamar.
 */
export async function checkWatchNow(sku: string, marketplace: MarketplaceId): Promise<CheckWatchResult> {
  const idToken = await getCurrentIdToken();
  const response = await fetch("/api/check-watch", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(idToken ? { Authorization: `Bearer ${idToken}` } : {}),
    },
    body: JSON.stringify({ sku, marketplace }),
  });

  if (!response.ok) {
    let detail = `Checagem falhou (${response.status})`;
    try {
      const body = (await response.json()) as { error?: string; detail?: string };
      detail = body.detail || body.error || detail;
    } catch {
      // Resposta não veio como JSON — mantém a mensagem genérica acima.
    }
    throw new Error(detail);
  }

  return (await response.json()) as CheckWatchResult;
}
