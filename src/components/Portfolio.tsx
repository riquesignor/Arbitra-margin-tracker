import { useEffect, useMemo, useState, type MouseEvent as ReactMouseEvent } from "react";
import { motion } from "framer-motion";
import {
  Boxes,
  Search,
  TrendingUp,
  TrendingDown,
  Minus,
  ExternalLink,
  ChevronLeft,
  ChevronRight,
  ArrowUp,
  ArrowDown,
  ArrowUpDown,
  Clock,
  X,
  BellRing,
  Loader2,
  RefreshCw,
} from "lucide-react";
import type { MarketplaceId, PlanId, Recommendation } from "../types";
import type { CatalogUploadRecord } from "../lib/catalogHistory";
import { buildPortfolio, type PortfolioItem } from "../lib/portfolio";
import { brl, displayProductName, pct } from "../lib/format";
import { checkWatchNow, listWatches, stopWatching, watchId, type WatchItem } from "../lib/watchlist";
import {
  ProductThumb,
  CompetitionBadge,
  BADGE_CLASS,
  BADGE_LABEL,
  MARKETPLACE_LABEL,
} from "./ResultsTable";
import WatchToggle from "./WatchToggle";
import PriceSparkline from "./PriceSparkline";
import ProductSheet from "./ProductSheet";
import { getPlan } from "../config/plans";
import styles from "./Portfolio.module.css";

interface Props {
  history: CatalogUploadRecord[];
  onNavigateToDashboard: () => void;
  userId?: string | null;
  planId?: PlanId | null;
  /** Preferência `autoCheckWatches` (Fase B, plano Pro) — controlada pelo App, salva em userPreferences. */
  autoCheckWatches?: boolean;
  onToggleAutoCheckWatches?: (next: boolean) => void;
  /** Margem-alvo de Precificação — usada no painel lateral do produto. */
  targetMarginPct: number;
}

const PAGE_SIZE = 50;

type Filter = "todos" | Recommendation | "subiu" | "caiu";
type SortKey = "status" | "price" | "trend" | "margin" | "when";
type SortDir = "asc" | "desc";

const FILTERS: { id: Filter; label: string }[] = [
  { id: "todos", label: "Todos" },
  { id: "recomendado", label: "Recomendado" },
  { id: "revisar", label: "Revisar" },
  { id: "evitar", label: "Evitar" },
  { id: "sem_custo", label: "Sem custo" },
  { id: "subiu", label: "Preço subiu" },
  { id: "caiu", label: "Preço caiu" },
];

// Ordem padrão da tabela: o que dá pra agir primeiro aparece primeiro.
const STATUS_RANK: Record<Recommendation, number> = { recomendado: 0, revisar: 1, evitar: 2, sem_custo: 3 };

function matchesFilter(item: PortfolioItem, filter: Filter): boolean {
  if (filter === "todos") return true;
  if (filter === "subiu") return item.trend === "up";
  if (filter === "caiu") return item.trend === "down";
  return item.recommendation === filter;
}

function priceDiff(item: PortfolioItem): number {
  return item.previousMarketplacePrice == null ? 0 : item.marketplacePrice - item.previousMarketplacePrice;
}

function compareItems(a: PortfolioItem, b: PortfolioItem, key: SortKey): number {
  switch (key) {
    case "status":
      return STATUS_RANK[a.recommendation] - STATUS_RANK[b.recommendation] || (b.marginPct ?? -Infinity) - (a.marginPct ?? -Infinity);
    case "price":
      return a.marketplacePrice - b.marketplacePrice;
    case "trend":
      return priceDiff(a) - priceDiff(b);
    case "margin":
      return (a.marginPct ?? -Infinity) - (b.marginPct ?? -Infinity);
    case "when":
      return a.lastSearchedAt - b.lastSearchedAt;
  }
}

function SortHeader({
  label,
  sortKey,
  active,
  dir,
  onSort,
}: {
  label: string;
  sortKey: SortKey;
  active: boolean;
  dir: SortDir;
  onSort: (key: SortKey) => void;
}) {
  const Icon = !active ? ArrowUpDown : dir === "asc" ? ArrowUp : ArrowDown;
  return (
    <th aria-sort={active ? (dir === "asc" ? "ascending" : "descending") : "none"}>
      <button type="button" className={styles.sortButton} onClick={() => onSort(sortKey)}>
        {label}
        <Icon size={11} className={active ? undefined : styles.sortIconIdle} />
      </button>
    </th>
  );
}

function formatWhen(ts: number): string {
  const diffMs = Date.now() - ts;
  const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24));
  if (diffDays <= 0) return "hoje";
  if (diffDays === 1) return "ontem";
  if (diffDays < 30) return `há ${diffDays}d`;
  const diffMonths = Math.floor(diffDays / 30);
  return `há ${diffMonths}${diffMonths === 1 ? " mês" : " meses"}`;
}

function TrendTag({ item }: { item: PortfolioItem }) {
  if (item.trend === null) {
    return (
      <span className={styles.trendNone} title="Só encontrado numa busca até agora — sem base pra comparar">
        1ª busca
      </span>
    );
  }
  const diff = item.marketplacePrice - (item.previousMarketplacePrice ?? item.marketplacePrice);
  if (item.trend === "stable") {
    return (
      <span className={styles.trendStable}>
        <Minus size={11} /> estável
      </span>
    );
  }
  const Icon = item.trend === "up" ? TrendingUp : TrendingDown;
  const cls = item.trend === "up" ? styles.trendUp : styles.trendDown;
  return (
    <span className={cls} title={`Era ${brl(item.previousMarketplacePrice ?? item.marketplacePrice)} na busca anterior`}>
      <Icon size={11} />
      {diff > 0 ? "+" : ""}
      {brl(diff)}
    </span>
  );
}

/**
 * Aba "Monitorados" (Fase A — out/2026, ver src/lib/watchlist.ts): lista os
 * watches ativos com o botão "checar agora" (api/check-watch.ts) e, no
 * plano Pro, o liga/desliga da checagem diária automática (cron).
 */
function WatchPanel({
  userId,
  watches,
  onRefresh,
  autoCheckAvailable,
  autoCheckOn,
  onToggleAutoCheck,
}: {
  userId: string | null;
  watches: WatchItem[];
  onRefresh: () => void;
  autoCheckAvailable: boolean;
  autoCheckOn: boolean;
  onToggleAutoCheck?: (next: boolean) => void;
}) {
  const [checkingId, setCheckingId] = useState<string | null>(null);
  const [errorById, setErrorById] = useState<Record<string, string>>({});

  async function handleCheck(w: WatchItem) {
    setCheckingId(w.id);
    setErrorById((prev) => {
      const next = { ...prev };
      delete next[w.id];
      return next;
    });
    try {
      await checkWatchNow(w.sku, w.marketplace);
      onRefresh();
    } catch (err) {
      setErrorById((prev) => ({ ...prev, [w.id]: err instanceof Error ? err.message : String(err) }));
    } finally {
      setCheckingId(null);
    }
  }

  async function handleStop(w: WatchItem) {
    if (!userId) return;
    await stopWatching(userId, w.sku, w.marketplace);
    onRefresh();
  }

  return (
    <div className={styles.watchPanel}>
      <div className={styles.watchHead}>
        <span className={styles.watchHeadText}>
          <span className={styles.watchHeadTitle}>Checagem automática diária</span>
          <span className={styles.muted}>
            {autoCheckAvailable
              ? "Confere o preço de todos os monitorados uma vez por dia, sozinho, com a sua chave de busca (1 busca por produto por dia)."
              : "Disponível no plano Pro. Sem ela, use “Checar agora” em cada produto."}
          </span>
        </span>
        {autoCheckAvailable && onToggleAutoCheck && (
          <button
            type="button"
            role="switch"
            aria-checked={autoCheckOn}
            aria-label="Checar automaticamente todo dia"
            className={autoCheckOn ? styles.switchOn : styles.switch}
            onClick={() => onToggleAutoCheck(!autoCheckOn)}
          >
            <span className={styles.switchThumb} />
          </button>
        )}
      </div>

      {watches.length === 0 ? (
        <div className={styles.empty}>
          <BellRing size={20} aria-hidden="true" className={styles.emptyIcon} />
          <p className={styles.emptyTitle}>Nenhum produto monitorado</p>
          <p className={styles.muted}>
            Clique no sininho de um produto (aqui na aba Produtos ou em Resultados) pra ser avisado quando o
            preço mudar ou o produto esgotar.
          </p>
        </div>
      ) : (
        <ul className={styles.watchList}>
          {watches.map((w) => (
            <li key={w.id} className={styles.watchRow}>
              <div className={styles.watchRowMain}>
                <span className={styles.watchRowName} title={w.name}>
                  {displayProductName(w.name)}
                </span>
                <span className={styles.watchRowMeta}>
                  {MARKETPLACE_LABEL[w.marketplace]} · {w.sku}
                </span>
                {errorById[w.id] && (
                  <span className={styles.watchRowError} role="alert">
                    {errorById[w.id]}
                  </span>
                )}
              </div>
              <span className={styles.watchRowPrice}>
                {brl(w.lastPrice)}
                <span className={styles.watchRowSub}>
                  {w.lastStatus === "esgotado" ? "esgotado" : w.lastMarginPct != null ? `${pct(w.lastMarginPct)} aprox.` : "—"}
                </span>
              </span>
              <span className={styles.watchRowWhen} title={new Date(w.lastCheckedAt).toLocaleString("pt-BR")}>
                checado {formatWhen(w.lastCheckedAt)}
              </span>
              <span className={styles.watchRowActions}>
                <button
                  type="button"
                  className={styles.toolButton}
                  onClick={() => void handleCheck(w)}
                  disabled={checkingId === w.id}
                >
                  {checkingId === w.id ? <Loader2 size={13} className="spin" aria-hidden="true" /> : <RefreshCw size={13} aria-hidden="true" />}
                  {checkingId === w.id ? "Checando…" : "Checar agora"}
                </button>
                <button type="button" className={styles.textButton} onClick={() => void handleStop(w)}>
                  Parar
                </button>
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

export default function Portfolio({
  history,
  onNavigateToDashboard,
  userId = null,
  planId = null,
  autoCheckWatches = false,
  onToggleAutoCheckWatches,
  targetMarginPct,
}: Props) {
  const [search, setSearch] = useState("");
  const [filter, setFilter] = useState<Filter>("todos");
  const [tab, setTab] = useState<"produtos" | "monitorados">("produtos");
  const [watches, setWatches] = useState<WatchItem[]>([]);
  const reloadWatches = () => listWatches(userId).then(setWatches);
  useEffect(() => {
    void reloadWatches();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [userId]);
  const watchedKeys = useMemo(() => new Set(watches.map((w) => w.id)), [watches]);
  // WatchToggle só manda sku/marketplace/watching — mais simples recarregar
  // a lista inteira (teto de maxWatches, no máximo 200 docs) do que tentar
  // reconstruir o WatchItem completo (com lastPrice/lastStatus/etc) aqui.
  function handleWatchChange(_sku: string, _marketplace: MarketplaceId, _watching: boolean) {
    void reloadWatches();
  }
  const [sortKey, setSortKey] = useState<SortKey>("status");
  const [sortDir, setSortDir] = useState<SortDir>("asc");
  const [page, setPage] = useState(0);

  const portfolio = useMemo(() => buildPortfolio(history), [history]);

  // Painel lateral de produto (ver ProductSheet.tsx). A linha da carteira é
  // um resumo — as ofertas completas (com a conta da margem) vêm da busca
  // salva mais recente que contém o SKU.
  const [sheetSku, setSheetSku] = useState<string | null>(null);
  function openFromRow(e: ReactMouseEvent<HTMLTableRowElement>, sku: string) {
    if ((e.target as Element).closest("a, button, input, select, label, textarea")) return;
    setSheetSku(sku);
  }
  const sheetItem = sheetSku ? portfolio.find((p) => p.sku === sheetSku) : undefined;
  const sheetOffers = useMemo(() => {
    if (!sheetSku) return [];
    const latest = [...history]
      .sort((a, b) => b.uploadedAt - a.uploadedAt)
      .find((h) => h.results.some((r) => r.sku === sheetSku));
    return latest ? latest.results.filter((r) => r.sku === sheetSku) : [];
  }, [history, sheetSku]);

  // Aviso "faz tempo que você não busca" (out/2026) — empurrão pontual pra
  // reprocessar. Olha a busca MAIS recente de todo o portfólio — se até ela
  // já é velha, o portfólio inteiro está desatualizado. Dispensa só nesta
  // sessão/tela, reaparece normalmente na próxima visita.
  const STALE_DAYS = 7;
  const [staleDismissed, setStaleDismissed] = useState(false);
  const daysSinceLastSearch = useMemo(() => {
    if (portfolio.length === 0) return null;
    const mostRecent = Math.max(...portfolio.map((i) => i.lastSearchedAt));
    return Math.floor((Date.now() - mostRecent) / (24 * 60 * 60 * 1000));
  }, [portfolio]);
  const showStaleNotice = !staleDismissed && daysSinceLastSearch != null && daysSinceLastSearch >= STALE_DAYS;

  const filterCounts = useMemo(() => {
    const counts = {} as Record<Filter, number>;
    for (const f of FILTERS) counts[f.id] = portfolio.filter((item) => matchesFilter(item, f.id)).length;
    return counts;
  }, [portfolio]);

  const filtered = useMemo(() => {
    const term = search.trim().toLowerCase();
    const rows = portfolio.filter(
      (item) =>
        matchesFilter(item, filter) &&
        (!term || item.sku.toLowerCase().includes(term) || item.name.toLowerCase().includes(term))
    );
    const sign = sortDir === "asc" ? 1 : -1;
    return rows.sort((a, b) => sign * compareItems(a, b, sortKey));
  }, [portfolio, search, filter, sortKey, sortDir]);

  function applyFilter(next: Filter) {
    setFilter((current) => (current === next && next !== "todos" ? "todos" : next));
    setTab("produtos");
    setPage(0);
  }

  function clearFilters() {
    setSearch("");
    setFilter("todos");
    setPage(0);
  }

  function handleSort(key: SortKey) {
    if (key === sortKey) {
      setSortDir((d) => (d === "asc" ? "desc" : "asc"));
    } else {
      setSortKey(key);
      setSortDir(key === "status" ? "asc" : "desc");
    }
    setPage(0);
  }

  const summary = useMemo(() => {
    const up = portfolio.filter((i) => i.trend === "up").length;
    const down = portfolio.filter((i) => i.trend === "down").length;
    const recomendados = portfolio.filter((i) => i.recommendation === "recomendado").length;
    const compared = portfolio.filter((i) => i.trend !== null).length;
    return { total: portfolio.length, up, down, recomendados, compared };
  }, [portfolio]);

  const pageCount = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  const currentPage = Math.min(page, pageCount - 1);
  const pageStart = currentPage * PAGE_SIZE;
  const paginated = filtered.slice(pageStart, pageStart + PAGE_SIZE);
  const isFiltered = filter !== "todos" || search.trim() !== "";
  // Status sem produto nenhum não vira botão — só polui a barra (a não ser que seja o filtro ativo).
  const visibleFilters = FILTERS.filter((f) => f.id === "todos" || f.id === filter || filterCounts[f.id] > 0);

  return (
    <div className={styles.container}>
      <header className={styles.header}>
        <h1 className={styles.title}>Meus produtos</h1>
        <p className={styles.lead}>
          Todo produto que você já buscou, num lugar só. A tendência compara a última busca com a anterior
          do mesmo produto.
        </p>
      </header>

      {showStaleNotice && (
        <div className={styles.staleNotice} role="status">
          <Clock size={16} aria-hidden="true" className={styles.staleIcon} />
          <span className={styles.staleText}>
            <b>Já faz {daysSinceLastSearch} dias desde sua última busca.</b> Os preços podem ter mudado — rode o
            catálogo de novo pra atualizar a tendência.
          </span>
          <button type="button" className={styles.staleAction} onClick={onNavigateToDashboard}>
            Nova busca
          </button>
          <button
            type="button"
            className={styles.staleNoticeClose}
            onClick={() => setStaleDismissed(true)}
            aria-label="Fechar aviso"
          >
            <X size={14} aria-hidden="true" />
          </button>
        </div>
      )}

      {portfolio.length === 0 ? (
        <div className={styles.empty}>
          <Boxes size={22} className={styles.emptyIcon} aria-hidden="true" />
          <p className={styles.emptyTitle}>Nenhum produto acompanhado ainda</p>
          <p className={styles.muted}>
            Processe um catálogo em Nova busca. A partir da segunda vez que um produto aparecer numa busca, ele
            ganha tendência de preço aqui.
          </p>
          <button type="button" className={styles.primaryButton} onClick={onNavigateToDashboard}>
            Ir pra Nova busca
          </button>
        </div>
      ) : (
        <>
          <div className={styles.kpis}>
            {(
              [
                {
                  id: "todos",
                  value: summary.total,
                  label: "Produtos acompanhados",
                  hint: `${summary.compared} com tendência`,
                  tone: "",
                },
                { id: "subiu", value: summary.up, label: "Preço subiu", hint: "mais espaço pra margem", tone: styles.toneGood },
                { id: "caiu", value: summary.down, label: "Preço caiu", hint: "concorrência apertando", tone: styles.toneBad },
                {
                  id: "recomendado",
                  value: summary.recomendados,
                  label: "Recomendados agora",
                  hint: `${summary.total ? Math.round((summary.recomendados / summary.total) * 100) : 0}% do portfólio`,
                  tone: styles.toneGood,
                },
              ] as const
            ).map((card) => (
              <button
                key={card.id}
                type="button"
                className={filter === card.id && card.id !== "todos" ? styles.kpiActive : styles.kpi}
                onClick={() => applyFilter(card.id)}
                aria-pressed={card.id !== "todos" ? filter === card.id : undefined}
                title={card.id === "todos" ? "Mostrar todos" : `Filtrar a tabela: ${card.label.toLowerCase()}`}
              >
                <span className={styles.kpiLabel}>{card.label}</span>
                <span className={`${styles.kpiValue} ${card.value > 0 ? card.tone : ""}`}>{card.value}</span>
                <span className={styles.kpiHint}>{card.hint}</span>
              </button>
            ))}
          </div>

          <div className={styles.tabs} role="tablist" aria-label="Visão de Meus produtos">
            <button
              type="button"
              role="tab"
              aria-selected={tab === "produtos"}
              className={tab === "produtos" ? styles.tabActive : styles.tab}
              onClick={() => setTab("produtos")}
            >
              Produtos <span className={styles.tabCount}>{portfolio.length}</span>
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={tab === "monitorados"}
              className={tab === "monitorados" ? styles.tabActive : styles.tab}
              onClick={() => setTab("monitorados")}
            >
              <BellRing size={14} aria-hidden="true" /> Monitorados <span className={styles.tabCount}>{watches.length}</span>
            </button>
          </div>

          {tab === "monitorados" ? (
            <WatchPanel
              userId={userId}
              watches={watches}
              onRefresh={() => void reloadWatches()}
              autoCheckAvailable={getPlan(planId).features.autoWatchCheck}
              autoCheckOn={autoCheckWatches}
              onToggleAutoCheck={onToggleAutoCheckWatches}
            />
          ) : (
            <div className={styles.panel}>
              <div className={styles.controls}>
                <span className={styles.searchWrap}>
                  <Search size={14} aria-hidden="true" />
                  <input
                    className={styles.searchInput}
                    placeholder="Buscar por SKU ou produto"
                    aria-label="Buscar por SKU ou produto"
                    value={search}
                    onChange={(e) => {
                      setSearch(e.target.value);
                      setPage(0);
                    }}
                  />
                  {search && (
                    <button type="button" className={styles.searchClear} onClick={() => setSearch("")} aria-label="Limpar busca">
                      <X size={13} aria-hidden="true" />
                    </button>
                  )}
                </span>
                <div className={styles.segmented} role="group" aria-label="Filtrar produtos">
                  {visibleFilters.map((f) => (
                    <button
                      key={f.id}
                      type="button"
                      aria-pressed={filter === f.id}
                      className={filter === f.id ? styles.segmentActive : styles.segment}
                      onClick={() => applyFilter(f.id)}
                    >
                      {f.label}
                      <span className={styles.segmentCount}>{filterCounts[f.id]}</span>
                    </button>
                  ))}
                </div>
              </div>

              {filtered.length === 0 ? (
                <div className={styles.empty}>
                  <p className={styles.emptyTitle}>Nenhum produto com esse filtro</p>
                  <button type="button" className={styles.toolButton} onClick={clearFilters}>
                    Limpar busca e filtro
                  </button>
                </div>
              ) : (
                <div className={styles.tableWrap}>
                  <table className={styles.table}>
                    <thead>
                      <tr>
                        <th className={styles.photoHeader} />
                        <th>SKU</th>
                        <th className={styles.productHeader}>Produto</th>
                        <th>Marketplace</th>
                        <SortHeader label="Preço atual" sortKey="price" active={sortKey === "price"} dir={sortDir} onSort={handleSort} />
                        <SortHeader label="Tendência" sortKey="trend" active={sortKey === "trend"} dir={sortDir} onSort={handleSort} />
                        <SortHeader label="Margem" sortKey="margin" active={sortKey === "margin"} dir={sortDir} onSort={handleSort} />
                        <SortHeader label="Status" sortKey="status" active={sortKey === "status"} dir={sortDir} onSort={handleSort} />
                        <SortHeader label="Última busca" sortKey="when" active={sortKey === "when"} dir={sortDir} onSort={handleSort} />
                      </tr>
                    </thead>
                    <tbody>
                      {paginated.map((item, i) => (
                        <motion.tr
                          key={item.sku}
                          className={item.sku === sheetSku ? `${styles.rowClickable} ${styles.rowActive}` : styles.rowClickable}
                          onClick={(e) => openFromRow(e, item.sku)}
                          initial={{ opacity: 0, y: 6 }}
                          animate={{ opacity: 1, y: 0 }}
                          transition={{ duration: 0.2, delay: Math.min(i, 12) * 0.02 }}
                        >
                          <td className={styles.photoCell}>
                            <ProductThumb src={item.imageUrl} />
                          </td>
                          <td className={styles.skuCell}>{item.sku}</td>
                          <td className={styles.productCell}>
                            <div className={styles.productName} title={item.name}>
                              <button
                                type="button"
                                className={styles.productNameButton}
                                onClick={() => setSheetSku(item.sku)}
                              >
                                {displayProductName(item.name)}
                              </button>
                            </div>
                            {item.link && (
                              <a
                                className={styles.productLink}
                                href={item.link}
                                target="_blank"
                                rel="noopener noreferrer"
                              >
                                <ExternalLink size={11} /> Ver anúncio
                              </a>
                            )}
                          </td>
                          <td className={styles.marketCell}>{MARKETPLACE_LABEL[item.marketplace]}</td>
                          <td className={styles.num}>{brl(item.marketplacePrice)}</td>
                          <td>
                            <span className={styles.trendCell}>
                              <TrendTag item={item} />
                              <PriceSparkline points={item.priceHistory} />
                            </span>
                          </td>
                          <td className={styles.num}>{item.marginPct != null ? pct(item.marginPct) : "—"}</td>
                          <td className={styles.statusCell}>
                            <span className={`${styles.badge} ${BADGE_CLASS[item.recommendation]}`}>
                              {BADGE_LABEL[item.recommendation]}
                            </span>
                            <CompetitionBadge
                              competitorCount={item.competitorCount}
                              buyBoxEligible={item.buyBoxEligible}
                            />
                            <WatchToggle
                              userId={userId}
                              planId={planId}
                              provider={item.provider}
                              item={item}
                              watching={watchedKeys.has(watchId(item.sku, item.marketplace))}
                              onChange={handleWatchChange}
                            />
                          </td>
                          <td className={styles.whenCell} title={new Date(item.lastSearchedAt).toLocaleString("pt-BR")}>
                            {formatWhen(item.lastSearchedAt)}
                          </td>
                        </motion.tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}

              {filtered.length > 0 && (
                <div className={styles.pagination}>
                  <span className={styles.countHint}>
                    {pageStart + 1}–{Math.min(pageStart + PAGE_SIZE, filtered.length)} de {filtered.length}
                    {filtered.length !== portfolio.length && ` · filtrado de ${portfolio.length}`}
                    {isFiltered && (
                      <button type="button" className={styles.inlineClear} onClick={clearFilters}>
                        limpar filtro
                      </button>
                    )}
                  </span>
                  {pageCount > 1 && (
                    <span className={styles.pager}>
                      <button
                        type="button"
                        className={styles.pageButton}
                        disabled={currentPage === 0}
                        onClick={() => setPage((p) => Math.max(0, p - 1))}
                      >
                        <ChevronLeft size={14} /> Anterior
                      </button>
                      <span className={styles.pageInfo}>
                        Página {currentPage + 1} de {pageCount}
                      </span>
                      <button
                        type="button"
                        className={styles.pageButton}
                        disabled={currentPage >= pageCount - 1}
                        onClick={() => setPage((p) => Math.min(pageCount - 1, p + 1))}
                      >
                        Próxima <ChevronRight size={14} />
                      </button>
                    </span>
                  )}
                </div>
              )}
            </div>
          )}
        </>
      )}
      {sheetSku && sheetOffers.length > 0 && (
        <ProductSheet
          offers={sheetOffers}
          targetMarginPct={targetMarginPct}
          priceHistory={sheetItem?.priceHistory}
          watch={{ userId, planId, provider: sheetItem?.provider, watchedKeys, onChange: handleWatchChange }}
          onClose={() => setSheetSku(null)}
        />
      )}
    </div>
  );
}
