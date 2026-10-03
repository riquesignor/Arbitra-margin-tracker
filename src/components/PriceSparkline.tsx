import { brl } from "../lib/format";
import styles from "./PriceSparkline.module.css";

interface Props {
  points: { price: number; date: number }[];
}

const WIDTH = 64;
const HEIGHT = 22;
const PADDING_Y = 3;

/**
 * Mini-gráfico de linha do histórico de preço (out/2026) — usa a série
 * completa já montada em `buildPortfolio` (src/lib/portfolio.ts), que
 * por sua vez já vinha de buscas salvas; nenhum dado novo foi coletado
 * pra isso existir, só parou de descartar os pontos além dos 2 mais
 * recentes. SVG customizado (sem lib de gráfico) pra ficar no mesmo
 * estilo do resto do app (ver MarginBar.tsx).
 */
export default function PriceSparkline({ points }: Props) {
  if (points.length < 2) return null;

  const prices = points.map((p) => p.price);
  const min = Math.min(...prices);
  const max = Math.max(...prices);
  const range = max - min;

  // Preço constante em todo o período: linha reta no meio, não um ponto
  // fora de escala — divisão por zero em `range` seria NaN no cálculo de y.
  const toY = (price: number) =>
    range === 0 ? HEIGHT / 2 : HEIGHT - PADDING_Y - ((price - min) / range) * (HEIGHT - PADDING_Y * 2);

  const toX = (i: number) => (i / (points.length - 1)) * WIDTH;

  const path = points.map((p, i) => `${toX(i)},${toY(p.price)}`).join(" ");

  const first = points[0].price;
  const last = points[points.length - 1].price;
  const trendClass = last > first ? styles.up : last < first ? styles.down : styles.flat;

  const title = `Histórico de preço (${points.length} busca${points.length === 1 ? "" : "s"}): ${points
    .map((p) => brl(p.price))
    .join(" → ")}`;

  return (
    <svg
      className={`${styles.sparkline} ${trendClass}`}
      width={WIDTH}
      height={HEIGHT}
      viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
      role="img"
      aria-label={title}
    >
      <title>{title}</title>
      <polyline points={path} fill="none" strokeWidth={1.5} />
    </svg>
  );
}
