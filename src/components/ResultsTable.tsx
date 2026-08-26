import { Fragment, useEffect, useMemo, useState } from "react";
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
  ChevronDown,
  ChevronUp,
  BarChart3,
  Users,
  Crown,
  AlertTriangle,
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
  /** Configurações → Personalização: "Gráficos na tela de Resultados" — só a faixa de distribuição no topo; a barra de margem por linha (MarginBar) é sempre visível, não é opcional. */
  showCharts?: boolean;
  /** 2+ marketplaces buscados: mostra 1 linha por SKU com 1 coluna de preço por marketplace + diferença, em vez de 1 linha por oferta. */
  compareSideBySide?: boolean;
  /** 1 linha por SKU (melhor oferta em destaque), com as outras ofertas do mesmo SKU recolhidas — expande com o chevron. */
  groupBySku?: boolean;
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
export function ProductThumb({ src }: { src?: string }) {
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

/**
 * Concorrência + elegibilidade ao "ganha-compra" (Buy Box) — os
 * providers já calculam isso (ver MarketplacePriceResult), mas até
 * agora nada na UI mostrava; só a margem/preço apareciam. Fica ao lado
 * do badge de recomendação (mesma coluna Status) em vez de coluna nova
 * pra não precisar mexer nos 3 modos de visualização (flat/lado-a-lado/
 * agrupado) em mais lugares do que o necessário.
 */
export function CompetitionBadge({
  competitorCount,
  buyBoxEligible,
}: {
  competitorCount: number;
  buyBoxEligible: boolean;
}) {
  return (
    <span
      className={buyBoxEligible ? styles.buyBoxYes : styles.buyBoxNo}
      title={
        buyBoxEligible
          ? `Elegível ao ganha-compra com ${competitorCount} concorrente(s) encontrado(s)`
          : `Não elegível ao ganha-compra — ${competitorCount} concorrente(s) encontrado(s)`
      }
    >
      {buyBoxEligible ? <Crown size={10} /> : <Users size={10} />}
      {competitorCount}
    </span>
  );
}

/**
 * Tag de match aproximado — ver `approximate` em types.ts. Aparece
 * quando o preço NÃO veio do marketplace pedido (o provider achou o
 * produto em outra loja) ou quando o título encontrado se parece pouco
 * demais com o nome do catálogo.
 *
 * Existe por uma razão concreta: antes, esses casos eram descartados em
 * silêncio e o produto sumia da tela — um catálogo de dezenas de itens
 * voltava com duas linhas, sem explicação. Mostrar o resultado com um
 * aviso explícito é mais útil (e mais honesto) do que esconder.
 */
export function ApproximateBadge({ matchedSource }: { matchedSource?: string }) {
  return (
    <span
      className={styles.approxBadge}
      title={
        matchedSource
          ? `Match aproximado — preço encontrado em "${matchedSource}", não no marketplace selecionado. ` +
            "Confira o anúncio antes de usar como referência."
          : "Match aproximado — o produto encontrado pode não ser exatamente o do seu catálogo. Confira o anúncio."
      }
    >
      <AlertTriangle size={10} /> Aproximado
    </span>
  );
}

/** Coluna de custo — "—" quando o catálogo não tem preço de fornecedor (ver Recommendation "sem_custo" em types/index.ts). */
function CostCell({ value }: { value?: number }) {
  return (
    <td>
      {value != null ? (
        `R$ ${value.toFixed(2)}`
      ) : (
        <span className={styles.noLink} title="Catálogo sem preço de custo pra este produto">
          —
        </span>
      )}
    </td>
  );
}

/** Coluna de margem — sem barra/percentual quando não há custo cadastrado pra calcular margem nenhuma (ver CostCell). */
function MarginCell({
  marginPct,
  targetMarginPct,
  recommendation,
}: {
  marginPct?: number;
  targetMarginPct: number;
  recommendation: Recommendation;
}) {
  if (marginPct == null) {
    return (
      <td>
        <span className={styles.noLink}>sem custo cadastrado</span>
      </td>
    );
  }
  return (
    <td>
      <MarginBar marginPct={marginPct} targetMarginPct={targetMarginPct} recommendation={recommendation} />
      <span className={styles.marginValue}>{(marginPct * 100).toFixed(1)}%</span>
    </td>
  );
}

const SOURCE_LABEL: Record<"server" | "local", string> = {
  server: "servidor (cache)",
  local: "direto no navegador",
};

type FilterOption = "todos" | Recommendation;
type SortKey = "supplierPrice" | "marketplacePrice" | "marginPct" | "confidence";
type SortDir = "asc" | "desc";

// Exportados — reaproveitados por Portfolio.tsx ("Meus produtos"), que
// mostra o mesmo vocabulário visual (badge de recomendação, rótulo de
// marketplace, foto/concorrência) sem duplicar os mapeamentos.
export const BADGE_CLASS: Record<Recommendation, string> = {
  recomendado: styles.badgeRecomendado,
  revisar: styles.badgeRevisar,
  evitar: styles.badgeEvitar,
  sem_custo: styles.badgeSemCusto,
};

export const BADGE_LABEL: Record<Recommendation, string> = {
  recomendado: "Recomendado",
  revisar: "Revisar",
  evitar: "Evitar",
  sem_custo: "Sem custo",
};

export const MARKETPLACE_LABEL: Record<MarketplaceId, string> = {
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
  showCharts = true,
  compareSideBySide = false,
  groupBySku = false,
}: Props) {
  const [search, setSearch] = useState("");
  const [filter, setFilter] = useState<FilterOption>("todos");
  const [sortKey, setSortKey] = useState<SortKey>("marginPct");
  const [sortDir, setSortDir] = useState<SortDir>("desc");
  const [page, setPage] = useState(0);
  const [expandedSkus, setExpandedSkus] = useState<Set<string>>(new Set());

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
      // supplierPrice/marginPct podem faltar (catálogo "sem_custo", ver
      // types/index.ts) — trata ausência como "menor valor possível" pra
      // ordenar de forma previsível em vez de NaN bagunçando a ordem.
      const av = a[sortKey] ?? -Infinity;
      const bv = b[sortKey] ?? -Infinity;
      // -Infinity - -Infinity daria NaN (os dois sem o campo) — trata
      // como empate em vez de deixar o comparador devolver NaN.
      const diff = av === bv ? 0 : av - bv;
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

  // Marketplaces de fato presentes NESTE resultado — "comparar lado a
  // lado" só faz sentido com 2+ (com 1 só, cai pro agrupado ou pro flat
  // normalmente, ver viewMode abaixo).
  const marketplacesPresent = useMemo(
    () => Array.from(new Set(results.map((r) => r.marketplace))),
    [results]
  );

  // Agrupa a PÁGINA atual por SKU (não o conjunto filtrado inteiro) —
  // mantém a paginação simples (PAGE_SIZE ofertas por página) mesmo em
  // modo agrupado/lado-a-lado; catálogo típico tem 1-2 marketplaces, então
  // o agrupamento dentro da página já cobre o caso comum.
  const groupedRows = useMemo(() => {
    const map = new Map<string, MarginResult[]>();
    for (const r of paginated) {
      const list = map.get(r.sku) ?? [];
      list.push(r);
      map.set(r.sku, list);
    }
    return Array.from(map.values());
  }, [paginated]);

  const viewMode: "flat" | "sideBySide" | "grouped" =
    compareSideBySide && marketplacesPresent.length >= 2
      ? "sideBySide"
      : groupBySku
        ? "grouped"
        : "flat";

  function toggleExpanded(sku: string) {
    setExpandedSkus((prev) => {
      const next = new Set(prev);
      if (next.has(sku)) next.delete(sku);
      else next.add(sku);
      return next;
    });
  }

  // Faixa de distribuição de margem (Configurações → Personalização,
  // "Gráficos na tela de Resultados") — sobre TODOS os resultados desta
  // busca (não só a página/filtro atual), mesmos buckets conceituais do
  // histograma em PricingConfig.tsx.
  const distribution = useMemo(() => {
    const buckets: { label: string; min: number; max: number }[] = [
      { label: "<0%", min: -Infinity, max: 0 },
      { label: "0–10%", min: 0, max: 0.1 },
      { label: "10–20%", min: 0.1, max: 0.2 },
      { label: "20–30%", min: 0.2, max: 0.3 },
      { label: "30–50%", min: 0.3, max: 0.5 },
      { label: "50%+", min: 0.5, max: Infinity },
    ];
    // "sem_custo" (sem marginPct) fica de fora de todo bucket — não tem
    // margem nenhuma pra classificar como negativa/positiva.
    const counts = buckets.map(
      (b) => results.filter((r) => r.marginPct != null && r.marginPct >= b.min && r.marginPct < b.max).length
    );
    const max = Math.max(1, ...counts);
    return buckets.map((b, i) => ({ label: b.label, count: counts[i], max }));
  }, [results]);

  const totalProfitable = results.filter((r) => r.recommendation === "recomendado").length;
  const totalToAvoid = results.filter((r) => r.recommendation === "evitar").length;
  // Mediana, não média — um único SKU com dado ruim (ex: extração de
  // PDF corrompida) não deve distorcer o KPI de destaque da tela.
  // "sem_custo" fica de fora (não tem marginPct nenhum pra entrar na conta).
  const medianMarginPct = median(
    results.map((r) => r.marginPct).filter((v): v is number => v != null)
  );

  function handleExportCsv() {
    const rows = filtered.map((r) => ({
      SKU: r.sku,
      Produto: r.name,
      Marketplace: MARKETPLACE_LABEL[r.marketplace],
      "Custo (R$)": r.supplierPrice != null ? r.supplierPrice.toFixed(2) : "",
      "Preço (R$)": r.marketplacePrice.toFixed(2),
      "Margem (%)": r.marginPct != null ? (r.marginPct * 100).toFixed(1) : "",
      "Confiança (%)": (r.confidence * 100).toFixed(0),
      Recomendação: BADGE_LABEL[r.recommendation],
      Concorrentes: r.competitorCount,
      "Elegível Buy Box": r.buyBoxEligible ? "Sim" : "Não",
      // Match aproximado precisa sobreviver à exportação — quem analisa
      // a planilha fora do app não pode confundir chute com match real.
      Aproximado: r.approximate ? "Sim" : "Não",
      "Loja de origem": r.matchedSource ?? "",
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

      {showCharts && results.length > 0 && (
        <div className={styles.distributionCard}>
          <div className={styles.distributionHeader}>
            <span className={styles.distributionHeaderIcon}>
              <BarChart3 size={13} />
            </span>
            <span className={styles.distributionTitle}>Distribuição de margem</span>
            <span className={styles.distributionMeta}>{results.length} produto(s)</span>
          </div>
          <div className={styles.distributionBand}>
            {distribution.map((b) => (
              <div key={b.label} className={styles.distributionCol}>
                <span className={styles.distributionValue}>{b.count}</span>
                <span className={styles.distributionTrack}>
                  <span
                    className={styles.distributionFill}
                    style={{ height: `${Math.max(3, Math.round((b.count / b.max) * 100))}%` }}
                  />
                </span>
                <span className={styles.distributionLabel}>{b.label}</span>
              </div>
            ))}
          </div>
        </div>
      )}

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
          {(["todos", "recomendado", "revisar", "evitar", "sem_custo"] as FilterOption[]).map((option) => (
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
                  "), mas nenhum produto encontrou preço em nenhum marketplace selecionado. Causas " +
                  "comuns: chave do provider ativo inválida/sem cota (confira em Conta), produto com " +
                  "nome/descrição genérica demais pra achar match, ou — se o provider ativo for o " +
                  "motor interno (sem SerpApi/RapidAPI) — bloqueio de IP ou mudança de layout da loja. " +
                  "O motivo específico de cada tentativa fica registrado nos logs da FUNCTION DO " +
                  "SERVIDOR (Vercel → projeto → Logs, filtrar por /api/fetch-prices) — não no console " +
                  "do navegador, essa busca roda no servidor."
                : "Nenhum resultado com esse filtro ou busca — limpe o texto ou troque o status acima."}
          </p>
        ) : viewMode === "flat" ? (
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
                        {r.approximate && <ApproximateBadge matchedSource={r.matchedSource} />}
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
                        <span className={styles.noLink} title="A fonte deste preço não retornou um link direto pro anúncio">
                          sem link
                        </span>
                      )}
                    </td>
                    <td className={styles.marketCell}>{MARKETPLACE_LABEL[r.marketplace]}</td>
                    <CostCell value={r.supplierPrice} />
                    <td>R$ {r.marketplacePrice.toFixed(2)}</td>
                    <MarginCell
                      marginPct={r.marginPct}
                      targetMarginPct={targetMarginPct}
                      recommendation={r.recommendation}
                    />
                    <td>{(r.confidence * 100).toFixed(0)}%</td>
                    <td>
                      <span className={`${styles.badge} ${BADGE_CLASS[r.recommendation]}`}>
                        {BADGE_LABEL[r.recommendation]}
                      </span>
                      <CompetitionBadge
                        competitorCount={r.competitorCount}
                        buyBoxEligible={r.buyBoxEligible}
                      />
                    </td>
                  </motion.tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : viewMode === "sideBySide" ? (
          <div className={styles.tableWrap}>
            <table className={styles.table}>
              <thead>
                <tr>
                  <th className={styles.photoHeader} />
                  <th>SKU</th>
                  <th className={styles.productHeader}>Produto</th>
                  {marketplacesPresent.map((m) => (
                    <th key={m}>{MARKETPLACE_LABEL[m]}</th>
                  ))}
                  {marketplacesPresent.length === 2 && <th>Diferença</th>}
                  <th>Status</th>
                </tr>
              </thead>
              <tbody>
                {groupedRows.map((group) => {
                  const best = [...group].sort(
                    (a, b) => (b.marginPct ?? -Infinity) - (a.marginPct ?? -Infinity)
                  )[0];
                  const byMarket = new Map(group.map((r) => [r.marketplace, r]));
                  const priceA =
                    marketplacesPresent.length === 2 ? byMarket.get(marketplacesPresent[0])?.marketplacePrice : undefined;
                  const priceB =
                    marketplacesPresent.length === 2 ? byMarket.get(marketplacesPresent[1])?.marketplacePrice : undefined;
                  const diff = priceA !== undefined && priceB !== undefined ? priceB - priceA : null;
                  return (
                    <motion.tr key={best.sku} initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }}>
                      <td className={styles.photoCell}>
                        <ProductThumb src={best.imageUrl} />
                      </td>
                      <td>{best.sku}</td>
                      <td className={styles.productCell}>
                        <div className={styles.productName} title={best.name}>
                          {best.name}
                          {group.some((r) => r.approximate) && (
                            <ApproximateBadge
                              matchedSource={group.find((r) => r.approximate)?.matchedSource}
                            />
                          )}
                        </div>
                      </td>
                      {marketplacesPresent.map((m) => {
                        const offer = byMarket.get(m);
                        return (
                          <td key={m}>
                            {offer ? (
                              <>
                                R$ {offer.marketplacePrice.toFixed(2)}
                                <span className={styles.marginValue}>
                                  {offer.marginPct != null
                                    ? `${(offer.marginPct * 100).toFixed(1)}% margem`
                                    : "sem custo"}
                                </span>
                                {offer.link ? (
                                  <a
                                    className={styles.productLink}
                                    href={offer.link}
                                    target="_blank"
                                    rel="noopener noreferrer"
                                    title={offer.matchedTitle ? `Encontrado como: ${offer.matchedTitle}` : undefined}
                                  >
                                    <ExternalLink size={10} /> Ver anúncio
                                  </a>
                                ) : (
                                  <span className={styles.noLink}>sem link</span>
                                )}
                              </>
                            ) : (
                              <span className={styles.noLink}>sem oferta</span>
                            )}
                          </td>
                        );
                      })}
                      {marketplacesPresent.length === 2 && (
                        <td>
                          {diff === null ? (
                            "—"
                          ) : (
                            <span className={diff <= 0 ? styles.diffDown : styles.diffUp}>
                              {diff > 0 ? "+" : ""}
                              R$ {diff.toFixed(2)}
                            </span>
                          )}
                        </td>
                      )}
                      <td>
                        <span className={`${styles.badge} ${BADGE_CLASS[best.recommendation]}`}>
                          {BADGE_LABEL[best.recommendation]}
                        </span>
                        <CompetitionBadge
                          competitorCount={best.competitorCount}
                          buyBoxEligible={best.buyBoxEligible}
                        />
                      </td>
                    </motion.tr>
                  );
                })}
              </tbody>
            </table>
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
                  <th>Custo</th>
                  <th>Preço</th>
                  <th>Margem</th>
                  <th>Status</th>
                </tr>
              </thead>
              <tbody>
                {groupedRows.map((group) => {
                  const sorted = [...group].sort(
                    (a, b) => (b.marginPct ?? -Infinity) - (a.marginPct ?? -Infinity)
                  );
                  const best = sorted[0];
                  const rest = sorted.slice(1);
                  const isExpanded = expandedSkus.has(best.sku);
                  return (
                    <Fragment key={best.sku}>
                      <motion.tr initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }}>
                        <td className={styles.photoCell}>
                          <ProductThumb src={best.imageUrl} />
                        </td>
                        <td>{best.sku}</td>
                        <td className={styles.productCell}>
                          <div className={styles.productName} title={best.name}>
                            {best.name}
                            {best.approximate && (
                              <ApproximateBadge matchedSource={best.matchedSource} />
                            )}
                          </div>
                          {best.link ? (
                            <a
                              className={styles.productLink}
                              href={best.link}
                              target="_blank"
                              rel="noopener noreferrer"
                              title={best.matchedTitle ? `Encontrado como: ${best.matchedTitle}` : undefined}
                            >
                              <ExternalLink size={11} /> Ver anúncio
                            </a>
                          ) : (
                            <span className={styles.noLink}>sem link</span>
                          )}
                          {rest.length > 0 && (
                            <button
                              type="button"
                              className={styles.expandButton}
                              onClick={() => toggleExpanded(best.sku)}
                            >
                              {isExpanded ? <ChevronUp size={11} /> : <ChevronDown size={11} />}
                              {isExpanded ? "ocultar" : `+${rest.length} oferta(s)`}
                            </button>
                          )}
                        </td>
                        <td className={styles.marketCell}>{MARKETPLACE_LABEL[best.marketplace]}</td>
                        <CostCell value={best.supplierPrice} />
                        <td>R$ {best.marketplacePrice.toFixed(2)}</td>
                        <MarginCell
                          marginPct={best.marginPct}
                          targetMarginPct={targetMarginPct}
                          recommendation={best.recommendation}
                        />
                        <td>
                          <span className={`${styles.badge} ${BADGE_CLASS[best.recommendation]}`}>
                            {BADGE_LABEL[best.recommendation]}
                          </span>
                          <CompetitionBadge
                            competitorCount={best.competitorCount}
                            buyBoxEligible={best.buyBoxEligible}
                          />
                        </td>
                      </motion.tr>
                      {isExpanded &&
                        rest.map((r) => (
                          <tr key={`${r.marketplace}-${r.sku}`} className={styles.subRow}>
                            <td className={styles.photoCell} />
                            <td />
                            <td className={styles.productCell}>
                              <span className={styles.subRowHint}>outra oferta</span>
                              {r.link ? (
                                <a
                                  className={styles.productLink}
                                  href={r.link}
                                  target="_blank"
                                  rel="noopener noreferrer"
                                  title={r.matchedTitle ? `Encontrado como: ${r.matchedTitle}` : undefined}
                                >
                                  <ExternalLink size={10} /> Ver anúncio
                                </a>
                              ) : (
                                <span className={styles.noLink}>sem link</span>
                              )}
                            </td>
                            <td className={styles.marketCell}>{MARKETPLACE_LABEL[r.marketplace]}</td>
                            <CostCell value={r.supplierPrice} />
                            <td>R$ {r.marketplacePrice.toFixed(2)}</td>
                            <td>
                              <span className={styles.marginValue}>
                                {r.marginPct != null ? `${(r.marginPct * 100).toFixed(1)}%` : "sem custo"}
                              </span>
                            </td>
                            <td>
                              <span className={`${styles.badge} ${BADGE_CLASS[r.recommendation]}`}>
                                {BADGE_LABEL[r.recommendation]}
                              </span>
                              <CompetitionBadge
                                competitorCount={r.competitorCount}
                                buyBoxEligible={r.buyBoxEligible}
                              />
                            </td>
                          </tr>
                        ))}
                    </Fragment>
                  );
                })}
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
