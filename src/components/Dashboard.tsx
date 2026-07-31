import { useEffect, useState, type DragEvent } from "react";
import { motion } from "framer-motion";
import {
  UploadCloud,
  Loader2,
  Download,
  AlertCircle,
  FileText,
  History,
  Check,
  Store,
  ShoppingBag,
  Search,
  Calculator,
  Library,
  Camera,
} from "lucide-react";
import type {
  CatalogRow,
  MarginResult,
  MarketplaceId,
  MarketplacePriceResult,
  PricingRules,
  SearchProviderId,
} from "../types";
import { parseCatalogFile } from "../lib/parseCatalog";
import { getPdfPageCount, parsePdfCatalogFile, type PageRange } from "../lib/parsePdfCatalog";
import { fetchMultipleMarketplacePrices } from "../lib/priceApi";
import { calculateMargins } from "../lib/marginCalculator";
import {
  computeFileHash,
  findExistingUpload,
  listCatalogUploads,
  saveCatalogUpload,
  type CatalogUploadRecord,
} from "../lib/catalogHistory";
import { listSharedCatalogsForPlan, type SharedCatalog } from "../lib/sharedCatalogs";
import { getTodayUsage, addTodayUsage } from "../lib/usageQuota";
import { getUserSerpApiKey, getUserRapidApiKey } from "../lib/userSecrets";
import { getPlan } from "../config/plans";
import type { UserProfile } from "../lib/userProfile";
import styles from "./Dashboard.module.css";

type UploadState = "idle" | "parsing" | "fetching" | "error";
type SourceType = "csv" | "pdf";
interface ParseOutcome {
  rows: CatalogRow[];
  skippedAmbiguous: number;
  /** Só preenchido quando o parse rodou em modo imagem (PDF) — ver processFile. */
  imagesBySku?: Record<string, string>;
}

// Marketplaces disponíveis pra seleção. Shopee entra aqui quando tiver
// provider registrado (ver ADR-0001) — nenhum outro código muda. Os
// dois buscam via Google Shopping (SerpApi) quando rodando com
// `vercel dev`/deploy — usando a chave SerpApi PRÓPRIA do usuário
// (BYOK, ver userSecrets.ts e o gate em finishWithRows). Sem `vercel
// dev` (npm run dev puro), caem no mock local só pra permitir testar a
// UI sem servidor — não é mais possível usar uma chave compartilhada.
const AVAILABLE_MARKETPLACES: {
  id: MarketplaceId;
  label: string;
  note: string;
  icon: typeof Store;
}[] = [
  { id: "mercadolivre", label: "Mercado Livre", note: "real com servidor", icon: Store },
  { id: "amazon", label: "Amazon", note: "real com servidor", icon: ShoppingBag },
];

// Qual API resolve o preço — eixo INDEPENDENTE de marketplace (ver
// SearchProviderId em ../types e o comentário em api/fetch-prices.ts).
// SerpApi cobre os dois marketplaces numa busca só; os providers
// "diretos" cobrem só um marketplace fixo cada, então escolher um deles
// já define `selectedMarketplaces` sozinho (ver selectProvider).
const SEARCH_PROVIDERS: {
  id: SearchProviderId;
  label: string;
  note: string;
  marketplaces: MarketplaceId[];
  icon: typeof Store;
  needsKey: "serpApiKey" | "rapidApiKey" | null;
}[] = [
  {
    id: "serpapi",
    label: "SerpApi (Google Shopping)",
    note: "Amazon + Mercado Livre juntos",
    marketplaces: ["mercadolivre", "amazon"],
    icon: Search,
    needsKey: "serpApiKey",
  },
  {
    id: "rapidapi_amazon",
    label: "Amazon direto (RapidAPI)",
    note: "só Amazon · grátis até 100 buscas/mês",
    marketplaces: ["amazon"],
    icon: ShoppingBag,
    needsKey: "rapidApiKey",
  },
  {
    id: "mercadolivre_direct",
    label: "Mercado Livre (API pública)",
    note: "só Mercado Livre · sem chave, mas instável",
    marketplaces: ["mercadolivre"],
    icon: Store,
    needsKey: null,
  },
  {
    id: "google_lens_products",
    label: "Busca por imagem (Google Lens)",
    note: "Amazon + Mercado Livre · usa a foto do catálogo, não o nome",
    marketplaces: ["mercadolivre", "amazon"],
    icon: Camera,
    needsKey: "serpApiKey",
  },
];

// "Busca por imagem" só funciona com PDF que tem foto de produto — CSV
// nunca tem imagem pra extrair. Nome genérico ("Faca de corte") busca
// qualquer coisa por TEXTO; por foto, o critério de match é visual —
// ver api/_lib/providers/googleLensProvider.ts.
const IMAGE_MODE_PROVIDER: SearchProviderId = "google_lens_products";

const STEP_ICONS = [UploadCloud, Search, Calculator];

// Tamanho do lote de busca — catálogos grandes são processados em
// lotes sequenciais (não tudo de uma vez) só pra reportar progresso
// real na UI (ver `progress` state em finishWithRows). Cada lote já
// usa concorrência 5 no servidor (googleShoppingProvider.ts), então
// isso não muda o paralelismo real, só a granularidade do feedback.
const CHUNK_SIZE = 20;

export interface DashboardResult {
  rows: CatalogRow[];
  pricesByMarket: Partial<Record<MarketplaceId, Record<string, MarketplacePriceResult>>>;
  results: MarginResult[];
  source: "server" | "local";
}

interface Props {
  rules: PricingRules;
  userId: string | null;
  profile: UserProfile | null;
  onComplete: (result: DashboardResult) => void;
}

interface LastUpload {
  file: File;
  sourceType: SourceType;
  pageRange: PageRange | null;
}

export default function Dashboard({ rules, userId, profile, onComplete }: Props) {
  const [state, setState] = useState<UploadState>("idle");
  const [error, setError] = useState<string | null>(null);
  const [historyInfo, setHistoryInfo] = useState<string | null>(null);
  const [skippedInfo, setSkippedInfo] = useState<string | null>(null);
  const [dragActive, setDragActive] = useState(false);

  // Escolha de marketplace — evita processar um marketplace que o
  // usuário não pediu. Default: os dois marcados (SerpApi cobre os dois
  // numa busca só). Ao trocar de provider pra um "direto" (RapidAPI
  // Amazon, Mercado Livre público), fica travado no único marketplace
  // que aquele provider cobre — ver selectProvider.
  const [selectedMarketplaces, setSelectedMarketplaces] = useState<MarketplaceId[]>([
    "mercadolivre",
    "amazon",
  ]);

  // Qual API usar pra essa busca — ver SEARCH_PROVIDERS acima. Escolhido
  // por busca, não fixo por conta (pedido explícito: "hoje quero amazon
  // aí amanhã uso a de mercado livre e depois a serp").
  const [searchProvider, setSearchProvider] = useState<SearchProviderId>("serpapi");

  const [pendingPdf, setPendingPdf] = useState<File | null>(null);
  const [pdfPageCount, setPdfPageCount] = useState<number | null>(null);
  const [pageFrom, setPageFrom] = useState(1);
  const [pageTo, setPageTo] = useState(1);

  const [lastUpload, setLastUpload] = useState<LastUpload | null>(null);
  const [uploadHistory, setUploadHistory] = useState<CatalogUploadRecord[]>([]);
  const [historyLoading, setHistoryLoading] = useState(false);

  // Biblioteca administrável (Fase Planos) — catálogos que o admin
  // liberou pro plano do usuário logado. Recarrega quando o plano muda
  // (ex.: admin trocou o plano da conta em outra aba).
  const [libraryCatalogs, setLibraryCatalogs] = useState<SharedCatalog[]>([]);
  const [libraryLoading, setLibraryLoading] = useState(false);

  // Cota diária de buscas do plano — ver config/plans.ts e usageQuota.ts.
  const [todayUsage, setTodayUsage] = useState<number | null>(null);

  // BYOK — chave SerpApi própria do usuário (Conta). Presente = busca usa
  // a cota da própria conta SerpApi do usuário, não a compartilhada do
  // app, e por isso não entra no enforcement de `usage_daily` abaixo.
  const [serpApiKey, setSerpApiKey] = useState<string | null>(null);

  // BYOK — chave RapidAPI própria (Amazon direto). Mesma lógica da
  // SerpApi acima, provider diferente.
  const [rapidApiKey, setRapidApiKey] = useState<string | null>(null);

  // Progresso real da busca (item 8+9 do roadmap) — preenchido só
  // durante state === "fetching", em lotes de CHUNK_SIZE produtos.
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);

  useEffect(() => {
    if (!userId) {
      setSerpApiKey(null);
      return;
    }
    getUserSerpApiKey(userId).then(setSerpApiKey);
  }, [userId]);

  useEffect(() => {
    if (!userId) {
      setRapidApiKey(null);
      return;
    }
    getUserRapidApiKey(userId).then(setRapidApiKey);
  }, [userId]);

  useEffect(() => {
    if (!userId) {
      setUploadHistory([]);
      return;
    }
    setHistoryLoading(true);
    listCatalogUploads(userId)
      .then(setUploadHistory)
      .finally(() => setHistoryLoading(false));
  }, [userId]);

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
      setTodayUsage(null);
      return;
    }
    getTodayUsage(userId).then(setTodayUsage);
  }, [userId]);

  const activeStep = state === "parsing" ? 0 : state === "fetching" ? 1 : -1;
  const marketplaceLabels = AVAILABLE_MARKETPLACES.filter((m) =>
    selectedMarketplaces.includes(m.id)
  )
    .map((m) => m.label)
    .join(" + ");

  const STEPS = [
    { label: "Upload do catálogo" },
    { label: marketplaceLabels ? `Buscamos preço (${marketplaceLabels})` : "Selecione um marketplace" },
    { label: "Calculamos a margem ideal" },
  ];

  const lastRun = uploadHistory[0] ?? null;
  const uniqueMarketplaces = new Set(uploadHistory.flatMap((h) => h.marketplaces ?? []));

  const plan = getPlan(profile?.plan);

  const activeProvider = SEARCH_PROVIDERS.find((p) => p.id === searchProvider)!;
  // Chave exigida pelo provider ativo — "mercadolivre_direct" não pede
  // nenhuma (endpoint público), os outros dois pedem a própria (BYOK).
  const activeProviderKey =
    activeProvider.needsKey === "serpApiKey"
      ? serpApiKey
      : activeProvider.needsKey === "rapidApiKey"
        ? rapidApiKey
        : null;
  const hasRequiredKey = activeProvider.needsKey === null || Boolean(activeProviderKey);

  function toggleMarketplace(id: MarketplaceId) {
    setSelectedMarketplaces((prev) =>
      prev.includes(id) ? prev.filter((m) => m !== id) : [...prev, id]
    );
  }

  /**
   * Troca de provider — providers "diretos" (RapidAPI Amazon, Mercado
   * Livre público) só cobrem 1 marketplace fixo cada, então travam
   * `selectedMarketplaces` sozinhos. "serpapi" e "google_lens_products"
   * cobrem os dois marketplaces (amazon + mercadolivre) numa busca só —
   * os dois deixam o usuário escolher um subconjunto via checkboxes (ver
   * subGroup na seção 01), não travam a seleção.
   */
  function selectProvider(id: SearchProviderId) {
    setSearchProvider(id);
    const config = SEARCH_PROVIDERS.find((p) => p.id === id)!;
    const isMultiMarketplace = id === "serpapi" || id === "google_lens_products";
    if (!isMultiMarketplace) {
      setSelectedMarketplaces(config.marketplaces);
    } else if (selectedMarketplaces.length === 0) {
      setSelectedMarketplaces(["mercadolivre", "amazon"]);
    }
  }

  function loadHistoryRecord(record: CatalogUploadRecord) {
    setHistoryInfo(null);
    setSkippedInfo(null);
    onComplete({
      rows: record.rows,
      pricesByMarket: record.pricesByMarket,
      results: record.results,
      source: record.source,
    });
  }

  /**
   * Usa um catálogo da biblioteca (já parseado pelo admin) — sem File
   * local, então o "hash" é sintético (`shared:{id}`), o que também
   * dedupe automaticamente via o mesmo `catalog_uploads`/`findExistingUpload`
   * usado pra upload próprio: dois usuários do mesmo plano rodando o
   * mesmo catálogo da biblioteca não pagam busca em dobro se um já
   * processou antes (cache por usuário, não global — ver catalogHistory.ts).
   */
  async function processSharedCatalog(catalog: SharedCatalog) {
    if (selectedMarketplaces.length === 0) {
      setError("Selecione ao menos um marketplace antes de usar um catálogo da biblioteca.");
      return;
    }

    setError(null);
    setHistoryInfo(null);
    setSkippedInfo(null);
    setLastUpload(null);

    const fileHash = `shared:${catalog.id}`;

    try {
      setState("parsing");
      const existing = await findExistingUpload(userId, fileHash, null, selectedMarketplaces);

      if (existing) {
        setState("idle");
        const when = new Date(existing.uploadedAt).toLocaleString("pt-BR");
        setHistoryInfo(`Carregado do histórico — este catálogo já foi buscado em ${when}.`);
        loadHistoryRecord(existing);
        return;
      }

      await finishWithRows(catalog.rows, {
        fileName: catalog.fileName,
        fileHash,
        sourceType: "pdf",
        pageRange: null,
        marketplaces: selectedMarketplaces,
      });
    } catch (err) {
      setState("error");
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  async function finishWithRows(
    rows: CatalogRow[],
    meta: {
      fileName: string;
      fileHash: string;
      sourceType: SourceType;
      pageRange: PageRange | null;
      marketplaces: MarketplaceId[];
    },
    imagesBySku?: Record<string, string>
  ) {
    // BYOK obrigatório pros providers que pedem chave (SerpApi,
    // RapidAPI) — não existe mais chave compartilhada do servidor pra
    // nenhum dos dois. Mercado Livre direto não pede chave (endpoint
    // público). Sem usuário logado ou sem a chave que ESSE provider
    // exige, a busca nem começa: bloqueia aqui, num único ponto, em vez
    // de deixar a API de terceiro falhar lá na frente com erro genérico.
    if (!userId) {
      setState("error");
      setError("Faça login (ou crie uma conta) em Conta antes de buscar preço.");
      return;
    }
    if (!hasRequiredKey) {
      setState("error");
      setError(
        activeProvider.needsKey === "serpApiKey"
          ? "Cadastre sua chave SerpApi em Conta antes de buscar preço (veja o card \"Sua chave SerpApi\")."
          : "Cadastre sua chave RapidAPI em Conta antes de buscar preço (veja o card \"Sua chave RapidAPI\")."
      );
      return;
    }
    if (searchProvider === IMAGE_MODE_PROVIDER && (!imagesBySku || Object.keys(imagesBySku).length === 0)) {
      setState("error");
      setError(
        "Não consegui extrair/subir nenhuma foto deste PDF (recorte ou upload falhou pra todo " +
          "mundo) — troque pra SerpApi/RapidAPI, que buscam por texto, ou tente reprocessar."
      );
      return;
    }

    const searchCost = rows.length * meta.marketplaces.length;
    setState("fetching");
    setProgress({ done: 0, total: rows.length });

    const pricesByMarket: Partial<Record<MarketplaceId, Record<string, MarketplacePriceResult>>> =
      {};
    for (const marketplace of meta.marketplaces) pricesByMarket[marketplace] = {};
    let allFromServer = true;

    // Lotes sequenciais (não um Promise.all de tudo de uma vez) — cada
    // chamada já cobre todos os marketplaces pedidos numa chamada HTTP
    // só (ver priceApi.ts e docs/architecture-review.md item 15), e
    // processar em lotes dá progresso real na UI pra catálogo grande em
    // vez de um spinner genérico (item 8+9). Concorrência de verdade
    // continua no servidor (mapWithConcurrency, googleShoppingProvider.ts) —
    // isso aqui é só granularidade de feedback, não paralelismo extra.
    try {
      const chunks: CatalogRow[][] = [];
      for (let i = 0; i < rows.length; i += CHUNK_SIZE) chunks.push(rows.slice(i, i + CHUNK_SIZE));

      for (const chunk of chunks) {
        const chunkItems = chunk.map((r) => ({
          sku: r.sku,
          name: r.name,
          imageUrl: imagesBySku?.[r.sku],
        }));
        const fetched = await fetchMultipleMarketplacePrices(
          meta.marketplaces,
          chunkItems,
          activeProviderKey,
          searchProvider
        );

        for (const marketplace of meta.marketplaces) {
          const { results: prices, source } = fetched[marketplace];
          pricesByMarket[marketplace] = { ...pricesByMarket[marketplace], ...prices };
          if (source !== "server") allFromServer = false;
        }

        setProgress((p) =>
          p ? { done: Math.min(p.done + chunk.length, rows.length), total: rows.length } : p
        );
      }
    } finally {
      setProgress(null);
    }

    let allResults: MarginResult[] = [];
    for (const marketplace of meta.marketplaces) {
      allResults = allResults.concat(calculateMargins(rows, pricesByMarket[marketplace] ?? {}, rules));
    }

    const source = allFromServer ? "server" : "local";
    setState("idle");
    onComplete({ rows, pricesByMarket, results: allResults, source });

    if (userId) {
      void addTodayUsage(userId, searchCost);
      setTodayUsage((u) => (u ?? 0) + searchCost);
    }

    void saveCatalogUpload(userId, {
      fileName: meta.fileName,
      fileHash: meta.fileHash,
      sourceType: meta.sourceType,
      pageRange: meta.pageRange,
      marketplaces: meta.marketplaces,
      uploadedAt: Date.now(),
      rows,
      pricesByMarket,
      results: allResults,
      source,
    }).then(() => {
      if (userId) listCatalogUploads(userId).then(setUploadHistory);
    });
  }

  async function processFile(
    file: File,
    parse: () => Promise<ParseOutcome>,
    sourceType: SourceType,
    pageRange: PageRange | null
  ) {
    if (selectedMarketplaces.length === 0) {
      setError("Selecione ao menos um marketplace antes de enviar o catálogo.");
      return;
    }

    setError(null);
    setHistoryInfo(null);
    setSkippedInfo(null);
    setLastUpload({ file, sourceType, pageRange });

    try {
      setState("parsing");
      const fileHash = await computeFileHash(file);
      const existing = await findExistingUpload(userId, fileHash, pageRange, selectedMarketplaces);

      if (existing) {
        setState("idle");
        const when = new Date(existing.uploadedAt).toLocaleString("pt-BR");
        setHistoryInfo(`Carregado do histórico — este arquivo já foi processado em ${when}.`);
        loadHistoryRecord(existing);
        return;
      }

      const { rows, skippedAmbiguous, imagesBySku } = await parse();
      if (skippedAmbiguous > 0) {
        setSkippedInfo(
          `${rows.length} produto(s) reconhecido(s) — ${skippedAmbiguous} linha(s) ignorada(s) ` +
            "por ambiguidade (mais de um preço detectado na mesma linha, provável mescla de colunas)."
        );
      }
      await finishWithRows(
        rows,
        {
          fileName: file.name,
          fileHash,
          sourceType,
          pageRange,
          marketplaces: selectedMarketplaces,
        },
        imagesBySku
      );
    } catch (err) {
      setState("error");
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  async function handleForceReprocess() {
    if (!lastUpload) return;
    setError(null);
    setHistoryInfo(null);
    setSkippedInfo(null);

    const { file, sourceType, pageRange } = lastUpload;
    const withImages = sourceType === "pdf" && searchProvider === IMAGE_MODE_PROVIDER;
    const parse = (): Promise<ParseOutcome> =>
      sourceType === "pdf"
        ? parsePdfCatalogFile(file, pageRange ?? undefined, { withImages, userId: userId ?? undefined })
        : parseCatalogFile(file).then((rows) => ({ rows, skippedAmbiguous: 0 }));

    try {
      setState("parsing");
      const fileHash = await computeFileHash(file);
      const { rows, skippedAmbiguous, imagesBySku } = await parse();
      if (skippedAmbiguous > 0) {
        setSkippedInfo(
          `${rows.length} produto(s) reconhecido(s) — ${skippedAmbiguous} linha(s) ignorada(s) por ambiguidade.`
        );
      }
      await finishWithRows(
        rows,
        {
          fileName: file.name,
          fileHash,
          sourceType,
          pageRange,
          marketplaces: selectedMarketplaces,
        },
        imagesBySku
      );
    } catch (err) {
      setState("error");
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  async function handleCsv(file: File) {
    if (searchProvider === IMAGE_MODE_PROVIDER) {
      setError(
        "\"Busca por imagem\" precisa de foto do produto — catálogo .csv não tem. " +
          "Troque de provider ou suba um .pdf com foto."
      );
      return;
    }
    await processFile(
      file,
      () => parseCatalogFile(file).then((rows) => ({ rows, skippedAmbiguous: 0 })),
      "csv",
      null
    );
  }

  async function handlePdfSelected(file: File) {
    setError(null);
    try {
      const count = await getPdfPageCount(file);
      setPendingPdf(file);
      setPdfPageCount(count);
      setPageFrom(1);
      setPageTo(Math.min(10, count));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  async function handleProcessPdf() {
    if (!pendingPdf) return;
    const file = pendingPdf;
    const pageRange: PageRange = { from: pageFrom, to: pageTo };
    setPendingPdf(null);
    setPdfPageCount(null);
    const withImages = searchProvider === IMAGE_MODE_PROVIDER;
    await processFile(
      file,
      () =>
        parsePdfCatalogFile(file, pageRange, {
          withImages,
          userId: userId ?? undefined,
        }),
      "pdf",
      pageRange
    );
  }

  function handleFile(file: File) {
    const extension = file.name.split(".").pop()?.toLowerCase();
    if (extension === "pdf") void handlePdfSelected(file);
    else void handleCsv(file);
  }

  function handleDrop(event: DragEvent<HTMLLabelElement>) {
    event.preventDefault();
    setDragActive(false);
    const file = event.dataTransfer.files?.[0];
    if (file) handleFile(file);
  }

  return (
    <motion.div
      className={styles.container}
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.3, ease: [0.16, 1, 0.3, 1] }}
    >
      <div className={styles.header}>
        <div className={styles.headerMain}>
          <span className={styles.eyebrow}>Arbitragem de preços</span>
          <h1 className={styles.title}>Bancada de precificação</h1>
          <p className={styles.subtitle}>
            Suba um catálogo em .csv ou .pdf, escolha onde comparar e a gente devolve preço de
            mercado e margem produto por produto.
          </p>
        </div>
        <div className={styles.headerCard}>
          <span className={styles.headerCardRow}>
            <span className={`${styles.headerCardDot} ${styles.dotSuccess}`} />
            fonte <b className={styles.headerCardStrong}>{activeProvider.label}</b>
          </span>
          {userId && activeProvider.needsKey === "serpApiKey" && serpApiKey && todayUsage !== null && (
            <span className={styles.headerCardRow}>
              <span className={`${styles.headerCardDot} ${styles.dotAccent}`} />
              plano <b className={styles.headerCardStrong}>{plan.name}</b> · {todayUsage} busca(s)
              hoje
            </span>
          )}
        </div>
      </div>

      <div className={styles.layout}>
        <div className={styles.main}>
          <section className={styles.card}>
            <div className={styles.cardHeader}>
              <span className={styles.cardHeaderNumber}>01</span>
              <h2 className={styles.cardHeaderTitle}>Qual API usar</h2>
              <span className={styles.cardHeaderMeta}>
                {selectedMarketplaces.length} marketplace(s)
                {marketplaceLabels ? ` · ${marketplaceLabels}` : ""}
              </span>
            </div>
            <div className={styles.cardBody}>
              <div className={styles.marketplaceGrid}>
                {SEARCH_PROVIDERS.map((p) => {
                  const active = searchProvider === p.id;
                  const Icon = p.icon;
                  return (
                    <button
                      key={p.id}
                      type="button"
                      className={active ? styles.marketplaceCardActive : styles.marketplaceCard}
                      onClick={() => selectProvider(p.id)}
                    >
                      <span
                        className={active ? styles.marketplaceIconBoxActive : styles.marketplaceIconBox}
                      >
                        <Icon size={15} />
                      </span>
                      <span className={styles.marketplaceCardText}>
                        <span className={styles.marketplaceCardLabel}>{p.label}</span>
                        <span className={styles.marketplaceCardNote}>{p.note}</span>
                      </span>
                      {active && (
                        <span className={styles.marketplaceCardCheck}>
                          <Check size={11} strokeWidth={3} />
                        </span>
                      )}
                    </button>
                  );
                })}
              </div>

              {(searchProvider === "serpapi" || searchProvider === "google_lens_products") && (
                <div className={styles.subGroup}>
                  <span className={styles.subGroupLabel}>
                    onde comparar ({activeProvider.label} cobre os dois — escolha um ou os dois)
                  </span>
                  <div className={styles.marketplaceGrid}>
                    {AVAILABLE_MARKETPLACES.map((m) => {
                      const active = selectedMarketplaces.includes(m.id);
                      const Icon = m.icon;
                      return (
                        <button
                          key={m.id}
                          type="button"
                          className={active ? styles.marketplaceCardActive : styles.marketplaceCard}
                          onClick={() => toggleMarketplace(m.id)}
                        >
                          <span
                            className={active ? styles.marketplaceIconBoxActive : styles.marketplaceIconBox}
                          >
                            <Icon size={15} />
                          </span>
                          <span className={styles.marketplaceCardText}>
                            <span className={styles.marketplaceCardLabel}>{m.label}</span>
                            <span className={styles.marketplaceCardNote}>{m.note}</span>
                          </span>
                          {active && (
                            <span className={styles.marketplaceCardCheck}>
                              <Check size={11} strokeWidth={3} />
                            </span>
                          )}
                        </button>
                      );
                    })}
                  </div>
                </div>
              )}
            </div>
          </section>

          <section className={styles.card}>
            <div className={styles.cardHeader}>
              <span className={styles.cardHeaderNumber}>02</span>
              <h2 className={styles.cardHeaderTitle}>Catálogo</h2>
              <a className={styles.cardHeaderLink} href="/sample-catalog.csv" download>
                <Download size={11} /> baixar exemplo .csv
              </a>
            </div>
            <div className={styles.cardBody}>
              {pendingPdf ? (
                <motion.div
                  className={styles.pageRangePanel}
                  initial={{ opacity: 0, y: 6 }}
                  animate={{ opacity: 1, y: 0 }}
                >
                  <div className={styles.pageRangeHeader}>
                    <FileText size={16} />
                    <span>
                      {pendingPdf.name} · {pdfPageCount} páginas
                    </span>
                  </div>
                  <div className={styles.pageRangeInputs}>
                    <label>
                      Página inicial
                      <input
                        type="number"
                        min={1}
                        max={pdfPageCount ?? 1}
                        value={pageFrom}
                        onChange={(e) => setPageFrom(Number(e.target.value) || 1)}
                      />
                    </label>
                    <label>
                      Página final
                      <input
                        type="number"
                        min={1}
                        max={pdfPageCount ?? 1}
                        value={pageTo}
                        onChange={(e) => setPageTo(Number(e.target.value) || 1)}
                      />
                    </label>
                  </div>
                  {searchProvider === IMAGE_MODE_PROVIDER && (
                    <p className={styles.warningNote}>
                      <Camera size={13} style={{ verticalAlign: "-2px", marginRight: 4 }} />
                      Modo imagem ativo — vai renderizar cada página e subir uma foto por produto
                      antes de buscar. Mais lento que busca por texto.
                    </p>
                  )}
                  <div className={styles.pageRangeActions}>
                    <button
                      className={styles.button}
                      type="button"
                      onClick={() => void handleProcessPdf()}
                    >
                      Processar páginas {pageFrom}–{pageTo}
                    </button>
                    <button
                      className={styles.linkButton}
                      type="button"
                      onClick={() => {
                        setPendingPdf(null);
                        setPdfPageCount(null);
                      }}
                    >
                      Cancelar
                    </button>
                  </div>
                </motion.div>
              ) : (
                <label
                  className={
                    dragActive ? `${styles.dropzone} ${styles.dropzoneActive}` : styles.dropzone
                  }
                  onDragOver={(e) => {
                    e.preventDefault();
                    setDragActive(true);
                  }}
                  onDragLeave={() => setDragActive(false)}
                  onDrop={handleDrop}
                >
                  <span className={styles.dropzoneIconBox}>
                    <UploadCloud size={20} strokeWidth={2} />
                  </span>
                  <span className={styles.dropzoneText}>
                    <span className={styles.dropzoneTitle}>
                      Arraste o arquivo aqui ou escolha do computador
                    </span>
                    <span className={styles.dropzoneHint}>
                      .csv com sku/nome/custo · .pdf de catálogo (pede intervalo de páginas)
                    </span>
                  </span>
                  <span className={styles.dropzoneButton}>Escolher arquivo</span>
                  <input
                    className={styles.fileInput}
                    type="file"
                    accept=".csv,.pdf"
                    onChange={(e) => e.target.files?.[0] && handleFile(e.target.files[0])}
                  />
                </label>
              )}
            </div>

            {(state !== "idle" || error || historyInfo || skippedInfo || !userId || !hasRequiredKey) && (
              <div className={styles.cardFooter}>
                {state === "parsing" && (
                  <p className={styles.status}>
                    <Loader2 size={14} className="spin" /> Lendo catálogo…
                  </p>
                )}
                {state === "fetching" && (
                  <div className={styles.progressWrap}>
                    <p className={styles.status}>
                      <Loader2 size={14} className="spin" /> Buscando preço ({marketplaceLabels})
                      {progress ? ` — ${progress.done}/${progress.total} produtos` : "…"}
                    </p>
                    {progress && progress.total > 0 && (
                      <div className={styles.progressTrack}>
                        <div
                          className={styles.progressFill}
                          style={{ width: `${Math.round((progress.done / progress.total) * 100)}%` }}
                        />
                      </div>
                    )}
                  </div>
                )}
                {error && (
                  <p className={styles.error}>
                    <AlertCircle size={14} style={{ verticalAlign: "-2px", marginRight: 4 }} />
                    {error}
                  </p>
                )}
                {historyInfo && (
                  <p className={styles.status}>
                    <History size={14} /> {historyInfo}{" "}
                    <button
                      className={styles.linkButton}
                      type="button"
                      onClick={() => void handleForceReprocess()}
                    >
                      Reprocessar mesmo assim
                    </button>
                  </p>
                )}
                {skippedInfo && (
                  <p className={styles.warningNote}>
                    <AlertCircle size={14} style={{ verticalAlign: "-2px", marginRight: 4 }} />
                    {skippedInfo}
                  </p>
                )}
                {(!userId || !hasRequiredKey) && (
                  <p className={styles.warningNote}>
                    <AlertCircle size={14} style={{ verticalAlign: "-2px", marginRight: 4 }} />
                    {!userId
                      ? "Faça login ou crie uma conta em Conta pra poder buscar preço."
                      : activeProvider.needsKey === "serpApiKey"
                        ? "Cadastre sua chave SerpApi em Conta (grátis, só email) pra poder buscar preço."
                        : "Cadastre sua chave RapidAPI em Conta (grátis até 100 buscas/mês) pra poder buscar preço."}
                  </p>
                )}
              </div>
            )}

            {userId && profile && !libraryLoading && libraryCatalogs.length > 0 && (
              <div className={styles.libraryPanel}>
                <div className={styles.libraryTitle}>
                  <Library size={12} /> Biblioteca do plano {plan.name}
                </div>
                {libraryCatalogs.map((catalog) => (
                  <button
                    key={catalog.id}
                    type="button"
                    className={styles.libraryRow}
                    onClick={() => void processSharedCatalog(catalog)}
                  >
                    <span className={styles.libraryName}>
                      <FileText size={13} /> {catalog.fileName}
                    </span>
                    <span className={styles.libraryMeta}>{catalog.rows.length} produtos</span>
                  </button>
                ))}
              </div>
            )}
          </section>

          {userId && (
            <section className={styles.card}>
              <div className={styles.cardHeader}>
                <span className={styles.cardHeaderNumber}>03</span>
                <h2 className={styles.cardHeaderTitle}>Catálogos processados</h2>
                <span className={styles.cardHeaderMeta}>{uploadHistory.length} registro(s)</span>
              </div>
              {historyLoading && (
                <div className={styles.tableEmpty}>Carregando histórico…</div>
              )}
              {!historyLoading && uploadHistory.length === 0 && (
                <div className={styles.tableEmpty}>Nenhum catálogo processado ainda.</div>
              )}
              {!historyLoading && uploadHistory.length > 0 && (
                <>
                  <div className={styles.tableHeadRow}>
                    <span>arquivo</span>
                    <span>com preço</span>
                    <span>marketplaces</span>
                    <span>quando</span>
                  </div>
                  {uploadHistory.slice(0, 10).map((record) => {
                    const foundCount = record.results.length;
                    const failed = foundCount === 0;
                    return (
                      <button
                        key={record.id}
                        type="button"
                        className={styles.tableRow}
                        onClick={() => loadHistoryRecord(record)}
                      >
                        <span className={styles.tableCellFile}>
                          <FileText size={13} /> {record.fileName}
                        </span>
                        <span className={failed ? styles.tableCellFoundFailed : styles.tableCellFound}>
                          {foundCount} / {record.rows.length}
                        </span>
                        <span className={styles.tableCellMarkets}>
                          {(record.marketplaces ?? []).join(" + ") || "—"}
                        </span>
                        <span className={styles.tableCellWhen}>
                          {new Date(record.uploadedAt).toLocaleString("pt-BR")}
                        </span>
                      </button>
                    );
                  })}
                </>
              )}
            </section>
          )}
        </div>

        <aside className={styles.aside}>
          <section className={styles.card}>
            <div className={styles.cardHeader}>
              <h2 className={styles.cardHeaderTitle}>Pré-requisitos</h2>
            </div>
            <div className={styles.prereqRow}>
              <span className={userId ? styles.prereqIcon : styles.prereqIconWarning}>
                {userId ? <Check size={11} strokeWidth={3} /> : <AlertCircle size={11} />}
              </span>
              <span>
                <span className={styles.prereqLabel}>Conta conectada</span>
                <span className={styles.prereqSub}>
                  {userId ? "sessão ativa" : "faça login em Conta"}
                </span>
              </span>
            </div>
            <div className={styles.prereqRow}>
              <span className={hasRequiredKey ? styles.prereqIcon : styles.prereqIconWarning}>
                {hasRequiredKey ? <Check size={11} strokeWidth={3} /> : <AlertCircle size={11} />}
              </span>
              <span>
                <span className={styles.prereqLabel}>
                  {activeProvider.needsKey === "serpApiKey"
                    ? "Chave SerpApi própria"
                    : activeProvider.needsKey === "rapidApiKey"
                      ? "Chave RapidAPI própria"
                      : "Chave de API"}
                </span>
                <span className={styles.prereqSub}>
                  {activeProvider.needsKey === null
                    ? "não precisa — endpoint público"
                    : hasRequiredKey
                      ? "cadastrada"
                      : "grátis — cadastre em Conta"}
                </span>
              </span>
            </div>
            <div className={styles.prereqRow}>
              <span
                className={
                  selectedMarketplaces.length > 0 ? styles.prereqIcon : styles.prereqIconWarning
                }
              >
                {selectedMarketplaces.length > 0 ? (
                  <Check size={11} strokeWidth={3} />
                ) : (
                  <AlertCircle size={11} />
                )}
              </span>
              <span>
                <span className={styles.prereqLabel}>Marketplace escolhido</span>
                <span className={styles.prereqSub}>
                  {marketplaceLabels || "selecione ao menos um"}
                </span>
              </span>
            </div>
          </section>

          <section className={styles.card}>
            <div className={styles.cardHeader}>
              <h2 className={styles.cardHeaderTitle}>Como o cálculo roda</h2>
            </div>
            {STEPS.map((step, i) => {
              const Icon = STEP_ICONS[i];
              const isActive = i === activeStep;
              return (
                <div key={step.label} className={isActive ? styles.stepRowActive : styles.stepRow}>
                  <span className={isActive ? styles.stepIconBoxActive : styles.stepIconBox}>
                    <Icon size={13} />
                  </span>
                  <span className={styles.stepRowLabel}>{step.label}</span>
                  <span className={styles.stepRowNumber}>0{i + 1}</span>
                </div>
              );
            })}
          </section>

          {userId && uploadHistory.length > 0 && (
            <section className={styles.card}>
              <div className={styles.cardHeader}>
                <h2 className={styles.cardHeaderTitle}>Seu histórico</h2>
              </div>
              <div className={styles.statRow}>
                <span className={styles.statLabel}>Catálogos processados</span>
                <span className={styles.statValue}>{uploadHistory.length}</span>
              </div>
              <div className={styles.statRow}>
                <span className={styles.statLabel}>Última busca</span>
                <span className={styles.statValue}>
                  {lastRun ? new Date(lastRun.uploadedAt).toLocaleDateString("pt-BR") : "—"}
                </span>
              </div>
              <div className={styles.statRow}>
                <span className={styles.statLabel}>Marketplaces usados</span>
                <span className={styles.statValue}>{uniqueMarketplaces.size || "—"}</span>
              </div>
            </section>
          )}
        </aside>
      </div>
    </motion.div>
  );
}
