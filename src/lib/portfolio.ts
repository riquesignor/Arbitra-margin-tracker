import type { MarginResult, MarketplaceId, Recommendation } from "../types";
import type { CatalogUploadRecord } from "./catalogHistory";

/**
 * "Meus produtos" — visão persistente por SKU, agregando TODAS as
 * buscas salvas do usuário (`catalog_uploads`, ver catalogHistory.ts),
 * não só a mais recente. Resolve a lacuna original do produto: cada
 * upload era uma unidade fechada, sem lugar que respondesse "quais
 * produtos eu acompanho, e o preço deles subiu ou caiu desde a última
 * vez que busquei".
 *
 * Decisão de escopo: a tendência aqui compara as DUAS ocorrências mais
 * recentes de um SKU dentro do histórico de buscas já salvo — não
 * depende de nenhuma infraestrutura nova (sem coleção de série
 * temporal, sem busca em segundo plano). Isso significa que a
 * "tendência" só existe quando o usuário já rebuscou aquele produto
 * pelo menos duas vezes; é uma aproximação deliberadamente simples,
 * não um histórico de preço contínuo — ver ADR futuro se um dia isso
 * virar rebusca automática (implica gastar cota da chave BYOK do
 * usuário sem ele estar olhando, decisão que merece ficar explícita).
 */
export type PriceTrend = "up" | "down" | "stable" | null;

export interface PortfolioItem {
  sku: string;
  name: string;
  marketplace: MarketplaceId;
  imageUrl?: string;
  supplierPrice: number;
  marketplacePrice: number;
  marginPct: number;
  recommendation: Recommendation;
  competitorCount: number;
  buyBoxEligible: boolean;
  link?: string;
  /** Quantas buscas salvas já encontraram esse SKU (1 = só apareceu uma vez, sem base pra tendência). */
  searchCount: number;
  lastSearchedAt: number;
  trend: PriceTrend;
  previousMarketplacePrice?: number;
  previousSearchedAt?: number;
}

/**
 * Agrega o histórico de buscas por SKU. `history` precisa vir mais
 * recente primeiro (mesmo contrato de `listCatalogUploads` — ordena de
 * novo aqui por segurança, é barato e evita depender silenciosamente da
 * ordem de quem chama).
 */
export function buildPortfolio(history: CatalogUploadRecord[]): PortfolioItem[] {
  const sortedHistory = [...history].sort((a, b) => b.uploadedAt - a.uploadedAt);

  const occurrencesBySku = new Map<string, { result: MarginResult; uploadedAt: number }[]>();

  for (const upload of sortedHistory) {
    // Uma mesma busca pode ter mais de uma oferta pro mesmo SKU (vários
    // marketplaces comparados) — fica só com a de maior margem, mesmo
    // critério já usado no agrupamento de ResultsTable.
    const bestPerSkuThisUpload = new Map<string, MarginResult>();
    for (const r of upload.results) {
      const current = bestPerSkuThisUpload.get(r.sku);
      if (!current || r.marginPct > current.marginPct) bestPerSkuThisUpload.set(r.sku, r);
    }

    for (const [sku, result] of bestPerSkuThisUpload) {
      const list = occurrencesBySku.get(sku) ?? [];
      list.push({ result, uploadedAt: upload.uploadedAt });
      occurrencesBySku.set(sku, list);
    }
  }

  const items: PortfolioItem[] = [];
  for (const [sku, occurrences] of occurrencesBySku) {
    const [latest, previous] = occurrences; // já em ordem desc (sortedHistory garante)
    const r = latest.result;

    let trend: PriceTrend = null;
    if (previous) {
      trend =
        r.marketplacePrice > previous.result.marketplacePrice
          ? "up"
          : r.marketplacePrice < previous.result.marketplacePrice
            ? "down"
            : "stable";
    }

    items.push({
      sku,
      name: r.name,
      marketplace: r.marketplace,
      imageUrl: r.imageUrl,
      supplierPrice: r.supplierPrice,
      marketplacePrice: r.marketplacePrice,
      marginPct: r.marginPct,
      recommendation: r.recommendation,
      competitorCount: r.competitorCount,
      buyBoxEligible: r.buyBoxEligible,
      link: r.link,
      searchCount: occurrences.length,
      lastSearchedAt: latest.uploadedAt,
      trend,
      previousMarketplacePrice: previous?.result.marketplacePrice,
      previousSearchedAt: previous?.uploadedAt,
    });
  }

  return items.sort((a, b) => b.lastSearchedAt - a.lastSearchedAt);
}
