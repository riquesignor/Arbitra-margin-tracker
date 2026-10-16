import type { CatalogItemQuery, MarketplacePriceResult } from "./types.js";

const EAN_PATTERN = /^\d{8,14}$/;

// Mesmo critério de resolveSearchQuery (EAN válido manda; senão o nome) —
// dois itens com a mesma chave mandariam a mesma busca ao provider.
function queryKey(item: CatalogItemQuery): string {
  const ean = item.ean?.trim();
  if (ean && EAN_PATTERN.test(ean)) return `ean:${ean}`;
  const name = item.name
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
  return `name:${name}`;
}

export interface DedupedItems {
  unique: CatalogItemQuery[];
  /** SKU representante → demais SKUs que fariam a mesma busca. */
  duplicatesOf: Map<string, string[]>;
}

/**
 * Agrupa itens que fariam a MESMA busca por texto (mesmo EAN válido, ou
 * mesmo nome ignorando caixa/acento/espaços) pra o provider ser chamado
 * uma vez só por grupo. Só vale pra busca por texto: na busca por foto o
 * insumo é a imagem de cada item, não o nome.
 */
export function dedupeItemsByQuery(items: CatalogItemQuery[]): DedupedItems {
  const firstByKey = new Map<string, CatalogItemQuery>();
  const duplicatesOf = new Map<string, string[]>();
  const unique: CatalogItemQuery[] = [];

  for (const item of items) {
    const key = queryKey(item);
    const first = firstByKey.get(key);
    if (!first) {
      firstByKey.set(key, item);
      unique.push(item);
      continue;
    }
    if (first.sku === item.sku) continue;
    const list = duplicatesOf.get(first.sku) ?? [];
    list.push(item.sku);
    duplicatesOf.set(first.sku, list);
  }

  return { unique, duplicatesOf };
}

/** Copia o resultado de cada SKU representante pros SKUs duplicados dele (com o `sku` trocado). */
export function fanOutDuplicates(
  results: Record<string, MarketplacePriceResult>,
  duplicatesOf: Map<string, string[]>
): Record<string, MarketplacePriceResult> {
  if (duplicatesOf.size === 0) return results;

  const expanded = { ...results };
  for (const [representativeSku, duplicateSkus] of duplicatesOf) {
    const representative = results[representativeSku];
    if (!representative) continue;
    for (const sku of duplicateSkus) {
      expanded[sku] = { ...representative, sku };
    }
  }
  return expanded;
}
