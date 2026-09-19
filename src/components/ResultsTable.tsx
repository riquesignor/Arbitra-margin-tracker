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
  Flame,
  Star,
  X,
  RefreshCw,
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
  /** Buscas salvas do usuário — alimenta o seletor "quais catálogos ver" abaixo. */
  history?: CatalogUploadRecord[];
  /**
   * IDs do histórico atualmente selecionados — 0/1 item é o mesmo
   * comportamento de sempre (resultado de uma busca só); 2+ mostra a
   * UNIÃO dos resultados desses catálogos numa tabela só, cada linha
   * carimbada com `sourceUpload` (ver MarginResult em types/index.ts) pra
   * dar pra distinguir de qual catálogo veio cada oferta.
   */
  selectedHistoryIds?: string[];
  onSelectHistoryMultiple?: (ids: string[]) => void;
  /** Configurações → Personalização: "Gráficos na tela de Resultados" — só a faixa de distribuição no topo; a barra de margem por linha (MarginBar) é sempre visível, não é opcional. */
  showCharts?: boolean;
  /** 2+ marketplaces buscados: mostra 1 linha por SKU com 1 coluna de preço por marketplace + diferença, em vez de 1 linha por oferta. */
  compareSideBySide?: boolean;
  /** 1 linha por SKU (melhor oferta em destaque), com as outras ofertas do mesmo SKU recolhidas — expande com o chevron. */
  groupBySku?: boolean;
  /**
   * true quando a regra de Precificação (taxa de venda, margem-alvo etc)
   * foi editada e AINDA NÃO foi aplicada a estes `results` (set/2026,
   * pedido explícito do usuário — ver handleSyncPricing em App.tsx).
   * Controla se o botão "Sincronizar com Precificação" abaixo fica
   * clicável ou desabilitado.
   */
  isPricingDirty?: boolean;
  /** Recalcula margem/preço sugerido/recomendação de TODAS as linhas com a regra atual de Precificação — ver handleSyncPricing em App.tsx. */
  onSyncPricing?: () => void;
}

/** Pequena legenda "de qual catálogo veio" — só aparece na visão combinada (2+ catálogos do histórico marcados, ver HistoryMultiSelect). */
function SourceUploadTag({ sourceUpload }: { sourceUpload?: MarginResult["sourceUpload"] }) {
  if (!sourceUpload) return null;
  return (
    <span className={styles.sourceUploadTag} title={`Veio do catálogo "${sourceUpload.fileName}"`}>
      {sourceUpload.fileName}
    </span>
  );
}

/**
 * Dropdown com checkbox (não `<select multiple>` nativo — UX ruim pra
 * marcar/desmarcar vários itens) pra escolher quais catálogos do
 * histórico combinar na tabela (ver selectedHistoryIds/onSelectHistoryMultiple
 * acima e handleSelectHistoryMultiple em App.tsx).
 */
function HistoryMultiSelect({
  history,
  selectedIds,
  onChange,
}: {
  history: CatalogUploadRecord[];
  selectedIds: string[];
  onChange: (ids: string[]) => void;
}) {
  const [open, setOpen] = useState(false);

  function toggle(id: string) {
    if (selectedIds.includes(id)) onChange(selectedIds.filter((existing) => existing !== id));
    else onChange([...selectedIds, id]);
  }

  const label =
    selectedIds.length === 0
      ? "Resultado atual desta sessão"
      : selectedIds.length === 1
        ? formatHistoryLabel(history.find((h) => h.id === selectedIds[0])!)
        : `${selectedIds.length} catálogos combinados`;

  return (
    <div className={styles.historyMultiSelectWrap}>
      <span className={styles.historySelectLabel}>ver busca</span>
      <button
        type="button"
        className={styles.historyMultiSelectButton}
        onClick={() => setOpen((v) => !v)}
      >
        <span className={styles.historyMultiSelectButtonLabel}>{label}</span>
        {open ? <ChevronUp size={13} /> : <ChevronDown size={13} />}
      </button>
      {open && (
        <>
          <div className={styles.historyMultiSelectBackdrop} onClick={() => setOpen(false)} />
          <div className={styles.historyMultiSelectPanel}>
            <button
              type="button"
              className={styles.historyMultiSelectClear}
              onClick={() => {
                onChange([]);
                setOpen(false);
              }}
              disabled={selectedIds.length === 0}
            >
              Voltar pro resultado atual desta sessão
            </button>
            <ul className={styles.historyMultiSelectList}>
              {history.map((record) => (
                <li key={record.id}>
                  <label className={styles.historyMultiSelectItem}>
                    <input
                      type="checkbox"
                      checked={selectedIds.includes(record.id)}
                      onChange={() => toggle(record.id)}
                    />
                    <span>{formatHistoryLabel(record)}</span>
                  </label>
                </li>
              ))}
            </ul>
          </div>
        </>
      )}
    </div>
  );
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
 * Thumbnail do produto — prioriza a foto do ANÚNCIO encontrado e cai pra
 * foto do catálogo (ver imageUrl em MarketplacePriceResult/CatalogRow).
 * Cai pro ícone genérico tanto na ausência do campo (busca por texto,
 * nunca teve foto) quanto no load da imagem falhando (documento expirado
 * em `catalog_images`, ver TTL em catalogImages.ts) — as duas situações
 * são o esperado, não um erro pra reportar ao usuário.
 *
 * Clicar amplia (set/2026): quando o resultado vem sem link do anúncio —
 * caso de fontes agregadas — conferir a foto é a única verificação manual
 * que sobra. A imagem é a MESMA que a IA usou pra decidir o match, então
 * ampliar mostra exatamente o dado em que a decisão se baseou. Resolução
 * é a da miniatura do marketplace: ampliar não cria detalhe, mas resolve
 * erro grosseiro (cor, modelo, kit x unidade).
 */
export function ProductThumb({ src, label }: { src?: string; label?: string }) {
  const [failed, setFailed] = useState(false);
  const [zoomed, setZoomed] = useState(false);

  useEffect(() => {
    if (!zoomed) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setZoomed(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [zoomed]);

  if (!src || failed) {
    return (
      <span className={styles.photoPlaceholder} title="Sem foto disponível">
        <ImageOff size={13} />
      </span>
    );
  }

  return (
    <>
      <button
        type="button"
        className={styles.photoButton}
        onClick={() => setZoomed(true)}
        title="Ampliar a foto do anúncio"
        aria-label="Ampliar a foto do anúncio"
      >
        <img
          className={styles.photoImg}
          src={src}
          alt=""
          loading="lazy"
          onError={() => setFailed(true)}
        />
      </button>
      {zoomed && (
        <div
          className={styles.lightboxOverlay}
          role="dialog"
          aria-modal="true"
          aria-label="Foto ampliada do anúncio"
          onClick={() => setZoomed(false)}
        >
          <div className={styles.lightboxBox} onClick={(e) => e.stopPropagation()}>
            <img className={styles.lightboxImg} src={src} alt={label ?? ""} />
            {label && <p className={styles.lightboxCaption}>{label}</p>}
            <p className={styles.lightboxHint}>
              Miniatura do marketplace — é a mesma imagem usada na comparação automática.
            </p>
            <button
              type="button"
              className={styles.lightboxClose}
              onClick={() => setZoomed(false)}
            >
              <X size={13} /> Fechar
            </button>
          </div>
        </div>
      )}
    </>
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
/**
 * Popularidade do anúncio de onde o preço saiu (set/2026) — avaliações na
 * Amazon, vendas no Mercado Livre. O dado já era extraído e já pesava no
 * desempate entre candidatos (`popularityScore` em rankCandidates.ts),
 * mas nunca chegava à tela: o usuário via um preço sem saber se ele vem
 * de um anúncio que vende de verdade ou de um anúncio parado com preço
 * inventado. Ganha importância quando a fonte não devolve link (aí a
 * popularidade e a foto são a única conferência possível).
 *
 * O campo é o mesmo (`reviewCount`) pros dois casos porque o sinal é o
 * mesmo — "quanta gente passou por esse anúncio" —; só o rótulo muda por
 * marketplace, senão a tela mentiria dizendo "avaliações" pra um número
 * que no ML é venda.
 */
export function PopularityBadge({
  reviewCount,
  rating,
  marketplace,
}: {
  reviewCount?: number;
  rating?: number;
  marketplace: MarketplaceId;
}) {
  if ((reviewCount == null || reviewCount <= 0) && rating == null) return null;

  const isSales = marketplace === "mercadolivre";
  const noun = isSales ? "vendas" : "avaliações";
  const parts: string[] = [];
  if (reviewCount != null && reviewCount > 0) parts.push(`${reviewCount.toLocaleString("pt-BR")} ${noun}`);
  if (rating != null) parts.push(`nota ${rating.toFixed(1).replace(".", ",")} de 5`);

  return (
    <span
      className={styles.popularityBadge}
      title={`Anúncio com ${parts.join(" · ")} — sinal de que o preço vem de oferta com procura real, não de anúncio parado.`}
    >
      {isSales ? <Flame size={10} /> : <Star size={10} />}
      {reviewCount != null && reviewCount > 0 ? formatCompactCount(reviewCount) : rating?.toFixed(1).replace(".", ",")}
    </span>
  );
}

/** "1.2 mil" em vez de "1.240" — a coluna Status é estreita e o número exato já está no title do badge. */
function formatCompactCount(count: number): string {
  if (count < 1000) return String(count);
  const thousands = count / 1000;
  return `${thousands.toFixed(thousands < 10 ? 1 : 0).replace(".", ",")} mil`;
}

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
/**
 * Motivo específico quando o preço não fecha com o custo do catálogo
 * (set/2026, ver api/_lib/priceSanity.ts). Tem prioridade sobre o texto
 * genérico da tag: "esse preço não bate com o seu custo" é acionável;
 * "match aproximado" sozinho não diz o que conferir.
 */
const PRICE_SANITY_TITLE: Record<NonNullable<MarginResult["priceSanityFlag"]>, string> = {
  abaixo_do_custo:
    "Preço bem ABAIXO do seu custo de fornecedor — normalmente o anúncio é de um acessório, peça avulsa " +
    "ou produto parecido, não do produto do catálogo. Abra o anúncio antes de considerar esse preço.",
  muito_acima_do_custo:
    "Preço muitas vezes ACIMA do seu custo — pode ser lote/atacado que o título não declarou, ou um " +
    "produto diferente com nome parecido. Abra o anúncio antes de considerar esse preço.",
};

export function ApproximateBadge({
  matchedSource,
  priceSanityFlag,
}: {
  matchedSource?: string;
  priceSanityFlag?: MarginResult["priceSanityFlag"];
}) {
  return (
    <span
      className={styles.approxBadge}
      title={
        priceSanityFlag
          ? PRICE_SANITY_TITLE[priceSanityFlag]
          : matchedSource
            ? `Match aproximado — preço encontrado em "${matchedSource}", não no marketplace selecionado. ` +
              "Confira o anúncio antes de usar como referência."
            : "Match aproximado — o produto encontrado pode não ser exatamente o do seu catálogo. Confira o anúncio."
      }
    >
      <AlertTriangle size={10} /> {priceSanityFlag ? "Preço suspeito" : "Aproximado"}
    </span>
  );
}

/**
 * Preço de mercado + nota de lote (set/2026, ver packQuantity.ts e
 * docs/auditoria-2026-09.md > item 10).
 *
 * O número em destaque é sempre o preço POR UNIDADE — é ele que é
 * comparável com o custo unitário do catálogo e o que entra na margem.
 * Quando o anúncio encontrado vende lote ("kit com 12"), a segunda linha
 * mostra o preço cheio do anúncio e a quantidade: sem isso o usuário
 * abriria o link, veria R$ 120 onde a tabela diz R$ 10, e perderia a
 * confiança no número (com razão).
 */
export function MarketPrice({ result }: { result: Pick<MarginResult, "marketplacePrice" | "packQuantity" | "listingPrice"> }) {
  return (
    <>
      R$ {result.marketplacePrice.toFixed(2)}
      {result.packQuantity != null && result.listingPrice != null && (
        <span
          className={styles.packNote}
          title={
            `O anúncio vende um lote de ${result.packQuantity} unidades por ` +
            `R$ ${result.listingPrice.toFixed(2)}. O valor em destaque é o preço por unidade — ` +
            "é o único comparável com o custo unitário do seu catálogo, e é o que entra no cálculo de margem."
          }
        >
          lote de {result.packQuantity} · R$ {result.listingPrice.toFixed(2)} no anúncio
        </span>
      )}
    </>
  );
}

/**
 * Coluna de confiança + de ONDE ela veio (set/2026, ver `confidenceSource`
 * em types/index.ts). O número sozinho era ambíguo: 62% por semelhança de
 * NOME e 62% por confirmação da FOTO são coisas muito diferentes na hora
 * de decidir compra — a primeira pode ser um produto homônimo, a segunda
 * teve a imagem comparada. O sufixo é discreto (a coluna é estreita) e o
 * tooltip explica.
 */
function ConfidenceCell({
  confidence,
  source,
}: {
  confidence: number;
  source?: MarginResult["confidenceSource"];
}) {
  return (
    <td
      title={
        source === "visual"
          ? "Match confirmado comparando a FOTO do catálogo com a foto do anúncio."
          : source === "texto"
            ? "Match decidido por semelhança entre o NOME do catálogo e o título do anúncio — a foto não entrou na decisão."
            : undefined
      }
    >
      {(confidence * 100).toFixed(0)}%
      {source && <span className={styles.confidenceSource}>{source === "visual" ? "foto" : "nome"}</span>}
    </td>
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

/**
 * Coluna de preço sugerido (set/2026, ver `suggestedPrice` em types/index.ts
 * e `resolveSuggestedPrice` em marginCalculator.ts): o preço de venda que
 * bate exatamente a margem-alvo configurada em Precificação, dado o custo
 * do fornecedor + taxas/impostos habilitados + frete. Até agora a tela só
 * classificava o preço de MERCADO já encontrado (badge recomendado/
 * revisar/evitar) — não existia um número dizendo POR QUANTO vender.
 *
 * A nota abaixo do valor compara com `marketplacePrice` (o preço já
 * encontrado no anúncio): acima dele significa que bater a meta exigiria
 * cobrar mais caro que a concorrência pratica hoje — é o motivo concreto
 * por trás de um "revisar"/"evitar", não só o rótulo.
 */
function SuggestedPriceCell({
  suggestedPrice,
  marketplacePrice,
}: {
  suggestedPrice?: number;
  marketplacePrice: number;
}) {
  if (suggestedPrice == null) {
    return (
      <td>
        <span
          className={styles.noLink}
          title="Não deu pra calcular — as taxas e impostos habilitados em Precificação somam 100% ou mais do preço de venda. Revise as taxas em Precificação."
        >
          —
        </span>
      </td>
    );
  }

  const diff = Number((suggestedPrice - marketplacePrice).toFixed(2));
  const withinMarket = diff <= 0;

  return (
    <td>
      R$ {suggestedPrice.toFixed(2)}
      <span
        className={`${styles.suggestedPriceNote} ${withinMarket ? styles.suggestedPriceOk : styles.suggestedPriceHigh}`}
        title={
          withinMarket
            ? "Pra bater sua margem-alvo, dá pra vender igual ou abaixo do preço de mercado encontrado."
            : `Pra bater sua margem-alvo, precisaria vender R$ ${diff.toFixed(2)} ACIMA do preço de mercado encontrado — acima da concorrência.`
        }
      >
        {withinMarket ? "dentro do mercado" : `+R$ ${diff.toFixed(2)} vs. mercado`}
      </span>
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
  geral: "Lojas gerais",
};

// Quebrado em dois grupos (em vez de um `SORTABLE_COLUMNS` só) porque a
// coluna "Preço sugerido" (set/2026, ver SuggestedPriceCell) entra ENTRE
// Preço e Margem no cabeçalho da visão flat, e ela não é sortável (não
// tem `SortKey` — é derivada, não um dado bruto do resultado).
const PRICE_SORTABLE_COLUMNS: { key: SortKey; label: string }[] = [
  { key: "supplierPrice", label: "Custo" },
  { key: "marketplacePrice", label: "Preço" },
];
const QUALITY_SORTABLE_COLUMNS: { key: SortKey; label: string }[] = [
  { key: "marginPct", label: "Margem" },
  { key: "confidence", label: "Confiança" },
];

/** Cabeçalho ordenável — extraído pra reaproveitar entre os dois grupos acima sem duplicar o JSX do botão/ícone de ordenação. */
function SortableHeader({
  col,
  sortKey,
  sortDir,
  onSort,
}: {
  col: { key: SortKey; label: string };
  sortKey: SortKey;
  sortDir: SortDir;
  onSort: (key: SortKey) => void;
}) {
  return (
    <th>
      <button type="button" className={styles.sortButton} onClick={() => onSort(col.key)}>
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
  );
}

// Catálogos grandes (a motivação original do parser de PDF/CSV) passam
// de 100-200 linhas fácil — renderizar tudo de uma vez deixa a tabela
// pesada sem necessidade, já que só a página visível importa pra tela.
const PAGE_SIZE = 50;

export default function ResultsTable({
  results,
  targetMarginPct,
  source,
  history = [],
  selectedHistoryIds = [],
  onSelectHistoryMultiple,
  showCharts = true,
  compareSideBySide = false,
  groupBySku = false,
  isPricingDirty = false,
  onSyncPricing,
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

  // Número com vírgula decimal (padrão BR) — só faz sentido combinado com
  // `;` como delimitador do CSV (ver handleExportCsv). Ponto decimal +
  // vírgula delimitadora é a combinação que faz o Excel configurado em
  // pt-BR (padrão de quem usa este app) abrir o arquivo com tudo numa
  // coluna só — a causa mais comum de "a exportação saiu desorganizada".
  function formatNumberBR(value: number, digits: number): string {
    return value.toFixed(digits).replace(".", ",");
  }

  function handleExportCsv() {
    const rows = filtered.map((r) => ({
      SKU: r.sku,
      Produto: r.name,
      Marketplace: MARKETPLACE_LABEL[r.marketplace],
      "Custo (R$)": r.supplierPrice != null ? formatNumberBR(r.supplierPrice, 2) : "",
      // Preço POR UNIDADE (ver MarketPrice acima) — as duas colunas
      // seguintes só vêm preenchidas quando o anúncio é lote, pra quem
      // analisa a planilha fora do app conseguir refazer a conta.
      "Preço (R$)": formatNumberBR(r.marketplacePrice, 2),
      "Lote (un.)": r.packQuantity ?? "",
      "Preço do anúncio (R$)": r.listingPrice != null ? formatNumberBR(r.listingPrice, 2) : "",
      // Preço que bate a margem-alvo configurada — ver suggestedPrice em
      // types/index.ts. Vazio nos mesmos casos que a coluna de margem
      // (catálogo "sem_custo") ou quando a config de taxas é inconsistente
      // (ver resolveSuggestedPrice, marginCalculator.ts).
      "Preço sugerido (R$)": r.suggestedPrice != null ? formatNumberBR(r.suggestedPrice, 2) : "",
      "Margem (%)": r.marginPct != null ? formatNumberBR(r.marginPct * 100, 1) : "",
      "Confiança (%)": Math.round(r.confidence * 100).toString(),
      "Confiança veio de": r.confidenceSource === "visual" ? "foto" : r.confidenceSource === "texto" ? "nome" : "",
      Recomendação: BADGE_LABEL[r.recommendation],
      Concorrentes: r.competitorCount,
      "Elegível Buy Box": r.buyBoxEligible ? "Sim" : "Não",
      // Popularidade do anúncio de origem — no ML o número é VENDAS, na
      // Amazon é AVALIAÇÕES (ver PopularityBadge); o cabeçalho diz os
      // dois pra planilha não induzir a leitura errada fora do app.
      "Vendas/avaliações do anúncio": r.reviewCount ?? "",
      "Nota do anúncio": r.rating != null ? formatNumberBR(r.rating, 1) : "",
      // Match aproximado precisa sobreviver à exportação — quem analisa
      // a planilha fora do app não pode confundir chute com match real.
      Aproximado: r.approximate ? "Sim" : "Não",
      "Loja de origem": r.matchedSource ?? "",
      Link: r.link ?? "",
    }));

    // Exporta o conjunto FILTRADO (respeita busca/status ativos na
    // tela), não paginado — quem exporta quer o recorte inteiro que
    // está olhando, não só a página visível. Delimitador `;` (não `,`,
    // o default do Papa) — Excel com Windows/config regional pt-BR
    // (o caso comum de quem usa este app) reconhece `;` como separador
    // de coluna nativamente ao abrir um .csv por duplo-clique; com `,`
    // ele tratava o arquivo inteiro como uma coluna só, com os números
    // decimais (que agora usam vírgula, ver formatNumberBR) picotando
    // linhas no meio. BOM (﻿) já presente segue garantindo que
    // acento/caractere especial abra certo no Excel também.
    const csv = Papa.unparse(rows, { delimiter: ";" });
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
        {history.length > 0 && onSelectHistoryMultiple && (
          <HistoryMultiSelect
            history={history}
            selectedIds={selectedHistoryIds}
            onChange={onSelectHistoryMultiple}
          />
        )}
      </div>

      {onSyncPricing && (
        <div className={isPricingDirty ? styles.syncBannerDirty : styles.syncBanner}>
          <span className={styles.syncBannerText}>
            {isPricingDirty
              ? "Sua Precificação (taxa de venda, margem-alvo etc) mudou desde a última vez que esta tela foi calculada."
              : "Margem, preço sugerido e recomendação já refletem sua Precificação atual."}
          </span>
          <button
            type="button"
            className={styles.syncButton}
            onClick={onSyncPricing}
            disabled={!isPricingDirty}
            title={
              isPricingDirty
                ? "Recalcula margem, preço sugerido e recomendação de todas as linhas com a Precificação atual"
                : "Nada pra sincronizar — já está atualizado"
            }
          >
            <RefreshCw size={13} /> Sincronizar com Precificação
          </button>
        </div>
      )}

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
                  {PRICE_SORTABLE_COLUMNS.map((col) => (
                    <SortableHeader key={col.key} col={col} sortKey={sortKey} sortDir={sortDir} onSort={handleSort} />
                  ))}
                  <th>Preço sugerido</th>
                  {QUALITY_SORTABLE_COLUMNS.map((col) => (
                    <SortableHeader key={col.key} col={col} sortKey={sortKey} sortDir={sortDir} onSort={handleSort} />
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
                      <ProductThumb src={r.imageUrl} label={r.matchedTitle ?? r.name} />
                    </td>
                    <td>{r.sku}</td>
                    <td className={styles.productCell}>
                      <div className={styles.productName} title={r.name}>
                        {r.name}
                        {r.approximate && (
                          <ApproximateBadge
                            matchedSource={r.matchedSource}
                            priceSanityFlag={r.priceSanityFlag}
                          />
                        )}
                      </div>
                      <SourceUploadTag sourceUpload={r.sourceUpload} />
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
                    <td>
                      <MarketPrice result={r} />
                    </td>
                    <SuggestedPriceCell suggestedPrice={r.suggestedPrice} marketplacePrice={r.marketplacePrice} />
                    <MarginCell
                      marginPct={r.marginPct}
                      targetMarginPct={targetMarginPct}
                      recommendation={r.recommendation}
                    />
                    <ConfidenceCell confidence={r.confidence} source={r.confidenceSource} />
                    <td>
                      <span className={`${styles.badge} ${BADGE_CLASS[r.recommendation]}`}>
                        {BADGE_LABEL[r.recommendation]}
                      </span>
                      <CompetitionBadge
                        competitorCount={r.competitorCount}
                        buyBoxEligible={r.buyBoxEligible}
                      />
                      <PopularityBadge
                        reviewCount={r.reviewCount}
                        rating={r.rating}
                        marketplace={r.marketplace}
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
                        <ProductThumb src={best.imageUrl} label={best.matchedTitle ?? best.name} />
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
                        <SourceUploadTag sourceUpload={best.sourceUpload} />
                      </td>
                      {marketplacesPresent.map((m) => {
                        const offer = byMarket.get(m);
                        return (
                          <td key={m}>
                            {offer ? (
                              <>
                                <MarketPrice result={offer} />
                                <span className={styles.marginValue}>
                                  {offer.marginPct != null
                                    ? `${(offer.marginPct * 100).toFixed(1)}% margem`
                                    : "sem custo"}
                                </span>
                                {offer.suggestedPrice != null && (
                                  <span
                                    className={styles.marginValue}
                                    title="Preço de venda que bate exatamente sua margem-alvo (Precificação) neste marketplace."
                                  >
                                    sugerido: R$ {offer.suggestedPrice.toFixed(2)}
                                  </span>
                                )}
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
                        <PopularityBadge
                          reviewCount={best.reviewCount}
                          rating={best.rating}
                          marketplace={best.marketplace}
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
                  <th>Preço sugerido</th>
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
                          <ProductThumb src={best.imageUrl} label={best.matchedTitle ?? best.name} />
                        </td>
                        <td>{best.sku}</td>
                        <td className={styles.productCell}>
                          <div className={styles.productName} title={best.name}>
                            {best.name}
                            {best.approximate && (
                              <ApproximateBadge
                                matchedSource={best.matchedSource}
                                priceSanityFlag={best.priceSanityFlag}
                              />
                            )}
                          </div>
                          <SourceUploadTag sourceUpload={best.sourceUpload} />
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
                        <td>
                          <MarketPrice result={best} />
                        </td>
                        <SuggestedPriceCell suggestedPrice={best.suggestedPrice} marketplacePrice={best.marketplacePrice} />
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
                          <PopularityBadge
                            reviewCount={best.reviewCount}
                            rating={best.rating}
                            marketplace={best.marketplace}
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
                              <SourceUploadTag sourceUpload={r.sourceUpload} />
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
                            <td>
                              <MarketPrice result={r} />
                            </td>
                            <SuggestedPriceCell suggestedPrice={r.suggestedPrice} marketplacePrice={r.marketplacePrice} />
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
                              <PopularityBadge
                                reviewCount={r.reviewCount}
                                rating={r.rating}
                                marketplace={r.marketplace}
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
