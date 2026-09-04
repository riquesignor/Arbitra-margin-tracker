/**
 * ══════════════════════════════════════════════════════════════════════
 * DETECÇÃO DE LOTE/KIT NO TÍTULO DO ANÚNCIO
 * ══════════════════════════════════════════════════════════════════════
 *
 * Problema estrutural (set/2026, ver docs/auditoria-2026-09.md > item 10):
 * o catálogo do fornecedor dá preço POR UNIDADE ("Unid.CX: 13,50"), e o
 * marketplace muito frequentemente anuncia CAIXA FECHADA ("kit 12
 * unidades", "atacado 50 peças", "pack c/ 6"). Até aqui os dois números
 * entravam no cálculo de margem como se fossem a mesma coisa — o app
 * comparava o custo de UMA peça com o preço de DOZE, e a margem saía
 * fantasiosa (positiva e enorme) justamente nos casos que o usuário mais
 * tenderia a comprar.
 *
 * Este módulo não adivinha nada: extrai a quantidade quando ela está
 * ESCRITA no título, com padrão explícito de embalagem. Título sem
 * padrão nenhum devolve `null` e o fluxo segue exatamente como antes —
 * é uma anotação a mais, nunca uma reinterpretação do preço em cima de
 * palpite.
 *
 * Deliberadamente NÃO conta como lote:
 *   - medida do produto ("caneca 300ml", "cabo 2m", "kit 2 em 1");
 *   - número solto sem rótulo de embalagem ("Fone XM4 1000");
 *   - "kit" sem número ("Kit Organizador") — kit de peças diferentes que
 *     compõem UM produto é o caso normal de catálogo, não lote da mesma
 *     peça.
 */

export interface PackInfo {
  /** Quantas unidades o anúncio entrega. Sempre >= 2 (1 não é lote). */
  quantity: number;
  /** Trecho do título que motivou a detecção — vai pra UI explicar o número, em vez de aparecer do nada. */
  matchedText: string;
}

/**
 * Cada padrão precisa de DOIS sinais juntos: um número e um rótulo de
 * embalagem/unidade. É o que separa "kit com 12 unidades" (lote) de
 * "caneca 300ml" (medida) sem precisar de lista de exceção.
 *
 * A ordem importa: padrões mais específicos primeiro, pra "caixa com 50
 * peças" não ser capturado pela regra genérica de "50 peças" com um
 * `matchedText` pela metade.
 */
const PACK_PATTERNS: RegExp[] = [
  // "kit com 12", "kit c/ 12", "kit 12", "conjunto com 6", "combo 4"
  /\b(?:kit|conjunto|combo|jogo|pack|pacote|caixa|cx|fardo|atacado)\s*(?:com|c\/|de)?\s*(\d{1,4})\b(?!\s*(?:ml|l|g|kg|mm|cm|m|w|v|gb|tb|mah|k)\b)/i,
  // "12 unidades", "12 peças", "12 pçs", "12 un", "12 pares"
  /\b(\d{1,4})\s*(?:unidades?|unid|und|un|pe[çc]as?|p[çc]s|pares?|itens)\b/i,
  // "c/ 12 un", "com 12 peças" (rótulo antes do número, sem "kit")
  /\b(?:com|c\/)\s*(\d{1,4})\s*(?:unidades?|unid|und|un|pe[çc]as?|p[çc]s)\b/i,
  // "12x" / "x12" no sentido de quantidade ("Pilha AA 12x")
  /\b(\d{1,4})\s*x\b(?!\s*\d)/i,
];

/**
 * Teto de sanidade: acima disso quase nunca é lote de varejo — é medida,
 * potência, código de modelo ou ano que escapou dos filtros ("Lâmpada
 * 2700k", "Fonte 1200w"). Dividir o preço por 5.000 criaria um preço
 * unitário absurdo e uma margem ainda mais errada do que não dividir.
 */
const MAX_PLAUSIBLE_PACK = 1000;

export function detectPackQuantity(title: string | undefined | null): PackInfo | null {
  if (!title?.trim()) return null;

  for (const pattern of PACK_PATTERNS) {
    const match = pattern.exec(title);
    if (!match) continue;

    const quantity = Number(match[1]);
    if (!Number.isFinite(quantity) || quantity < 2 || quantity > MAX_PLAUSIBLE_PACK) continue;

    return { quantity, matchedText: match[0].trim() };
  }

  return null;
}

/**
 * Preço por unidade quando o anúncio é lote — é ESTE número que dá pra
 * comparar com o custo unitário do catálogo. Devolve `null` quando não há
 * lote detectado (o preço cheio já é o preço unitário) pra quem chama
 * distinguir "não é lote" de "é lote de 1".
 */
export function unitPriceFromPack(price: number, pack: PackInfo | null): number | null {
  if (!pack || pack.quantity < 2 || !Number.isFinite(price) || price <= 0) return null;
  return Number((price / pack.quantity).toFixed(2));
}
