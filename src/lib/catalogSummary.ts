import type { MarginResult, MarketplaceId } from "../types";
import type { CatalogUploadRecord } from "./catalogHistory";
import { median } from "./marginCalculator";

/**
 * Resumo de uma busca salva pra tabelas de "catálogos rodados" (Início e
 * Nova busca). "Produto" aqui é produto, não oferta: uma busca em 2
 * marketplaces guarda até 2 resultados por SKU, e contar resultados dava
 * "22 com preço de 15 produtos".
 */
export interface CatalogSummary {
  id: string;
  fileName: string;
  shortName: string;
  uploadedAt: number;
  productCount: number;
  pricedCount: number;
  marketplaces: MarketplaceId[];
  /** Mediana da margem dos produtos com custo; `null` = catálogo sem preço de custo. */
  margin: number | null;
  margins: number[];
}

export const MARKETPLACE_NAME: Record<MarketplaceId, string> = {
  mercadolivre: "Mercado Livre",
  amazon: "Amazon",
  shopee: "Shopee",
  geral: "Lojas gerais",
};

/** Uma oferta por produto — a de maior margem, mesmo critério de Meus produtos (portfolio.ts). */
export function bestOfferPerSku(results: MarginResult[]): MarginResult[] {
  const best = new Map<string, MarginResult>();
  for (const r of results) {
    const cur = best.get(r.sku);
    if (!cur || (r.marginPct ?? -Infinity) > (cur.marginPct ?? -Infinity)) best.set(r.sku, r);
  }
  return [...best.values()];
}

/** "Catálogo TOP UTIL 31.08.26.pdf" → "Catálogo TOP UTIL 31.08.26" (quem exibe corta com reticências). */
export function shortCatalogName(fileName: string): string {
  return fileName.replace(/\.(pdf|csv|xlsx|xlsm)$/i, "").replace(/\[\d+\]$/, "").trim() || fileName;
}

export function summarizeCatalog(record: CatalogUploadRecord): CatalogSummary {
  const best = bestOfferPerSku(record.results);
  const margins = best.map((r) => r.marginPct).filter((v): v is number => v != null);
  return {
    id: record.id,
    fileName: record.fileName,
    shortName: shortCatalogName(record.fileName),
    uploadedAt: record.uploadedAt,
    productCount: record.rows.length,
    pricedCount: best.length,
    marketplaces: record.marketplaces ?? [],
    margin: margins.length > 0 ? median(margins) : null,
    margins,
  };
}

/** −16,3% com sinal de menos tipográfico, +110,8% com sinal explícito. */
export function signedPct(fraction: number): string {
  const abs = Math.abs(fraction * 100).toLocaleString("pt-BR", { minimumFractionDigits: 1, maximumFractionDigits: 1 });
  const sign = fraction > 0.0005 ? "+" : fraction < -0.0005 ? "−" : "";
  return `${sign}${abs}%`;
}

export function shortDate(ts: number): string {
  return new Date(ts).toLocaleDateString("pt-BR", { day: "2-digit", month: "2-digit", year: "2-digit" });
}

/** ["Mercado Livre", "Amazon"] → "Mercado Livre e Amazon". */
export function joinPt(parts: string[]): string {
  if (parts.length <= 1) return parts.join("");
  return `${parts.slice(0, -1).join(", ")} e ${parts[parts.length - 1]}`;
}
