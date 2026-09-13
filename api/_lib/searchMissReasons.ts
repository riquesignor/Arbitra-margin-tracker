/**
 * POR QUE ESTE PRODUTO VOLTOU SEM PREÇO (set/2026, auditoria item 21)
 * ══════════════════════════════════════════════════════════════════════
 *
 * Antes: o banner explicava a causa do LOTE ("um lote falhou", "cota de
 * IA esgotada"), mas o produto individual simplesmente sumia da tela —
 * linha sem preço é descartada em `calculateMargins`. Do ponto de vista
 * do usuário, "o app não achou" cobria três situações bem diferentes:
 * o item nem chegou a ser buscado (catálogo sem foto num mecanismo por
 * imagem), a busca parou no meio (cota de IA) ou a busca rodou e não
 * achou nada parecido.
 *
 * A razão é derivada do que o servidor JÁ sabe no ponto de saída — não
 * exige que os 6 providers passem a devolver motivo por SKU (mudança
 * grande e arriscada). É deliberadamente conservadora: quando não dá pra
 * afirmar, cai em "sem_candidato", que é o caso mais comum e o menos
 * enganoso.
 */

import type { CatalogItemQuery, MarketplacePriceResult, SearchProviderId } from "./types.js";

export type MissReason = "sem_foto" | "cota_ia" | "sem_candidato";

/** Mecanismos que decidem o match pela FOTO — sem `imageUrl` no item, eles pulam o produto em silêncio. */
const IMAGE_REQUIRED_PROVIDERS = new Set<SearchProviderId>([
  "google_lens_products",
  "searchapi_lens",
  "vision_internal",
  "vision_mistral",
  "vision_nvidia",
]);

/**
 * SKUs sem NENHUM resultado em NENHUM marketplace pedido, com a razão
 * mais provável. Produto que achou preço em pelo menos uma loja não
 * entra: ele apareceu na tela, não precisa de explicação.
 */
export function collectMissReasons(
  responseByMarketplace: Record<string, Record<string, MarketplacePriceResult>>,
  items: CatalogItemQuery[],
  provider: SearchProviderId,
  options: { quotaExhausted?: boolean } = {}
): Record<string, MissReason> {
  const found = new Set<string>();
  for (const bySku of Object.values(responseByMarketplace)) {
    for (const sku of Object.keys(bySku)) found.add(sku);
  }

  const needsImage = IMAGE_REQUIRED_PROVIDERS.has(provider);
  const reasons: Record<string, MissReason> = {};

  for (const item of items) {
    if (found.has(item.sku)) continue;

    if (needsImage && !item.imageUrl) {
      // Certeza, não estimativa: sem foto, o mecanismo por imagem nem
      // tenta esse item (ver `itemsWithImage` em visionInternalSearchProvider.ts).
      reasons[item.sku] = "sem_foto";
      continue;
    }

    if (options.quotaExhausted) {
      // A cota estourou no meio do lote; não dá pra saber se ESTE item
      // chegou a ser tentado, mas é a explicação honesta — e acionável
      // (esperar a janela renovar ou usar chave própria).
      reasons[item.sku] = "cota_ia";
      continue;
    }

    reasons[item.sku] = "sem_candidato";
  }

  return reasons;
}

/** Texto curto por razão — usado no resumo da tela (ver Dashboard.tsx). Plural sempre, porque o resumo agrupa. */
export const MISS_REASON_LABEL: Record<MissReason, string> = {
  sem_foto: "sem foto no catálogo (o mecanismo escolhido busca por imagem)",
  cota_ia: "a cota de IA esgotou antes de chegar neles",
  sem_candidato: "nenhum anúncio parecido encontrado",
};
