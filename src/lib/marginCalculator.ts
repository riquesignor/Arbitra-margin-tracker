import type {
  CatalogRow,
  MarginResult,
  MarginSummary,
  MarketplacePriceResult,
  PricingRules,
  Recommendation,
} from "../types";
import { safeExternalUrl } from "./safeExternalUrl";

export const DEFAULT_PRICING_RULES: PricingRules = {
  marketplaceFees: [
    { id: "referencia", name: "Taxa de referência", rate: 0.15, enabled: true },
    { id: "fechamento", name: "Taxa de fechamento", rate: 0.02, enabled: true },
    // Desabilitada por padrão (opt-in): nem todo revendedor roda ads
    // patrocinado, e o % varia muito por categoria/estratégia — ao
    // contrário das duas taxas acima (fixas pela regra do marketplace),
    // aqui quem sabe o próprio número é o usuário. Ativar + preencher em
    // Precificação já entra no cálculo de margem como as outras taxas.
    { id: "ads", name: "Ads / patrocinado (média)", rate: 0, enabled: false },
  ],
  shippingTiers: [
    { id: "tier-1", label: "Até R$50", maxPrice: 50, cost: 12 },
    { id: "tier-2", label: "Até R$150", maxPrice: 150, cost: 22 },
    { id: "tier-3", label: "Acima de R$150", maxPrice: Infinity, cost: 35 },
  ],
  taxRates: [{ id: "icms-sp", state: "SP", label: "ICMS", rate: 0.07, enabled: true }],
  targetMarginPct: 0.2,
  priceFloor: 0,
};

function resolveShippingCost(supplierPrice: number, tiers: PricingRules["shippingTiers"]): number {
  const sorted = [...tiers].sort((a, b) => a.maxPrice - b.maxPrice);
  const tier = sorted.find((t) => supplierPrice <= t.maxPrice);
  return tier?.cost ?? sorted[sorted.length - 1]?.cost ?? 0;
}

function resolveRecommendation(marginPct: number, targetMarginPct: number): Recommendation {
  if (marginPct >= targetMarginPct) return "recomendado";
  if (marginPct >= 0) return "revisar";
  return "evitar";
}

export function calculateMargin(
  row: CatalogRow,
  priceResult: MarketplacePriceResult,
  rules: PricingRules
): MarginResult {
  // Preço COMPARÁVEL com o custo do catálogo (set/2026, ver
  // packQuantity.ts): quando o anúncio é lote ("kit com 12"), o número que
  // faz sentido comparar com o custo de UMA peça é o preço unitário, não o
  // do lote inteiro. Antes disso, anúncio de atacado gerava margem
  // fantasiosa — e é o tipo de anúncio que mais aparece nessa busca.
  // `unitPrice` só vem preenchido quando o título declara a quantidade;
  // no caso comum (anúncio unitário) isto é exatamente `priceResult.price`,
  // ou seja, zero mudança de comportamento.
  const comparablePrice = priceResult.unitPrice ?? priceResult.price;

  const base = {
    sku: row.sku,
    name: row.name,
    marketplacePrice: comparablePrice,
    // Preço cheio do anúncio + quantidade do lote, preservados pra UI
    // conseguir mostrar "R$ 120 no anúncio (lote de 12 · R$ 10/un.)" —
    // sem isso o usuário veria um preço que não bate com o que ele
    // encontra ao abrir o link, e perderia a confiança no número.
    listingPrice: priceResult.unitPrice != null ? priceResult.price : undefined,
    packQuantity: priceResult.packQuantity,
    marketplace: priceResult.marketplace,
    confidence: priceResult.confidence,
    // Ponto único de saneamento do link de anúncio (set/2026, ver
    // safeExternalUrl.ts e docs/auditoria-2026-09.md > P1-7): o `link` vem
    // de API de terceiro e é renderizado como `href` clicável em duas
    // telas (Resultados e Carteira). Sanear AQUI, na fronteira onde o dado
    // externo vira dado do app, cobre as duas de uma vez — e qualquer tela
    // nova que use MarginResult nasce protegida. Esquema fora de http(s)
    // (`javascript:`, `data:`) vira `undefined`, que a UI já sabe exibir
    // como "sem link".
    link: safeExternalUrl(priceResult.link),
    matchedTitle: priceResult.matchedTitle,
    competitorCount: priceResult.competitorCount,
    buyBoxEligible: priceResult.buyBoxEligible,
    // Prioriza a foto do ANÚNCIO encontrado (mais útil pra conferir se o
    // match faz sentido) — cai pra foto do próprio catálogo só quando o
    // provider/item não trouxe nenhuma (ex: Mercado Livre direto sem
    // thumbnail nesse resultado específico).
    imageUrl: priceResult.imageUrl ?? row.imageUrl,
    // Match não confiável (outra loja ou similaridade baixa) — a margem
    // é calculada normalmente, mas a UI precisa poder avisar que o preço
    // de referência é um chute (ver tag "Aproximado" em ResultsTable.tsx).
    approximate: priceResult.approximate,
    matchedSource: priceResult.matchedSource,
    // Motivo ESPECÍFICO de o preço ser suspeito (ver priceSanity.ts) — a
    // tag "Aproximado" sozinha não distingue "veio de outra loja" de
    // "esse preço não fecha com o seu custo", que é o caso em que o
    // usuário mais precisa parar e conferir o anúncio.
    priceSanityFlag: priceResult.priceSanityFlag,
    // Origem da confiança (foto x nome) — ver confidenceSource em
    // ../types: a coluna "Confiança" mostra o mesmo número pros dois
    // casos, e eles não significam a mesma coisa.
    confidenceSource: priceResult.confidenceSource,
    // Popularidade do anúncio de onde o preço saiu (avaliações na Amazon,
    // vendas no ML) — ver reviewCount em ../types. Um preço vindo de
    // anúncio com histórico de venda é referência de mercado; o mesmo
    // preço num anúncio parado pode ser só um vendedor pedindo o que quer.
    reviewCount: priceResult.reviewCount,
    rating: priceResult.rating,
  };

  // Catálogo sem preço de custo (ver CatalogRow.supplierPrice, catálogo
  // "vitrine") — mostra o preço de mercado encontrado, mas não tem em
  // cima de que calcular margem/taxa/frete/imposto. "sem_custo" fica de
  // fora dos totais de recomendado/evitar (ver ResultsTable.tsx), não é
  // um "evitar" disfarçado — é literalmente "sem dado pra julgar".
  if (row.supplierPrice == null) {
    return { ...base, recommendation: "sem_custo" };
  }

  const feesCost = rules.marketplaceFees
    .filter((f) => f.enabled)
    .reduce((sum, fee) => sum + comparablePrice * fee.rate, 0);

  const shippingCost = resolveShippingCost(row.supplierPrice, rules.shippingTiers);

  const taxesCost = rules.taxRates
    .filter((t) => t.enabled)
    .reduce((sum, tax) => sum + comparablePrice * tax.rate, 0);

  const totalCost = row.supplierPrice + feesCost + shippingCost + taxesCost;
  const marginPct = row.supplierPrice > 0 ? (comparablePrice - totalCost) / row.supplierPrice : 0;

  return {
    ...base,
    supplierPrice: row.supplierPrice,
    feesCost: Number(feesCost.toFixed(2)),
    shippingCost,
    taxesCost: Number(taxesCost.toFixed(2)),
    totalCost: Number(totalCost.toFixed(2)),
    marginPct: Number(marginPct.toFixed(4)),
    recommendation: resolveRecommendation(marginPct, rules.targetMarginPct),
  };
}

export function calculateMargins(
  rows: CatalogRow[],
  prices: Record<string, MarketplacePriceResult>,
  rules: PricingRules
): MarginResult[] {
  return rows
    .filter((row) => prices[row.sku])
    .map((row) => calculateMargin(row, prices[row.sku], rules));
}

/** Mediana — usada pro KPI de destaque porque não é distorcida por um único outlier (ver Session 3 do critique de design). */
export function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

export function summarize(results: MarginResult[]): MarginSummary {
  const totalSkus = results.length;
  const totalProfitable = results.filter((r) => r.recommendation === "recomendado").length;
  // "sem_custo" (catálogo sem preço de fornecedor) não entra na média/
  // mediana de margem — não tem margem nenhuma pra pesar aqui, incluir
  // como 0 distorceria o número pra baixo sem motivo real.
  const withMargin = results.filter((r): r is MarginResult & { marginPct: number } => r.marginPct != null);
  const avgMarginPct =
    withMargin.length > 0 ? withMargin.reduce((sum, r) => sum + r.marginPct, 0) / withMargin.length : 0;
  const medianMarginPct = median(withMargin.map((r) => r.marginPct));

  return {
    totalSkus,
    totalProfitable,
    avgMarginPct: Number(avgMarginPct.toFixed(4)),
    medianMarginPct: Number(medianMarginPct.toFixed(4)),
  };
}
