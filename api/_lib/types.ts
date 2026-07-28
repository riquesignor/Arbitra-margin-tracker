/**
 * Contrato de dados do backend. Duplicado (não importado) de src/types —
 * decisão deliberada: frontend e backend usam tsconfigs diferentes (DOM vs
 * Node) e ficam buildáveis/deployáveis de forma independente. O preço da
 * duplicação é sincronizar manualmente se o shape mudar; se isso doer,
 * extrair pra um pacote `packages/shared` (workspace) resolve — ver
 * docs/adr/0001-marketplace-adapter-pattern.md > Consequências.
 */
export type MarketplaceId = "amazon" | "shopee" | "mercadolivre";

export interface CatalogItemQuery {
  sku: string;
  name: string;
}

export interface MarketplacePriceResult {
  marketplace: MarketplaceId;
  sku: string;
  price: number;
  competitorCount: number;
  buyBoxEligible: boolean;
  confidence: number;
  link?: string;
  matchedTitle?: string;
}
