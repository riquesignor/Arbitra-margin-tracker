import { useEffect, useRef, useState, type DragEvent, type MouseEvent } from "react";
import { motion } from "framer-motion";
import {
  UploadCloud,
  Loader2,
  AlertCircle,
  FileText,
  History,
  Check,
  Store,
  ShoppingBag,
  Search,
  Camera,
  Trash2,
  Gauge,
  Zap,
  Globe,
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
import { fetchMultipleMarketplacePrices, MISS_REASON_LABEL, type MissReason } from "../lib/priceApi";
import { missingKeyMessage, PROVIDER_KEY_GUIDE } from "../config/providerKeys";
import { calculateMargins } from "../lib/marginCalculator";
import {
  computeFileHash,
  deleteCatalogUpload,
  findExistingUpload,
  listCatalogUploads,
  saveCatalogUpload,
  type CatalogUploadRecord,
} from "../lib/catalogHistory";
import { getTodayUsage } from "../lib/usageQuota";
import {
  getUserSerpApiKey,
  getUserRapidApiKey,
  getUserSearchApiKey,
  getUserUnwrangleApiKey,
  getUserGeminiApiKey,
  getUserMistralApiKey,
  getUserScraperApiKey,
} from "../lib/userSecrets";
import { getPlan } from "../config/plans";
import type { UserProfile } from "../lib/userProfile";
import type { SharedCatalog } from "../lib/sharedCatalogs";
import { getSpeedSummary, recordSample, type ProviderSpeedSummary } from "../lib/providerSpeedStats";
import styles from "./Dashboard.module.css";

type UploadState = "idle" | "parsing" | "fetching" | "error";
type SourceType = "csv" | "pdf";
interface ParseOutcome {
  rows: CatalogRow[];
  skippedAmbiguous: number;
  /** Só preenchido quando o parse rodou em modo imagem (PDF) — ver processFile. */
  imagesBySku?: Record<string, string>;
  /** true se o PDF precisou de OCR (sem texto real) — ver ExtractResult em parsePdfCatalog.ts. CSV nunca seta isso (fica undefined/falsy). */
  usedOcr?: boolean;
  /** true se ALGUMA página precisou do fallback genérico de IA (Gemini) por não bater em nenhuma heurística conhecida — ver ExtractResult em parsePdfCatalog.ts. CSV nunca seta isso. */
  usedGeminiPageExtraction?: boolean;
  /** Ver mesmo campo em ExtractResult (parsePdfCatalog.ts) — páginas que não contribuíram produto nenhum. CSV nunca seta isso (não tem conceito de "página"). */
  pagesWithNoProducts?: number[];
  /** Ver mesmo campo em ExtractResult (parsePdfCatalog.ts) — linhas removidas por SKU repetido dentro do catálogo. */
  duplicateSkusRemoved?: number;
  /** Ver mesmo campo em ExtractResult (parsePdfCatalog.ts) — páginas sem texto que não couberam no teto de OCR. */
  ocrSkippedPages?: number[];
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

/**
 * "Lojas gerais" (ago/2026) — pseudo-marketplace opt-in (`"geral"`, ver
 * MarketplaceId em ../types). Não entra em `AVAILABLE_MARKETPLACES`
 * acima de propósito: só faz sentido pro motor interno + IA
 * (vision_internal, ver visionInternalSearchProvider.ts > Passo 4) —
 * nos outros mecanismos o matcher existe mas é inerte (não traz produto
 * nenhum, ver GOOGLE_SHOPPING_MATCHERS). Renderizado à parte, só quando
 * `searchProvider === "vision_internal"` (ver seção 01 mais abaixo), pra
 * não oferecer uma opção que não faz nada nos outros 4.
 */
const GENERAL_STORES_MARKETPLACE: { id: MarketplaceId; label: string; note: string; icon: typeof Store } = {
  id: "geral",
  label: "Lojas gerais",
  note: "qualquer loja fora de Amazon/ML (Shopee, Magalu...) — só quando as duas focadas não têm o produto",
  icon: Globe,
};

// Qual API resolve o preço — eixo INDEPENDENTE de marketplace (ver
// SearchProviderId em ../types e o comentário em api/fetch-prices.ts).
// Motor interno e SerpApi cobrem os dois marketplaces numa busca só; os
// providers "diretos" cobrem só um marketplace fixo cada, então escolher
// um deles já define `selectedMarketplaces` sozinho (ver selectProvider).
//
// "serpapi" (texto puro) continua no array — ainda é um SearchProviderId
// válido e resolve `activeProvider`/needsKey normalmente — mas NÃO entra
// no grid principal de seleção (ver SELECTABLE_PROVIDERS abaixo). Desde
// ago/2026 o motivo mudou: o "Motor interno" assumiu a busca por TEXTO
// (mesma cobertura, sem chave e sem custo por busca), então oferecer
// SerpApi por texto só empurraria custo pro usuário sem ganho. A SerpApi
// segue essencial no app, mas como motor da busca por FOTO
// (google_lens_products), que o motor interno ainda não faz.
const SEARCH_PROVIDERS: {
  id: SearchProviderId;
  label: string;
  note: string;
  marketplaces: MarketplaceId[];
  icon: typeof Store;
  needsKey:
    | "serpApiKey"
    | "rapidApiKey"
    | "searchApiKey"
    | "geminiApiKey"
    | "mistralApiKey"
    | "scraperApiKey"
    | null;
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
  {
    id: "searchapi_lens",
    label: "Busca por imagem (SearchApi.io)",
    note: "Amazon + Mercado Livre · 2ª fonte por foto, redundância à SerpApi",
    marketplaces: ["mercadolivre", "amazon"],
    icon: Camera,
    needsKey: "searchApiKey",
  },
  // 6ª opção (ago/2026) — motor interno + IA (ver
  // visionInternalSearchProvider.ts): busca por foto sem SerpApi/
  // SearchApi.io, usando Gemini (BYOK) pra descrever e confirmar
  // visualmente o produto. Adicionada como opção A MAIS, sem tocar nas
  // 5 acima — combinar/reorganizar o seletor fica pra depois de validar
  // a taxa de acerto real (instrução explícita do produto, não decisão
  // técnica: só reduz opção quando esta aqui provar que funciona bem).
  {
    id: "vision_internal",
    label: "Motor interno + IA (Gemini)",
    note: "Amazon + Mercado Livre · foto do catálogo, sem SerpApi/SearchApi.io",
    marketplaces: ["mercadolivre", "amazon"],
    icon: Camera,
    needsKey: "geminiApiKey",
  },
  // 7ª opção (ago/2026) — MESMA orquestração da anterior (motor interno +
  // IA), trocando o backend de IA de Gemini pra Mistral (ver VisionBackend
  // em api/_lib/providers/visionInternalSearchProvider.ts e
  // mistralVision.ts). SUBSTITUIU "vision_groq" (removido no mesmo mês —
  // relato real "não traz nenhum resultado sequer": o free tier de 8.000
  // tokens/minuto da Groq zerava a cota mesmo com comparação em lote). O
  // tier gratuito da Mistral (500.000 tokens/minuto) tem folga bem maior
  // pro mesmo padrão de uso — existe pra comparar diretamente com a opção
  // de cima no mesmo catálogo.
  {
    id: "vision_mistral",
    label: "Motor interno + IA (Mistral)",
    note: "Amazon + Mercado Livre · foto do catálogo, 2ª opção de IA (compare com a de cima)",
    marketplaces: ["mercadolivre", "amazon"],
    icon: Camera,
    needsKey: "mistralApiKey",
  },
  // ScraperAPI como busca de verdade (Structured Data Endpoints: Amazon
  // Search API + Google Shopping API), não só transporte — ver
  // scraperApiSearchProvider.ts. Virou o DEFAULT do seletor (ver
  // DEFAULT_PROVIDER abaixo) depois da remoção de "internal_search"
  // (ago/2026), quando a chave ainda era secret de servidor.
  //
  // `needsKey: "scraperApiKey"` (set/2026 — ANTES era `null`): a chave
  // virou BYOK, mesmo padrão das outras (ver comentário grande em
  // internalSearchProvider.ts > SCRAPERAPI_ENDPOINT). Continua sendo o
  // DEFAULT mesmo precisando de chave agora — é consistente com o resto
  // do app (todo mecanismo de API pede a própria chave) e o onboarding de
  // BYOK abaixo (`byokHint`) já mostra onde criar e quanto custa assim
  // que o usuário escolhe o mecanismo, sem esperar a busca falhar.
  {
    id: "scraperapi",
    label: "ScraperAPI (Amazon + Google Shopping)",
    note: "Amazon + Mercado Livre · endpoints estruturados",
    marketplaces: ["mercadolivre", "amazon"],
    icon: Zap,
    needsKey: "scraperApiKey",
  },
];

// Providers que buscam por FOTO (não por nome) — precisam de imagem
// extraída do PDF (ver catalogImages.ts). Dois vendors possíveis
// (SerpApi vs SearchApi.io), mesmo comportamento de UI pros dois — ver
// api/_lib/types.ts pro porquê de dois vendors pro mesmo tipo de busca.
const IMAGE_MODE_PROVIDERS = new Set<SearchProviderId>([
  "google_lens_products",
  "searchapi_lens",
  "vision_internal",
  "vision_mistral",
]);

/**
 * Subconjunto de IMAGE_MODE_PROVIDERS que é motor interno + IA de VISÃO
 * "lenta" (várias chamadas Gemini/Mistral sequenciais por item, sujeita a
 * cota por minuto do free tier — ver visionInternalSearchProvider.ts).
 * Google Lens/SearchApi.io (as outras duas de IMAGE_MODE_PROVIDERS) são 1
 * chamada por produto, não precisam do mesmo tratamento (lote pequeno,
 * pausa de cota) que este par precisa — daí um Set separado em vez de
 * reaproveitar IMAGE_MODE_PROVIDERS pra essas decisões.
 */
const SLOW_AI_VISION_PROVIDERS = new Set<SearchProviderId>(["vision_internal", "vision_mistral"]);

/**
 * Providers que cobrem amazon + mercadolivre na mesma busca (o usuário
 * escolhe o subconjunto por checkbox, em vez de ficar travado num
 * marketplace só — ver selectProvider). Extraído pra constante porque a
 * lista cresceu com o motor interno e estava repetida em três condições
 * diferentes, cada uma com risco próprio de esquecer um provider novo.
 */
const MULTI_MARKETPLACE_PROVIDERS = new Set<SearchProviderId>([
  "serpapi",
  "google_lens_products",
  "searchapi_lens",
  "vision_internal",
  "vision_mistral",
  "scraperapi",
]);

/**
 * Default da tela: ScraperAPI, herdado de quando virou o substituto de
 * "internal_search" (ago/2026). Continua default mesmo após a chave virar
 * BYOK (set/2026) — sem chave cadastrada, o usuário só vê o mesmo
 * onboarding (`byokHint`) que qualquer outro mecanismo de API mostraria;
 * não há mais um mecanismo "genuinamente sem chave" pra ocupar esse lugar
 * (o único `needsKey: null` que sobrou, "mercadolivre_direct", cobre só
 * 1 marketplace e é avisadamente instável — pior default pra quem chega
 * sem saber nada do app).
 */
const DEFAULT_PROVIDER: SearchProviderId = "scraperapi";

/**
 * Monta o texto informativo pós-parse (`skippedInfo`) combinando os dois
 * avisos possíveis — ambiguidade descartada (sempre existiu) e leitura
 * por IA como último recurso (ver usedGeminiPageExtraction em
 * ParseOutcome/ExtractResult, ago/2026). Devolve `null` quando nenhum
 * dos dois se aplica, pra `setSkippedInfo(null)` esconder o aviso —
 * mesmo comportamento de antes desta função existir.
 */
function buildParseInfoMessage(
  rowCount: number,
  skippedAmbiguous: number,
  usedGeminiPageExtraction?: boolean,
  pagesWithNoProducts?: number[],
  duplicateSkusRemoved?: number,
  ocrSkippedPages?: number[]
): string | null {
  const parts: string[] = [];
  if (skippedAmbiguous > 0) {
    parts.push(
      `${rowCount} produto(s) reconhecido(s) — ${skippedAmbiguous} linha(s) ignorada(s) por ambiguidade ` +
        "(mais de um preço detectado na mesma linha, provável mescla de colunas)."
    );
  }
  if (usedGeminiPageExtraction) {
    parts.push(
      "Uma ou mais páginas não bateram em nenhum padrão conhecido e foram lidas por IA (Gemini) — " +
        "confira nome e preço desses produtos antes de decidir compra."
    );
  }
  // Ver pagesWithNoProducts em ExtractResult (parsePdfCatalog.ts, ago/2026) —
  // regressão real reportada: catálogo de N páginas devolvia menos produto
  // que o esperado sem NENHUMA pista de qual página falhou. Lista as
  // páginas explicitamente pra virar um ponto de partida concreto (conferir
  // layout, tentar Gemini se ainda não tinha chave) em vez de "sumiu
  // produto, não sei por quê".
  if (pagesWithNoProducts && pagesWithNoProducts.length > 0) {
    parts.push(
      `Página(s) ${pagesWithNoProducts.join(", ")} não tiveram produto nenhum reconhecido — layout ` +
        "diferente do resto do catálogo, ou é só uma página de capa/divisor. Confira essas páginas " +
        "manualmente ou reprocesse só elas com uma chave Gemini em Conta (leitura por IA como último recurso)."
    );
  }
  // Ver dedupeCatalogRows em parsePdfCatalog.ts (ago/2026) — mesmo SKU
  // aparecendo em mais de uma linha do catálogo (ex: página de destaque
  // repetindo um produto que já está na grade principal) some do total
  // sem aviso nenhum; melhor dizer quantas linhas saíram por isso do que
  // deixar o usuário estranhar "por que voltou menos produto que eu
  // contei no PDF".
  if (duplicateSkusRemoved && duplicateSkusRemoved > 0) {
    parts.push(
      `${duplicateSkusRemoved} linha(s) removida(s) por SKU repetido dentro do próprio catálogo — ` +
        "mesmo produto reconhecido mais de uma vez (ex: página de destaque + grade principal); mantivemos " +
        "só uma ocorrência de cada, priorizando a que tinha preço de custo."
    );
  }
  // Teto de OCR atingido (set/2026, ver ocrSkippedPages em ExtractResult):
  // catálogo 100% imagem com mais páginas que o limite por processamento.
  // Antes isso só aparecia no console — o usuário via menos produto do que
  // o PDF tem e não tinha como saber que era só reprocessar o resto.
  if (ocrSkippedPages && ocrSkippedPages.length > 0) {
    const first = ocrSkippedPages[0];
    const last = ocrSkippedPages[ocrSkippedPages.length - 1];
    parts.push(
      `Este PDF não tem texto (é imagem), e o limite de páginas de OCR por processamento foi atingido — ` +
        `as páginas ${first}–${last} ficaram de fora. Processe de novo escolhendo o intervalo ` +
        `${first}–${last} pra cobrir o restante.`
    );
  }
  return parts.length > 0 ? parts.join(" ") : null;
}

/**
 * "mercadolivre_alt" (Unwrangle, ver unwrangleMercadoLivreProvider.ts)
 * de propósito NÃO entra aqui — não é uma opção normal de busca, só é
 * usada via `providerOverride` em finishWithRows quando
 * "mercadolivre_direct" falha e o usuário já tem a chave cadastrada (ver
 * mlFallbackOffer mais abaixo).
 */
/**
 * ⚠️ MODO TESTE A/B (ago/2026) — temporário, ver conversa sobre comparar
 * os mecanismos de terceiros depois do ScraperAPI entrar no motor
 * interno. Grid principal reduzido de propósito, pra comparação direta
 * com o MESMO catálogo:
 *
 *   - serpapi           → "a serp api": Google Shopping, cota renovada
 *   - searchapi_lens     → "a search": busca por foto via SearchApi.io
 *   - scraperapi         → "a scraper" (nativa): Structured Data Endpoints
 *     da própria ScraperAPI (Amazon Search API + Google Shopping API), ver
 *     scraperApiSearchProvider.ts — mecanismo de busca de verdade, não só
 *     transporte.
 *   - vision_internal    → motor interno + IA (Gemini): busca por FOTO
 *     sem depender de SerpApi/SearchApi.io, com confirmação visual via IA.
 *   - vision_mistral (ago/2026) → MESMO motor interno + IA, backend
 *     Mistral no lugar do Gemini (ver VisionBackend em
 *     visionInternalSearchProvider.ts e mistralVision.ts) — entrou no
 *     grid JUNTO com vision_internal de propósito, pra comparar os dois
 *     lado a lado no mesmo catálogo. SUBSTITUIU vision_groq (removido no
 *     mesmo mês — free tier de 8.000 tokens/minuto zerava resultado
 *     mesmo com comparação em lote; o da Mistral, 500.000 tokens/minuto,
 *     tem folga bem maior).
 *
 * `internal_search` (motor interno SEM IA) foi REMOVIDO do grid (ago/2026,
 * decisão de produto pós-rodada de teste): entre os "motor interno"
 * testados, só as variantes COM IA (`vision_internal`/`vision_mistral`)
 * seguiram — ver SearchProviderId em ../types.
 *
 * Fora deliberadamente desta rodada: rapidapi_amazon e mercadolivre_direct
 * (não são "terceiro" no sentido testado aqui) e google_lens_products
 * (mesma chave/cota da SerpApi acima — testar os dois juntos dilui a
 * leitura de qual mecanismo rendeu melhor).
 *
 * Reverter depois do teste: trocar a linha abaixo de volta pra
 * `SEARCH_PROVIDERS.filter((p) => p.id !== "serpapi")` (o filtro
 * original, que só tirava a SerpApi do grid principal — ver comentário
 * antigo preservado acima em SEARCH_PROVIDERS).
 */
const AB_TEST_PROVIDER_IDS = new Set<SearchProviderId>([
  "serpapi",
  "searchapi_lens",
  "scraperapi",
  "vision_internal",
  "vision_mistral",
]);
const SELECTABLE_PROVIDERS = SEARCH_PROVIDERS.filter((p) => AB_TEST_PROVIDER_IDS.has(p.id));

// Tamanho do lote de busca — catálogos grandes são processados em
// lotes sequenciais (não tudo de uma vez) só pra reportar progresso
// real na UI (ver `progress` state em finishWithRows). Cada lote já
// usa concorrência 5 no servidor (googleShoppingProvider.ts), então
// isso não muda o paralelismo real, só a granularidade do feedback.
const CHUNK_SIZE = 20;

// Lote menor pro motor interno + IA (`vision_internal`) — concorrência 1
// de propósito (tier gratuito do Gemini) e várias chamadas sequenciais
// por item deixam esse provider bem mais lento por item que os outros;
// ver comentário completo em `finishWithRows`.
//
// Reduzido de 5 pra 3 (ago/2026) junto com o retry em 503
// (internalSearchProvider.ts) e o timeout maior do Gemini
// (geminiVision.ts, 15s→20s): as duas mudanças aumentam o pior caso de
// tempo por item, e `searchVisionInternalShared` só lança erro de
// verdade (vira 502 pro lote inteiro) quando TODOS os itens do lote
// falham — lote menor reduz quantos produtos um 502 desses carrega
// junto, e dá mais folga pro teto de 300s da function (vercel.json)
// antes de um catálogo grande esbarrar nele de novo.
const VISION_CHUNK_SIZE = 3;

// Ver `lastVisionQuotaExhaustedAtRef` em finishWithRows — substring
// ESTÁVEL o bastante do warning gerado por searchVisionInternalShared
// (visionInternalSearchProvider.ts) pra detectar "foi cota, não outro
// motivo" sem acoplar ao texto inteiro da frase (que pode mudar o resto
// da redação sem quebrar esta checagem). Backend-agnóstico de propósito
// (NÃO "...do Gemini esgotada" — ago/2026, entrada de um 2º backend, hoje
// Mistral): a frase muda pra "Cota gratuita do Mistral esgotada" quando é
// esse o provider ativo, mas "esgotada depois de" é comum aos dois — ver
// o warning montado em visionInternalSearchProvider.ts.
const VISION_QUOTA_WARNING_MARKER = "esgotada depois de";

// Janela aproximada do rate-limit por MINUTO do free tier (Gemini OU
// Mistral, ver comentário "Cota do Gemini free tier..." em
// visionInternalSearchProvider.ts e o comentário de topo de
// mistralVision.ts). Não é um valor documentado de forma estável — é uma estimativa
// conservadora pra evitar o desperdício descrito abaixo, não uma garantia.
const VISION_QUOTA_COOLDOWN_MS = 60_000;

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
  /**
   * Mesma forma de `onComplete`, chamado a cada LOTE (não só no final) —
   * ago/2026, feedback real: catálogo de 68 produtos com motor interno +
   * IA rodou 5+ minutos e só no final mostrou 2 resultados, indistinguível
   * de "achou o resto e jogou fora" (na real, a maior parte dos lotes
   * ficou re-tentando contra a cota do Gemini esgotada, ver
   * visionInternalSearchProvider.ts — mas o usuário não tinha como saber
   * disso enquanto olhava uma barra de progresso muda). Chamar isto a
   * cada lote deixa a tela de Resultados ir preenchendo AO VIVO conforme
   * cada lote termina, em vez de um "tudo ou nada" no fim — se o processo
   * for interrompido (fechar aba, erro sistêmico no meio) o que já
   * apareceu na tela não se perde, só o que ainda não tinha chegado.
   * Opcional pra não quebrar quem ainda não passa essa prop.
   */
  onProgress?: (result: DashboardResult) => void;
  /** Avisa o App que o histórico salvo mudou (nova busca concluída) — ver seletor de histórico em Precificação/Resultados. */
  onHistoryChanged?: () => void;
  /** Avisa o App que um registro do histórico foi excluído, pra podar o mesmo id da lista global. */
  onHistoryDeleted?: (id: string) => void;
  /** Preferências opcionais (Conta) — controla só o badge "!" da barra de cota abaixo, nunca bloqueia a busca. */
  warnAt80PercentQuota?: boolean;
  /** Catálogo da biblioteca escolhido em "usar" na Home (ver App.tsx) — a biblioteca em si não mora mais aqui, só o gatilho de processar. */
  pendingSharedCatalog?: SharedCatalog | null;
  /** Avisa o App que o catálogo pendente acima já foi consumido (evita reprocessar em loop). */
  onPendingSharedCatalogConsumed?: () => void;
}

interface LastUpload {
  file: File;
  sourceType: SourceType;
  pageRange: PageRange | null;
}

export default function Dashboard({
  rules,
  userId,
  profile,
  onComplete,
  onProgress,
  onHistoryChanged,
  onHistoryDeleted,
  warnAt80PercentQuota = true,
  pendingSharedCatalog,
  onPendingSharedCatalogConsumed,
}: Props) {
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
  // aí amanhã uso a de mercado livre e depois a serp"). Default =
  // ScraperAPI (ver DEFAULT_PROVIDER): é o único que roda sem o usuário
  // cadastrar chave nenhuma, então é o único default honesto pra quem
  // acabou de criar a conta.
  const [searchProvider, setSearchProvider] = useState<SearchProviderId>(DEFAULT_PROVIDER);

  const [pendingPdf, setPendingPdf] = useState<File | null>(null);
  const [pdfPageCount, setPdfPageCount] = useState<number | null>(null);
  const [pageFrom, setPageFrom] = useState(1);
  const [pageTo, setPageTo] = useState(1);

  const [lastUpload, setLastUpload] = useState<LastUpload | null>(null);
  const [uploadHistory, setUploadHistory] = useState<CatalogUploadRecord[]>([]);
  const [historyLoading, setHistoryLoading] = useState(false);

  // Cota diária de buscas do plano — ver config/plans.ts e usageQuota.ts.
  const [todayUsage, setTodayUsage] = useState<number | null>(null);
  /**
   * Teto AUTORITATIVO devolvido pelo servidor no `_usage` (ver
   * api/_lib/searchQuota.ts) — só ele sabe se o mecanismo escolhido custa
   * crédito da plataforma (limite do plano) ou roda com chave do usuário
   * (teto anti-abuso, bem mais alto). Antes a tela usava sempre
   * `plan.dailySearchLimit`, o que mostrava uma barra errada pra quem
   * estava em BYOK. `null` até a primeira resposta do servidor.
   */
  const [serverQuotaLimit, setServerQuotaLimit] = useState<number | null>(null);
  /**
   * Quanto a ÚLTIMA busca consumiu de fato (diferença do contador do
   * servidor entre o começo e o fim). A barra sozinha só dizia o
   * acumulado do dia — não dava pra saber o preço do que você acabou de
   * rodar, que é justamente o número que faz o usuário decidir se repete
   * a busca com outro mecanismo (auditoria item 23).
   */
  const [lastSearchCost, setLastSearchCost] = useState<number | null>(null);

  // Comparativo de velocidade por mecanismo (ver providerSpeedStats.ts) —
  // substitui o antigo card estático "Como o cálculo roda".
  const [speedSummary, setSpeedSummary] = useState<ProviderSpeedSummary[]>(() => getSpeedSummary());

  // BYOK — chave SerpApi própria do usuário (Conta). Presente = busca usa
  // a cota da própria conta SerpApi do usuário, não a compartilhada do
  // app, e por isso não entra no enforcement de `usage_daily` abaixo.
  const [serpApiKey, setSerpApiKey] = useState<string | null>(null);

  // BYOK — chave RapidAPI própria (Amazon direto). Mesma lógica da
  // SerpApi acima, provider diferente.
  const [rapidApiKey, setRapidApiKey] = useState<string | null>(null);

  // BYOK — chave SearchApi.io própria (2ª fonte de busca por imagem).
  const [searchApiKey, setSearchApiKey] = useState<string | null>(null);

  // BYOK — chave Unwrangle própria (alternativa paga ao Mercado Livre
  // público). Não é lida via `activeProviderKey` normal — só usada no
  // fluxo de fallback (ver mlFallbackOffer/handleRetryWithUnwrangle).
  const [unwrangleApiKey, setUnwrangleApiKey] = useState<string | null>(null);

  // BYOK — chave Gemini própria (motor interno + IA, busca por foto sem
  // SerpApi/SearchApi.io). Mesma lógica das chaves acima.
  const [geminiApiKey, setGeminiApiKey] = useState<string | null>(null);

  // BYOK — chave Mistral própria (motor interno + IA, provider
  // "vision_mistral", 2ª opção de backend ao lado do Gemini acima).
  // Mesma lógica das chaves acima, campo separado (ver userSecrets.ts).
  const [mistralApiKey, setMistralApiKey] = useState<string | null>(null);

  // BYOK — chave ScraperAPI própria (set/2026, virou BYOK — antes era
  // secret de servidor da plataforma). Mesma lógica das chaves acima;
  // usada pelo provider "scraperapi" E como fallback cross-cutting de
  // outros (motor interno + IA, download de imagem bloqueada — ver
  // api/_lib/userSecrets.ts > getUserScraperApiKey, resolvida no servidor
  // independente de qual provider foi selecionado).
  const [scraperApiKey, setScraperApiKey] = useState<string | null>(null);

  // Oferta de "tentar de novo com sua chave Unwrangle" — preenchida só
  // quando "mercadolivre_direct" falha com o erro conhecido de HTTP 403
  // E o usuário já tem `unwrangleApiKey` cadastrada (ver finishWithRows).
  // Guarda o suficiente pra repetir a MESMA busca trocando só o
  // provider/chave, sem precisar reprocessar o arquivo.
  const [mlFallbackOffer, setMlFallbackOffer] = useState<{
    rows: CatalogRow[];
    meta: Parameters<typeof finishWithRows>[1];
    imagesBySku?: Record<string, string>;
  } | null>(null);

  /**
   * Cancelamento da busca em andamento (set/2026, ver
   * docs/auditoria-2026-09.md > item 19). Fica num ref (não em estado)
   * porque o botão só precisa CHAMAR `.abort()` — não há nada pra
   * re-renderizar quando o controller troca, e estado aqui só provocaria
   * render a cada lote.
   */
  const searchAbortRef = useRef<AbortController | null>(null);

  /**
   * Oferta de "tentar de novo só os que falharam" (set/2026, item 20).
   * Antes, lote que falhava (timeout, 502, instabilidade) deixava aqueles
   * produtos sem preço e a única saída era refazer o catálogo INTEIRO —
   * pagando cota de novo pelos que já tinham dado certo. Guarda só os
   * SKUs que falharam + o contexto pra repetir a mesma busca.
   */
  const [failedRetryOffer, setFailedRetryOffer] = useState<{
    rows: CatalogRow[];
    meta: Parameters<typeof finishWithRows>[1];
    imagesBySku?: Record<string, string>;
    skus: string[];
  } | null>(null);

  // Mesmo padrão de mlFallbackOffer, pro outro caso onde o usuário
  // reclamou de "perder tudo" (ago/2026): provider de imagem escolhido,
  // mas TODAS as fotos falharam ao extrair/subir do PDF (ver o guard
  // logo no início de finishWithRows). Antes disso, o único jeito de
  // seguir buscando por TEXTO era clicar "Reprocessar agora", que reroda
  // o parse INTEIRO do zero (OCR incluso, se for o caso) — caro e lento
  // à toa, já que `rows` (nome/SKU/preço de fornecedor) já estão
  // perfeitamente prontas, só a FOTO que não existe. Guarda o suficiente
  // pra repetir a busca com um provider de texto sem reprocessar nada.
  const [imageUploadFailedOffer, setImageUploadFailedOffer] = useState<{
    rows: CatalogRow[];
    meta: Parameters<typeof finishWithRows>[1];
  } | null>(null);

  // Progresso real da busca (item 8+9 do roadmap) — preenchido só
  // durante state === "fetching", em lotes de CHUNK_SIZE produtos.
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);

  // Contador ao vivo de "quantos produtos já têm preço encontrado até
  // agora" (ago/2026) — junto com `onProgress`, resolve o feedback que
  // faltava num catálogo grande e lento (motor interno + IA, 5+ minutos):
  // antes disso, `progress` só mostrava "X/Y produtos" (quantos JÁ FORAM
  // TENTADOS), sem dizer quantos deram certo — usuário só descobria se
  // achou algo depois que TUDO terminasse. Resetado no início de cada
  // busca junto com `progress` (ver finishWithRows).
  const [foundSoFar, setFoundSoFar] = useState(0);

  // Ver VISION_QUOTA_WARNING_MARKER/VISION_QUOTA_COOLDOWN_MS acima —
  // `ref` (não `state`) porque só é lido/escrito dentro de finishWithRows,
  // nunca precisa disparar re-render. Timestamp (ms epoch) da ÚLTIMA vez
  // que um lote voltou com o warning de cota esgotada (Gemini OU Mistral,
  // qualquer que seja o backend ativo no momento); `null` enquanto isso
  // nunca aconteceu nesta sessão do componente. Compartilhado entre os
  // dois de propósito — cada backend usa a PRÓPRIA chave/janela de cota,
  // então nunca há mistura real (só um dos dois provider está ativo por
  // vez), um único ref cobre os dois sem duplicar o mecanismo.
  //
  // Existe pra parar de desperdiçar tempo: hoje cada lote é uma
  // requisição SEPARADA ao servidor, e a flag que sabe "a cota já
  // estourou" (quotaExhausted, visionInternalSearchProvider.ts) é LOCAL
  // a cada requisição — o lote seguinte chega "sem saber" que o anterior,
  // 5 segundos atrás, já bateu na mesma parede, tenta de novo, espera o
  // retry embutido lá (geminiVision.ts/mistralVision.ts), desiste, e o
  // PRÓXIMO lote repete tudo de novo. Num catálogo de 68 produtos (~23
  // lotes) isso sozinho já explica boa parte dos 5+ minutos pra só 2
  // resultados reportados pelo usuário. Guardando o timestamp aqui NO
  // CLIENTE (que já vê o warning de cada lote), dá pra pular esse ciclo
  // perdido — ver o `await sleep(...)` no início do loop de lotes.
  const lastVisionQuotaExhaustedAtRef = useRef<number | null>(null);

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
      setSearchApiKey(null);
      return;
    }
    getUserSearchApiKey(userId).then(setSearchApiKey);
  }, [userId]);

  useEffect(() => {
    if (!userId) {
      setUnwrangleApiKey(null);
      return;
    }
    getUserUnwrangleApiKey(userId).then(setUnwrangleApiKey);
  }, [userId]);

  useEffect(() => {
    if (!userId) {
      setGeminiApiKey(null);
      return;
    }
    getUserGeminiApiKey(userId).then(setGeminiApiKey);
  }, [userId]);

  useEffect(() => {
    if (!userId) {
      setMistralApiKey(null);
      return;
    }
    getUserMistralApiKey(userId).then(setMistralApiKey);
  }, [userId]);

  useEffect(() => {
    if (!userId) {
      setScraperApiKey(null);
      return;
    }
    getUserScraperApiKey(userId).then(setScraperApiKey);
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
    if (!userId) {
      setTodayUsage(null);
      return;
    }
    getTodayUsage(userId).then(setTodayUsage);
  }, [userId]);

  // Catálogo escolhido em "usar" na biblioteca da Home — processa uma vez
  // e avisa o App pra limpar o pendente (senão reprocessaria em loop a
  // cada re-render). `processSharedCatalog` é function declaration
  // (hoisted), então funciona mesmo definida mais abaixo no arquivo.
  useEffect(() => {
    if (!pendingSharedCatalog) return;
    void processSharedCatalog(pendingSharedCatalog);
    onPendingSharedCatalogConsumed?.();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pendingSharedCatalog]);

  // Inclui GENERAL_STORES_MARKETPLACE aqui (fora de AVAILABLE_MARKETPLACES
  // de propósito, ver comentário lá) só pra resolver o LABEL quando
  // selecionado — não afeta se a opção aparece no grid (isso continua
  // condicionado a `searchProvider === "vision_internal"` no JSX).
  const marketplaceLabels = [...AVAILABLE_MARKETPLACES, GENERAL_STORES_MARKETPLACE]
    .filter((m) => selectedMarketplaces.includes(m.id))
    .map((m) => m.label)
    .join(" + ");

  const lastRun = uploadHistory[0] ?? null;
  const uniqueMarketplaces = new Set(uploadHistory.flatMap((h) => h.marketplaces ?? []));

  const plan = getPlan(profile?.plan);

  const activeProvider = SEARCH_PROVIDERS.find((p) => p.id === searchProvider)!;
  // Chave exigida pelo provider ativo — "mercadolivre_direct" não pede
  // nenhuma (endpoint público), os outros pedem a própria (BYOK).
  const activeProviderKey =
    activeProvider.needsKey === "serpApiKey"
      ? serpApiKey
      : activeProvider.needsKey === "rapidApiKey"
        ? rapidApiKey
        : activeProvider.needsKey === "searchApiKey"
          ? searchApiKey
          : activeProvider.needsKey === "geminiApiKey"
            ? geminiApiKey
            : activeProvider.needsKey === "mistralApiKey"
              ? mistralApiKey
              : activeProvider.needsKey === "scraperApiKey"
                ? scraperApiKey
                : null;
  const hasRequiredKey = activeProvider.needsKey === null || Boolean(activeProviderKey);

  // Cota diária (ver config/plans.ts) — só informativo, nunca bloqueia a
  // busca (mesma filosofia BYOK do resto do app). `!` a partir de 80% —
  // design-tokens.md § Regras de tela adicionadas — respeitando o
  // toggle "Avisar quando eu chegar a 80% da cota" (Conta).
  // Teto real da barra: o do servidor manda (ele sabe se é limite de plano
  // ou teto BYOK, ver searchQuota.ts); antes da primeira busca do dia usa
  // o do plano, que é o palpite correto pra quem gasta crédito da casa.
  const effectiveQuotaLimit = serverQuotaLimit ?? plan.dailySearchLimit;
  const quotaPct = todayUsage !== null ? Math.min(1, todayUsage / effectiveQuotaLimit) : 0;
  const quotaWarning = warnAt80PercentQuota && quotaPct >= 0.8;

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
    const isMultiMarketplace = MULTI_MARKETPLACE_PROVIDERS.has(id);
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
   * Exclui uma busca do histórico — otimista (some da lista na hora),
   * com rollback se a exclusão falhar no Firestore (mesmo padrão de
   * Admin.tsx > handleDeleteCatalog). `stopPropagation` no clique é
   * essencial: o botão de lixeira fica DENTRO da linha inteira, que por
   * sua vez é clicável pra carregar o registro (ver renderização da
   * seção 03) — sem isso, clicar em excluir também dispararia o load.
   */
  async function handleDeleteRecord(event: MouseEvent<HTMLButtonElement>, id: string) {
    event.stopPropagation();
    if (!userId) return;
    const previous = uploadHistory;
    setUploadHistory((prev) => prev.filter((r) => r.id !== id));
    try {
      await deleteCatalogUpload(userId, id);
      onHistoryDeleted?.(id);
    } catch (err) {
      setUploadHistory(previous);
      setError(err instanceof Error ? err.message : String(err));
    }
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
      /** true se o PDF precisou de OCR (sem texto real) — ver ParseOutcome/ExtractResult. */
      usedOcr?: boolean;
    },
    imagesBySku?: Record<string, string>,
    /**
     * Override de provider — usado SÓ pelo retry de "mercadolivre_alt"
     * (ver handleRetryWithUnwrangle). Sem override, usa `searchProvider`
     * normal (fluxo comum). O parâmetro `apiKeyOverride` que existia aqui
     * saiu junto com o envio de chave pelo corpo da requisição (set/2026,
     * ver api/_lib/userSecrets.ts) — o servidor resolve a chave do
     * provider sozinho, inclusive nesse retry.
     */
    providerOverride?: SearchProviderId
  ) {
    setMlFallbackOffer(null);
    setImageUploadFailedOffer(null);
    // Oferta de retry é sempre da busca ANTERIOR — some ao começar outra
    // (inclusive quando a nova busca É o retry, ver handleRetryFailed).
    setFailedRetryOffer(null);
    const effectiveProvider = providerOverride ?? searchProvider;

    // BYOK obrigatório pros providers que pedem chave (SerpApi,
    // RapidAPI, SearchApi.io) — não existe mais chave compartilhada do
    // servidor pra nenhum deles. Mercado Livre direto não pede chave
    // (endpoint público). Sem usuário logado ou sem a chave que ESSE
    // provider exige, a busca nem começa: bloqueia aqui, num único
    // ponto, em vez de deixar a API de terceiro falhar lá na frente com
    // erro genérico. Pulado no retry com override — quem chamou já
    // garantiu que a chave existe (ver handleRetryWithUnwrangle).
    if (!providerOverride) {
      if (!userId) {
        setState("error");
        setError("Faça login (ou crie uma conta) em Conta antes de buscar preço.");
        return;
      }
      if (!hasRequiredKey) {
        setState("error");
        // Mensagem única (ver config/providerKeys.ts) — inclui ONDE criar
        // a chave e quanto custa, não só "vá em Conta".
        setError(activeProvider.needsKey ? missingKeyMessage(activeProvider.needsKey) : "Chave de API ausente.");
        return;
      }
    }
    if (IMAGE_MODE_PROVIDERS.has(effectiveProvider) && (!imagesBySku || Object.keys(imagesBySku).length === 0)) {
      setState("error");
      setError(
        "Não consegui extrair/subir nenhuma foto deste PDF (recorte ou upload falhou pra todo " +
          "mundo) — use o botão abaixo pra buscar por texto (ScraperAPI) com os produtos já lidos, " +
          "ou tente reprocessar."
      );
      // Guarda `rows`/`meta` pro botão abaixo (ver imageUploadFailedOffer/
      // handleRetryAsText) — o catálogo já foi lido e parseado com
      // sucesso (nome/SKU/preço de fornecedor prontos), só a FOTO que
      // falhou pra todo mundo. "Reprocessar agora" reroda o parse INTEIRO
      // do zero à toa; isto deixa buscar por texto imediatamente com o
      // que já foi extraído, sem re-ler o PDF.
      if (!providerOverride) setImageUploadFailedOffer({ rows, meta });
      return;
    }
    // Catálogo sem texto real (nomes vieram de OCR de imagem, ver
    // usedOcr/ExtractResult) — busca por NOME tende a errar o produto
    // nesse caso (nome pode ter saído torto do OCR, ou ser só o código
    // do modelo). Só "busca por imagem" (Google Lens/SearchApi.io/motor
    // interno + IA, casa pela foto, não pelo nome) é confiável aqui —
    // trava os outros providers com um erro claro em vez de deixar
    // rodar e devolver preço errado silenciosamente.
    //
    // Auto-troca de provider (ago/2026): antes o usuário só via o erro e
    // precisava achar/clicar manualmente a opção de imagem certa antes de
    // reprocessar — ciclo de tentativa-e-erro real reportado em catálogo
    // OCR (ver conversa/diagnóstico). Já troca `searchProvider` sozinho
    // pra um provider de imagem disponível no grid atual — `withImages`
    // (processFile/handleForceReprocess) lê `searchProvider` no momento
    // do PRÓXIMO parse, então só falta o usuário clicar "Reprocessar
    // agora" (ver botão junto do banner de erro) pra image mode entrar
    // em vigor. Só troca em fluxo normal (`!providerOverride`) — não mexe
    // no caminho de retry do Unwrangle, que é um caso à parte.
    if (meta.usedOcr && !IMAGE_MODE_PROVIDERS.has(effectiveProvider)) {
      const imageModeFallback = !providerOverride
        ? SELECTABLE_PROVIDERS.find((p) => IMAGE_MODE_PROVIDERS.has(p.id))
        : undefined;
      if (imageModeFallback) setSearchProvider(imageModeFallback.id);
      setState("error");
      setError(
        imageModeFallback
          ? `Este PDF não tem texto real — o catálogo foi lido por OCR (imagem), e busca por NOME ` +
              `tende a errar o produto nesse caso. Já troquei o mecanismo pra "${imageModeFallback.label}" ` +
              `— clique em "Reprocessar agora" abaixo pra extrair as fotos e buscar de novo.`
          : "Este PDF não tem texto real — o catálogo foi lido por OCR (imagem), e busca por NOME " +
              "tende a errar o produto nesse caso. Troque pra \"Busca por imagem\" na seção 01 antes " +
              "de continuar."
      );
      return;
    }

    // Mescla a foto (quando existe, modo imagem) em cada linha ANTES de
    // calcular margem/salvar — assim `imageUrl` viaja junto com o resto
    // da linha em `MarginResult` (marginCalculator.ts) e em
    // `catalog_uploads` (catalogHistory.ts) sem precisar de um mapa
    // paralelo em nenhum outro lugar do app (ver coluna de foto em
    // ResultsTable.tsx).
    const rowsWithImages =
      imagesBySku && Object.keys(imagesBySku).length > 0
        ? rows.map((r) => (imagesBySku[r.sku] ? { ...r, imageUrl: imagesBySku[r.sku] } : r))
        : rows;

    setState("fetching");
    setProgress({ done: 0, total: rowsWithImages.length });
    setFoundSoFar(0);

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
    //
    // Tamanho do lote varia por provider: CHUNK_SIZE (20) pressupõe
    // concorrência 5 no servidor (googleShoppingProvider.ts) — vale pros
    // providers "rápidos" (1 chamada de API por item). O motor interno +
    // IA (`vision_internal`) é OUTRA classe de custo: concorrência 1 DE
    // PROPÓSITO (limite do tier gratuito do Gemini, ver
    // visionInternalSearchProvider.ts) e várias chamadas sequenciais por
    // item (descrever + comparar candidatos + raspagem) — um lote de 20
    // nesse provider é lento o bastante pra estourar o teto de execução
    // da function serverless (relato real: HTTP 504 em /api/fetch-prices
    // com catálogo de ~45 produtos). VISION_CHUNK_SIZE menor reduz o
    // trabalho por chamada, ficando com folga confortável do teto.
    const chunkSize = SLOW_AI_VISION_PROVIDERS.has(effectiveProvider) ? VISION_CHUNK_SIZE : CHUNK_SIZE;
    const chunks: CatalogRow[][] = [];
    for (let i = 0; i < rowsWithImages.length; i += chunkSize) chunks.push(rowsWithImages.slice(i, i + chunkSize));

    // Falha de UM lote (timeout, 504, instabilidade pontual) não derruba
    // os OUTROS lotes — mesma filosofia de isolamento de falha usada no
    // resto do app (ver visionInternalSearchProvider.ts): melhor mostrar
    // resultado PARCIAL (com aviso do que faltou) do que perder um
    // catálogo inteiro por causa de um lote ruim. Só propaga erro de
    // verdade se TODOS os lotes falharem — aí é sinal de problema
    // sistêmico (chave inválida, servidor fora), não de um lote lento
    // isolado.
    let failedItems = 0;
    let failedChunks = 0;
    let lastChunkErrorMessage: string | null = null;
    // Aviso de bloqueio PARCIAL do motor interno (ver
    // FetchPricesResult.warning, priceApi.ts) — `Set` porque o mesmo
    // aviso se repete em todo lote enquanto o bloqueio persistir; dedupe
    // evita repetir a mesma frase N vezes no banner final.
    const searchWarnings = new Set<string>();
    // SKUs dos lotes que falharam — vira a oferta "tentar de novo só os
    // que falharam" no fim (ver `retryOffer`), em vez de obrigar o
    // usuário a refazer o catálogo inteiro e pagar a cota de novo.
    const failedSkus: string[] = [];
    const missReasons = new Map<string, MissReason>();
    // Fotografia do contador ANTES de começar — base pra calcular o custo
    // real desta busca quando o servidor devolver o `_usage` (item 23).
    const usageAtSearchStart = todayUsage;
    setLastSearchCost(null);
    // Quantos produtos já saíram do laço (com sucesso OU falha) — é o
    // número que a mensagem de "busca interrompida" precisa mostrar.
    let processedItems = 0;

    // Cancelamento (set/2026): o controller vive num ref pra o botão
    // "Parar busca" (fora deste escopo) conseguir abortar o fetch em voo.
    const abortController = new AbortController();
    searchAbortRef.current = abortController;
    let cancelled = false;

    try {
      for (const chunk of chunks) {
        // Checagem ANTES do lote: o usuário pode ter mandado parar durante
        // a espera de cota logo abaixo, ou durante o lote anterior.
        if (abortController.signal.aborted) {
          cancelled = true;
          break;
        }

        // Ver comentário completo de `lastVisionQuotaExhaustedAtRef` mais
        // acima — se um lote ANTERIOR (desta busca ou de uma anterior na
        // mesma sessão, mesmo backend) já avisou que a cota esgotou há
        // pouco, esperar aqui o resto da janela evita mandar este lote pra
        // bater na MESMA parede: sem isso, o servidor ainda gastaria o
        // retry embutido (geminiVision.ts/mistralVision.ts) só pra descobrir
        // de novo o que o client já sabia antes de sequer mandar a
        // requisição.
        if (SLOW_AI_VISION_PROVIDERS.has(effectiveProvider) && lastVisionQuotaExhaustedAtRef.current !== null) {
          const elapsed = Date.now() - lastVisionQuotaExhaustedAtRef.current;
          const remaining = VISION_QUOTA_COOLDOWN_MS - elapsed;
          if (remaining > 0) {
            setSkippedInfo(
              `Aguardando ~${Math.ceil(remaining / 1000)}s a cota renovar antes do próximo lote ` +
                "(evita bater na mesma cota esgotada à toa)…"
            );
            await new Promise((resolve) => setTimeout(resolve, remaining));
            setSkippedInfo(null);
          }
        }

        const chunkItems = chunk.map((r) => ({
          sku: r.sku,
          name: r.name,
          imageUrl: imagesBySku?.[r.sku],
          // Custo vai junto (set/2026) só como ÂNCORA de sanidade de preço
          // no servidor (ver api/_lib/priceSanity.ts) — a margem continua
          // sendo calculada aqui no cliente. Catálogo "vitrine" (sem custo)
          // manda `undefined` e a checagem simplesmente não roda.
          supplierPrice: r.supplierPrice,
        }));
        const chunkStartedAt = performance.now();

        let fetched: Awaited<ReturnType<typeof fetchMultipleMarketplacePrices>>;
        try {
          // Sem `apiKey` na chamada (set/2026): o servidor lê a chave BYOK
          // do usuário direto do Firestore pelo uid do token — ver
          // api/_lib/userSecrets.ts. A chave não sai mais do navegador.
          fetched = await fetchMultipleMarketplacePrices(
            meta.marketplaces,
            chunkItems,
            effectiveProvider,
            abortController.signal
          );
        } catch (err) {
          // Cancelamento pedido pelo usuário: sai do laço mantendo o que
          // já foi encontrado — não conta como lote "falhado" nem entra
          // na oferta de retry.
          if (err instanceof DOMException && err.name === "AbortError") {
            cancelled = true;
            break;
          }

          // Caso específico: busca pública do Mercado Livre falhou (HTTP
          // 403, instabilidade conhecida desde fev/2026 — ver
          // mercadoLivreDirectProvider.ts) E o usuário já tem a chave
          // Unwrangle cadastrada (alternativa paga, ver
          // unwrangleMercadoLivreProvider.ts). Isso é sistêmico (vai
          // acontecer em TODO lote), não um lote ruim isolado — aborta
          // já oferecendo "tentar de novo com sua chave" em vez de
          // deixar rodar os lotes restantes sabendo que vão falhar igual.
          const message = err instanceof Error ? err.message : String(err);
          if (
            !providerOverride &&
            effectiveProvider === "mercadolivre_direct" &&
            message.includes("Mercado Livre bloqueou a busca pública") &&
            unwrangleApiKey
          ) {
            setState("error");
            setError(message);
            setMlFallbackOffer({ rows, meta, imagesBySku });
            return;
          }

          failedChunks++;
          failedItems += chunk.length;
          failedSkus.push(...chunk.map((r) => r.sku));
          processedItems += chunk.length;
          lastChunkErrorMessage = message;
          console.error(`[busca] lote de ${chunk.length} produto(s) falhou (seguindo com os próximos lotes):`, err);
          setProgress((p) =>
            p
              ? { done: Math.min(p.done + chunk.length, rowsWithImages.length), total: rowsWithImages.length }
              : p
          );
          continue;
        }

        // ms/item deste lote — vira 1 amostra do comparativo de
        // velocidade (ver providerSpeedStats.ts e o card "Velocidade por
        // mecanismo" na aside). Só registra lote com item de verdade
        // (chunkItems.length > 0 sempre aqui, mas a guarda existe pra
        // não dividir por zero se isso mudar).
        if (chunkItems.length > 0) {
          recordSample(effectiveProvider, (performance.now() - chunkStartedAt) / chunkItems.length);
        }

        for (const marketplace of meta.marketplaces) {
          const { results: prices, source, warning, usage, reasons } = fetched[marketplace];
          // Razão POR SKU de quem voltou sem preço (ver
          // api/_lib/searchMissReasons.ts) — acumula ao longo dos lotes
          // pra virar um resumo agrupado no fim da busca.
          if (reasons) {
            for (const [sku, reason] of Object.entries(reasons)) missReasons.set(sku, reason);
          }
          pricesByMarket[marketplace] = { ...pricesByMarket[marketplace], ...prices };
          if (source !== "server") allFromServer = false;
          // Cota agora é contada no SERVIDOR (ver api/_lib/searchQuota.ts,
          // set/2026) — a barra passa a refletir o número autoritativo,
          // lote a lote, em vez de uma soma local que o próprio navegador
          // fazia (e que, por isso, não valia como limite de nada).
          if (usage) {
            setTodayUsage(usage.used);
            setServerQuotaLimit(usage.limit);
            // `usageAtSearchStart` é lido uma vez por busca (ver acima do
            // laço) — a diferença é o custo REAL desta execução, incluindo
            // os lotes que falharam e os itens que vieram do cache.
            if (usageAtSearchStart !== null) setLastSearchCost(usage.used - usageAtSearchStart);
          }
          if (warning) {
            searchWarnings.add(warning);
            // Ver comentário de lastVisionQuotaExhaustedAtRef — marca o
            // instante pro PRÓXIMO lote (se houver) esperar a janela
            // renovar em vez de tentar às cegas e desperdiçar o retry
            // embutido no servidor. Marcador backend-agnóstico (ver
            // VISION_QUOTA_WARNING_MARKER) — pega tanto "Cota gratuita do
            // Gemini esgotada..." quanto "...do Mistral esgotada...".
            if (warning.includes(VISION_QUOTA_WARNING_MARKER)) {
              lastVisionQuotaExhaustedAtRef.current = Date.now();
            }
          }
        }

        processedItems += chunk.length;
        setProgress((p) =>
          p
            ? { done: Math.min(p.done + chunk.length, rowsWithImages.length), total: rowsWithImages.length }
            : p
        );

        // Ver comentário de `onProgress` na interface Props — entrega o
        // que já foi encontrado ATÉ AQUI, lote por lote, em vez de segurar
        // tudo pro final. `rowsWithImages` completo (não só o chunk atual)
        // porque `calculateMargins` precisa da lista toda pra calcular
        // margem de cada linha — linhas de lotes ainda não processados
        // simplesmente não têm entrada em `pricesByMarket` ainda, o que
        // já é o comportamento normal de "sem preço encontrado ainda".
        {
          let resultsSoFar: MarginResult[] = [];
          for (const marketplace of meta.marketplaces) {
            resultsSoFar = resultsSoFar.concat(
              calculateMargins(rowsWithImages, pricesByMarket[marketplace] ?? {}, rules)
            );
          }
          // `resultsSoFar` tem 1 linha por (produto × marketplace) — SKUs
          // distintos é a contagem que faz sentido pro usuário ("quantos
          // PRODUTOS já têm preço", não "quantas linhas"), senão um
          // catálogo com 2 marketplaces marcados contaria em dobro.
          setFoundSoFar(new Set(resultsSoFar.map((r) => r.sku)).size);
          onProgress?.({
            rows: rowsWithImages,
            pricesByMarket,
            results: resultsSoFar,
            source: allFromServer ? "server" : "local",
          });
        }
      }

      if (cancelled) {
        // Parada pedida pelo usuário: NÃO é erro. Segue pro resultado com
        // o que já foi encontrado (é justamente o motivo de existir o
        // botão), avisando quantos produtos ficaram de fora.
        setSkippedInfo(
          `Busca interrompida por você — ${processedItems} de ${rowsWithImages.length} produto(s) foram ` +
            "buscados. O resultado abaixo é parcial; os demais ficaram sem preço."
        );
      } else if (failedChunks > 0 && failedChunks === chunks.length) {
        // TODOS os lotes falharam — não é "um lote lento", é sistêmico
        // (chave inválida, servidor fora, etc.). Propaga erro de verdade
        // em vez de seguir pra tela de resultado com "0 produtos"
        // enganoso (parece busca vazia, não falha).
        throw new Error(lastChunkErrorMessage ?? "Todos os lotes de busca falharam.");
      }
      const searchInfoParts: string[] = [];
      if (failedItems > 0) {
        searchInfoParts.push(
          `${failedItems} produto(s) não puderam ser buscados (erro/timeout num lote) — o resultado ` +
            "abaixo é parcial. Use o botão abaixo pra tentar de novo SÓ esses produtos."
        );
        // Guarda o contexto pra repetir a busca só dos que falharam (ver
        // handleRetryFailed) — sem isso o usuário teria que refazer o
        // catálogo inteiro e pagar cota pelos que já deram certo.
        setFailedRetryOffer({ rows, meta, imagesBySku, skus: failedSkus });
      }
      // Resumo do "por quê" agrupado por razão (ver searchMissReasons.ts).
      // Fica FORA do bloco de `failedItems` acima porque são coisas
      // diferentes: lá o lote falhou (erro/timeout), aqui a busca rodou
      // normalmente e mesmo assim o produto não rendeu preço — antes as
      // duas situações chegavam ao usuário com a mesma cara ("sumiu").
      const reasonCounts = new Map<MissReason, number>();
      for (const [sku, reason] of missReasons) {
        if (failedSkus.includes(sku)) continue; // já explicado pelo aviso de lote
        reasonCounts.set(reason, (reasonCounts.get(reason) ?? 0) + 1);
      }
      const missTotal = [...reasonCounts.values()].reduce((sum, n) => sum + n, 0);
      if (missTotal > 0) {
        const detail = [...reasonCounts.entries()]
          .sort((a, b) => b[1] - a[1])
          .map(([reason, count]) => `${count} ${MISS_REASON_LABEL[reason]}`)
          .join("; ");
        searchInfoParts.push(`${missTotal} produto(s) ficaram sem preço — ${detail}.`);
      }
      if (searchWarnings.size > 0) {
        searchInfoParts.push(...searchWarnings);
      }
      if (searchInfoParts.length > 0) {
        setSkippedInfo(searchInfoParts.join(" "));
      }
    } finally {
      setProgress(null);
      setSpeedSummary(getSpeedSummary());
    }

    let allResults: MarginResult[] = [];
    for (const marketplace of meta.marketplaces) {
      allResults = allResults.concat(
        calculateMargins(rowsWithImages, pricesByMarket[marketplace] ?? {}, rules)
      );
    }

    const source = allFromServer ? "server" : "local";
    setState("idle");
    onComplete({ rows: rowsWithImages, pricesByMarket, results: allResults, source });

    // O incremento client-side (`addTodayUsage(userId, searchCost)`) foi
    // REMOVIDO aqui (set/2026, ver api/_lib/searchQuota.ts): quem conta a
    // cota agora é o servidor, dentro de uma transaction, ANTES de gastar
    // API. Manter os dois somando contaria em dobro — e a contagem que
    // vale é a do servidor, já que a do navegador nunca foi confiável
    // (o próprio usuário podia zerar o doc). A barra da tela é atualizada
    // lote a lote com o `_usage` que vem na resposta (ver acima).

    void saveCatalogUpload(userId, {
      fileName: meta.fileName,
      fileHash: meta.fileHash,
      sourceType: meta.sourceType,
      pageRange: meta.pageRange,
      marketplaces: meta.marketplaces,
      uploadedAt: Date.now(),
      rows: rowsWithImages,
      pricesByMarket,
      results: allResults,
      source,
    }).then(() => {
      if (userId) listCatalogUploads(userId).then(setUploadHistory);
      onHistoryChanged?.();
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

      const {
        rows,
        skippedAmbiguous,
        imagesBySku,
        usedOcr,
        usedGeminiPageExtraction,
        pagesWithNoProducts,
        duplicateSkusRemoved,
        ocrSkippedPages,
      } = await parse();
      setSkippedInfo(
        buildParseInfoMessage(
          rows.length,
          skippedAmbiguous,
          usedGeminiPageExtraction,
          pagesWithNoProducts,
          duplicateSkusRemoved,
          ocrSkippedPages
        )
      );
      await finishWithRows(
        rows,
        {
          fileName: file.name,
          fileHash,
          sourceType,
          pageRange,
          marketplaces: selectedMarketplaces,
          usedOcr,
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
    const withImages = sourceType === "pdf" && IMAGE_MODE_PROVIDERS.has(searchProvider);
    const parse = (): Promise<ParseOutcome> =>
      sourceType === "pdf"
        ? parsePdfCatalogFile(file, pageRange ?? undefined, {
            withImages,
            userId: userId ?? undefined,
            geminiApiKey: geminiApiKey ?? undefined,
          })
        : parseCatalogFile(file).then((rows) => ({ rows, skippedAmbiguous: 0 }));

    try {
      setState("parsing");
      const fileHash = await computeFileHash(file);
      const {
        rows,
        skippedAmbiguous,
        imagesBySku,
        usedOcr,
        usedGeminiPageExtraction,
        pagesWithNoProducts,
        duplicateSkusRemoved,
        ocrSkippedPages,
      } = await parse();
      setSkippedInfo(
        buildParseInfoMessage(
          rows.length,
          skippedAmbiguous,
          usedGeminiPageExtraction,
          pagesWithNoProducts,
          duplicateSkusRemoved,
          ocrSkippedPages
        )
      );
      await finishWithRows(
        rows,
        {
          fileName: file.name,
          fileHash,
          sourceType,
          pageRange,
          marketplaces: selectedMarketplaces,
          usedOcr,
        },
        imagesBySku
      );
    } catch (err) {
      setState("error");
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  /**
   * "Tentar de novo com sua chave Unwrangle" — repete a MESMA busca que
   * acabou de falhar (mercadolivre_direct, HTTP 403), trocando só o
   * provider/chave via override em finishWithRows, sem reprocessar o
   * arquivo (rows já estão prontas, guardadas em mlFallbackOffer no
   * momento da falha).
   */
  /**
   * "Parar busca" — cancela o fetch em voo e sai do laço de lotes
   * mantendo tudo que já foi encontrado (ver finishWithRows). O único
   * jeito de parar antes disso era recarregar a página, o que jogava fora
   * o resultado parcial junto.
   */
  function handleStopSearch() {
    searchAbortRef.current?.abort();
  }

  /**
   * "Tentar de novo só os que falharam" — repete a busca apenas pros SKUs
   * dos lotes que deram erro, reaproveitando as linhas já lidas do
   * arquivo (nada de reprocessar PDF/planilha) e sem gastar cota de novo
   * com os produtos que já voltaram com preço.
   */
  async function handleRetryFailed() {
    if (!failedRetryOffer) return;
    const { rows, meta, imagesBySku, skus } = failedRetryOffer;
    setFailedRetryOffer(null);

    const failedSet = new Set(skus);
    const rowsToRetry = rows.filter((r) => failedSet.has(r.sku));
    if (rowsToRetry.length === 0) return;

    await finishWithRows(rowsToRetry, meta, imagesBySku);
  }

  async function handleRetryWithUnwrangle() {
    if (!mlFallbackOffer || !unwrangleApiKey) return;
    const { rows, meta, imagesBySku } = mlFallbackOffer;
    setMlFallbackOffer(null);
    await finishWithRows(rows, meta, imagesBySku, "mercadolivre_alt");
  }

  /**
   * "Buscar por texto agora" — repete a busca com os PRODUTOS JÁ LIDOS
   * (nome/SKU/preço de fornecedor, ver imageUploadFailedOffer), sem
   * reprocessar o PDF do zero, quando um provider de imagem falhou por
   * não ter conseguido extrair/subir foto nenhuma.
   *
   * "scraperapi" (não "internal_search", que foi removido — ver
   * AB_TEST_PROVIDER_IDS) por ser o provider por TEXTO de referência do
   * app (DEFAULT_PROVIDER).
   *
   * ⚠️ Usa `providerOverride` (ver finishWithRows), que PULA a checagem
   * normal de `hasRequiredKey` — antes tudo bem, porque "scraperapi" não
   * pedia chave nenhuma. Desde que a chave virou BYOK (set/2026), esse
   * pulo deixou de ser inofensivo: sem checar aqui, o clique chegaria até
   * o servidor pra só então falhar com "cadastre sua chave" — funciona,
   * mas não é o UX rápido que o resto do app dá. Checagem explícita
   * abaixo replica o mesmo `hasRequiredKey`/`missingKeyMessage` do fluxo
   * normal, só que fixo em "scraperApiKey" (a chave de QUEM ESTE botão
   * de fato usa, independente de `activeProvider` no momento do clique).
   */
  async function handleRetryAsText() {
    if (!imageUploadFailedOffer) return;
    const { rows, meta } = imageUploadFailedOffer;
    if (!scraperApiKey) {
      setState("error");
      setError(missingKeyMessage("scraperApiKey"));
      return;
    }
    setImageUploadFailedOffer(null);
    await finishWithRows(rows, meta, undefined, "scraperapi");
  }

  async function handleCsv(file: File) {
    if (IMAGE_MODE_PROVIDERS.has(searchProvider)) {
      setError(
        "\"Busca por imagem\" precisa de foto do produto — planilha (.csv/.xlsx) não tem. " +
          "Troque de mecanismo ou suba um .pdf com foto."
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
    const withImages = IMAGE_MODE_PROVIDERS.has(searchProvider);
    await processFile(
      file,
      () =>
        parsePdfCatalogFile(file, pageRange, {
          withImages,
          userId: userId ?? undefined,
          geminiApiKey: geminiApiKey ?? undefined,
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
            Suba um catálogo em .csv, .xlsx ou .pdf, escolha onde comparar e a gente devolve preço de
            mercado e margem produto por produto.
          </p>
        </div>
        <div className={styles.headerCard}>
          <span className={styles.headerCardRow}>
            <span className={`${styles.headerCardDot} ${styles.dotSuccess}`} />
            fonte <b className={styles.headerCardStrong}>{activeProvider.label}</b>
          </span>
          {/* Mesmo motivo do card "Cota diária" abaixo: o contador vale pra
              todo mecanismo, não só SerpApi (auditoria item 23). */}
          {userId && todayUsage !== null && (
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
                {SELECTABLE_PROVIDERS.map((p) => {
                  const active = searchProvider === p.id;
                  const Icon = p.icon;
                  return (
                    <button
                      key={p.id}
                      type="button"
                      className={active ? styles.marketplaceCardActive : styles.marketplaceCard}
                      onClick={() => selectProvider(p.id)}
                      title={p.note}
                    >
                      <span
                        className={active ? styles.marketplaceIconBoxActive : styles.marketplaceIconBox}
                      >
                        <Icon size={15} />
                      </span>
                      <span className={styles.marketplaceCardText}>
                        <span className={styles.marketplaceCardLabel}>{p.label}</span>
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

              {/* Onboarding do BYOK (set/2026, auditoria item 24): o aviso de
                  chave faltando só existia DEPOIS da busca falhar e mandava
                  "vá em Conta" sem dizer onde criar a chave nem se é paga.
                  Aqui ele aparece no instante em que o mecanismo é escolhido,
                  com link direto e o custo — as duas dúvidas que faziam a
                  pessoa parar no meio. */}
              {userId && !hasRequiredKey && activeProvider.needsKey && (
                <p className={styles.byokHint}>
                  <AlertCircle size={13} />
                  <span>
                    Este mecanismo roda com a <b>sua</b> chave{" "}
                    {PROVIDER_KEY_GUIDE[activeProvider.needsKey].name} ({PROVIDER_KEY_GUIDE[activeProvider.needsKey].cost}).{" "}
                    <a
                      href={PROVIDER_KEY_GUIDE[activeProvider.needsKey].url}
                      target="_blank"
                      rel="noreferrer"
                    >
                      Criar chave
                    </a>{" "}
                    e cadastrar em Conta, no card "{PROVIDER_KEY_GUIDE[activeProvider.needsKey].card}".
                  </span>
                </p>
              )}

              {IMAGE_MODE_PROVIDERS.has(searchProvider) && (
                <div className={styles.subGroup}>
                  <span className={styles.subGroupLabel}>API em uso agora</span>
                  <div className={styles.apiSwitchRow}>
                    {/* Antes iterava SEARCH_PROVIDERS (todos), o que reintroduzia
                        google_lens_products/vision_internal aqui mesmo escondidos
                        do grid principal (ver AB_TEST_PROVIDER_IDS acima) — troca
                        pra SELECTABLE_PROVIDERS pra respeitar o mesmo recorte. */}
                    {SELECTABLE_PROVIDERS.filter((p) => IMAGE_MODE_PROVIDERS.has(p.id)).map((p) => {
                      const active = p.id === searchProvider;
                      const Icon = p.icon;
                      return (
                        <button
                          key={p.id}
                          type="button"
                          className={active ? styles.apiChipActive : styles.apiChip}
                          title={p.note}
                          onClick={() => selectProvider(p.id)}
                        >
                          <Icon size={12} />
                          {p.label}
                          {active && <Check size={11} strokeWidth={3} />}
                        </button>
                      );
                    })}
                  </div>
                  <p className={styles.subGroupHint}>
                    "Busca por imagem" usa a foto do catálogo pra achar o produto. Duas SerpApi/
                    SearchApi.io resolvem o preço com a chave/cota de Google Lens; "Motor interno +
                    IA (Gemini)" faz o mesmo sem essas duas, usando a chave Gemini pra descrever e
                    confirmar visualmente o produto no motor interno. Clique acima pra voltar pra
                    busca por texto (Motor interno, Amazon direto ou Mercado Livre) a qualquer
                    momento.
                  </p>
                </div>
              )}

              {MULTI_MARKETPLACE_PROVIDERS.has(searchProvider) && (
                <div className={styles.subGroup}>
                  <span className={styles.subGroupLabel}>
                    onde comparar ({activeProvider.label} cobre os dois — escolha um ou os dois)
                  </span>
                  <div className={styles.marketplaceGrid}>
                    {(searchProvider === "vision_internal"
                      ? [...AVAILABLE_MARKETPLACES, GENERAL_STORES_MARKETPLACE]
                      : AVAILABLE_MARKETPLACES
                    ).map((m) => {
                      const active = selectedMarketplaces.includes(m.id);
                      const Icon = m.icon;
                      return (
                        <button
                          key={m.id}
                          type="button"
                          className={active ? styles.marketplaceCardActive : styles.marketplaceCard}
                          onClick={() => toggleMarketplace(m.id)}
                          title={m.note}
                        >
                          <span
                            className={active ? styles.marketplaceIconBoxActive : styles.marketplaceIconBox}
                          >
                            <Icon size={15} />
                          </span>
                          <span className={styles.marketplaceCardText}>
                            <span className={styles.marketplaceCardLabel}>{m.label}</span>
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
                  {searchProvider === "vision_internal" && selectedMarketplaces.includes("geral") && (
                    <p className={styles.subGroupHint}>
                      "Lojas gerais" marcado: quando Amazon/Mercado Livre não confirmarem o produto por
                      foto, o motor interno + IA tenta achar em qualquer outra loja (Shopee, Magalu, loja
                      própria...) antes de desistir — entra marcado "Aproximado" na tela de Resultados,
                      numa coluna própria.
                    </p>
                  )}
                </div>
              )}
            </div>
          </section>

          <section className={styles.card}>
            <div className={styles.cardHeader}>
              <span className={styles.cardHeaderNumber}>02</span>
              <h2 className={styles.cardHeaderTitle}>Catálogo</h2>
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
                  {IMAGE_MODE_PROVIDERS.has(searchProvider) && (
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
                      .csv ou .xlsx com sku/nome/custo · .pdf de catálogo (pede intervalo de páginas)
                    </span>
                  </span>
                  <span className={styles.dropzoneButton}>Escolher arquivo</span>
                  <input
                    className={styles.fileInput}
                    type="file"
                    accept=".csv,.xlsx,.xlsm,.pdf"
                    onChange={(e) => e.target.files?.[0] && handleFile(e.target.files[0])}
                  />
                </label>
              )}
            </div>

            {(state !== "idle" || error || historyInfo || skippedInfo || mlFallbackOffer || failedRetryOffer || imageUploadFailedOffer || !userId || !hasRequiredKey) && (
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
                    {/* Contador ao vivo (ver onProgress/foundSoFar) — resolve o "rodou 5
                        minutos e só no final mostrou 2" (catálogo grande, motor interno + IA):
                        agora dá pra ver quantos JÁ deram certo sem esperar o lote inteiro
                        terminar, lote a lote. Só aparece depois do 1º lote resolver (evita
                        piscar "0 de X" no instante inicial, quando nada rodou ainda). */}
                    {progress && progress.done > 0 && (
                      <p className={styles.statusMuted}>
                        {foundSoFar} de {progress.done} já com preço encontrado até agora
                      </p>
                    )}
                    {progress && progress.total > 0 && (
                      <div className={styles.progressTrack}>
                        <div
                          className={styles.progressFill}
                          style={{ width: `${Math.round((progress.done / progress.total) * 100)}%` }}
                        />
                      </div>
                    )}
                    {/* "Parar busca" (set/2026) — catálogo grande roda por
                        minutos e, até aqui, a única saída era recarregar a
                        página, o que jogava fora TODO o resultado parcial.
                        Parar aqui mantém o que já foi encontrado. */}
                    <button className={styles.linkButton} type="button" onClick={handleStopSearch}>
                      Parar busca e ficar com o que já achei
                    </button>
                  </div>
                )}
                {error && (
                  <p className={styles.error}>
                    <AlertCircle size={14} style={{ verticalAlign: "-2px", marginRight: 4 }} />
                    {error}{" "}
                    {/* Reprocessa o MESMO arquivo já guardado em `lastUpload` (setado logo no
                        início de processFile, antes de qualquer guard) — cobre tanto o guard de
                        OCR (que já troca `searchProvider` sozinho, ver finishWithRows) quanto
                        qualquer outro erro recuperável sem precisar re-selecionar o arquivo. */}
                    {lastUpload && (
                      <button
                        className={styles.linkButton}
                        type="button"
                        onClick={() => void handleForceReprocess()}
                      >
                        Reprocessar agora
                      </button>
                    )}
                  </p>
                )}
                {mlFallbackOffer && (
                  <p className={styles.warningNote}>
                    <AlertCircle size={14} style={{ verticalAlign: "-2px", marginRight: 4 }} />
                    Quer tentar de novo usando sua chave Unwrangle no lugar do Mercado Livre público?{" "}
                    <button
                      className={styles.linkButton}
                      type="button"
                      onClick={() => void handleRetryWithUnwrangle()}
                    >
                      Tentar com Unwrangle
                    </button>
                  </p>
                )}
                {failedRetryOffer && (
                  <p className={styles.warningNote}>
                    <AlertCircle size={14} style={{ verticalAlign: "-2px", marginRight: 4 }} />
                    {failedRetryOffer.skus.length} produto(s) ficaram sem preço porque o lote deles falhou.{" "}
                    <button
                      className={styles.linkButton}
                      type="button"
                      onClick={() => void handleRetryFailed()}
                    >
                      Tentar de novo só esses {failedRetryOffer.skus.length}
                    </button>
                  </p>
                )}
                {imageUploadFailedOffer && (
                  <p className={styles.warningNote}>
                    <AlertCircle size={14} style={{ verticalAlign: "-2px", marginRight: 4 }} />
                    Os {imageUploadFailedOffer.rows.length} produto(s) já lidos deste PDF continuam disponíveis
                    — buscar o preço deles por texto (ScraperAPI) agora, sem reprocessar o arquivo?{" "}
                    <button
                      className={styles.linkButton}
                      type="button"
                      onClick={() => void handleRetryAsText()}
                    >
                      Buscar por texto agora
                    </button>
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
                      : activeProvider.needsKey
                        ? missingKeyMessage(activeProvider.needsKey)
                        : "Chave de API ausente."}
                  </p>
                )}
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
                    <span />
                  </div>
                  {uploadHistory.slice(0, 10).map((record) => {
                    const foundCount = record.results.length;
                    const failed = foundCount === 0;
                    return (
                      <div
                        key={record.id}
                        className={styles.tableRow}
                        role="button"
                        tabIndex={0}
                        onClick={() => loadHistoryRecord(record)}
                        onKeyDown={(e) => {
                          if (e.key === "Enter" || e.key === " ") {
                            e.preventDefault();
                            loadHistoryRecord(record);
                          }
                        }}
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
                        <button
                          type="button"
                          className={styles.tableRowDelete}
                          title="Excluir esta busca do histórico"
                          onClick={(e) => void handleDeleteRecord(e, record.id)}
                        >
                          <Trash2 size={13} />
                        </button>
                      </div>
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
                      : activeProvider.needsKey === "searchApiKey"
                        ? "Chave SearchApi.io própria"
                        : activeProvider.needsKey === "geminiApiKey"
                          ? "Chave Gemini própria"
                          : activeProvider.needsKey === "mistralApiKey"
                            ? "Chave Mistral própria"
                            : activeProvider.needsKey === "scraperApiKey"
                              ? "Chave ScraperAPI própria"
                              : "Chave de API"}
                </span>
                <span className={styles.prereqSub}>
                  {activeProvider.needsKey === null
                    ? "não precisa — endpoint público"
                    : hasRequiredKey
                      ? "cadastrada"
                      : /* Custo real por mecanismo (set/2026) — antes dizia sempre
                           "grátis", errado pro ScraperAPI (trial, depois pago). */
                        `${PROVIDER_KEY_GUIDE[activeProvider.needsKey].cost} — cadastre em Conta`}
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

          {/* Cota (set/2026, auditoria item 23): o card era exclusivo de quem
              usava SerpApi, mas o contador do servidor vale pra TODO
              mecanismo — quem rodava motor interno/ScraperAPI gastava cota
              sem nada na tela dizendo isso. O teto exibido vem do servidor
              (`_usage.limit`) quando já houve uma busca; antes dela, cai
              pro limite do plano, que é o palpite certo pra quem ainda não
              rodou nada. */}
          {userId && todayUsage !== null && (
            <section className={quotaWarning ? styles.cardWarning : styles.card}>
              <div className={styles.cardHeader}>
                <span className={styles.cardHeaderIcon}>
                  <Gauge size={13} />
                </span>
                <h2 className={styles.cardHeaderTitle}>Cota diária</h2>
                <span className={quotaWarning ? styles.quotaBadgeWarning : styles.cardHeaderMeta}>
                  {quotaWarning && <AlertCircle size={11} />}
                  {Math.round(quotaPct * 100)}%
                </span>
              </div>
              <div className={styles.quotaBody}>
                <div className={styles.quotaTrack}>
                  <div
                    className={quotaWarning ? styles.quotaFillWarning : styles.quotaFill}
                    style={{ width: `${Math.round(quotaPct * 100)}%` }}
                  />
                </div>
                <span className={styles.quotaLabel}>
                  {todayUsage} / {effectiveQuotaLimit} busca(s) hoje
                  {serverQuotaLimit !== null && serverQuotaLimit > plan.dailySearchLimit
                    ? " · com sua própria chave"
                    : ` · plano ${plan.name}`}
                </span>
                {lastSearchCost !== null && lastSearchCost > 0 && (
                  <span className={styles.quotaLabel}>
                    Última busca consumiu <b>{lastSearchCost}</b> — contagem do servidor, já descontando o
                    que veio do cache.
                  </span>
                )}
              </div>
            </section>
          )}

          <section className={styles.card}>
            <div className={styles.cardHeader}>
              <span className={styles.cardHeaderIcon}>
                <Zap size={13} />
              </span>
              <h2 className={styles.cardHeaderTitle}>Velocidade por mecanismo</h2>
            </div>
            {speedSummary.length === 0 ? (
              <p className={styles.speedEmpty}>
                Ainda sem dado — aparece aqui depois da primeira busca com cada mecanismo (medido
                neste navegador, ms por produto).
              </p>
            ) : (
              <div className={styles.speedList}>
                {(() => {
                  const maxMs = Math.max(...speedSummary.map((s) => s.avgMsPerItem));
                  return speedSummary.map((s) => {
                    const label = SEARCH_PROVIDERS.find((p) => p.id === s.provider)?.label ?? s.provider;
                    return (
                      <div key={s.provider} className={styles.speedRow}>
                        <span className={styles.speedRowLabel}>{label}</span>
                        <span className={styles.speedTrack}>
                          <span
                            className={styles.speedFill}
                            style={{ width: `${Math.max(6, Math.round((s.avgMsPerItem / maxMs) * 100))}%` }}
                          />
                        </span>
                        <span className={styles.speedValue}>{Math.round(s.avgMsPerItem)}ms</span>
                      </div>
                    );
                  });
                })()}
                <p className={styles.speedCaption}>
                  média de ms por produto, medida nas suas últimas buscas — mais curto é mais rápido.
                </p>
              </div>
            )}
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
