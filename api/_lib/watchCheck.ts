import type { MarketplaceId, MarketplacePriceResult, SearchProviderId } from "./types.js";
import { fetchPricesCore, FetchPricesValidationError } from "./fetchPricesCore.js";

/**
 * Espelha `WatchItem`/`approxMarginPct` de src/lib/watchlist.ts — MANTER
 * EM SINCRONIA (mesmo motivo de `PLAN_DAILY_LIMIT` em searchQuota.ts:
 * `tsconfig.api.json` só inclui `api/`, cliente e servidor não
 * compartilham módulo). Usado por `api/check-watch.ts` (checagem manual)
 * e `api/cron-check-watches.ts` (Fase B) — os dois precisam do MESMO
 * resultado pra um watch dado, então a lógica mora aqui, não duplicada
 * duas vezes dentro de cada handler.
 */
export type WatchStatus = "disponivel" | "esgotado" | "sem_chave";

export interface WatchDoc {
  sku: string;
  name: string;
  marketplace: MarketplaceId;
  provider: SearchProviderId;
  supplierPrice?: number;
  lastPrice: number;
  lastMarginPct?: number;
  lastStatus: WatchStatus;
  lastCheckedAt: number;
  createdAt: number;
  active: boolean;
}

/**
 * Mesmo ID determinístico de `watchId()` em src/lib/watchlist.ts (sku
 * saneado + marketplace) — duplicado aqui pelo mesmo motivo do resto do
 * arquivo. `api/check-watch.ts` recebe {sku, marketplace} no corpo da
 * requisição e precisa chegar no MESMO doc ID que o client usou ao criar
 * o watch.
 */
export function watchId(sku: string, marketplace: MarketplaceId): string {
  const safeSku = sku.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 200) || "sku";
  return `${safeSku}__${marketplace}`;
}

export type WatchAlertKind = "price_down" | "price_up" | "out_of_stock" | "back_in_stock";

export interface WatchCheckOutcome {
  found: boolean;
  newPrice: number | null;
  newMarginPct?: number;
  alertKind: WatchAlertKind | null;
}

/** Formato gravado em `users/{uid}/watch_alerts/{autoId}` — usado por api/check-watch.ts e api/cron-check-watches.ts, os dois únicos escritores (Admin SDK). */
export interface WatchAlertDoc {
  watchId: string;
  sku: string;
  name: string;
  kind: WatchAlertKind;
  oldPrice: number | null;
  newPrice: number | null;
  oldMarginPct: number | null;
  newMarginPct: number | null;
  createdAt: number;
  read: boolean;
}

/** Monta o alerta a partir do watch antes da checagem + o resultado dela — centraliza o `?? null` dos dois campos opcionais (Firestore aceita `null`, campo ausente em `oldMarginPct`/`newMarginPct` seria ambíguo com "não mudou"). */
export function buildAlertDoc(watchDocId: string, watch: WatchDoc, outcome: WatchCheckOutcome): WatchAlertDoc {
  return {
    watchId: watchDocId,
    sku: watch.sku,
    name: watch.name,
    kind: outcome.alertKind!,
    oldPrice: watch.lastPrice,
    newPrice: outcome.newPrice,
    oldMarginPct: watch.lastMarginPct ?? null,
    newMarginPct: outcome.newMarginPct ?? null,
    createdAt: Date.now(),
    read: false,
  };
}

/** Mesma fórmula de `approxMarginPct` em src/lib/watchlist.ts — ver comentário lá do porquê é simplificada (sem taxa/frete/imposto). */
export function approxMarginPct(price: number, supplierPrice: number | undefined): number | undefined {
  if (supplierPrice == null || supplierPrice <= 0) return undefined;
  return (price - supplierPrice) / supplierPrice;
}

/**
 * Rebusca o preço de UM watch e decide se isso vira alerta. Lança
 * `FetchPricesValidationError` se o par provider/marketplace do watch
 * não bater mais (ex.: watch antigo de um provider removido) — quem
 * chama decide o que fazer (checagem manual: 400; cron: loga e pula pro
 * próximo watch, não derruba o lote inteiro).
 */
export async function checkWatch(uid: string, watch: WatchDoc): Promise<WatchCheckOutcome> {
  const { byMarketplace } = await fetchPricesCore(
    uid,
    watch.provider,
    [watch.marketplace],
    [{ sku: watch.sku, name: watch.name, supplierPrice: watch.supplierPrice }],
    "auto"
  );

  const result: MarketplacePriceResult | undefined = byMarketplace[watch.marketplace]?.[watch.sku];
  const wasFound = watch.lastStatus !== "esgotado";

  if (!result) {
    return {
      found: false,
      newPrice: null,
      alertKind: wasFound ? "out_of_stock" : null,
    };
  }

  const newMarginPct = approxMarginPct(result.price, watch.supplierPrice);
  let alertKind: WatchAlertKind | null = null;
  if (!wasFound) {
    alertKind = "back_in_stock";
  } else if (result.price < watch.lastPrice) {
    alertKind = "price_down";
  } else if (result.price > watch.lastPrice) {
    alertKind = "price_up";
  }

  return { found: true, newPrice: result.price, newMarginPct, alertKind };
}

export { FetchPricesValidationError };
