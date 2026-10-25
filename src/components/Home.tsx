import { useEffect, useMemo, useRef, useState } from "react";
import { motion } from "framer-motion";
import { Plus } from "lucide-react";
import type { MarketplaceId, Screen } from "../types";
import type { CatalogUploadRecord } from "../lib/catalogHistory";
import { listSharedCatalogsForPlan, type SharedCatalog } from "../lib/sharedCatalogs";
import { getUserApiKeys } from "../lib/userSecrets";
import { median } from "../lib/marginCalculator";
import { marginTone, pct } from "../lib/format";
import { getPlan } from "../config/plans";
import {
  MARKETPLACE_NAME,
  joinPt,
  shortDate,
  signedPct,
  summarizeCatalog,
  type CatalogSummary,
} from "../lib/catalogSummary";
import type { UserProfile } from "../lib/userProfile";
import styles from "./Home.module.css";

interface Props {
  userId: string | null;
  userEmail?: string | null;
  profile: UserProfile | null;
  /** Histórico completo (já carregado em App.tsx pro seletor de Precificação/Resultados) — Home só lê, não refaz a consulta. */
  history: CatalogUploadRecord[];
  onNavigate: (screen: Screen) => void;
  /** Abre um registro do histórico direto na tela de Resultados (ver handleOpenHistoryRecord em App.tsx). */
  onOpenRecord: (id: string) => void;
  /** "Rodar" num catálogo da biblioteca — manda o catálogo inteiro pro App, que passa pra Dashboard já processar (ver handleUseSharedCatalog em App.tsx). */
  onUseSharedCatalog: (catalog: SharedCatalog) => void;
  /** Margem-alvo das regras de Precificação — posição da linha "meta" na régua e régua das cores. */
  targetMarginPct: number;
  /** Abre Configurações direto na seção de planos/pagamento. */
  onOpenPlans: () => void;
}

/**
 * Início — "régua de margem" + "livro-razão" (out/2026, design em
 * Home-html.zip > Main.dc.html). Cada catálogo rodado vira um marcador
 * na régua pela margem MEDIANA dos produtos com preço (mediana, não
 * média: um preço estranho não puxa o catálogo inteiro). Cores vêm dos
 * tokens semânticos do app (tokens.css), não dos hex do mockup — os
 * valores do tema claro batem com o mockup e o tema escuro sai de graça.
 */

/** Escala fixa da régua (fração): −100% a +120%, como no mockup. Valor fora disso encosta na borda, com o número real no rótulo. */
const RULER_MIN = -1;
const RULER_MAX = 1.2;
/** Quantos catálogos recentes entram na régua e na tabela — além disso a régua vira um borrão de rótulos sobrepostos. */
const RECENT_LIMIT = 6;
/** Largura de cada rótulo de catálogo embaixo da régua (mesmo valor do CSS). */
const LABEL_WIDTH_PX = 128;
const LABEL_LANES = 2;

const TONE_CLASS = { good: styles.toneGood, warn: styles.toneWarn, bad: styles.toneBad } as const;

const MARKETPLACE_IN: Record<MarketplaceId, string> = {
  mercadolivre: "no Mercado Livre",
  amazon: "na Amazon",
  shopee: "na Shopee",
  geral: "em lojas gerais",
};

const STEPS = [
  { title: "Suba o catálogo", text: "CSV, planilha ou PDF com SKU, nome e preço de custo — a Nova busca extrai as linhas." },
  { title: "Escolha onde comparar", text: "Mercado Livre, Amazon ou busca por foto — cada mecanismo com a sua chave." },
  { title: "Leia a margem", text: "Preço encontrado menos taxa, frete e imposto — o catálogo entra nesta régua." },
];

function rulerPos(fraction: number): number {
  const clamped = Math.min(Math.max(fraction, RULER_MIN), RULER_MAX);
  return ((clamped - RULER_MIN) / (RULER_MAX - RULER_MIN)) * 100;
}

/** Frase do "fecha acima da meta" — conta catálogos, não produtos. */
function metaSentence(withMargin: CatalogSummary[], target: number): string {
  if (withMargin.length === 0) return "";
  const above = withMargin.filter((c) => (c.margin ?? -Infinity) >= target);
  const meta = pct(target, 0);
  if (above.length === 0) return `Nenhum fecha acima da meta de ${meta}.`;
  if (above.length === withMargin.length) {
    return withMargin.length === 1 ? `Fecha acima da meta de ${meta}.` : `Todos fecham acima da meta de ${meta}.`;
  }
  if (above.length === 1) return `Só o ${above[0].shortName} fecha acima da meta.`;
  return `${above.length} de ${withMargin.length} fecham acima da meta.`;
}

/** Posição horizontal de um rótulo centrado num ponto, sem vazar pelas bordas da régua. */
function edgeAlign(pos: number): "start" | "center" | "end" {
  if (pos < 8) return "start";
  if (pos > 92) return "end";
  return "center";
}

function useElementWidth<T extends HTMLElement>() {
  const ref = useRef<T>(null);
  const [width, setWidth] = useState(0);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    setWidth(el.getBoundingClientRect().width);
    const observer = new ResizeObserver(([entry]) => setWidth(entry.contentRect.width));
    observer.observe(el);
    return () => observer.disconnect();
  }, []);
  return [ref, width] as const;
}

export default function Home({
  userId,
  profile,
  history,
  onNavigate,
  onOpenRecord,
  onUseSharedCatalog,
  targetMarginPct,
  onOpenPlans,
}: Props) {
  const [libraryCatalogs, setLibraryCatalogs] = useState<SharedCatalog[]>([]);
  const [libraryLoading, setLibraryLoading] = useState(false);
  const [hasSerpKey, setHasSerpKey] = useState<boolean | null>(null);
  const [rulerRef, rulerWidth] = useElementWidth<HTMLDivElement>();

  useEffect(() => {
    if (!profile) {
      setLibraryCatalogs([]);
      return;
    }
    setLibraryLoading(true);
    void listSharedCatalogsForPlan(profile.plan)
      .then(setLibraryCatalogs)
      .finally(() => setLibraryLoading(false));
  }, [profile]);

  useEffect(() => {
    if (!userId) {
      setHasSerpKey(null);
      return;
    }
    void getUserApiKeys(userId).then((keys) => setHasSerpKey(Boolean(keys.serpApiKey)));
  }, [userId]);

  const plan = getPlan(profile?.plan);
  const recent = useMemo(() => history.slice(0, RECENT_LIMIT).map(summarizeCatalog), [history]);
  const withMargin = useMemo(() => recent.filter((c) => c.margin != null), [recent]);
  const allMargins = withMargin.flatMap((c) => c.margins);
  const overallMedian = allMargins.length > 0 ? median(allMargins) : null;
  const totalProducts = recent.reduce((s, c) => s + c.productCount, 0);
  const totalPriced = recent.reduce((s, c) => s + c.pricedCount, 0);
  const marketplacesUsed = [...new Set(recent.flatMap((c) => c.marketplaces))];
  const truncated = history.length > recent.length;

  const zeroPos = rulerPos(0);
  const metaPos = rulerPos(targetMarginPct);
  // Meta colada no zero (ex.: 5%): rótulo "zero" vai pro lado esquerdo da linha pra não encavalar com "meta".
  const zeroLabelLeft = Math.abs(metaPos - zeroPos) < 7;

  // Rótulos dos catálogos em até 2 faixas; o que não couber fica só com o marcador (dado completo na tabela).
  const labelLanes = useMemo(() => {
    const minGapPct = rulerWidth > 0 ? ((LABEL_WIDTH_PX + 8) / rulerWidth) * 100 : 12;
    const lastPos: number[] = [];
    const lanes = new Map<string, number>();
    const sorted = [...withMargin].sort((a, b) => (a.margin ?? 0) - (b.margin ?? 0));
    for (const c of sorted) {
      const pos = rulerPos(c.margin!);
      for (let lane = 0; lane < LABEL_LANES; lane++) {
        if (lastPos[lane] == null || pos - lastPos[lane] >= minGapPct) {
          lanes.set(c.id, lane);
          lastPos[lane] = pos;
          break;
        }
      }
    }
    return lanes;
  }, [withMargin, rulerWidth]);
  const lanesUsed = labelLanes.size === 0 ? 1 : Math.max(...labelLanes.values()) + 1;

  const rulerDescription = [
    `Régua de margem de ${signedPct(RULER_MIN)} a ${signedPct(RULER_MAX)}.`,
    overallMedian != null ? `Mediana geral em ${signedPct(overallMedian)}.` : "",
    `Meta em ${pct(targetMarginPct, 0)}.`,
    ...withMargin.map((c) => `${c.shortName} em ${signedPct(c.margin!)}.`),
  ]
    .filter(Boolean)
    .join(" ");

  const medianPos = overallMedian != null ? rulerPos(overallMedian) : null;
  const libraryProducts = libraryCatalogs.reduce((s, c) => s + c.rows.length, 0);

  return (
    <motion.div
      className={styles.container}
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.3, ease: [0.16, 1, 0.3, 1] }}
    >
      {/* ─────────── a régua de margem ─────────── */}
      <section className={styles.rulerSection}>
        <h1 className={styles.title}>Margem dos catálogos rodados</h1>
        <p className={styles.lead}>
          Cada catálogo entra na régua pela margem mediana dos produtos em que o preço foi encontrado.
        </p>

        {recent.length === 0 ? (
          <div className={styles.emptyRuler}>
            <p className={styles.emptyLead}>
              Nenhum catálogo rodado ainda. Rode o primeiro na Nova busca — ele aparece aqui na régua.
            </p>
            <ol className={styles.steps}>
              {STEPS.map((s, i) => (
                <li key={s.title} className={styles.step}>
                  <span className={styles.stepNumber}>{String(i + 1).padStart(2, "0")}</span>
                  <span className={styles.stepTitle}>{s.title}</span>
                  <span className={styles.stepText}>{s.text}</span>
                </li>
              ))}
            </ol>
          </div>
        ) : (
          <figure className={styles.figure} role="img" aria-label={rulerDescription}>
            <div ref={rulerRef} className={styles.ruler} aria-hidden="true">
              <div className={styles.rulerTop}>
                {medianPos != null && (
                  <>
                    <div
                      className={`${styles.median} ${styles[`align_${edgeAlign(medianPos)}`]}`}
                      style={{ left: `${medianPos}%` }}
                      title={`Mediana da margem de ${allMargins.length} produto(s) dos ${withMargin.length} catálogo(s) acima.`}
                    >
                      <span className={styles.medianLabel}>mediana geral</span>
                      <span className={styles.medianValue}>{signedPct(overallMedian!)}</span>
                    </div>
                    <div className={styles.medianTick} style={{ left: `${medianPos}%` }} />
                  </>
                )}
                <div
                  className={`${styles.refLabel} ${zeroLabelLeft ? styles.refLabelLeft : ""}`}
                  style={{ left: `${zeroPos}%` }}
                >
                  zero
                </div>
                <div className={styles.refLabel} style={{ left: `${metaPos}%` }}>
                  meta {pct(targetMarginPct, 0)}
                </div>
              </div>

              <div className={styles.bar}>
                <div className={styles.zoneBad} style={{ width: `${zeroPos}%` }} />
                <div className={styles.zoneGood} style={{ left: `${zeroPos}%` }} />
                <div className={styles.baseline} />
                <div className={styles.zeroLine} style={{ left: `${zeroPos}%` }} />
                <div className={styles.metaLine} style={{ left: `${metaPos}%` }} />
                {withMargin.map((c) => (
                  <div
                    key={c.id}
                    className={`${styles.marker} ${TONE_CLASS[marginTone(c.margin!, targetMarginPct)]}`}
                    style={{ left: `${rulerPos(c.margin!)}%` }}
                    title={`${c.fileName} · ${shortDate(c.uploadedAt)} · ${signedPct(c.margin!)}`}
                  />
                ))}
              </div>

              <div className={styles.labels} style={{ height: `${lanesUsed * 42}px` }}>
                {withMargin.map((c) => {
                  const lane = labelLanes.get(c.id);
                  if (lane == null) return null;
                  const pos = rulerPos(c.margin!);
                  return (
                    <div
                      key={c.id}
                      className={`${styles.catLabel} ${styles[`align_${edgeAlign(pos)}`]}`}
                      style={{ left: `${pos}%`, top: `${lane * 42}px` }}
                    >
                      <span className={styles.catName}>{c.shortName}</span>
                      <span className={`${styles.catValue} ${TONE_CLASS[marginTone(c.margin!, targetMarginPct)]}`}>
                        {signedPct(c.margin!)}
                      </span>
                    </div>
                  );
                })}
              </div>
            </div>
          </figure>
        )}

        {recent.length > 0 && (
          <p className={styles.summary}>
            {totalProducts.toLocaleString("pt-BR")} produtos{" "}
            {recent.length === 1 ? "no catálogo" : `nos ${recent.length} catálogos`}
            {truncated ? " mais recentes" : ""}, {totalPriced.toLocaleString("pt-BR")} com preço encontrado
            {marketplacesUsed.length > 0 ? ` ${joinPt(marketplacesUsed.map((m) => MARKETPLACE_IN[m]))}` : ""}.{" "}
            {withMargin.length === 0
              ? "Nenhum deles tem preço de custo, então não há margem pra posicionar."
              : metaSentence(withMargin, targetMarginPct)}{" "}
            <a className={styles.mutedLink} href="#faq/como-calcula-margem">
              Como a margem é calculada
            </a>
          </p>
        )}

        <div className={styles.actions}>
          <button type="button" className={styles.primaryButton} onClick={() => onNavigate("dashboard")}>
            <Plus size={13} strokeWidth={2.5} aria-hidden="true" /> Nova busca
          </button>
          {recent.length > 0 && (
            <button type="button" className={styles.secondaryButton} onClick={() => onOpenRecord(recent[0].id)}>
              Ver último resultado
            </button>
          )}
        </div>
      </section>

      {/* ─────────── o livro-razão ─────────── */}
      <section className={styles.ledger}>
        <div className={styles.ledgerMain}>
          <h2 className={styles.sectionLabel}>Catálogos rodados</h2>
          {recent.length === 0 ? (
            <p className={styles.emptyText}>
              Nenhum ainda. O resultado de cada Nova busca fica guardado aqui.
            </p>
          ) : (
            <div className={styles.tableScroll}>
              <table className={styles.table}>
                <caption className={styles.caption}>
                  {recent.length} {recent.length === 1 ? "catálogo" : "catálogos"}
                  {truncated ? ` mais recentes de ${history.length}` : ""}, {totalProducts.toLocaleString("pt-BR")} produtos
                </caption>
                <thead>
                  <tr>
                    <th scope="col">Catálogo</th>
                    <th scope="col" className={styles.num}>Produtos</th>
                    <th scope="col" className={styles.num}>Com preço</th>
                    <th scope="col" className={styles.colMarkets}>Marketplaces</th>
                    <th scope="col" className={styles.num}>Margem</th>
                  </tr>
                </thead>
                <tbody>
                  {recent.map((c) => (
                    <tr key={c.id}>
                      <td>
                        <button
                          type="button"
                          className={styles.catalogLink}
                          onClick={() => onOpenRecord(c.id)}
                          title={`Abrir ${c.fileName} em Resultados`}
                        >
                          {c.fileName}
                        </button>
                        <span className={styles.rowDate}>{shortDate(c.uploadedAt)}</span>
                      </td>
                      <td className={styles.num}>{c.productCount.toLocaleString("pt-BR")}</td>
                      <td className={styles.num}>{c.pricedCount.toLocaleString("pt-BR")}</td>
                      <td className={styles.colMarkets}>{c.marketplaces.map((m) => MARKETPLACE_NAME[m]).join(", ")}</td>
                      <td
                        className={`${styles.num} ${styles.marginCell} ${
                          c.margin != null ? TONE_CLASS[marginTone(c.margin, targetMarginPct)] : ""
                        }`}
                        title={c.margin == null ? "Catálogo sem preço de custo — margem não calculada" : undefined}
                      >
                        {c.margin != null ? signedPct(c.margin) : "—"}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          <p className={styles.footnote}>
            Reabrir um catálogo salvo não consome busca.
            {truncated && (
              <>
                {" "}
                <button type="button" className={styles.inlineLink} onClick={() => onNavigate("dashboard")}>
                  Ver todos ({history.length})
                </button>
              </>
            )}
          </p>
        </div>

        <div className={styles.ledgerSide}>
          <h2 className={styles.sectionLabel}>Prontos para rodar</h2>
          {libraryLoading ? (
            <p className={styles.caption}>Carregando biblioteca…</p>
          ) : libraryCatalogs.length === 0 ? (
            <>
              <p className={styles.caption}>Biblioteca do plano {plan.name}</p>
              <div className={styles.listEmpty}>
                <p className={styles.emptyText}>
                  Nenhum catálogo liberado pro plano {plan.name} ainda. A Nova busca funciona com
                  qualquer catálogo seu.
                </p>
                <div className={styles.inlineActions}>
                  <button type="button" className={styles.inlineLink} onClick={() => onNavigate("dashboard")}>
                    Subir meu catálogo
                  </button>
                  <button type="button" className={styles.inlineLink} onClick={onOpenPlans}>
                    Ver planos
                  </button>
                </div>
              </div>
            </>
          ) : (
            <>
              <p className={styles.caption}>
                {libraryCatalogs.length} {libraryCatalogs.length === 1 ? "catálogo" : "catálogos"},{" "}
                {libraryProducts.toLocaleString("pt-BR")} produtos
              </p>
              <ul className={styles.readyList}>
                {libraryCatalogs.map((c) => (
                  <li key={c.id} className={styles.readyRow}>
                    <span className={styles.readyName} title={c.fileName}>
                      {c.fileName}
                    </span>
                    <span className={styles.readyMeta}>{c.rows.length} produtos</span>
                    <button
                      type="button"
                      className={styles.runButton}
                      onClick={() => onUseSharedCatalog(c)}
                      aria-label={`Rodar ${c.fileName}`}
                    >
                      Rodar
                    </button>
                  </li>
                ))}
              </ul>
            </>
          )}

          {hasSerpKey !== null && (
            <div className={styles.keyBlock}>
              <h2 className={styles.sectionLabel}>Chave SerpApi</h2>
              <p className={styles.keyText}>
                {hasSerpKey
                  ? "Ativa. As buscas consomem a cota da sua própria conta."
                  : "Não configurada. Sem chave própria, a busca de preço fica indisponível."}
              </p>
              <button type="button" className={styles.keyLink} onClick={() => onNavigate("account")}>
                {hasSerpKey ? "Gerenciar chave" : "Configurar chave"}
              </button>
            </div>
          )}
        </div>
      </section>
    </motion.div>
  );
}
