import { useMemo, useState } from "react";
import {
  Percent,
  Truck,
  Receipt,
  Target,
  RotateCcw,
  FlaskConical,
  LineChart,
  Layers,
  Check,
  ArrowRight,
} from "lucide-react";
import type { CatalogRow, MarketplaceId, MarketplacePriceResult, PricingRules } from "../types";
import { calculateMargin, calculateMargins, DEFAULT_PRICING_RULES, median } from "../lib/marginCalculator";
import type { CatalogUploadRecord } from "../lib/catalogHistory";
import { brl, displayProductName, marginTone, pct } from "../lib/format";
import { useToast } from "../lib/toast";
import type { Recommendation } from "../types";
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
  /** Abre Resultados já filtrado — usado pelo card "Impacto no catálogo". */
  onViewResults?: (filter: Recommendation) => void;
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

interface StatCard {
  label: string;
  value: string;
  of: string;
  foot: string;
  tone?: "good" | "warn" | "bad";
}

const TONE_CLASS: Record<NonNullable<StatCard["tone"]>, string> = {
  good: styles.toneGood,
  warn: styles.toneWarn,
  bad: styles.toneBad,
};

function pctToInput(rate: number): string {
  return String(Math.round(rate * 1000) / 10);
}
function inputToPct(value: string): number {
  const n = Number(value);
  return Number.isFinite(n) ? n / 100 : 0;
}
function Toggle({ checked, onChange, label }: { checked: boolean; onChange: (v: boolean) => void; label: string }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={`${label}: ${checked ? "ligada" : "desligada"}`}
      className={checked ? styles.switchOn : styles.switch}
      onClick={() => onChange(!checked)}
    >
      <span className={styles.switchThumb} />
    </button>
  );
}

export default function PricingConfig({
  rules,
  onChange,
  catalogRows,
  pricesByMarket,
  history = [],
  activeHistoryId = null,
  onSelectHistory,
  showCharts = true,
  onViewResults,
}: Props) {
  const toast = useToast();
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
  // Produtos que dá pra usar na prévia: com custo (sem custo não há
  // frete/margem pra simular — catálogo "vitrine", ver
  // CatalogRow.supplierPrice) e com preço encontrado em algum marketplace.
  const previewOptions = useMemo(() => {
    if (!catalogRows || !pricesByMarket) return [];
    const options: { sku: string; name: string; row: CatalogRow; price: MarketplacePriceResult }[] = [];
    for (const row of catalogRows) {
      if (row.supplierPrice == null) continue;
      for (const priceMap of Object.values(pricesByMarket)) {
        const price = priceMap?.[row.sku];
        if (price) {
          options.push({ sku: row.sku, name: row.name, row, price });
          break;
        }
      }
    }
    return options;
  }, [catalogRows, pricesByMarket]);
  // Escolha do usuário no seletor da prévia; sem escolha (ou se o produto
  // sumiu ao trocar de busca), cai no primeiro da lista.
  const [previewSku, setPreviewSku] = useState<string | null>(null);
  const { previewRow, previewPrice, isRealData } = useMemo(() => {
    const chosen = previewOptions.find((o) => o.sku === previewSku) ?? previewOptions[0];
    if (chosen) return { previewRow: chosen.row, previewPrice: chosen.price, isRealData: true };
    return { previewRow: FALLBACK_ROW, previewPrice: FALLBACK_PRICE, isRealData: false };
  }, [previewOptions, previewSku]);

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
  // `?? 0` abaixo é defensivo, não esperado na prática: previewRow SEMPRE
  // tem supplierPrice (garantido na seleção acima), então calculateMargin
  // nunca cai no ramo "sem_custo" aqui — os campos vêm preenchidos. O
  // tipo de MarginResult é opcional porque a função também serve pra
  // catálogo sem custo (ver marginCalculator.ts), não porque ESTE
  // preview possa ficar sem eles.
  const profit = preview.marketplacePrice - (preview.totalCost ?? 0);

  const costSegments = [
    { label: "Produto", value: preview.supplierPrice ?? 0, className: styles.segProduct },
    { label: "Taxas", value: preview.feesCost ?? 0, className: styles.segFees },
    { label: "Frete", value: preview.shippingCost ?? 0, className: styles.segShipping },
    { label: "Impostos", value: preview.taxesCost ?? 0, className: styles.segTaxes },
    { label: "Lucro", value: Math.max(0, profit), className: styles.segProfit },
  ];

  // Faixa de frete aplicada no preview — marcada na lista pra ficar
  // claro qual das três linhas afeta o número mostrado ao lado.
  const appliedTierId = useMemo(() => {
    const sorted = [...rules.shippingTiers].sort((a, b) => a.maxPrice - b.maxPrice);
    const previewSupplierPrice = previewRow.supplierPrice ?? 0;
    return (sorted.find((t) => previewSupplierPrice <= t.maxPrice) ?? sorted[sorted.length - 1])?.id;
  }, [rules.shippingTiers, previewRow.supplierPrice]);

  const stats = useMemo((): StatCard[] => {
    const total = results.length;
    if (total === 0) {
      return [
        { label: "margem mediana", value: "—", of: "", foot: `meta ${(rules.targetMarginPct * 100).toFixed(0)}%` },
        { label: "recomendados", value: "—", of: "", foot: "processe um catálogo no Dashboard" },
        { label: "lucro médio por venda", value: "—", of: "", foot: "sem catálogo nesta sessão" },
        { label: "carga sobre a venda", value: "—", of: "", foot: "taxas + frete + impostos" },
      ];
    }

    // Métricas de custo/margem só fazem sentido pra quem TEM custo (ver
    // "sem_custo" em types/index.ts) — produto sem preço de fornecedor
    // entra no total de itens processados (pro "N / total" abaixo), mas
    // fica fora da média/mediana de margem e lucro, senão distorceria
    // pra baixo com um "custo zero" que não é real.
    const withCost = results.filter((r): r is typeof r & { marginPct: number } => r.marginPct != null);
    const medianMargin = median(withCost.map((r) => r.marginPct));
    const recomendados = results.filter((r) => r.recommendation === "recomendado").length;
    const avgProfit =
      withCost.length > 0
        ? withCost.reduce((sum, r) => sum + (r.marketplacePrice - (r.totalCost ?? 0)), 0) / withCost.length
        : 0;
    const avgTicket =
      withCost.length > 0 ? withCost.reduce((sum, r) => sum + r.marketplacePrice, 0) / withCost.length : 0;
    const totalPrice = withCost.reduce((sum, r) => sum + r.marketplacePrice, 0);
    const totalLoad = withCost.reduce(
      (sum, r) => sum + (r.feesCost ?? 0) + (r.shippingCost ?? 0) + (r.taxesCost ?? 0),
      0
    );

    return [
      {
        label: "margem mediana",
        value: pct(medianMargin),
        of: "",
        foot: `mediana de ${withCost.length} produto(s) · meta ${(rules.targetMarginPct * 100).toFixed(0)}%`,
        tone: withCost.length > 0 ? marginTone(medianMargin, rules.targetMarginPct) : undefined,
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
      const count = results.filter(
        (r) => r.marginPct != null && r.marginPct >= min && r.marginPct < b.max
      ).length;
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
      // `?? 0` defensivo (ver comentário em `profit` acima) — previewRow
      // sempre tem custo aqui, então na prática esse ramo nunca dispara.
      const margin = calculateMargin(previewRow, { ...previewPrice, price }, rules).marginPct ?? 0;
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

  function handleReset() {
    const previous = rules;
    onChange(DEFAULT_PRICING_RULES);
    toast.show({
      message: "Regras voltaram pro padrão.",
      action: { label: "Desfazer", onClick: () => onChange(previous) },
    });
  }

  const activeFees = rules.marketplaceFees.filter((f) => f.enabled).length;
  const activeTaxes = rules.taxRates.filter((t) => t.enabled).length;

  return (
    <div className={styles.container}>
      <header className={styles.header}>
        <div className={styles.headerMain}>
          <h1 className={styles.title}>Precificação</h1>
          <p className={styles.lead}>
            Ajuste taxas, frete e impostos e veja o efeito no catálogo inteiro na hora — sem gastar uma busca
            nova. Tudo é salvo sozinho.
            <span className={styles.leadMeta}>
              simulando <b>{results.length} produto(s)</b> · meta <b>{pctToInput(rules.targetMarginPct)}%</b>
            </span>
          </p>
        </div>
        {history.length > 0 && onSelectHistory && (
          <label className={styles.historySelectWrap}>
            <span className={styles.historySelectLabel}>Busca simulada</span>
            <select
              className={styles.select}
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
      </header>

      <div className={styles.kpis}>
        {stats.map((s) => (
          <div key={s.label} className={styles.kpi}>
            <span className={styles.kpiLabel}>{s.label}</span>
            <span className={`${styles.kpiValue} ${s.tone ? TONE_CLASS[s.tone] : ""}`}>
              {s.value}
              {s.of && <span className={styles.kpiOf}>{s.of}</span>}
            </span>
            <span className={styles.kpiHint}>{s.foot}</span>
          </div>
        ))}
      </div>

      <div className={styles.layout}>
        <div className={styles.main}>
          <section className={styles.sectionAccent}>
            <div className={styles.sectionHead}>
              <h2 className={styles.sectionTitle}>
                <Target size={15} aria-hidden="true" /> Meta
              </h2>
              <span className={styles.sectionMeta}>o número que o sistema otimiza</span>
            </div>
            <div className={styles.row}>
              <span className={styles.rowText}>
                <span className={styles.rowLabel}>Margem alvo</span>
                <span className={styles.rowHint}>Acima disso o produto vira “Recomendado”; entre 0 e a meta, “Revisar”.</span>
              </span>
              <NumberField
                label="Margem alvo"
                suffix="%"
                step="1"
                value={pctToInput(rules.targetMarginPct)}
                onChange={(v) => onChange({ ...rules, targetMarginPct: inputToPct(v) })}
              />
            </div>
            <div className={styles.row}>
              <span className={styles.rowText}>
                <span className={styles.rowLabel}>Preço mínimo</span>
                <span className={styles.rowHint}>O preço sugerido nunca fica abaixo disso. 0 = sem piso.</span>
              </span>
              <NumberField
                label="Preço mínimo"
                prefix="R$"
                step="1"
                value={String(rules.priceFloor)}
                onChange={(v) => onChange({ ...rules, priceFloor: Number(v) || 0 })}
              />
            </div>
          </section>

          <section className={styles.section}>
            <div className={styles.sectionHead}>
              <h2 className={styles.sectionTitle}>
                <Percent size={15} aria-hidden="true" /> Taxas de marketplace
              </h2>
              <span className={styles.sectionMeta}>
                {activeFees} de {rules.marketplaceFees.length} ativas · valor no produto da prévia
              </span>
            </div>
            {rules.marketplaceFees.map((fee) => (
              <div className={fee.enabled ? styles.row : styles.rowOff} key={fee.id}>
                <Toggle checked={fee.enabled} label={fee.name} onChange={(v) => updateFee(fee.id, { enabled: v })} />
                <span className={styles.rowText}>
                  <span className={styles.rowLabel}>{fee.name}</span>
                  {!fee.enabled && <span className={styles.rowHint}>desligada — não entra no custo</span>}
                </span>
                <span className={styles.rowComputed}>{fee.enabled ? brl(preview.marketplacePrice * fee.rate) : "—"}</span>
                <NumberField
                  label={fee.name}
                  suffix="%"
                  step="0.1"
                  value={pctToInput(fee.rate)}
                  disabled={!fee.enabled}
                  onChange={(v) => updateFee(fee.id, { rate: inputToPct(v) })}
                />
              </div>
            ))}
          </section>

          <section className={styles.section}>
            <div className={styles.sectionHead}>
              <h2 className={styles.sectionTitle}>
                <Truck size={15} aria-hidden="true" /> Frete por faixa de custo
              </h2>
              <span className={styles.sectionMeta}>a faixa vem do custo do produto</span>
            </div>
            {rules.shippingTiers.map((tier) => (
              <div className={tier.id === appliedTierId ? styles.rowApplied : styles.row} key={tier.id}>
                <span className={styles.rowText}>
                  <span className={styles.rowLabel}>
                    {tier.label}
                    {tier.id === appliedTierId && <span className={styles.rowTag}>usada na prévia</span>}
                  </span>
                </span>
                <NumberField
                  label={`Frete ${tier.label}`}
                  prefix="R$"
                  step="0.5"
                  value={String(tier.cost)}
                  onChange={(v) => updateTier(tier.id, { cost: Number(v) || 0 })}
                />
              </div>
            ))}
          </section>

          <section className={styles.section}>
            <div className={styles.sectionHead}>
              <h2 className={styles.sectionTitle}>
                <Receipt size={15} aria-hidden="true" /> Impostos
              </h2>
              <span className={styles.sectionMeta}>
                {activeTaxes} de {rules.taxRates.length} ativos
              </span>
            </div>
            {rules.taxRates.map((tax) => (
              <div className={tax.enabled ? styles.row : styles.rowOff} key={tax.id}>
                <Toggle checked={tax.enabled} label={tax.label} onChange={(v) => updateTax(tax.id, { enabled: v })} />
                <span className={styles.rowText}>
                  <span className={styles.rowLabel}>
                    {tax.label} <span className={styles.rowState}>{tax.state}</span>
                  </span>
                  {!tax.enabled && <span className={styles.rowHint}>desligado — não entra no custo</span>}
                </span>
                <span className={styles.rowComputed}>{tax.enabled ? brl(preview.marketplacePrice * tax.rate) : "—"}</span>
                <NumberField
                  label={tax.label}
                  suffix="%"
                  step="0.1"
                  value={pctToInput(tax.rate)}
                  disabled={!tax.enabled}
                  onChange={(v) => updateTax(tax.id, { rate: inputToPct(v) })}
                />
              </div>
            ))}
          </section>

          <div className={styles.footer}>
            <span className={styles.savedHint}>
              <Check size={13} aria-hidden="true" /> Alterações salvas automaticamente
            </span>
            <button type="button" className={styles.toolButton} onClick={handleReset}>
              <RotateCcw size={13} aria-hidden="true" /> Restaurar padrão
            </button>
          </div>
        </div>

        <aside className={styles.aside}>
          <section className={styles.block}>
            <div className={styles.sectionHead}>
              <h2 className={styles.sectionTitle}>
                <FlaskConical size={15} aria-hidden="true" /> Prévia ao vivo
              </h2>
              {!isRealData && <span className={styles.previewTag}>exemplo</span>}
            </div>
            {previewOptions.length > 1 ? (
              <select
                className={styles.select}
                value={previewRow.sku}
                onChange={(e) => setPreviewSku(e.target.value)}
                aria-label="Produto da prévia"
              >
                {previewOptions.map((o) => (
                  <option key={o.sku} value={o.sku}>
                    {displayProductName(o.name)}
                  </option>
                ))}
              </select>
            ) : (
              <span className={styles.previewName}>{displayProductName(previewRow.name)}</span>
            )}
            <span className={styles.previewMeta}>
              {/* `?? 0` defensivo (ver comentário em `profit` acima) — previewRow sempre tem custo aqui. */}
              custo {brl(preview.supplierPrice ?? 0)} · venda {brl(preview.marketplacePrice)}
            </span>
            <div className={styles.costBar}>
              {costSegments.map((seg) => (
                <div
                  key={seg.label}
                  className={`${styles.costSegment} ${seg.className}`}
                  style={{ width: `${Math.max(0, Math.min(100, (seg.value / marketplacePrice) * 100))}%` }}
                  title={`${seg.label}: ${brl(seg.value)}`}
                />
              ))}
            </div>
            <dl className={styles.ledger}>
              {costSegments.map((seg) => (
                <div key={seg.label} className={seg.label === "Lucro" ? styles.ledgerTotal : undefined}>
                  <dt>
                    <span className={`${styles.legendDot} ${seg.className}`} aria-hidden="true" />
                    {seg.label === "Lucro" ? "Sobra" : seg.label}
                  </dt>
                  <dd>{seg.label === "Lucro" ? brl(profit) : brl(seg.value)}</dd>
                </div>
              ))}
            </dl>
            <div className={styles.previewResult}>
              <span className={`${styles.previewMargin} ${TONE_CLASS[marginTone(preview.marginPct ?? 0, rules.targetMarginPct)]}`}>
                {pct(preview.marginPct ?? 0)}
              </span>
              <span className={styles.previewResultText}>
                margem deste produto
                <span className={styles.previewResultSub}>meta {pctToInput(rules.targetMarginPct)}%</span>
              </span>
            </div>
          </section>

          {showCharts && (
            <section className={styles.block}>
              <div className={styles.sectionHead}>
                <h2 className={styles.sectionTitle}>
                  <LineChart size={15} aria-hidden="true" /> Se o preço mudar
                </h2>
                <span className={styles.sectionMeta}>−30% a +40%</span>
              </div>
              <svg className={styles.curve} viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true">
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
                <polyline className={styles.curvePath} points={sensitivity.polyline} vectorEffect="non-scaling-stroke" />
              </svg>
              <div className={styles.curveAxis}>
                <span>−30%</span>
                <span>preço atual</span>
                <span>+40%</span>
              </div>
              <p className={styles.chartCaption}>
                {sensitivity.reachesTarget && sensitivity.breakEven !== null ? (
                  <>
                    Bate a meta a partir de <b>{brl(sensitivity.breakEven)}</b> de preço de venda.
                  </>
                ) : (
                  "Não bate a meta nem a +40% do preço atual — reveja custo, taxas ou a própria meta."
                )}
              </p>
            </section>
          )}

          {showCharts && (
            <section className={styles.block}>
              <div className={styles.sectionHead}>
                <h2 className={styles.sectionTitle}>
                  <Layers size={15} aria-hidden="true" /> Impacto no catálogo
                </h2>
              </div>
              {impact.total === 0 ? (
                <p className={styles.chartCaption}>
                  Nenhum catálogo processado nesta sessão — rode uma Nova busca pra ver a distribuição de margem com
                  estas regras.
                </p>
              ) : (
                <>
                  <div className={styles.stackBar}>
                    <span className={styles.stackRecomendado} style={{ width: `${(impact.counts.recomendado / impact.total) * 100}%` }} />
                    <span className={styles.stackRevisar} style={{ width: `${(impact.counts.revisar / impact.total) * 100}%` }} />
                    <span className={styles.stackEvitar} style={{ width: `${(impact.counts.evitar / impact.total) * 100}%` }} />
                  </div>
                  <ul className={styles.impactList}>
                    {(
                      [
                        { id: "recomendado", label: "Recomendado", dot: styles.segProfit },
                        { id: "revisar", label: "Revisar", dot: styles.segShipping },
                        { id: "evitar", label: "Evitar", dot: styles.segTaxes },
                      ] as const
                    ).map((item) => (
                      <li key={item.id}>
                        {onViewResults && impact.counts[item.id] > 0 ? (
                          <button
                            type="button"
                            className={styles.impactButton}
                            onClick={() => onViewResults(item.id)}
                            title={`Ver os produtos em "${item.label}" na tela de Resultados`}
                          >
                            <span className={`${styles.legendDot} ${item.dot}`} aria-hidden="true" />
                            {item.label}
                            <b>{impact.counts[item.id]}</b>
                            <ArrowRight size={13} aria-hidden="true" className={styles.impactArrow} />
                          </button>
                        ) : (
                          <span className={styles.impactStatic}>
                            <span className={`${styles.legendDot} ${item.dot}`} aria-hidden="true" />
                            {item.label}
                            <b>{impact.counts[item.id]}</b>
                          </span>
                        )}
                      </li>
                    ))}
                  </ul>
                  <div className={styles.histogram}>
                    {impact.buckets.map((b) => (
                      <div key={b.label} className={styles.histCol}>
                        <span className={styles.histValue}>{b.count}</span>
                        <span className={styles.histTrack}>
                          <span
                            className={b.isNegative ? styles.histFillNegative : styles.histFill}
                            style={{ height: b.count === 0 ? 0 : `${Math.max(4, Math.round((b.count / impact.maxBucket) * 100))}%` }}
                          />
                        </span>
                        <span className={styles.histLabel}>{b.label}</span>
                      </div>
                    ))}
                  </div>
                  <p className={styles.chartCaption}>Produtos por faixa de margem, com as regras atuais.</p>
                </>
              )}
            </section>
          )}
        </aside>
      </div>
    </div>
  );
}

/** Campo numérico com unidade dentro da caixa (R$ antes, % depois) — padrão "input group" do shadcn. */
function NumberField({
  label,
  value,
  onChange,
  prefix,
  suffix,
  step,
  disabled,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  prefix?: string;
  suffix?: string;
  step: string;
  disabled?: boolean;
}) {
  return (
    <span className={disabled ? styles.numberFieldOff : styles.numberField}>
      {prefix && <span className={styles.numberAffix}>{prefix}</span>}
      <input
        className={styles.numberInput}
        type="number"
        inputMode="decimal"
        step={step}
        value={value}
        aria-label={label}
        disabled={disabled}
        onChange={(e) => onChange(e.target.value)}
      />
      {suffix && <span className={styles.numberAffix}>{suffix}</span>}
    </span>
  );
}
