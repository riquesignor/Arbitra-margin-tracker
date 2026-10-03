import { useMemo, useState } from "react";
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
} from "lucide-react";
import type { Recommendation } from "../types";
import type { CatalogUploadRecord } from "../lib/catalogHistory";
import { buildPortfolio, type PortfolioItem } from "../lib/portfolio";
import { brl, displayProductName, pct } from "../lib/format";
import {
  ProductThumb,
  CompetitionBadge,
  BADGE_CLASS,
  BADGE_LABEL,
  MARKETPLACE_LABEL,
} from "./ResultsTable";
import styles from "./Portfolio.module.css";

interface Props {
  history: CatalogUploadRecord[];
  onNavigateToDashboard: () => void;
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

export default function Portfolio({ history, onNavigateToDashboard }: Props) {
  const [search, setSearch] = useState("");
  const [filter, setFilter] = useState<Filter>("todos");
  const [sortKey, setSortKey] = useState<SortKey>("status");
  const [sortDir, setSortDir] = useState<SortDir>("asc");
  const [page, setPage] = useState(0);

  const portfolio = useMemo(() => buildPortfolio(history), [history]);

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
    return { total: portfolio.length, up, down, recomendados };
  }, [portfolio]);

  const pageCount = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  const currentPage = Math.min(page, pageCount - 1);
  const pageStart = currentPage * PAGE_SIZE;
  const paginated = filtered.slice(pageStart, pageStart + PAGE_SIZE);

  return (
    <div className={styles.container}>
      <div className={styles.header}>
        <div className={styles.headerMain}>
          <span className={styles.eyebrow}>Portfólio</span>
          <h1 className={styles.title}>Meus produtos</h1>
          <p className={styles.subtitle}>
            Todo SKU que você já buscou, agregado por produto — não por busca isolada. A tendência
            compara a última busca com a anterior do mesmo produto.
          </p>
        </div>
      </div>

      {portfolio.length === 0 ? (
        <div className={styles.empty}>
          <Boxes size={22} className={styles.emptyIcon} />
          <p>
            Nenhum produto acompanhado ainda — processe um catálogo em Nova busca. A partir da
            segunda vez que um SKU aparecer numa busca, ele ganha tendência de preço aqui.
          </p>
          <button type="button" className={styles.emptyButton} onClick={onNavigateToDashboard}>
            Ir pra Nova busca
          </button>
        </div>
      ) : (
        <>
          <div className={styles.summaryRow}>
            {(
              [
                { id: "todos", value: summary.total, label: "Produtos acompanhados", tone: "" },
                { id: "subiu", value: summary.up, label: "Preço subiu", tone: styles.cardValueUp },
                { id: "caiu", value: summary.down, label: "Preço caiu", tone: styles.cardValueDown },
                { id: "recomendado", value: summary.recomendados, label: "Recomendados agora", tone: "" },
              ] as const
            ).map((card) => (
              <button
                key={card.id}
                type="button"
                className={filter === card.id && card.id !== "todos" ? styles.cardActive : styles.card}
                onClick={() => applyFilter(card.id)}
                aria-pressed={filter === card.id}
                title={card.id === "todos" ? "Mostrar todos" : `Filtrar a tabela: ${card.label.toLowerCase()}`}
              >
                <span className={`${styles.cardValue} ${card.tone}`}>{card.value}</span>
                <span className={styles.cardLabel}>{card.label}</span>
              </button>
            ))}
          </div>

          <div className={styles.panel}>
            <div className={styles.controls}>
              <span className={styles.searchWrap}>
                <Search size={13} />
                <input
                  className={styles.searchInput}
                  placeholder="Buscar por SKU ou produto"
                  value={search}
                  onChange={(e) => {
                    setSearch(e.target.value);
                    setPage(0);
                  }}
                />
              </span>
              {FILTERS.map((f) => (
                <button
                  key={f.id}
                  type="button"
                  className={filter === f.id ? styles.filterButtonActive : styles.filterButton}
                  onClick={() => applyFilter(f.id)}
                >
                  {f.label}
                </button>
              ))}
            </div>

            <p className={styles.countHint}>
              Mostrando {filtered.length === 0 ? 0 : pageStart + 1}–
              {Math.min(pageStart + PAGE_SIZE, filtered.length)} de {filtered.length}
              {filtered.length !== portfolio.length && ` (filtrado de ${portfolio.length})`}
            </p>

            {filtered.length === 0 ? (
              <p className={styles.emptyFilter}>Nenhum produto com esse filtro ou termo de busca.</p>
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
                        initial={{ opacity: 0, y: 6 }}
                        animate={{ opacity: 1, y: 0 }}
                        transition={{ duration: 0.2, delay: Math.min(i, 12) * 0.02 }}
                      >
                        <td className={styles.photoCell}>
                          <ProductThumb src={item.imageUrl} />
                        </td>
                        <td>{item.sku}</td>
                        <td className={styles.productCell}>
                          <div className={styles.productName} title={item.name}>
                            {displayProductName(item.name)}
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
                        <td>{MARKETPLACE_LABEL[item.marketplace]}</td>
                        <td>{brl(item.marketplacePrice)}</td>
                        <td>
                          <TrendTag item={item} />
                        </td>
                        <td>{item.marginPct != null ? pct(item.marginPct) : "—"}</td>
                        <td>
                          <span className={`${styles.badge} ${BADGE_CLASS[item.recommendation]}`}>
                            {BADGE_LABEL[item.recommendation]}
                          </span>
                          <CompetitionBadge
                            competitorCount={item.competitorCount}
                            buyBoxEligible={item.buyBoxEligible}
                          />
                        </td>
                        <td className={styles.whenCell}>{formatWhen(item.lastSearchedAt)}</td>
                      </motion.tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}

            {pageCount > 1 && (
              <div className={styles.pagination}>
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
              </div>
            )}
          </div>
        </>
      )}
    </div>
  );
}
