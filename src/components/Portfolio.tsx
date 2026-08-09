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
} from "lucide-react";
import type { CatalogUploadRecord } from "../lib/catalogHistory";
import { buildPortfolio, type PortfolioItem } from "../lib/portfolio";
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
    <span className={cls} title={`Era R$ ${item.previousMarketplacePrice?.toFixed(2)} na busca anterior`}>
      <Icon size={11} />
      {diff > 0 ? "+" : ""}
      {diff.toFixed(2)}
    </span>
  );
}

export default function Portfolio({ history, onNavigateToDashboard }: Props) {
  const [search, setSearch] = useState("");
  const [page, setPage] = useState(0);

  const portfolio = useMemo(() => buildPortfolio(history), [history]);

  const filtered = useMemo(() => {
    const term = search.trim().toLowerCase();
    if (!term) return portfolio;
    return portfolio.filter(
      (item) => item.sku.toLowerCase().includes(term) || item.name.toLowerCase().includes(term)
    );
  }, [portfolio, search]);

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
            <div className={styles.card}>
              <span className={styles.cardValue}>{summary.total}</span>
              <span className={styles.cardLabel}>Produtos acompanhados</span>
            </div>
            <div className={styles.card}>
              <span className={`${styles.cardValue} ${styles.cardValueUp}`}>{summary.up}</span>
              <span className={styles.cardLabel}>Preço subiu</span>
            </div>
            <div className={styles.card}>
              <span className={`${styles.cardValue} ${styles.cardValueDown}`}>{summary.down}</span>
              <span className={styles.cardLabel}>Preço caiu</span>
            </div>
            <div className={styles.card}>
              <span className={styles.cardValue}>{summary.recomendados}</span>
              <span className={styles.cardLabel}>Recomendados agora</span>
            </div>
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
            </div>

            <p className={styles.countHint}>
              Mostrando {filtered.length === 0 ? 0 : pageStart + 1}–
              {Math.min(pageStart + PAGE_SIZE, filtered.length)} de {filtered.length}
              {filtered.length !== portfolio.length && ` (filtrado de ${portfolio.length})`}
            </p>

            {filtered.length === 0 ? (
              <p className={styles.emptyFilter}>Nenhum produto com esse termo de busca.</p>
            ) : (
              <div className={styles.tableWrap}>
                <table className={styles.table}>
                  <thead>
                    <tr>
                      <th className={styles.photoHeader} />
                      <th>SKU</th>
                      <th className={styles.productHeader}>Produto</th>
                      <th>Marketplace</th>
                      <th>Preço atual</th>
                      <th>Tendência</th>
                      <th>Margem</th>
                      <th>Status</th>
                      <th>Última busca</th>
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
                            {item.name}
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
                        <td>R$ {item.marketplacePrice.toFixed(2)}</td>
                        <td>
                          <TrendTag item={item} />
                        </td>
                        <td>{(item.marginPct * 100).toFixed(1)}%</td>
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
