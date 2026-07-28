import type { CatalogItemQuery, MarketplaceId, MarketplacePriceResult } from "../../types";

/**
 * Contrato que qualquer marketplace precisa implementar para entrar no
 * fluxo de arbitragem no client.
 *
 * Recebe `{ sku, name }` (não só sku): providers oficiais (SP-API) usam o
 * sku porque é o vendedor consultando o próprio catálogo já cadastrado;
 * providers de busca pública (Mercado Livre) só têm o `name` pra buscar —
 * não existe "SKU do fornecedor" reconhecido por eles.
 *
 * Adicionar um marketplace novo (ex: Shopee, Fase 4) = criar um arquivo
 * `shopeeProvider.ts` implementando essa interface + uma linha em
 * `registry.ts`. Nenhum outro arquivo (parseCatalog, marginCalculator,
 * priceApi, componentes de UI) precisa mudar.
 */
export interface PriceProvider {
  readonly id: MarketplaceId;
  readonly label: string;
  fetchPrices(items: CatalogItemQuery[]): Promise<Record<string, MarketplacePriceResult>>;
}
