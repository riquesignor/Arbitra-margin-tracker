import type { ApiRequest, ApiResponse } from "./_lib/httpTypes.js";
import type { CatalogItemQuery, MarketplaceId, SearchProviderId, VisionCandidateSource } from "./_lib/types.js";
import { fetchPricesCore, FetchPricesValidationError } from "./_lib/fetchPricesCore.js";
import { requireVerifiedAuth, UnauthorizedError, EmailNotVerifiedError } from "./_lib/verifyAuth.js";
import { isSafeCatalogImageUrl } from "./_lib/safeImageUrl.js";
import { consumeSearchQuota, QuotaExceededError, type QuotaConsumption } from "./_lib/searchQuota.js";

/**
 * Teto de produtos por requisição (set/2026, ver docs/auditoria-2026-09.md
 * > P0-3). O cliente já fatia catálogo grande em lotes de 20 (CHUNK_SIZE
 * em Dashboard.tsx) ou 3 (VISION_CHUNK_SIZE) — este teto existe pra quem
 * NÃO passa pelo cliente: sem ele, uma requisição podia pedir milhares de
 * produtos de uma vez e queimar crédito de API (inclusive o
 * ScraperAPI, BYOK desde set/2026 mas ainda assim do PRÓPRIO usuário) num
 * request só. 50 dá folga de 2,5x sobre o maior lote que o app manda.
 */
const MAX_ITEMS_PER_REQUEST = 50;

const VALID_MARKETPLACES: MarketplaceId[] = ["amazon", "shopee", "mercadolivre", "geral"];
const VALID_PROVIDERS: SearchProviderId[] = [
  "serpapi",
  "rapidapi_amazon",
  "mercadolivre_direct",
  "mercadolivre_alt",
  "google_lens_products",
  "searchapi_lens",
  "vision_internal",
  "vision_mistral",
  "vision_nvidia",
  "scraperapi",
];

interface RequestBody {
  marketplaces?: string[];
  items?: CatalogItemQuery[];
  /**
   * ⚠️ IGNORADO desde set/2026 (ver api/_lib/userSecrets.ts): a chave BYOK
   * passou a ser lida no servidor, a partir do uid do token. O campo
   * segue declarado só pra documentar que uma versão antiga do cliente
   * ainda pode mandá-lo — e que ele não é lido, nem logado.
   */
  apiKey?: string;
  /** Qual API de busca usar — default "serpapi" pra manter compatibilidade. */
  provider?: string;
  /**
   * Fonte de candidato pro motor interno + IA (set/2026, ver
   * VisionCandidateSource em _lib/types.ts) — só lido quando `provider`
   * é "vision_internal"/"vision_mistral"; ignorado (sem erro) pros demais,
   * mesmo padrão de tolerância de `apiKey` acima pra campo que não se
   * aplica ao provider da requisição.
   */
  candidateSource?: string;
}

function isValidMarketplaces(value: unknown): value is MarketplaceId[] {
  return (
    Array.isArray(value) &&
    value.length > 0 &&
    value.every((v) => typeof v === "string" && (VALID_MARKETPLACES as string[]).includes(v))
  );
}

function isValidItems(value: unknown): value is CatalogItemQuery[] {
  return (
    Array.isArray(value) &&
    value.length > 0 &&
    value.every((v) => typeof v?.sku === "string" && typeof v?.name === "string")
  );
}

/**
 * Fronteira de confiança do SSRF (set/2026, ver docs/auditoria-2026-09.md
 * > P0-2 e api/_lib/safeImageUrl.ts): `imageUrl` é o ÚNICO campo do corpo
 * da requisição que o servidor usa como alvo de um `fetch()` — os
 * providers de foto (Gemini/Mistral) baixam essa URL pra mandar a imagem
 * pro modelo. Sem esta checagem, um usuário autenticado escolhia
 * livremente o que a function ia buscar (metadata da nuvem, serviço
 * interno, host arbitrário).
 *
 * Só aceita o formato que o PRÓPRIO app gera (`/api/catalog-image`, ver
 * uploadCatalogImage em src/lib/catalogImages.ts). Item sem `imageUrl`
 * continua válido — busca por texto não precisa de foto, e os providers
 * de imagem já pulam item sem foto em silêncio.
 */
function findInvalidImageUrlItem(items: CatalogItemQuery[]): CatalogItemQuery | undefined {
  return items.find((item) => item.imageUrl !== undefined && !isSafeCatalogImageUrl(item.imageUrl));
}

function isValidProvider(value: unknown): value is SearchProviderId {
  return typeof value === "string" && (VALID_PROVIDERS as string[]).includes(value);
}

const VALID_CANDIDATE_SOURCES: VisionCandidateSource[] = ["auto", "scraperapi", "serpapi", "searchapi"];
function isValidCandidateSource(value: unknown): value is VisionCandidateSource {
  return typeof value === "string" && (VALID_CANDIDATE_SOURCES as string[]).includes(value);
}

/**
 * POST /api/fetch-prices
 * Body: { marketplaces: MarketplaceId[], items: {sku, name}[], apiKey?, provider? }
 * Resposta: { [marketplace]: { [sku]: MarketplacePriceResult } }
 *
 * `provider` (default "serpapi", ver SearchProviderId em _lib/types.ts)
 * escolhe QUAL API resolve o preço, eixo independente de `marketplaces`:
 *   - "serpapi", "google_lens_products", "searchapi_lens",
 *     "vision_internal" e "scraperapi" aceitam VÁRIOS marketplaces numa
 *     chamada só (contrato mudou de `marketplace: string` singular pra
 *     `marketplaces: string[]` — ver docs/architecture-review.md item
 *     15): amazon + mercadolivre numa busca só por produto, em vez de uma
 *     busca por produto POR marketplace. Os cinco só diferem no
 *     INSUMO/vendor — nome em texto (SerpApi/Google Shopping ou
 *     ScraperAPI) ou foto do produto via `item.imageUrl` (Google Lens por
 *     SerpApi, por SearchApi.io, ou motor interno + IA via Gemini —
 *     `apiKey` muda de significado conforme o provider: chave
 *     SerpApi/SearchApi.io nos dois primeiros, chave Gemini em
 *     "vision_internal") — não em quantos marketplaces cobrem.
 *   - "rapidapi_amazon", "mercadolivre_direct" e "mercadolivre_alt" só
 *     cobrem UM marketplace fixo cada (ver DIRECT_PROVIDER_MARKETPLACE em
 *     _lib/fetchPricesCore.ts) — branch separado, mais simples que o
 *     caminho compartilhado. "mercadolivre_alt" (Unwrangle, BYOK) é a
 *     alternativa paga oferecida só quando "mercadolivre_direct" falha —
 *     ver fluxo de fallback em Dashboard.tsx.
 * Cache (`market_prices`) é por provider+marketplace: o mesmo SKU pode
 * estar em cache pra "serpapi/amazon" e não pra "rapidapi_amazon/amazon"
 * (fontes diferentes, preços podem divergir) — ver cache.ts.
 *
 * A busca em si (resolução de chave BYOK, cache, chamada ao provider
 * certo) mora em `_lib/fetchPricesCore.ts` (out/2026, extraído daqui pra
 * ser reaproveitado pela checagem de monitoramento — ver
 * api/check-watch.ts e api/cron-check-watches.ts) — este handler cuida só
 * do que é específico de HTTP: validar corpo, autenticar, reservar cota,
 * moldar a resposta.
 */
export default async function handler(req: ApiRequest, res: ApiResponse): Promise<void> {
  if (req.method !== "POST") {
    res.status(405).json({ error: "Método não permitido" });
    return;
  }

  // Autenticação obrigatória — ver docs/architecture-review.md > Segurança.
  let uid: string;
  try {
    uid = await requireVerifiedAuth(req);
  } catch (err) {
    if (err instanceof UnauthorizedError) {
      res.status(401).json({ error: err.message });
      return;
    }
    if (err instanceof EmailNotVerifiedError) {
      res.status(403).json({ error: err.message });
      return;
    }
    throw err;
  }

  const body = req.body as RequestBody;

  if (!isValidMarketplaces(body?.marketplaces)) {
    res.status(400).json({ error: "marketplaces deve ser um array não vazio de marketplaces válidos" });
    return;
  }
  if (!isValidItems(body.items)) {
    res.status(400).json({ error: "items deve ser um array não vazio de {sku, name}" });
    return;
  }
  if (body.items.length > MAX_ITEMS_PER_REQUEST) {
    res.status(400).json({
      error:
        `Máximo de ${MAX_ITEMS_PER_REQUEST} produtos por requisição (recebidos ${body.items.length}). ` +
        "O app já divide catálogo grande em lotes automaticamente.",
    });
    return;
  }
  const invalidImageItem = findInvalidImageUrlItem(body.items);
  if (invalidImageItem) {
    res.status(400).json({
      error:
        `A foto do produto "${invalidImageItem.sku}" não veio de /api/catalog-image — ` +
        "só aceitamos foto hospedada pelo próprio app na busca por imagem.",
    });
    return;
  }
  if (body.provider !== undefined && !isValidProvider(body.provider)) {
    res.status(400).json({ error: `provider inválido: ${VALID_PROVIDERS.join(" | ")}` });
    return;
  }
  if (body.candidateSource !== undefined && !isValidCandidateSource(body.candidateSource)) {
    res.status(400).json({ error: `candidateSource inválido: ${VALID_CANDIDATE_SOURCES.join(" | ")}` });
    return;
  }

  const marketplaces = body.marketplaces;
  const items = body.items;
  // Default é "scraperapi" (ago/2026, desde a remoção de "internal_search"
  // — decisão de produto pós A/B): é o único sem custo por busca e sem
  // chave que sobrou no seletor depois da remoção, então é o comportamento
  // certo pra quem não escolheu nada explicitamente. Antes era "serpapi",
  // que falhava de cara sem BYOK configurado.
  const provider: SearchProviderId = isValidProvider(body.provider) ? body.provider : "scraperapi";
  const candidateSource: VisionCandidateSource = isValidCandidateSource(body.candidateSource)
    ? body.candidateSource
    : "auto";

  console.log(
    `[fetch-prices] uid=${uid} provider=${provider} marketplaces=${marketplaces.join("+")} items=${items.length}`
  );

  // Cota ANTES de qualquer chamada externa (set/2026, ver
  // api/_lib/searchQuota.ts): reserva o custo desta requisição e recusa
  // com 429 se estourar o teto do dia. Mesma unidade que a barra de cota
  // da tela já usa (produto × marketplace, ver `searchCost` em
  // Dashboard.tsx). O cliente NÃO incrementa mais o contador — quem
  // manda agora é este ponto, senão contaria em dobro.
  let quota: QuotaConsumption;
  try {
    quota = await consumeSearchQuota(uid, provider, items.length * marketplaces.length);
  } catch (err) {
    if (err instanceof QuotaExceededError) {
      res.status(429).json({ error: err.message, used: err.used, limit: err.limit });
      return;
    }
    // Falha de infraestrutura no contador (rede/Firestore) não pode
    // derrubar a busca do usuário — segue sem reservar, e o log fica
    // pra investigar. Falha ABERTA aqui é deliberada: o teto existe
    // contra abuso, não contra o usuário legítimo do dia a dia.
    console.error("[fetch-prices] falha ao reservar cota (seguindo sem bloquear):", err);
    quota = { used: 0, limit: 0 };
  }

  try {
    const { byMarketplace, warning, reasons } = await fetchPricesCore(
      uid,
      provider,
      marketplaces,
      items,
      candidateSource
    );

    // `_warning` é aditivo — não é um marketplace, então o cliente antigo
    // (que só lê chaves de marketplace conhecidas, ver priceApi.ts)
    // ignora sem quebrar; o cliente novo lê e mostra no banner de aviso
    // (ver Dashboard.tsx > finishWithRows).
    // `_usage` é aditivo, mesmo espírito do `_warning` acima: não é um
    // marketplace, então cliente antigo ignora. O cliente novo usa isso
    // pra atualizar a barra de cota com o número AUTORITATIVO do servidor,
    // em vez de somar por conta própria (ver Dashboard.tsx — o incremento
    // client-side foi removido junto com esta mudança).
    // `_reasons` é aditivo pelo mesmo motivo: diz POR SKU por que o
    // produto voltou sem preço (ver searchMissReasons.ts e auditoria
    // item 21).
    res.status(200).json({
      ...byMarketplace,
      ...(warning ? { _warning: warning } : {}),
      ...(quota.limit > 0 ? { _usage: quota } : {}),
      ...(Object.keys(reasons).length > 0 ? { _reasons: reasons } : {}),
    });
  } catch (err) {
    if (err instanceof FetchPricesValidationError) {
      res.status(400).json({ error: err.message });
      return;
    }
    res.status(502).json({
      error: "Busca de preço indisponível",
      detail: err instanceof Error ? err.message : String(err),
    });
  }
}
