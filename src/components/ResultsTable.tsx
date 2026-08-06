import { useEffect, useMemo, useState } from "react";
import { motion } from "framer-motion";
import Papa from "papaparse";
import {
  Package,
  ImageOff,
  TrendingUp,
  Percent,
  ShieldAlert,
  ExternalLink,
  ArrowUp,
  ArrowDown,
  ArrowUpDown,
  Download,
  Search,
  ChevronLeft,
  ChevronRight,
} from "lucide-react";
import type { MarginResult, MarketplaceId, Recommendation } from "../types";
import { median } from "../lib/marginCalculator";
import type { CatalogUploadRecord } from "../lib/catalogHistory";
import MarginBar from "./MarginBar";
import styles from "./ResultsTable.module.css";

interface Props {
  results: MarginResult[];
  targetMarginPct: number;
  source: "server" | "local" | null;
  /** Buscas salvas do usuário — alimenta o seletor "qual busca ver" abaixo. */
  history?: CatalogUploadRecord[];
  activeHistoryId?: string | null;
  onSelectHistory?: (id: string) => void;
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

/**
 * Thumbnail do produto — só existe quando a busca rodou em modo imagem
 * (Google Lens, ver imageUrl em CatalogRow/MarginResult). Cai pro ícone
 * genérico tanto na ausência do campo (busca por texto, nunca teve
 * foto) quanto no load da imagem falhando (documento expirado em
 * `catalog_images`, ver TTL em catalogImages.ts) — as duas situações são
 * o esperado, não um erro pra reportar ao usuário.
 */
function ProductThumb({ src }: { src?: string }) {
  const [failed, setFailed] = useState(false);
  if (!src || failed) {
    return (
      <span className={styles.photoPlaceholder} title="Sem foto disponível">
        <ImageOff size={13} />
      </span>
    );
  }
  return (
    <img
      className={styles.photoImg}
      src={src}
      alt=""
      loading="lazy"
      onError={() => setFailed(true)}
    />
  );
}

const SOURCE_LABEL: Record<"server" | "local", string> = {
  server: "servidor (cache)",
  local: "direto no navegador",
};

type FilterOption = "todos" | Recommendation;
type SortKey = "supplierPrice" | "marketplacePrice" | "marginPct" | "confidence";
type SortDir = "asc" | "desc";

const BADGE_CLASS: Record<Recommendation, string> = {
  recomendado: styles.badgeRecomendado,
  revisar: styles.badgeRevisar,
  evitar: styles.badgeEvitar,
};

const BADGE_LABEL: Record<Recommendation, string> = {
  recomendado: "Recomendado",
  revisar: "Revisar",
  evitar: "Evitar",
};

const MARKETPLACE_LABEL: Record<MarketplaceId, string> = {
  amazon: "Amazon",
  mercadolivre: "Mercado Livre",
  shopee: "Shopee",
};

const SORTABLE_COLUMNS: { key: SortKey; label: string }[] = [
  { key: "supplierPrice", label: "Custo" },
  { key: "marketplacePrice", label: "Preço" },
  { key: "marginPct", label: "Margem" },
  { key: "confidence", label: "Confiança" },
];

// Catálogos grandes (a motivação original do parser de PDF/CSV) passam
// de 100-200 linhas fácil — renderizar tudo de uma vez deixa a tabela
// pesada sem necessidade, já que só a página visível importa pra tela.
const PAGE_SIZE = 50;

export default function ResultsTable({
  results,
  targetMarginPct,
  source,
  history = [],
  activeHistoryId = null,
  onSelectHistory,
}: Props) {
  const [search, setSearch] = useState("");
  const [filter, setFilter] = useState<FilterOption>("todos");
  const [sortKey, setSortKey] = useState<SortKey>("marginPct");
  const [sortDir, setSortDir] = useState<SortDir>("desc");
  const [page, setPage] = useState(0);

  function handleSort(key: SortKey) {
    if (key === sortKey) {
      setSortDir((d) => (d === "asc" ? "desc" : "asc"));
    } else {
      setSortKey(key);
      setSortDir("desc");
    }
  }

  const filtered = useMemo(() => {
    const term = search.trim().toLowerCase();
    const list = results.filter((r) => {
      const matchesFilter = filter === "todos" || r.recommendation === filter;
      const matchesSearch =
        term === "" || r.sku.toLowerCase().includes(term) || r.name.toLowerCase().includes(term);
      return matchesFilter && matchesSearch;
    });

    const sorted = [...list].sort((a, b) => {
      const diff = a[sortKey] - b[sortKey];
      return sortDir === "asc" ? diff : -diff;
    });

    return sorted;
  }, [results, search, filter, sortKey, sortDir]);

  // Busca/filtro novo pode reduzir o total de páginas — volta pra
  // primeira página nesses casos (senão a tela pode ficar "vazia" numa
  // página que não existe mais nesse conjunto filtrado).
  useEffect(() => {
    setPage(0);
  }, [search, filter, results]);

  const pageCount = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  const currentPage = Math.min(page, pageCount - 1);
  const pageStart = currentPage * PAGE_SIZE;
  const paginated = filtered.slice(pageStart, pageStart + PAGE_SIZE);

  const totalProfitable = results.filter((r) => r.recommendation === "recomendado").length;
  const totalToAvoid = results.filter((r) => r.recommendation === "evitar").length;
  // Mediana, não média — um único SKU com dado ruim (ex: extração de
  // PDF corrompida) não deve distorcer o KPI de destaque da tela.
  const medianMarginPct = median(results.map((r) => r.marginPct));

  function handleExportCsv() {
    const rows = filtered.map((r) => ({
      SKU: r.sku,
      Produto: r.name,
      Marketplace: MARKETPLACE_LABEL[r.marketplace],
      "Custo (R$)": r.supplierPrice.toFixed(2),
      "Preço (R$)": r.marketplacePrice.toFixed(2),
      "Margem (%)": (r.marginPct * 100).toFixed(1),
      "Confiança (%)": (r.confidence * 100).toFixed(0),
      Recomendação: BADGE_LABEL[r.recommendation],
      Link: r.link ?? "",
    }));

    // Exporta o conjunto FILTRADO (respeita busca/status ativos na
    // tela), não paginado — quem exporta quer o recorte inteiro que
    // está olhando, não só a página visível.
    const csv = Papa.unparse(rows);
    const blob = new Blob([`﻿${csv}`], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `arbitra-resultados-${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  }

  return (
    <div className={styles.container}>
      <div className={styles.header}>
        <div className={styles.headerMain}>
          <span className={styles.eyebrow}>Catálogo analisado</span>
          <h1 className={styles.title}>Resultados</h1>
          <p className={styles.subtitle}>
            Cada produto com o preço encontrado no marketplace e a margem calculada pelas suas
            regras de precificação.
          </p>
        </div>
        <div className={styles.headerCard}>
          <span className={styles.headerCardRow}>
            <span className={styles.headerCardDot} />
            fonte{" "}
            <b className={styles.headerCardStrong}>{source ? SOURCE_LABEL[source] : "—"}</b>
          </span>
          <span className={styles.headerCardRow}>
            <span className={styles.headerCardDotSuccess} />
            meta <b className={styles.headerCardStrong}>{(targetMarginPct * 100).toFixed(0)}%</b>
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

      <div className={styles.summaryRow}>
        {[
          { icon: Package, value: String(results.length), label: "Total de SKUs" },
          { icon: TrendingUp, value: String(totalProfitable), label: "Recomendados" },
          {
            icon: Percent,
            value: `${(medianMarginPct * 100).toFixed(1).replace(".", ",")}%`,
            label: "Margem mediana",
          },
          { icon: ShieldAlert, value: String(totalToAvoid), label: "A evitar" },
        ].map((card, i) => (
          <motion.div
            key={card.label}
            className={styles.card}
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.3, delay: i * 0.05, ease: [0.16, 1, 0.3, 1] }}
          >
            <span className={styles.cardIcon}>
              <card.icon size={16} />
            </span>
            <div className={styles.cardText}>
              <div className={styles.cardValue}>{card.value}</div>
              <div className={styles.cardLabel}>{card.label}</div>
            </div>
          </motion.div>
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
              onChange={(e) => setSearch(e.target.value)}
            />
          </span>
          {(["todos", "recomendado", "revisar", "evitar"] as FilterOption[]).map((option) => (
            <button
              key={option}
              type="button"
              className={filter === option ? styles.filterButtonActive : styles.filterButton}
              onClick={() => setFilter(option)}
            >
              {option === "todos" ? "Todos" : BADGE_LABEL[option]}
            </button>
          ))}
          {filtered.length > 0 && (
            <button className={styles.exportButton} type="button" onClick={handleExportCsv}>
              <Download size={13} /> Exportar CSV
            </button>
          )}
        </div>

        {results.length > 0 && (
          <p className={styles.countHint}>
            Mostrando {filtered.length === 0 ? 0 : pageStart + 1}–
            {Math.min(pageStart + PAGE_SIZE, filtered.length)} de {filtered.length}
            {filtered.length !== results.length && ` (filtrado de ${results.length})`}
          </p>
        )}

        {filtered.length === 0 ? (
          <p className={styles.empty}>
            {source === null
              ? "Nenhum resultado. Faça upload de um catálogo no Dashboard."
              : results.length === 0
                ? "A busca rodou (fonte: " +
                  (SOURCE_LABEL[source] ?? source) +
                  "), mas nenhum produto encontrou preço em nenhum marketplace selecionado. " +
                  "Confira sua chave SerpApi em Conta (válida? ainda tem cota?) ou tente novamente — " +
                  "produtos com nome muito genérico também podem não achar match no Google Shopping."
                : "Nenhum resultado com esse filtro ou busca — limpe o texto ou troque o status acima."}
          </p>
        ) : (
          <div className={styles.tableWrap}>
            <table className={styles.table}>
              <thead>
                <tr>
                  <th className={styles.photoHeader} />
                  <th>SKU</th>
                  <th className={styles.productHeader}>Produto</th>
                  <th>Marketplace</th>
                  {SORTABLE_COLUMNS.map((col) => (
                    <th key={col.key}>
                      <button
                        type="button"
                        className={styles.sortButton}
                        onClick={() => handleSort(col.key)}
                      >
                        {col.label}
                        {sortKey === col.key ? (
                          sortDir === "asc" ? (
                            <ArrowUp size={11} />
                          ) : (
                            <ArrowDown size={11} />
                          )
                        ) : (
                          <ArrowUpDown size={11} className={styles.sortIconIdle} />
                        )}
                      </button>
                    </th>
                  ))}
                  <th>Status</th>
                </tr>
              </thead>
              <tbody>
                {paginated.map((r, i) => (
                  <motion.tr
                    key={`${r.marketplace}-${r.sku}`}
                    initial={{ opacity: 0, y: 6 }}
                    animate={{ opacity: 1, y: 0 }}
                    transition={{
                      duration: 0.2,
                      delay: Math.min(i, 12) * 0.02,
                      ease: [0.16, 1, 0.3, 1],
                    }}
                  >
                    <td className={styles.photoCell}>
                      <ProductThumb src={r.imageUrl} />
                    </td>
                    <td>{r.sku}</td>
                    <td className={styles.productCell}>
                      <div className={styles.productName} title={r.name}>
                        {r.name}
                      </div>
                      {r.link ? (
                        <a
                          className={styles.productLink}
                          href={r.link}
                          target="_blank"
                          rel="noopener noreferrer"
                          title={r.matchedTitle ? `Encontrado como: ${r.matchedTitle}` : undefined}
                        >
                          <ExternalLink size={11} /> Ver anúncio
                        </a>
                      ) : (
                        <span className={styles.noLink}>sem link (simulado)</span>
                      )}
                    </td>
                    <td className={styles.marketCell}>{MARKETPLACE_LABEL[r.marketplace]}</td>
                    <td>R$ {r.supplierPrice.toFixed(2)}</td>
                    <td>R$ {r.marketplacePrice.toFixed(2)}</td>
                    <td>
                      <MarginBar
                        marginPct={r.marginPct}
                        targetMarginPct={targetMarginPct}
                        recommendation={r.recommendation}
                      />
                      <span className={styles.marginValue}>{(r.marginPct * 100).toFixed(1)}%</span>
                    </td>
                    <td>{(r.confidence * 100).toFixed(0)}%</td>
                    <td>
                      <span className={`${styles.badge} ${BADGE_CLASS[r.recommendation]}`}>
                        {BADGE_LABEL[r.recommendation]}
                      </span>
                    </td>
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
    </div>
  );
}
