import { useMemo } from "react";
import { BarChart3, Target } from "lucide-react";
import type { MarginResult, Recommendation } from "../types";
import { brl, displayProductName, pct } from "../lib/format";
import styles from "./ProfitCharts.module.css";

interface Props {
  results: MarginResult[];
  targetMarginPct: number;
}

const TOP_N = 10;

const STATUS_LABEL: Record<Recommendation, string> = {
  recomendado: "Recomendado",
  revisar: "Revisar",
  evitar: "Evitar",
  sem_custo: "Sem custo",
};

function statusClass(r: Recommendation): string {
  return styles[`status_${r}`];
}

function unitProfit(r: MarginResult): number | null {
  if (r.recommendation === "sem_custo" || r.totalCost == null) return null;
  return r.marketplacePrice - r.totalCost;
}

function TopProfitChart({ results }: { results: MarginResult[] }) {
  const top = useMemo(() => {
    const bestBySku = new Map<string, { r: MarginResult; profit: number }>();
    for (const r of results) {
      const profit = unitProfit(r);
      if (profit == null || profit <= 0) continue;
      const current = bestBySku.get(r.sku);
      if (!current || profit > current.profit) bestBySku.set(r.sku, { r, profit });
    }
    return [...bestBySku.values()].sort((a, b) => b.profit - a.profit).slice(0, TOP_N);
  }, [results]);

  if (top.length === 0) return null;
  const max = top[0].profit;

  return (
    <div className={styles.card}>
      <div className={styles.header}>
        <span className={styles.headerIcon}>
          <BarChart3 size={13} />
        </span>
        <span className={styles.title}>Maiores lucros por unidade</span>
        <span className={styles.meta}>top {top.length}</span>
      </div>
      <ol className={styles.barList}>
        {top.map(({ r, profit }) => (
          <li
            key={`${r.marketplace}-${r.sku}`}
            className={styles.barRow}
            title={`${r.name} — lucro ${brl(profit)} (${r.marginPct != null ? pct(r.marginPct) : "sem margem"})`}
          >
            <span className={styles.barName}>{displayProductName(r.name)}</span>
            <span className={styles.barTrack}>
              <span
                className={`${styles.barFill} ${statusClass(r.recommendation)}`}
                style={{ width: `${Math.max(2, (profit / max) * 100)}%` }}
              />
            </span>
            <span className={styles.barValue}>{brl(profit)}</span>
          </li>
        ))}
      </ol>
    </div>
  );
}

const W = 560;
const H = 250;
const PAD = { l: 46, r: 14, t: 12, b: 30 };

function formatCost(v: number): string {
  return `R$ ${v.toLocaleString("pt-BR", { maximumFractionDigits: v < 10 ? 2 : 0 })}`;
}

function CostMarginScatter({ results, targetMarginPct }: Props) {
  const chart = useMemo(() => {
    const pts = results.filter(
      (r) => r.supplierPrice != null && r.supplierPrice > 0 && r.marginPct != null
    );
    if (pts.length === 0) return null;

    const costs = pts.map((r) => r.supplierPrice as number);
    const margins = pts.map((r) => (r.marginPct as number) * 100);
    const minCost = Math.min(...costs);
    const maxCost = Math.max(...costs);
    const useLog = maxCost / minCost > 20;
    const tx = (v: number) => (useLog ? Math.log10(v) : v);
    const inv = (t: number) => (useLog ? 10 ** t : t);

    let x0 = tx(minCost);
    let x1 = tx(maxCost);
    if (x1 === x0) {
      x0 -= 1;
      x1 += 1;
    }
    const xPad = (x1 - x0) * 0.05;
    x0 -= xPad;
    x1 += xPad;

    const yMin = Math.max(-50, Math.min(0, Math.floor(Math.min(...margins) / 10) * 10));
    const yMax = Math.min(
      150,
      Math.max(Math.ceil((targetMarginPct * 100 + 10) / 10) * 10, Math.ceil(Math.max(...margins) / 10) * 10)
    );

    const plotW = W - PAD.l - PAD.r;
    const plotH = H - PAD.t - PAD.b;
    const xPos = (cost: number) => PAD.l + ((tx(cost) - x0) / (x1 - x0)) * plotW;
    const yPos = (marginPctValue: number) => {
      const clamped = Math.min(yMax, Math.max(yMin, marginPctValue));
      return PAD.t + (1 - (clamped - yMin) / (yMax - yMin)) * plotH;
    };

    const xTicks = [0, 1, 2, 3].map((i) => inv(x0 + ((x1 - x0) * i) / 3));
    const yTicks = [0, 1, 2, 3, 4].map((i) => Math.round(yMin + ((yMax - yMin) * i) / 4));

    return {
      dots: pts.map((r) => ({
        r,
        cx: xPos(r.supplierPrice as number),
        cy: yPos((r.marginPct as number) * 100),
      })),
      xTicks: xTicks.map((v) => ({ v, x: xPos(v) })),
      yTicks: yTicks.map((v) => ({ v, y: yPos(v) })),
      zeroY: yMin < 0 ? yPos(0) : null,
      targetY: yPos(targetMarginPct * 100),
      useLog,
    };
  }, [results, targetMarginPct]);

  if (!chart) return null;

  return (
    <div className={styles.card}>
      <div className={styles.header}>
        <span className={styles.headerIcon}>
          <Target size={13} />
        </span>
        <span className={styles.title}>Custo × margem</span>
        <span className={styles.meta}>
          {chart.dots.length} produto(s){chart.useLog ? " · escala log" : ""}
        </span>
      </div>
      <svg
        className={styles.scatter}
        viewBox={`0 0 ${W} ${H}`}
        role="img"
        aria-label="Dispersão de custo do fornecedor por margem, uma bolinha por produto"
      >
        {chart.yTicks.map((t) => (
          <g key={`y-${t.v}`}>
            <line className={styles.grid} x1={PAD.l} x2={W - PAD.r} y1={t.y} y2={t.y} />
            <text className={styles.axisText} x={PAD.l - 6} y={t.y + 3} textAnchor="end">
              {t.v}%
            </text>
          </g>
        ))}
        {chart.xTicks.map((t) => (
          <text
            key={`x-${t.v}`}
            className={styles.axisText}
            x={t.x}
            y={H - PAD.b + 16}
            textAnchor="middle"
          >
            {formatCost(t.v)}
          </text>
        ))}
        {chart.zeroY != null && (
          <line className={styles.zeroLine} x1={PAD.l} x2={W - PAD.r} y1={chart.zeroY} y2={chart.zeroY} />
        )}
        <line
          className={styles.targetLine}
          x1={PAD.l}
          x2={W - PAD.r}
          y1={chart.targetY}
          y2={chart.targetY}
        />
        <text className={styles.targetText} x={W - PAD.r} y={chart.targetY - 4} textAnchor="end">
          meta {pct(targetMarginPct, 0)}
        </text>
        {chart.dots.map(({ r, cx, cy }) => (
          <circle
            key={`${r.marketplace}-${r.sku}`}
            className={`${styles.dot} ${statusClass(r.recommendation)}`}
            cx={cx}
            cy={cy}
            r={4}
          >
            <title>
              {`${displayProductName(r.name)} — custo ${brl(r.supplierPrice as number)}, margem ${pct(r.marginPct as number)}`}
            </title>
          </circle>
        ))}
      </svg>
      <div className={styles.legend}>
        {(["recomendado", "revisar", "evitar"] as Recommendation[]).map((s) => (
          <span key={s} className={styles.legendItem}>
            <span className={`${styles.legendDot} ${statusClass(s)}`} />
            {STATUS_LABEL[s]}
          </span>
        ))}
      </div>
    </div>
  );
}

export default function ProfitCharts({ results, targetMarginPct }: Props) {
  return (
    <div className={styles.row}>
      <TopProfitChart results={results} />
      <CostMarginScatter results={results} targetMarginPct={targetMarginPct} />
    </div>
  );
}
