import { useEffect, useState } from "react";
import { motion } from "framer-motion";
import {
  Plus,
  ArrowRight,
  Upload,
  Search,
  Percent,
  Library,
  FileText,
  KeyRound,
  Check,
} from "lucide-react";
import type { Screen } from "../types";
import type { CatalogUploadRecord } from "../lib/catalogHistory";
import { listSharedCatalogsForPlan, type SharedCatalog } from "../lib/sharedCatalogs";
import { getUserSerpApiKey } from "../lib/userSecrets";
import { median } from "../lib/marginCalculator";
import { marginTone, pct } from "../lib/format";
import { getPlan } from "../config/plans";
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
  /** "usar" num catálogo da biblioteca — manda o catálogo inteiro pro App, que passa pra Dashboard já processar (ver handleUseSharedCatalog em App.tsx). */
  onUseSharedCatalog: (catalog: SharedCatalog) => void;
  /** Margem-alvo das regras de Precificação — régua das cores de margem desta tela. */
  targetMarginPct: number;
  /** Abre Configurações direto na seção de planos/pagamento. */
  onOpenPlans: () => void;
}

const STEPS = [
  {
    n: "01",
    icon: Upload,
    title: "Suba o catálogo",
    text: "CSV ou PDF com SKU, nome e preço de custo — a Nova busca extrai as linhas automaticamente.",
  },
  {
    n: "02",
    icon: Search,
    title: "Escolha onde comparar",
    text: "Amazon, Mercado Livre ou busca por foto (Google Lens) — cada um com sua própria API.",
  },
  {
    n: "03",
    icon: Percent,
    title: "Leia a margem",
    text: "Preço encontrado menos taxa, frete e imposto — recomendação pronta por produto.",
  },
];

const TONE_CLASS = { good: styles.toneGood, warn: styles.toneWarn, bad: styles.toneBad } as const;

function greeting(): string {
  const h = new Date().getHours();
  if (h < 12) return "Bom dia";
  if (h < 18) return "Boa tarde";
  return "Boa noite";
}

function accountFirstName(email?: string | null): string {
  if (!email) return "";
  const local = email.split("@")[0] ?? email;
  return local.charAt(0).toUpperCase() + local.slice(1);
}

function isThisMonth(ts: number): boolean {
  const d = new Date(ts);
  const now = new Date();
  return d.getFullYear() === now.getFullYear() && d.getMonth() === now.getMonth();
}

export default function Home({
  userId,
  userEmail,
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

  useEffect(() => {
    if (!profile) {
      setLibraryCatalogs([]);
      return;
    }
    setLibraryLoading(true);
    listSharedCatalogsForPlan(profile.plan)
      .then(setLibraryCatalogs)
      .finally(() => setLibraryLoading(false));
  }, [profile]);

  useEffect(() => {
    if (!userId) {
      setHasSerpKey(null);
      return;
    }
    getUserSerpApiKey(userId).then((key) => setHasSerpKey(Boolean(key)));
  }, [userId]);

  const dateLabel = new Intl.DateTimeFormat("pt-BR", {
    weekday: "long",
    day: "numeric",
    month: "long",
  }).format(new Date());

  const totalProdutos = history.reduce((sum, h) => sum + h.results.length, 0);

  const thisMonthMargins = history
    .filter((h) => isThisMonth(h.uploadedAt))
    .flatMap((h) => h.results.map((r) => r.marginPct))
    .filter((v): v is number => v != null);
  const allMargins = history
    .flatMap((h) => h.results.map((r) => r.marginPct))
    .filter((v): v is number => v != null);
  const usingThisMonth = thisMonthMargins.length > 0;
  const medianMargin = median(usingThisMonth ? thisMonthMargins : allMargins);
  const medianCount = usingThisMonth ? thisMonthMargins.length : allMargins.length;

  const recent = history.slice(0, 5);
  const plan = getPlan(profile?.plan);

  return (
    <motion.div
      className={styles.container}
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.3, ease: [0.16, 1, 0.3, 1] }}
    >
      <section className={styles.heroCard}>
        <div className={styles.heroMain}>
          <span className={styles.eyebrow}>{dateLabel}</span>
          <h1 className={styles.heroTitle}>
            {greeting()}
            {userEmail ? `, ${accountFirstName(userEmail)}` : ""}.
          </h1>
          <p className={styles.heroSubtitle}>
            Suba um catálogo, escolha onde comparar preço e veja a margem calculada por produto —
            tudo isso acontece na Nova busca. Aqui na Home fica o resumo do que você já rodou.
          </p>
          <div className={styles.heroActions}>
            <button type="button" className={styles.primaryButton} onClick={() => onNavigate("dashboard")}>
              <Plus size={15} strokeWidth={2.5} /> Nova busca
            </button>
            {recent.length > 0 && (
              <button
                type="button"
                className={styles.secondaryButton}
                onClick={() => onOpenRecord(recent[0].id)}
              >
                Ver último resultado <ArrowRight size={14} />
              </button>
            )}
          </div>
        </div>

        <div className={styles.heroStats}>
          <div className={styles.statRow}>
            <span className={styles.statValue}>{history.length}</span>
            <span className={styles.statLabel}>catálogos processados</span>
          </div>
          <div className={styles.statRow}>
            <span className={styles.statValue}>{totalProdutos.toLocaleString("pt-BR")}</span>
            <span className={styles.statLabel}>produtos precificados</span>
          </div>
          <div
            className={styles.statRow}
            title={
              allMargins.length > 0
                ? `Mediana da margem sobre o custo de ${medianCount} produto(s) ${usingThisMonth ? "buscados este mês" : "de todas as buscas"}, com as regras de Precificação de cada busca. Meta atual: ${pct(targetMarginPct, 0)}. Valor muito negativo costuma vir de produto com match errado ou preço de mercado suspeito — confira em Resultados.`
                : undefined
            }
          >
            <span
              className={`${styles.statValue} ${
                allMargins.length > 0 ? TONE_CLASS[marginTone(medianMargin, targetMarginPct)] : ""
              }`}
            >
              {allMargins.length > 0 ? pct(medianMargin) : "—"}
            </span>
            <span className={styles.statLabel}>
              margem mediana {usingThisMonth ? "do mês" : "geral"} · meta {pct(targetMarginPct, 0)}
            </span>
            {allMargins.length > 0 && medianMargin < 0 && recent.length > 0 && (
              <button type="button" className={styles.statLink} onClick={() => onOpenRecord(recent[0].id)}>
                entender esse número →
              </button>
            )}
          </div>
        </div>
      </section>

      {history.length === 0 && (
        <section className={styles.stepsCard}>
          <h2 className={styles.stepsTitle}>Como funciona</h2>
          <div className={styles.stepsRow}>
            {STEPS.map((s) => (
              <div key={s.n} className={styles.stepCol}>
                <span className={styles.stepIcon}>
                  <s.icon size={16} strokeWidth={2} />
                </span>
                <span className={styles.stepNumber}>{s.n}</span>
                <span className={styles.stepTitle}>{s.title}</span>
                <span className={styles.stepText}>{s.text}</span>
              </div>
            ))}
          </div>
        </section>
      )}

      <div className={styles.twoCol}>
        <section className={styles.panel}>
          <div className={styles.panelHeader}>
            <h2 className={styles.panelTitle}>Suas buscas</h2>
            {history.length > recent.length && (
              <button type="button" className={styles.panelHeaderLink} onClick={() => onNavigate("dashboard")}>
                ver todas ({history.length})
              </button>
            )}
          </div>

          {recent.length === 0 ? (
            <p className={styles.emptyText}>
              Nenhum catálogo processado ainda. Comece pela <strong>Nova busca</strong> — o resultado
              volta pra cá automaticamente.
            </p>
          ) : (
            <div className={styles.recentTable}>
              {recent.map((r) => {
                const recordMargins = r.results
                  .map((m) => m.marginPct)
                  .filter((v): v is number => v != null);
                const recordMargin = median(recordMargins);
                return (
                  <button
                    key={r.id}
                    type="button"
                    className={styles.recentRow}
                    onClick={() => onOpenRecord(r.id)}
                  >
                    <span className={styles.recentName}>
                      <FileText size={13} /> {r.fileName}
                    </span>
                    <span className={styles.recentMeta}>{r.marketplaces.join(", ")}</span>
                    <span className={styles.recentMeta}>{r.results.length}/{r.rows.length} com preço</span>
                    <span
                      className={`${styles.recentMargin} ${
                        recordMargins.length > 0 ? TONE_CLASS[marginTone(recordMargin, targetMarginPct)] : ""
                      }`}
                      title="Margem mediana dos produtos com custo nesta busca"
                    >
                      {recordMargins.length > 0 ? pct(recordMargin) : "—"}
                    </span>
                  </button>
                );
              })}
            </div>
          )}

          <p className={styles.panelFooterNote}>
            Resultado guardado não gasta busca nova — reabrir um catálogo é de graça.
          </p>
        </section>

        <aside className={styles.asideCol}>
          {hasSerpKey !== null && (
            <section className={hasSerpKey ? styles.keyCardOk : styles.keyCardWarning}>
              <span className={styles.keyCardIcon}>
                {hasSerpKey ? <Check size={13} strokeWidth={3} /> : <KeyRound size={13} />}
              </span>
              <span className={styles.keyCardText}>
                {hasSerpKey ? "Sua chave SerpApi está ativa" : "Configure sua chave SerpApi"}
                <span className={styles.keyCardSub}>
                  {hasSerpKey
                    ? "As buscas rodam na cota da sua própria conta."
                    : "Sem chave própria, a busca de preço fica indisponível."}
                </span>
              </span>
              <button type="button" className={styles.keyCardLink} onClick={() => onNavigate("account")}>
                Gerenciar chave
              </button>
            </section>
          )}
          <section className={styles.panel}>
            <div className={styles.panelHeader}>
              <h2 className={styles.panelTitle}>
                <Library size={14} /> Catálogos disponíveis
              </h2>
              <span className={styles.planBadge}>plano {plan.name}</span>
            </div>

            {libraryLoading ? (
              <p className={styles.emptyText}>Carregando biblioteca…</p>
            ) : libraryCatalogs.length === 0 ? (
              <div className={styles.libraryEmpty}>
                <p className={styles.emptyText}>
                  Nenhum catálogo liberado pro plano {plan.name} ainda. Enquanto isso, a Nova busca
                  funciona com qualquer catálogo seu.
                </p>
                <div className={styles.libraryEmptyActions}>
                  <button type="button" className={styles.keyCardLink} onClick={() => onNavigate("dashboard")}>
                    Subir meu catálogo
                  </button>
                  <button type="button" className={styles.panelHeaderLink} onClick={onOpenPlans}>
                    Ver planos
                  </button>
                </div>
              </div>
            ) : (
              <div className={styles.libraryList}>
                {libraryCatalogs.map((c) => (
                  <div key={c.id} className={styles.libraryRow}>
                    <span className={styles.libraryName}>
                      <FileText size={13} /> {c.fileName}
                    </span>
                    <span className={styles.libraryMeta}>{c.rows.length} produtos</span>
                    <button
                      type="button"
                      className={styles.libraryUseButton}
                      onClick={() => onUseSharedCatalog(c)}
                    >
                      usar
                    </button>
                  </div>
                ))}
              </div>
            )}
          </section>

        </aside>
      </div>
    </motion.div>
  );
}
