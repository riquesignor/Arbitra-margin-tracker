import { motion } from "framer-motion";
import type { Recommendation } from "../types";
import styles from "./MarginBar.module.css";

interface Props {
  marginPct: number;
  targetMarginPct: number;
  recommendation: Recommendation;
}

const SCALE_MIN = -0.3;
const SCALE_MAX = 0.8;

function toPosition(value: number): number {
  const clamped = Math.min(Math.max(value, SCALE_MIN), SCALE_MAX);
  return ((clamped - SCALE_MIN) / (SCALE_MAX - SCALE_MIN)) * 100;
}

const FILL_CLASS: Record<Recommendation, string> = {
  recomendado: styles.fillRecomendado,
  revisar: styles.fillRevisar,
  evitar: styles.fillEvitar,
};

/** Barra de spread: eixo zero (linha sólida), eixo target (linha tracejada), fill colorido. */
export default function MarginBar({ marginPct, targetMarginPct, recommendation }: Props) {
  const zeroPos = toPosition(0);
  const targetPos = toPosition(targetMarginPct);
  const valuePos = toPosition(marginPct);

  const fillStart = Math.min(zeroPos, valuePos);
  const fillWidth = Math.abs(valuePos - zeroPos);

  return (
    <div
      className={styles.track}
      title={`Margem: ${(marginPct * 100).toFixed(1)}% · Meta: ${(targetMarginPct * 100).toFixed(1)}%`}
    >
      <motion.div
        className={`${styles.fill} ${FILL_CLASS[recommendation]}`}
        style={{ left: `${fillStart}%` }}
        initial={false}
        animate={{ width: `${fillWidth}%` }}
        transition={{ duration: 0.35, ease: [0.16, 1, 0.3, 1] }}
      />
      <div className={`${styles.axis} ${styles.axisZero}`} style={{ left: `${zeroPos}%` }} />
      <div className={`${styles.axis} ${styles.axisTarget}`} style={{ left: `${targetPos}%` }} />
    </div>
  );
}
