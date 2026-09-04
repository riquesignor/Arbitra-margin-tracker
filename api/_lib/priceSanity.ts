/**
 * ══════════════════════════════════════════════════════════════════════
 * SANIDADE DE PREÇO — o custo do catálogo como âncora
 * ══════════════════════════════════════════════════════════════════════
 *
 * Lacuna estrutural corrigida (set/2026, ver docs/auditoria-2026-09.md >
 * item 9): a escolha do candidato (rankCandidates.ts) considerava só
 * similaridade de texto e popularidade — PREÇO não entrava na decisão em
 * momento nenhum. Num app de arbitragem isso é cego no pior lugar
 * possível: anúncio de acessório, de peça de reposição ou de produto
 * errado passa batido e vira "preço de mercado", com margem calculada em
 * cima.
 *
 * A âncora usada aqui é o CUSTO DE FORNECEDOR do próprio catálogo, não a
 * mediana dos candidatos. É uma decisão deliberada: quando a busca traz
 * majoritariamente acessórios (comum em "capa para X"), a mediana É o
 * preço do acessório — a estatística confirmaria o erro em vez de
 * denunciá-lo. O custo do fornecedor, ao contrário, é um dado real e
 * externo à busca.
 *
 * O que se faz com o flag: NÃO descartar. Um preço fora da faixa vira um
 * resultado marcado (`approximate` + motivo), porque descartar em silêncio
 * é exatamente o comportamento que já gerou o relato "catálogo de 40
 * produtos, voltaram 3". O usuário vê o preço, vê o aviso e decide.
 */

import type { MarketplacePriceResult } from "./types.js";

export type PriceSanityFlag = "abaixo_do_custo" | "muito_acima_do_custo";

/**
 * Piso: abaixo de 60% do custo de fornecedor. Revenda com preço de
 * mercado ABAIXO do atacado existe (queima de estoque, importado
 * paralelo), mas é minoria — na prática esse padrão quase sempre é
 * acessório do produto, peça avulsa ou produto diferente com nome
 * parecido. 0.6 (e não 1.0) dá margem pro caso legítimo de mercado
 * apertado sem deixar passar o acessório de R$ 9 num produto de R$ 80.
 */
const MIN_RATIO_TO_SUPPLIER_PRICE = 0.6;

/**
 * Teto: 25× o custo. Acima disso normalmente é lote não detectado (ver
 * packQuantity.ts, que já corrige o caso declarado no título), produto
 * profissional homônimo, ou simplesmente outro produto. Alto de propósito
 * — margem de revenda saudável nesse mercado raramente passa de 5×, então
 * 25× só pega o que é claramente outra coisa.
 */
const MAX_RATIO_TO_SUPPLIER_PRICE = 25;

/**
 * Compara o preço encontrado com o custo do catálogo. `undefined` =
 * nenhum problema detectado OU não há âncora (catálogo "vitrine" sem
 * preço de custo — ver CatalogRow.supplierPrice).
 *
 * `marketPrice` deve ser o preço COMPARÁVEL: quando o anúncio é lote, o
 * chamador passa o preço unitário (ver unitPriceFromPack em
 * packQuantity.ts), senão um kit legítimo cairia no teto por engano.
 */
export function assessPriceSanity(
  marketPrice: number,
  supplierPrice: number | undefined
): PriceSanityFlag | undefined {
  if (
    supplierPrice == null ||
    !Number.isFinite(supplierPrice) ||
    supplierPrice <= 0 ||
    !Number.isFinite(marketPrice) ||
    marketPrice <= 0
  ) {
    return undefined;
  }

  if (marketPrice < supplierPrice * MIN_RATIO_TO_SUPPLIER_PRICE) return "abaixo_do_custo";
  if (marketPrice > supplierPrice * MAX_RATIO_TO_SUPPLIER_PRICE) return "muito_acima_do_custo";
  return undefined;
}

/** Texto mostrado ao usuário pra cada flag — some da UI quando não há flag. */
export const PRICE_SANITY_REASON: Record<PriceSanityFlag, string> = {
  abaixo_do_custo:
    "O preço encontrado está bem abaixo do seu custo de fornecedor — normalmente isso significa que o " +
    "anúncio é de um acessório, peça avulsa ou produto parecido, não do produto do catálogo. Confira o anúncio.",
  muito_acima_do_custo:
    "O preço encontrado está muitas vezes acima do seu custo — pode ser um lote/atacado que não foi " +
    "reconhecido pelo título, ou um produto diferente com nome parecido. Confira o anúncio.",
};

/**
 * Aplica a checagem num resultado já montado, marcando-o como aproximado
 * quando o preço não bate com o custo. Preserva `approximate` que já
 * estivesse `true` (o motivo original — outra loja, similaridade baixa —
 * continua valendo).
 */
export function flagPriceSanity(
  result: MarketplacePriceResult,
  supplierPrice: number | undefined
): MarketplacePriceResult {
  const comparablePrice = result.unitPrice ?? result.price;
  const flag = assessPriceSanity(comparablePrice, supplierPrice);
  if (!flag) return result;

  return { ...result, approximate: true, priceSanityFlag: flag };
}
