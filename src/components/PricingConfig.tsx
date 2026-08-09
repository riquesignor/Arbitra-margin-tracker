import { useMemo } from "react";
import { motion } from "framer-motion";
import {
  Percent,
  Truck,
  Receipt,
  Target,
  RotateCcw,
  FlaskConical,
  LineChart,
  Layers,
} from "lucide-react";
import type { CatalogRow, MarketplaceId, MarketplacePriceResult, PricingRules } from "../types";
import { calculateMargin, calculateMargins, DEFAULT_PRICING_RULES, median } from "../lib/marginCalculator";
import type { CatalogUploadRecord } from "../lib/catalogHistory";
import styles from "./PricingConfig.module.css";

interface Props {
  rules: PricingRules;
  onChange: (rules: PricingRules) => void;
  catalogRows?: CatalogRow[];
  pricesByMarket?: Partial<Record<MarketplaceId, Record<string, MarketplacePriceResult>>>;
  /** Buscas salvas do usuário — alimenta o seletor "qual busca ver" abaixo. */
  history?: CatalogUploadRecord[];
  activeHistoryId?: string | null;
  onSelectHistory?: (id: string) => void;
  /** Configurações → Personalização: "Gráficos na tela de Precificação". Some só a curva de sensibilidade e o histograma — Preview ao vivo (números + barra de custo) fica sempre visível, não é opcional. */
  showCharts?: boolean;
}

function formatHistoryLabel(record: CatalogUploadRecord): string {
  const when = new Date(record.uploadedAt).toLocaleString("pt-BR", {
    day: "2-digit",
    month: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
  return `${record.fileName} · ${when}`;
}

// Exemplo ilustrativo — usado só quando ainda não há catálogo processado
// nesta sessão, pra o preview ao vivo nunca ficar vazio.
const FALLBACK_ROW: CatalogRow = { sku: "EX-001", name: "Produto de exemplo", supplierPrice: 50 };
const FALLBACK_PRICE: MarketplacePriceResult = {
  marketplace: "mercadolivre",
  sku: "EX-001",
  price: 100,
  competitorCount: 3,
  buyBoxEligible: true,
  confidence: 1,
};

// Faixas do histograma "Impacto no catálogo" (limite superior de cada
// faixa, em fração de margem). O último bucket é aberto pra cima.
const HISTOGRAM_BUCKETS: { label: string; max: number }[] = [
  { label: "<0%", max: 0 },
  { label: "0–10", max: 0.1 },
  { label: "10–20", max: 0.2 },
  { label: "20–30", max: 0.3 },
  { label: "30–50", max: 0.5 },
  { label: "50%+", max: Infinity },
];

// Curva "Se o preço mudar": varia o preço de venda de −30% a +40% em
// torno do preço atual e recalcula a margem com as MESMAS regras.
const CURVE_FROM = -0.3;
const CURVE_TO = 0.4;
const CURVE_STEPS = 13;

function pctToInput(rate: number): string {
  return String(Math.round(rate * 1000) / 10);
}
function inputToPct(value: string): number {
  const n = Number(value);
  return Number.isFinite(n) ? n / 100 : 0;
}
function brl(value: number): string {
  return `R$ ${value.toFixed(2).replace(".", ",")}`;
}

function Toggle({ checked, onChange }: { checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <label className={styles.switch}>
      <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} />
      <span className={styles.switchTrack} />
    </label>
  );
}

const sections = (delay: number) => ({
  initial: { opacity: 0, y: 8 },
  animate: { opacity: 1, y: 0 },
  transition: { duration: 0.3, delay, ease: [0.16, 1, 0.3, 1] as const },
});

export default function PricingConfig({
  rules,
  onChange,
  catalogRows,
  pricesByMarket,
  history = [],
  activeHistoryId = null,
  onSelectHistory,
  showCharts = true,
}: Props) {
  function updateFee(id: string, patch: Partial<PricingRules["marketplaceFees"][number]>) {
    onChange({
      ...rules,
      marketplaceFees: rules.marketplaceFees.map((f) => (f.id === id ? { ...f, ...patch } : f)),
    });
  }

  function updateTier(id: string, patch: Partial<PricingRules["shippingTiers"][number]>) {
    onChange({
      ...rules,
      shippingTiers: rules.shippingTiers.map((t) => (t.id === id ? { ...t, ...patch } : t)),
    });
  }

  function updateTax(id: string, patch: Partial<PricingRules["taxRates"][number]>) {
    onChange({
      ...rules,
      taxRates: rules.taxRates.map((t) => (t.id === id ? { ...t, ...patch } : t)),
    });
  }

  // Pega o primeiro produto com preço real já buscado nesta sessão; se
  // não tiver nenhum ainda, usa o exemplo ilustrativo — o preview nunca
  // fica vazio, e fica claro quando é exemplo vs dado real.
  const { previewRow, previewPrice, isRealData } = useMemo(() => {
    const row = catalogRows?.[0];
    if (row && pricesByMarket) {
      for (const priceMap of Object.values(pricesByMarket)) {
        const price = priceMap?.[row.sku];
        if (price) return { previewRow: row, previewPrice: price, isRealData: true };
      }
    }
    return { previewRow: FALLBACK_ROW, previewPrice: FALLBACK_PRICE, isRealData: false };
  }, [catalogRows, pricesByMarket]);

  // Catálogo inteiro recalculado com as regras ATUAIS — é o que alimenta
  // as stats do topo e o card "Impacto no catálogo". Mesmo cálculo que
  // App.tsx usa pra tela de Resultados (calculateMargins), então os
  // números batem entre as duas telas.
  const results = useMemo(() => {
    if (!catalogRows?.length || !pricesByMarket) return [];
    return Object.values(pricesByMarket).flatMap((priceMap) =>
      priceMap ? calculateMargins(catalogRows, priceMap, rules) : []
    );
  }, [catalogRows, pricesByMarket, rules]);

  const preview = calculateMargin(previewRow, previewPrice, rules);
  const marketplacePrice = preview.marketplacePrice || 1; // evita divisão por zero no rollup
  const profit = preview.marketplacePrice - preview.totalCost;

  const costSegments = [
    { label: "Produto", value: preview.supplierPrice, className: styles.segProduct },
    { label: "Taxas", value: preview.feesCost, className: styles.segFees },
    { label: "Frete", value: preview.shippingCost, className: styles.segShipping },
    { label: "Impostos", value: preview.taxesCost, className: styles.segTaxes },
    { label: "Lucro", value: Math.max(0, profit), className: styles.segProfit },
  ];

  // Faixa de frete aplicada no preview — marcada na lista pra ficar
  // claro qual das três linhas afeta o número mostrado ao lado.
  const appliedTierId = useMemo(() => {
    const sorted = [...rules.shippingTiers].sort((a, b) => a.maxPrice - b.maxPrice);
    return (sorted.find((t) => previewRow.supplierPrice <= t.maxPrice) ?? sorted[sorted.length - 1])?.id;
  }, [rules.shippingTiers, previewRow.supplierPrice]);

  const stats = useMemo(() => {
    const total = results.length;
    if (total === 0) {
      return [
        { label: "margem mediana", value: "—", of: "", foot: `meta ${(rules.targetMarginPct * 100).toFixed(0)}%` },
        { label: "recomendados", value: "—", of: "", foot: "processe um catálogo no Dashboard" },
        { label: "lucro médio por venda", value: "—", of: "", foot: "sem catálogo nesta sessão" },
        { label: "carga sobre a venda", value: "—", of: "", foot: "taxas + frete + impostos" },
      ];
    }

    const medianMargin = median(results.map((r) => r.marginPct));
    const recomendados = results.filter((r) => r.recommendation === "recomendado").length;
    const avgProfit =
      results.reduce((sum, r) => sum + (r.marketplacePrice - r.totalCost), 0) / total;
    const avgTicket = results.reduce((sum, r) => sum + r.marketplacePrice, 0) / total;
    const totalPrice = results.reduce((sum, r) => sum + r.marketplacePrice, 0);
    const totalLoad = results.reduce((sum, r) => sum + r.feesCost + r.shippingCost + r.taxesCost, 0);

    return [
      {
        label: "margem mediana",
        value: `${(medianMargin * 100).toFixed(1).replace(".", ",")}%`,
        of: "",
        foot: `meta ${(rules.targetMarginPct * 100).toFixed(0)}%`,
      },
      {
        label: "recomendados",
        value: String(recomendados),
        of: `/ ${total}`,
        foot: "batem a meta com estas regras",
      },
      {
        label: "lucro médio por venda",
        value: brl(avgProfit),
        of: "",
        foot: `ticket médio ${brl(avgTicket)}`,
      },
      {
        label: "carga sobre a venda",
        value: totalPrice > 0 ? `${((totalLoad / totalPrice) * 100).toFixed(0)}%` : "—",
        of: "",
        foot: "taxas + frete + impostos",
      },
    ];
  }, [results, rules.targetMarginPct]);

  const impact = useMemo(() => {
    const total = results.length;
    const counts = {
      recomendado: results.filter((r) => r.recommendation === "recomendado").length,
      revisar: results.filter((r) => r.recommendation === "revisar").length,
      evitar: results.filter((r) => r.recommendation === "evitar").length,
    };

    const buckets = HISTOGRAM_BUCKETS.map((b, i) => {
      const min = i === 0 ? -Infinity : HISTOGRAM_BUCKETS[i - 1].max;
      const count = results.filter((r) => r.marginPct >= min && r.marginPct < b.max).length;
      return { label: b.label, count, isNegative: i === 0 };
    });
    const maxBucket = Math.max(1, ...buckets.map((b) => b.count));

    return { total, counts, buckets, maxBucket };
  }, [results]);

  // Sensibilidade a preço: recalcula a margem do produto do preview
  // variando só o preço de venda. Serve pra responder "quanto eu
  // preciso vender pra bater a meta" sem gastar busca nova.
  const sensitivity = useMemo(() => {
    const basePrice = preview.marketplacePrice;
    const points = Array.from({ length: CURVE_STEPS }, (_, i) => {
      const factor = CURVE_FROM + ((CURVE_TO - CURVE_FROM) * i) / (CURVE_STEPS - 1);
      const price = basePrice * (1 + factor);
      const margin = calculateMargin(previewRow, { ...previewPrice, price }, rules).marginPct;
      return { factor, price, margin };
    });

    const values = points.map((p) => p.margin).concat([0, rules.targetMarginPct]);
    const lo = Math.min(...values);
    const hi = Math.max(...values);
    const span = hi - lo || 1;
    const toY = (v: number) => 100 - ((v - lo) / span) * 100;

    const polyline = points
      .map((p, i) => `${(i / (points.length - 1)) * 100},${toY(p.margin)}`)
      .join(" ");

    const hit = points.find((p) => p.margin >= rules.targetMarginPct);

    return {
      polyline,
      zeroY: toY(0),
      targetY: toY(rules.targetMarginPct),
      breakEven: hit?.price ?? null,
      reachesTarget: Boolean(hit),
    };
  }, [preview.marketplacePrice, previewRow, previewPrice, rules]);

  return (
    <div className={styles.container}>
      <div className={styles.header}>
        <div className={styles.headerMain}>
          <span className={styles.eyebrow}>Regras de margem</span>
          <h1 className={styles.title}>Simulador de precificação</h1>
          <p className={styles.subtitle}>
            Ajuste taxas, frete e impostos e veja o efeito no catálogo inteiro na hora — sem gastar
            uma busca nova.
          </p>
        </div>
        <div className={styles.headerCard}>
          <span className={styles.headerCardRow}>
            <span className={styles.headerCardDotSquare} />
            simulando{" "}
            <b className={styles.headerCardStrong}>{results.length} produto(s)</b>
          </span>
          <span className={styles.headerCardRow}>
            <span className={styles.headerCardDot} />
            meta{" "}
            <b className={styles.headerCardStrong}>
              {(rules.targetMarginPct * 100).toFixed(0)}%
            </b>
          </span>
        </div>
        {history.length > 0 && onSelectHistory && (
          <label className={styles.historySelectWrap}>
            <span className={styles.historySelectLabel}>ver busca</span>
            <select
              className={styles.historySelect}
              value={activeHistoryId ?? ""}
              onChange={(e) => e.target.value && onSelectHistory(e.target.value)}
            >
              <option value="" disabled={activeHistoryId !== null}>
                Resultado atual desta sessão
              </option>
              {history.map((record) => (
                <option key={record.id} value={record.id}>
                  {formatHistoryLabel(record)}
                </option>
              ))}
            </select>
          </label>
        )}
      </div>

      <div className={styles.statsGrid}>
        {stats.map((s) => (
          <div key={s.label} className={styles.statCard}>
            <span className={styles.statCardLabel}>{s.label}</span>
            <span className={styles.statCardValue}>
              {s.value}
              {s.of && <span className={styles.statCardValueOf}>{s.of}</span>}
            </span>
            <span className={styles.statCardFoot}>{s.foot}</span>
          </div>
        ))}
      </div>

      <div className={styles.layout}>
        <div className={styles.main}>
          <motion.section className={styles.cardAccent} {...sections(0)}>
            <div className={styles.cardHeader}>
              <span className={styles.cardHeaderIconAccent}>
                <Target size={14} />
              </span>
              <h2 className={styles.cardHeaderTitle}>Meta — o número que o sistema otimiza</h2>
            </div>
            <div className={styles.cardRows}>
              <div className={styles.row}>
                <span className={styles.rowLabel}>Margem alvo</span>
                <input
                  className={styles.numberInput}
                  type="number"
                  step="1"
                  value={pctToInput(rules.targetMarginPct)}
                  onChange={(e) => onChange({ ...rules, targetMarginPct: inputToPct(e.target.value) })}
                />
                <span className={styles.rowUnit}>%</span>
              </div>
              <div className={styles.row}>
                <span className={styles.rowLabel}>Preço mínimo (floor)</span>
                <span className={styles.rowUnit}>R$</span>
                <input
                  className={styles.numberInput}
                  type="number"
                  step="1"
                  value={rules.priceFloor}
                  onChange={(e) => onChange({ ...rules, priceFloor: Number(e.target.value) || 0 })}
                />
              </div>
            </div>
          </motion.section>

          <motion.section className={styles.card} {...sections(0.04)}>
            <div className={styles.cardHeader}>
              <span className={styles.cardHeaderIcon}>
                <Percent size={14} />
              </span>
              <h2 className={styles.cardHeaderTitle}>Taxas de marketplace</h2>
              <span className={styles.cardHeaderMeta}>
                {rules.marketplaceFees.filter((f) => f.enabled).length} de{" "}
                {rules.marketplaceFees.length} ativas
              </span>
            </div>
            <div className={styles.cardRows}>
              {rules.marketplaceFees.map((fee) => (
                <div className={styles.row} key={fee.id}>
                  <Toggle checked={fee.enabled} onChange={(v) => updateFee(fee.id, { enabled: v })} />
                  <span
                    className={styles.rowLabel}
                    title={
                      fee.enabled
                        ? "Ativada: entra no custo total do cálculo de margem."
                        : "Desativada: essa taxa NÃO entra no custo total — margem fica maior do que seria na prática."
                    }
                  >
                    {fee.name}
                  </span>
                  <span className={styles.rowComputed}>
                    {fee.enabled ? brl(preview.marketplacePrice * fee.rate) : "—"}
                  </span>
                  <input
                    className={styles.numberInput}
                    type="number"
                    step="0.1"
                    value={pctToInput(fee.rate)}
                    onChange={(e) => updateFee(fee.id, { rate: inputToPct(e.target.value) })}
                  />
                  <span className={styles.rowUnit}>%</span>
                </div>
              ))}
            </div>
          </motion.section>

          <motion.section className={styles.card} {...sections(0.08)}>
            <div className={styles.cardHeader}>
              <span className={styles.cardHeaderIcon}>
                <Truck size={14} />
              </span>
              <h2 className={styles.cardHeaderTitle}>Frete por faixa de custo</h2>
              <span className={styles.cardHeaderMeta}>faixa fixa · valor editável</span>
            </div>
            <div className={styles.cardRows}>
              {rules.shippingTiers.map((tier) => (
                <div className={styles.row} key={tier.id}>
                  <span className={styles.rowLabel}>
                    {tier.label}
                    {tier.id === appliedTierId && (
                      <span className={styles.rowTag}>aplicado no preview</span>
                    )}
                  </span>
                  <span className={styles.rowUnit}>R$</span>
                  <input
                    className={styles.numberInput}
                    type="number"
                    step="0.5"
                    value={tier.cost}
                    onChange={(e) => updateTier(tier.id, { cost: Number(e.target.value) || 0 })}
                  />
                </div>
              ))}
            </div>
          </motion.section>

          <motion.section className={styles.card} {...sections(0.12)}>
            <div className={styles.cardHeader}>
              <span className={styles.cardHeaderIcon}>
                <Receipt size={14} />
              </span>
              <h2 className={styles.cardHeaderTitle}>Impostos</h2>
              <span className={styles.cardHeaderMeta}>
                {rules.taxRates.filter((t) => t.enabled).length} de {rules.taxRates.length} ativos
              </span>
            </div>
            <div className={styles.cardRows}>
              {rules.taxRates.map((tax) => (
                <div className={styles.row} key={tax.id}>
                  <Toggle checked={tax.enabled} onChange={(v) => updateTax(tax.id, { enabled: v })} />
                  <span
                    className={styles.rowLabel}
                    title={
                      tax.enabled
                        ? "Ativado: entra no custo total do cálculo de margem."
                        : "Desativado: esse imposto NÃO entra no custo total — margem fica maior do que seria na prática."
                    }
                  >
                    {tax.label} ({tax.state})
                  </span>
                  <span className={styles.rowComputed}>
                    {tax.enabled ? brl(preview.marketplacePrice * tax.rate) : "—"}
                  </span>
                  <input
                    className={styles.numberInput}
                    type="number"
                    step="0.1"
                    value={pctToInput(tax.rate)}
                    onChange={(e) => updateTax(tax.id, { rate: inputToPct(e.target.value) })}
                  />
                  <span className={styles.rowUnit}>%</span>
                </div>
              ))}
            </div>
            <div className={styles.cardFooter}>
              <p className={styles.savedHint}>Alterações são salvas automaticamente.</p>
              <button
                type="button"
                className={styles.resetButton}
                onClick={() => onChange(DEFAULT_PRICING_RULES)}
              >
                <RotateCcw size={13} /> Restaurar padrão
              </button>
            </div>
          </motion.section>
        </div>

        <aside className={styles.aside}>
          <motion.section className={styles.card} {...sections(0.02)}>
            <div className={styles.cardHeader}>
              <span className={styles.cardHeaderIcon}>
                <FlaskConical size={14} />
              </span>
              <h2 className={styles.cardHeaderTitle}>Preview ao vivo</h2>
              {!isRealData && <span className={styles.previewTag}>exemplo</span>}
            </div>
            <div className={styles.previewBody}>
              <span className={styles.previewName}>{previewRow.name}</span>
              <span className={styles.previewMeta}>
                Custo {brl(preview.supplierPrice)} · Venda {brl(preview.marketplacePrice)}
              </span>
              <div className={styles.costBar}>
                {costSegments.map((seg) => (
                  <div
                    key={seg.label}
                    className={`${styles.costSegment} ${seg.className}`}
                    style={{
                      width: `${Math.max(0, Math.min(100, (seg.value / marketplacePrice) * 100))}%`,
                    }}
                    title={`${seg.label}: ${brl(seg.value)}`}
                  />
                ))}
              </div>
              <div className={styles.legend}>
                {costSegments.map((seg) => (
                  <span key={seg.label} className={styles.legendItem}>
                    <span className={`${styles.legendDot} ${seg.className}`} />
                    {seg.label}
                    <b className={styles.legendValue}>{brl(seg.value)}</b>
                  </span>
                ))}
              </div>
            </div>
            <div className={styles.previewResult}>
              <span
                className={preview.marginPct >= 0 ? styles.previewMarginUp : styles.previewMarginDown}
              >
                {(preview.marginPct * 100).toFixed(1).replace(".", ",")}%
              </span>
              <span className={styles.previewResultText}>
                margem sobre o custo
                <span className={styles.previewResultSub}>
                  meta {(rules.targetMarginPct * 100).toFixed(0)}%
                </span>
              </span>
            </div>
          </motion.section>

          {showCharts && (
            <motion.section className={styles.card} {...sections(0.06)}>
              <div className={styles.cardHeader}>
                <span className={styles.cardHeaderIcon}>
                  <LineChart size={14} />
                </span>
                <h2 className={styles.cardHeaderTitle}>Se o preço mudar</h2>
                <span className={styles.cardHeaderMeta}>−30% a +40%</span>
              </div>
              <div className={styles.chartBody}>
                <svg className={styles.curve} viewBox="0 0 100 100" preserveAspectRatio="none">
                  <line
                    className={styles.curveLineTarget}
                    x1="0"
                    x2="100"
                    y1={sensitivity.targetY}
                    y2={sensitivity.targetY}
                    vectorEffect="non-scaling-stroke"
                  />
                  <line
                    className={styles.curveLineZero}
                    x1="0"
                    x2="100"
                    y1={sensitivity.zeroY}
                    y2={sensitivity.zeroY}
                    vectorEffect="non-scaling-stroke"
                  />
                  <polyline
                    className={styles.curvePath}
                    points={sensitivity.polyline}
                    vectorEffect="non-scaling-stroke"
                  />
                </svg>
                <div className={styles.curveAxis}>
                  <span>−30%</span>
                  <span>preço atual</span>
                  <span>+40%</span>
                </div>
                <p className={styles.chartCaption}>
                  {sensitivity.reachesTarget && sensitivity.breakEven !== null
                    ? `bate a meta a partir de ${brl(sensitivity.breakEven)} de preço de venda`
                    : "não bate a meta nem a +40% do preço atual — reveja custo, taxas ou a própria meta"}
                </p>
              </div>
            </motion.section>
          )}

          {showCharts && (
            <motion.section className={styles.card} {...sections(0.1)}>
              <div className={styles.cardHeader}>
                <span className={styles.cardHeaderIcon}>
                  <Layers size={14} />
                </span>
                <h2 className={styles.cardHeaderTitle}>Impacto no catálogo</h2>
              </div>
              <div className={styles.chartBody}>
                {impact.total === 0 ? (
                  <p className={styles.chartCaption}>
                    Nenhum catálogo processado nesta sessão — envie um arquivo no Dashboard pra ver a
                    distribuição de margem com estas regras.
                  </p>
                ) : (
                  <>
                    <div className={styles.stackBar}>
                      <span
                        className={styles.stackRecomendado}
                        style={{ width: `${(impact.counts.recomendado / impact.total) * 100}%` }}
                      />
                      <span
                        className={styles.stackRevisar}
                        style={{ width: `${(impact.counts.revisar / impact.total) * 100}%` }}
                      />
                      <span
                        className={styles.stackEvitar}
                        style={{ width: `${(impact.counts.evitar / impact.total) * 100}%` }}
                      />
                    </div>
                    <div className={styles.legend}>
                      <span className={styles.legendItem}>
                        <span className={`${styles.legendDot} ${styles.segProfit}`} />
                        Recomendado
                        <b className={styles.legendValue}>{impact.counts.recomendado}</b>
                      </span>
                      <span className={styles.legendItem}>
                        <span className={`${styles.legendDot} ${styles.segShipping}`} />
                        Revisar
                        <b className={styles.legendValue}>{impact.counts.revisar}</b>
                      </span>
                      <span className={styles.legendItem}>
                        <span className={`${styles.legendDot} ${styles.segTaxes}`} />
                        Evitar
                        <b className={styles.legendValue}>{impact.counts.evitar}</b>
                      </span>
                    </div>
                    <div className={styles.histogram}>
                      {impact.buckets.map((b) => (
                        <div key={b.label} className={styles.histCol}>
                          <span className={styles.histValue}>{b.count}</span>
                          <span className={styles.histTrack}>
                            <span
                              className={b.isNegative ? styles.histFillNegative : styles.histFill}
                              style={{
                                height: `${Math.max(2, Math.round((b.count / impact.maxBucket) * 100))}%`,
                              }}
                            />
                          </span>
                          <span className={styles.histLabel}>{b.label}</span>
                        </div>
                      ))}
                    </div>
                    <p className={styles.chartCaption}>
                      produtos por faixa de margem, com as regras atuais
                    </p>
                  </>
                )}
              </div>
            </motion.section>
          )}
        </aside>
      </div>
    </div>
  );
}
