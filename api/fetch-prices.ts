import type { ApiRequest, ApiResponse } from "./_lib/httpTypes.js";
import type {
  CatalogItemQuery,
  MarketplaceId,
  MarketplacePriceResult,
  SearchProviderId,
  VisionCandidateSource,
} from "./_lib/types.js";
import { getCachedPrices, writeCachedPrices } from "./_lib/cache.js";
import { getProvider, isGoogleShoppingMarketplace } from "./_lib/providers/registry.js";
import { GOOGLE_SHOPPING_MATCHERS, searchGoogleShoppingShared } from "./_lib/providers/googleShoppingProvider.js";
import { searchGoogleLensProductsShared } from "./_lib/providers/googleLensProvider.js";
import { searchSearchApiLensShared } from "./_lib/providers/searchApiLensProvider.js";
import {
  searchVisionInternalShared,
  GEMINI_BACKEND,
  MISTRAL_BACKEND,
  NVIDIA_BACKEND,
} from "./_lib/providers/visionInternalSearchProvider.js";
import { searchScraperApiShared } from "./_lib/providers/scraperApiSearchProvider.js";
import { fetchRapidApiAmazonPrices } from "./_lib/providers/rapidApiAmazonProvider.js";
import { fetchMercadoLivreDirectPrices } from "./_lib/providers/mercadoLivreDirectProvider.js";
import { fetchUnwrangleMercadoLivrePrices } from "./_lib/providers/unwrangleMercadoLivreProvider.js";
import { requireAuth, UnauthorizedError } from "./_lib/verifyAuth.js";
import { isSafeCatalogImageUrl } from "./_lib/safeImageUrl.js";
import { getUserApiKeyForProvider, getUserScraperApiKey } from "./_lib/userSecrets.js";
import { detectPackQuantity, unitPriceFromPack } from "./_lib/packQuantity.js";
import { flagPriceSanity } from "./_lib/priceSanity.js";
import { consumeSearchQuota, QuotaExceededError, type QuotaConsumption } from "./_lib/searchQuota.js";
import { collectMissReasons } from "./_lib/searchMissReasons.js";

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

// Providers que só cobrem UM marketplace fixo cada — ver
// SearchProviderId em _lib/types.ts. "serpapi", "google_lens_products" e
// "searchapi_lens" NÃO entram aqui: os três cobrem amazon+mercadolivre
// numa busca só (dois insumos possíveis — nome em texto ou foto do
// produto — e dois vendors pro insumo foto) — ver branch "shared" mais
// abaixo. "mercadolivre_alt" é a alternativa PAGA (Unwrangle) ao
// endpoint público — mesmo grupo "direto" que "mercadolivre_direct",
// só muda o vendor por trás; não aparece no seletor normal (ver
// Dashboard.tsx), só no fluxo de fallback quando o público falha.
type DirectProvider = "rapidapi_amazon" | "mercadolivre_direct" | "mercadolivre_alt";
const DIRECT_PROVIDER_MARKETPLACE: Record<DirectProvider, MarketplaceId> = {
  rapidapi_amazon: "amazon",
  mercadolivre_direct: "mercadolivre",
  mercadolivre_alt: "mercadolivre",
};
function isDirectProvider(p: SearchProviderId): p is DirectProvider {
  return p === "rapidapi_amazon" || p === "mercadolivre_direct" || p === "mercadolivre_alt";
}

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
/**
 * Anota `packQuantity`/`unitPrice` em todo resultado cujo TÍTULO do
 * anúncio diga que é lote (set/2026, ver packQuantity.ts e
 * docs/auditoria-2026-09.md > item 10).
 *
 * Feito aqui, num ponto só, de propósito: são 6 providers montando
 * `MarketplacePriceResult`, e a informação necessária (`matchedTitle` +
 * `price`) já está pronta em todos. Também cobre resultado vindo do CACHE
 * — entrada gravada antes desta anotação existir ganha os campos na
 * leitura, sem migração nenhuma.
 *
 * Não altera `price`: quem decide usar o preço unitário no cálculo é o
 * marginCalculator (client), e a UI continua podendo mostrar o preço cheio
 * do anúncio. Aqui só ANOTA.
 */
function annotatePackPricing(byMarketplace: Record<string, Record<string, MarketplacePriceResult>>): void {
  for (const results of Object.values(byMarketplace)) {
    for (const [sku, result] of Object.entries(results)) {
      const pack = detectPackQuantity(result.matchedTitle);
      const unitPrice = unitPriceFromPack(result.price, pack);
      if (pack && unitPrice != null) {
        results[sku] = { ...result, packQuantity: pack.quantity, unitPrice };
      }
    }
  }
}

/**
 * Sanidade de preço contra o custo do catálogo (set/2026, ver
 * priceSanity.ts). Roda DEPOIS de `annotatePackPricing` de propósito: a
 * comparação usa o preço unitário quando o anúncio é lote, senão um kit
 * legítimo de 12 seria reprovado por "preço alto demais" sendo que o
 * preço por peça está perfeito.
 *
 * Também é o único ponto que precisa do `supplierPrice` do item — por
 * isso ele passou a viajar no `CatalogItemQuery` (ver types.ts). Nada
 * mais no servidor usa esse número; margem continua sendo calculada no
 * cliente.
 */
function annotatePriceSanity(
  byMarketplace: Record<string, Record<string, MarketplacePriceResult>>,
  items: CatalogItemQuery[]
): void {
  const supplierPriceBySku = new Map(items.map((item) => [item.sku, item.supplierPrice]));

  for (const results of Object.values(byMarketplace)) {
    for (const [sku, result] of Object.entries(results)) {
      results[sku] = flagPriceSanity(result, supplierPriceBySku.get(sku));
    }
  }
}

/**
 * Mecanismos que decidem o match olhando a FOTO (o texto é só pré-filtro
 * ou nem isso) — os demais decidem por similaridade de nome. Ver
 * `confidenceSource` em types.ts.
 */
const VISUAL_MATCH_PROVIDERS = new Set<SearchProviderId>([
  "google_lens_products",
  "searchapi_lens",
  "vision_internal",
  "vision_mistral",
  "vision_nvidia",
]);

/**
 * Carimba a ORIGEM da confiança em cada resultado. Feito aqui, e não em
 * cada provider, porque a informação é o próprio `provider` da
 * requisição: são 8 arquivos montando `MarketplacePriceResult` e todos
 * teriam que repetir a mesma constante — um ponto só evita divergência
 * quando um mecanismo novo entrar.
 *
 * ⚠️ NÃO sobrescreve `confidenceSource` já preenchido (set/2026) —
 * histórico: até set/2026 o motor interno + IA tinha um FAST LANE
 * (candidateSource "serpapi"/"searchapi") que delegava pra
 * `searchGoogleShoppingShared`/`searchSearchApiLensShared` como provider
 * standalone e o resultado vinha SEM `confidenceSource`, então esta guarda
 * existia pra não carimbar "visual" por engano quando a fast lane
 * "serpapi" tinha decidido por texto. O FAST LANE foi removido (ver
 * VisionCandidateSource em ../api/_lib/types.ts) — hoje "vision_internal"/
 * "vision_mistral" sempre passam pela comparação visual de verdade,
 * então sempre caem no default "visual" abaixo, correto pros 3 (auto/
 * scraperapi/serpapi/searchapi). A guarda em si continua útil (defesa em
 * profundidade caso algum provider volte a preencher o campo sozinho no
 * futuro), só o motivo histórico de existir mudou.
 */
function annotateConfidenceSource(
  byMarketplace: Record<string, Record<string, MarketplacePriceResult>>,
  provider: SearchProviderId
): void {
  const defaultConfidenceSource: "visual" | "texto" = VISUAL_MATCH_PROVIDERS.has(provider) ? "visual" : "texto";

  for (const results of Object.values(byMarketplace)) {
    for (const [sku, result] of Object.entries(results)) {
      results[sku] = { ...result, confidenceSource: result.confidenceSource ?? defaultConfidenceSource };
    }
  }
}

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
 *     cobrem UM marketplace fixo cada (ver DIRECT_PROVIDER_MARKETPLACE) —
 *     branch separado logo no início do handler, mais simples que o
 *     caminho compartilhado. "mercadolivre_alt" (Unwrangle, BYOK) é a
 *     alternativa paga oferecida só quando "mercadolivre_direct" falha —
 *     ver fluxo de fallback em Dashboard.tsx.
 * Cache (`market_prices`) é por provider+marketplace: o mesmo SKU pode
 * estar em cache pra "serpapi/amazon" e não pra "rapidapi_amazon/amazon"
 * (fontes diferentes, preços podem divergir) — ver cache.ts.
 */
export default async function handler(req: ApiRequest, res: ApiResponse): Promise<void> {
  if (req.method !== "POST") {
    res.status(405).json({ error: "Método não permitido" });
    return;
  }

  // Autenticação obrigatória — ver docs/architecture-review.md > Segurança.
  let uid: string;
  try {
    uid = await requireAuth(req);
  } catch (err) {
    if (err instanceof UnauthorizedError) {
      res.status(401).json({ error: err.message });
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
  // Só tem efeito pra "vision_internal"/"vision_mistral" (ver
  // VisionCandidateSource em _lib/types.ts) — default "auto" preserva a
  // cascata de sempre pros dois providers, e é simplesmente ignorado pelos
  // demais (nunca chega a ser lido fora do branch deles, mais abaixo).
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
  // Chave BYOK lida NO SERVIDOR a partir do uid já verificado (set/2026,
  // ver api/_lib/userSecrets.ts) — `apiKey` não é mais usado. Antes,
  // a chave vinha do navegador em toda requisição, o que expunha as seis
  // chaves do usuário a qualquer XSS. `undefined` aqui significa "provider
  // não é BYOK" ou "usuário não cadastrou" — cada provider já trata isso
  // com mensagem própria.
  const apiKey = await getUserApiKeyForProvider(uid, provider);
  // Chave ScraperAPI (BYOK, set/2026 — ver api/_lib/userSecrets.ts):
  // resolvida SEMPRE, independente do `provider` pedido — diferente de
  // `apiKey` acima (que resolve só a chave do provider selecionado), esta
  // é usada de forma cruzada (mecanismo "scraperapi" em si, fallback do
  // motor interno + IA, retry de imagem bloqueada), então precisa estar
  // disponível não importa qual provider o usuário escolheu.
  const scraperApiKey = await getUserScraperApiKey(uid);
  // Chaves da FAST LANE (set/2026, ver VisionCandidateSource em
  // _lib/types.ts) — resolvidas só quando de fato vão ser usadas
  // (provider é um dos dois motores internos E o usuário fixou essa fonte
  // no pop-up), pra não pagar leitura extra de Firestore à toa em toda
  // requisição dos outros providers. Mesmo mapa de campo que "serpapi"/
  // "searchapi_lens" já usam como provider standalone (ver
  // PROVIDER_SECRET_FIELD, userSecrets.ts) — reaproveitado aqui, não é
  // uma chave nova.
  const isVisionProvider =
    provider === "vision_internal" || provider === "vision_mistral" || provider === "vision_nvidia";
  const serpApiKeyForVision =
    isVisionProvider && candidateSource === "serpapi"
      ? await getUserApiKeyForProvider(uid, "serpapi")
      : undefined;
  const searchApiKeyForVision =
    isVisionProvider && candidateSource === "searchapi"
      ? await getUserApiKeyForProvider(uid, "searchapi_lens")
      : undefined;

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

  // Providers "diretos" só cobrem 1 marketplace fixo — branch isolado,
  // sem passar pela lógica de busca compartilhada abaixo (que serve
  // "serpapi" e "google_lens_products", os dois multi-marketplace).
  if (isDirectProvider(provider)) {
    const expectedMarketplace = DIRECT_PROVIDER_MARKETPLACE[provider];
    if (marketplaces.length !== 1 || marketplaces[0] !== expectedMarketplace) {
      res.status(400).json({
        error:
          `O provider "${provider}" só busca o marketplace "${expectedMarketplace}" — ` +
          `envie marketplaces: ["${expectedMarketplace}"]`,
      });
      return;
    }

    try {
      const cached = await getCachedPrices(
        uid,
        provider,
        expectedMarketplace,
        items.map((i) => i.sku)
      );
      const missItems = items.filter((i) => cached.misses.includes(i.sku));

      let fresh: Record<string, MarketplacePriceResult> = {};
      if (missItems.length > 0) {
        fresh =
          provider === "rapidapi_amazon"
            ? await fetchRapidApiAmazonPrices(missItems, apiKey)
            : provider === "mercadolivre_alt"
              ? await fetchUnwrangleMercadoLivrePrices(missItems, apiKey)
              : await fetchMercadoLivreDirectPrices(missItems);

        try {
          await writeCachedPrices(uid, provider, expectedMarketplace, fresh);
        } catch (cacheErr) {
          console.error(
            `writeCachedPrices(${provider}/${expectedMarketplace}) falhou (ignorando, best-effort):`,
            cacheErr
          );
        }
      }

      const directResponse = { [expectedMarketplace]: { ...cached.hits, ...fresh } };
      annotatePackPricing(directResponse);
      annotatePriceSanity(directResponse, items);
      annotateConfidenceSource(directResponse, provider);

      const directReasons = collectMissReasons(directResponse, items, provider);

      res.status(200).json({
        ...directResponse,
        // Ver `_usage` no branch compartilhado abaixo.
        ...(quota.limit > 0 ? { _usage: quota } : {}),
        // Ver `_reasons` no branch compartilhado abaixo.
        ...(Object.keys(directReasons).length > 0 ? { _reasons: directReasons } : {}),
      });
    } catch (err) {
      res.status(502).json({
        error: "Busca de preço indisponível",
        detail: err instanceof Error ? err.message : String(err),
      });
    }
    return;
  }

  try {
    // 1) Cache por marketplace — hits/misses independentes (ver doc acima).
    const cacheByMarketplace = new Map<
      MarketplaceId,
      { hits: Record<string, MarketplacePriceResult>; misses: string[] }
    >();
    await Promise.all(
      marketplaces.map(async (marketplace) => {
        const cached = await getCachedPrices(
          uid,
          provider,
          marketplace,
          items.map((i) => i.sku)
        );
        cacheByMarketplace.set(marketplace, cached);
      })
    );

    const responseByMarketplace: Record<string, Record<string, MarketplacePriceResult>> = {};
    for (const marketplace of marketplaces) {
      responseByMarketplace[marketplace] = { ...cacheByMarketplace.get(marketplace)!.hits };
    }

    // Aviso de cota/qualidade do motor interno + IA (ver
    // visionInternalSearchProvider.ts) — só "vision_internal" preenche
    // isto; fica `undefined` pros demais providers. Declarado no escopo da
    // função pra sobreviver até o `res.status(200).json(...)` final, mesmo
    // sendo atribuído dentro do bloco de busca compartilhada mais abaixo.
    let internalSearchWarning: string | undefined;

    // 2) Marketplaces do grupo Google Shopping: 1 busca por produto
    // cobrindo a UNIÃO dos misses de todos eles.
    const sharedMarketplaces = marketplaces.filter(isGoogleShoppingMarketplace);
    if (sharedMarketplaces.length > 0) {
      const missedSkus = new Set<string>();
      for (const m of sharedMarketplaces) {
        for (const sku of cacheByMarketplace.get(m)!.misses) missedSkus.add(sku);
      }
      const missItems = items.filter((i) => missedSkus.has(i.sku));

      if (missItems.length > 0) {
        const matchers = GOOGLE_SHOPPING_MATCHERS.filter((g) => sharedMarketplaces.includes(g.marketplace));
        // Mesmo grupo de marketplaces, upstream diferente: busca por
        // texto (SerpApi/Shopping) ou por foto — e por foto ainda tem 2
        // vendors possíveis (SerpApi vs SearchApi.io, ver
        // IMAGE_SEARCH_PROVIDERS acima) — ver comentário no topo do arquivo.
        //
        // if/else-if em vez de ternário encadeado (ago/2026): a versão em
        // ternário profundamente aninhado fazia o TS se confundir inferindo
        // o tipo de retorno através do `.then(...)` do ramo
        // "vision_internal" — passava a achar que `fresh` podia ser um
        // `VisionInternalSearchOutcome` cru (o objeto `{results, warning}`
        // inteiro, não só `.results`) mesmo com anotação explícita no
        // `const`. Cada branch aqui é checado de forma independente contra
        // o tipo de `fresh` — mais robusto E mais legível que insistir no
        // ternário.
        let fresh: Record<MarketplaceId, Record<string, MarketplacePriceResult>>;
        if (provider === "vision_internal") {
          // Motor interno + IA: `apiKey` aqui é a chave GEMINI do usuário
          // (BYOK), não SerpApi/SearchApi.io — ver
          // visionInternalSearchProvider.ts. Warning de cota esgotada
          // (ago/2026) vai pro mesmo canal `internalSearchWarning` usado
          // pelo motor interno puro — mesmo formato de saída, `_warning`
          // não distingue a origem porque a UI só precisa mostrar o
          // aviso, não a causa exata.
          const outcome = await searchVisionInternalShared(
            missItems,
            matchers,
            apiKey,
            GEMINI_BACKEND,
            scraperApiKey,
            candidateSource,
            serpApiKeyForVision,
            searchApiKeyForVision
          );
          internalSearchWarning = outcome.warning;
          fresh = outcome.results;
        } else if (provider === "vision_mistral") {
          // Mesma orquestração de "vision_internal" acima, backend Mistral
          // (ago/2026, substituiu o Groq — ver mistralVision.ts) — `apiKey`
          // aqui é a chave MISTRAL do usuário, campo separado do Gemini em
          // Conta. `scraperApiKey` é o mesmo dos dois branches — fallback
          // opcional quando a raspagem direta bloqueia (ver
          // fetchCandidateOffers, visionInternalSearchProvider.ts).
          const outcome = await searchVisionInternalShared(
            missItems,
            matchers,
            apiKey,
            MISTRAL_BACKEND,
            scraperApiKey,
            candidateSource,
            serpApiKeyForVision,
            searchApiKeyForVision
          );
          internalSearchWarning = outcome.warning;
          fresh = outcome.results;
        } else if (provider === "vision_nvidia") {
          // Mesma orquestração de "vision_internal"/"vision_mistral" acima,
          // backend NVIDIA (BETA, set/2026 — ver nvidiaVision.ts). `apiKey`
          // aqui é a chave NVIDIA do usuário, campo próprio em Conta.
          const outcome = await searchVisionInternalShared(
            missItems,
            matchers,
            apiKey,
            NVIDIA_BACKEND,
            scraperApiKey,
            candidateSource,
            serpApiKeyForVision,
            searchApiKeyForVision
          );
          internalSearchWarning = outcome.warning;
          fresh = outcome.results;
        } else if (provider === "google_lens_products") {
          fresh = await searchGoogleLensProductsShared(missItems, matchers, apiKey);
        } else if (provider === "searchapi_lens") {
          fresh = await searchSearchApiLensShared(missItems, matchers, apiKey);
        } else if (provider === "scraperapi") {
          // ScraperAPI (Structured Data Endpoints): BYOK desde set/2026
          // (ver api/_lib/userSecrets.ts > getUserScraperApiKey) — `apiKey`
          // genérico (resolvido pelo mapa de provider) fica `undefined`
          // pra "scraperapi" de propósito (ver comentário no mapa), então
          // usa `scraperApiKey`, resolvido incondicionalmente acima.
          fresh = await searchScraperApiShared(missItems, matchers, scraperApiKey);
        } else {
          fresh = await searchGoogleShoppingShared(missItems, matchers, apiKey);
        }

        for (const marketplace of sharedMarketplaces) {
          const misses = new Set(cacheByMarketplace.get(marketplace)!.misses);
          const freshForThisMarketplace: Record<string, MarketplacePriceResult> = {};
          for (const [sku, value] of Object.entries(fresh[marketplace] ?? {})) {
            if (misses.has(sku)) freshForThisMarketplace[sku] = value;
          }
          responseByMarketplace[marketplace] = {
            ...responseByMarketplace[marketplace],
            ...freshForThisMarketplace,
          };

          // Best-effort: grava tudo que a busca compartilhada achou pra
          // esse marketplace, mesmo o que não era miss dele agora — só
          // adianta cache pra próxima consulta.
          try {
            await writeCachedPrices(uid, provider, marketplace, fresh[marketplace] ?? {});
          } catch (cacheErr) {
            console.error(`writeCachedPrices(${provider}/${marketplace}) falhou (ignorando, best-effort):`, cacheErr);
          }
        }
      }
    }

    // 3) Marketplaces fora do grupo Google Shopping — caminho antigo,
    // um ServerPriceProvider próprio por marketplace (nenhum registrado
    // hoje, mas a extensibilidade da ADR-0001 continua valendo).
    const otherMarketplaces = marketplaces.filter((m) => !sharedMarketplaces.includes(m));
    for (const marketplace of otherMarketplaces) {
      const misses = cacheByMarketplace.get(marketplace)!.misses;
      if (misses.length === 0) continue;

      const missItems = items.filter((i) => misses.includes(i.sku));
      const registeredProvider = getProvider(marketplace);
      const fresh = await registeredProvider.fetchPrices(missItems, apiKey);
      responseByMarketplace[marketplace] = { ...responseByMarketplace[marketplace], ...fresh };

      try {
        await writeCachedPrices(uid, provider, marketplace, fresh);
      } catch (cacheErr) {
        console.error(`writeCachedPrices(${provider}/${marketplace}) falhou (ignorando, best-effort):`, cacheErr);
      }
    }

    // `_warning` é aditivo — não é um marketplace, então o cliente antigo
    // (que só lê chaves de marketplace conhecidas, ver priceApi.ts)
    // ignora sem quebrar; o cliente novo lê e mostra no banner de aviso
    // (ver Dashboard.tsx > finishWithRows).
    // `_usage` é aditivo, mesmo espírito do `_warning` acima: não é um
    // marketplace, então cliente antigo ignora. O cliente novo usa isso
    // pra atualizar a barra de cota com o número AUTORITATIVO do servidor,
    // em vez de somar por conta própria (ver Dashboard.tsx — o incremento
    // client-side foi removido junto com esta mudança).
    annotatePackPricing(responseByMarketplace);
    annotatePriceSanity(responseByMarketplace, items);
    annotateConfidenceSource(responseByMarketplace, provider);

    // `_reasons` é aditivo pelo mesmo motivo de `_warning`/`_usage`: não é
    // chave de marketplace, então cliente antigo ignora. Diz POR SKU por
    // que o produto voltou sem preço — antes disso, a explicação existia
    // só no nível do lote e o produto sumia da tela sem rastro (ver
    // searchMissReasons.ts e auditoria item 21).
    const reasons = collectMissReasons(responseByMarketplace, items, provider, {
      quotaExhausted: Boolean(internalSearchWarning),
    });

    res.status(200).json({
      ...responseByMarketplace,
      ...(internalSearchWarning ? { _warning: internalSearchWarning } : {}),
      ...(quota.limit > 0 ? { _usage: quota } : {}),
      ...(Object.keys(reasons).length > 0 ? { _reasons: reasons } : {}),
    });
  } catch (err) {
    res.status(502).json({
      error: "Busca de preço indisponível",
      detail: err instanceof Error ? err.message : String(err),
    });
  }
}
