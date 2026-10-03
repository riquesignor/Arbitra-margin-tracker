import type {
  CatalogItemQuery,
  MarketplaceId,
  MarketplacePriceResult,
  SearchProviderId,
  VisionCandidateSource,
} from "./types.js";
import { getCachedPrices, writeCachedPrices } from "./cache.js";
import { getProvider, isGoogleShoppingMarketplace } from "./providers/registry.js";
import { GOOGLE_SHOPPING_MATCHERS, searchGoogleShoppingShared } from "./providers/googleShoppingProvider.js";
import { searchGoogleLensProductsShared } from "./providers/googleLensProvider.js";
import { searchSearchApiLensShared } from "./providers/searchApiLensProvider.js";
import {
  searchVisionInternalShared,
  GEMINI_BACKEND,
  MISTRAL_BACKEND,
  NVIDIA_BACKEND,
} from "./providers/visionInternalSearchProvider.js";
import { searchScraperApiShared } from "./providers/scraperApiSearchProvider.js";
import { fetchRapidApiAmazonPrices } from "./providers/rapidApiAmazonProvider.js";
import { fetchMercadoLivreDirectPrices } from "./providers/mercadoLivreDirectProvider.js";
import { fetchUnwrangleMercadoLivrePrices } from "./providers/unwrangleMercadoLivreProvider.js";
import { getUserApiKeyForProvider, getUserScraperApiKey } from "./userSecrets.js";
import { detectPackQuantity, unitPriceFromPack } from "./packQuantity.js";
import { flagPriceSanity } from "./priceSanity.js";
import { collectMissReasons, type MissReason } from "./searchMissReasons.js";

/**
 * Extraído de `api/fetch-prices.ts` (out/2026, ver feature de monitoramento
 * contínuo — docs/design-critique-log.md): era tudo inline no `handler`
 * HTTP. Esta função cobre só "dado uid+provider+marketplaces+items, busca
 * o preço" — SEM auth, SEM validação de corpo de requisição, SEM cota.
 * Isso é de propósito: o `handler` de `fetch-prices.ts` (chamado pelo
 * navegador) e o endpoint de checagem de monitoramento (chamado por um
 * usuário autenticado pontualmente, ou pelo cron sem usuário nenhum)
 * precisam dos três por motivos DIFERENTES — handler valida corpo de
 * requisição HTTP e aplica cota por requisição; o cron itera N watches de
 * N usuários e teria que fazer tudo isso de um jeito totalmente diferente
 * mesmo assim. Deixar os três de fora daqui evita que esta função cresça
 * pra atender dois chamadores com formato de erro incompatível (HTTP
 * status vs. "loga e segue pro próximo watch").
 *
 * Refactor mecânico: o corpo de cada função abaixo é idêntico ao que
 * existia dentro do handler, só o nome dos dois arquivos mudou. Qualquer
 * comportamento documentado nos comentários abaixo (histórico de bugs,
 * decisões de produto) continua valendo exatamente como estava.
 */

// Providers que só cobrem UM marketplace fixo cada — ver
// SearchProviderId em types.ts. "serpapi", "google_lens_products" e
// "searchapi_lens" NÃO entram aqui: os três cobrem amazon+mercadolivre
// numa busca só (dois insumos possíveis — nome em texto ou foto do
// produto — e dois vendors pro insumo foto) — ver branch "shared" mais
// abaixo. "mercadolivre_alt" é a alternativa PAGA (Unwrangle) ao
// endpoint público — mesmo grupo "direto" que "mercadolivre_direct",
// só muda o vendor por trás; não aparece no seletor normal (ver
// Dashboard.tsx), só no fluxo de fallback quando o público falha.
export type DirectProvider = "rapidapi_amazon" | "mercadolivre_direct" | "mercadolivre_alt";
export const DIRECT_PROVIDER_MARKETPLACE: Record<DirectProvider, MarketplaceId> = {
  rapidapi_amazon: "amazon",
  mercadolivre_direct: "mercadolivre",
  mercadolivre_alt: "mercadolivre",
};
export function isDirectProvider(p: SearchProviderId): p is DirectProvider {
  return p === "rapidapi_amazon" || p === "mercadolivre_direct" || p === "mercadolivre_alt";
}

/** Corpo pedia um marketplace incompatível com um provider "direto" (ver isDirectProvider). Quem chama decide o status HTTP/log. */
export class FetchPricesValidationError extends Error {}

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
 * ⚠️ NÃO sobrescreve `confidenceSource` já preenchido — ver histórico
 * completo em fetch-prices.ts (anotação idêntica, só movida pra cá).
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

export interface FetchPricesCoreResult {
  byMarketplace: Record<string, Record<string, MarketplacePriceResult>>;
  /** Aviso de cota/qualidade do motor interno + IA — só "vision_internal"/"vision_mistral"/"vision_nvidia" preenchem. */
  warning?: string;
  reasons: Record<string, MissReason>;
}

/**
 * Busca de preço de verdade — dado uid (pra resolver chave BYOK e ler/
 * gravar cache por usuário), provider, marketplaces e items, devolve o
 * preço encontrado por marketplace/SKU. SEM cota (quem chama reserva
 * antes, ver `consumeSearchQuota` em `fetch-prices.ts`/`check-watch.ts`/
 * `cron-check-watches.ts`) e SEM validação de formato de requisição HTTP
 * (isso é responsabilidade de quem expõe a rota).
 */
export async function fetchPricesCore(
  uid: string,
  provider: SearchProviderId,
  marketplaces: MarketplaceId[],
  items: CatalogItemQuery[],
  candidateSource: VisionCandidateSource = "auto"
): Promise<FetchPricesCoreResult> {
  // Chave BYOK lida NO SERVIDOR a partir do uid já verificado (set/2026,
  // ver api/_lib/userSecrets.ts). `undefined` aqui significa "provider
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
  // types.ts) — resolvidas só quando de fato vão ser usadas (provider é
  // um dos motores internos E o usuário fixou essa fonte no pop-up), pra
  // não pagar leitura extra de Firestore à toa em toda requisição dos
  // outros providers. Mesmo mapa de campo que "serpapi"/"searchapi_lens"
  // já usam como provider standalone (ver PROVIDER_SECRET_FIELD,
  // userSecrets.ts) — reaproveitado aqui, não é uma chave nova.
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

  // Providers "diretos" só cobrem 1 marketplace fixo — branch isolado,
  // sem passar pela lógica de busca compartilhada abaixo (que serve
  // "serpapi" e "google_lens_products", os dois multi-marketplace).
  if (isDirectProvider(provider)) {
    const expectedMarketplace = DIRECT_PROVIDER_MARKETPLACE[provider];
    if (marketplaces.length !== 1 || marketplaces[0] !== expectedMarketplace) {
      throw new FetchPricesValidationError(
        `O provider "${provider}" só busca o marketplace "${expectedMarketplace}" — ` +
          `envie marketplaces: ["${expectedMarketplace}"]`
      );
    }

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

    return {
      byMarketplace: directResponse,
      reasons: collectMissReasons(directResponse, items, provider),
    };
  }

  // 1) Cache por marketplace — hits/misses independentes (ver doc de
  // fetch-prices.ts, seção "Cache").
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
  // visionInternalSearchProvider.ts) — só "vision_internal"/
  // "vision_mistral"/"vision_nvidia" preenchem isto.
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
      let fresh: Record<MarketplaceId, Record<string, MarketplacePriceResult>>;
      if (provider === "vision_internal") {
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

        try {
          await writeCachedPrices(uid, provider, marketplace, fresh[marketplace] ?? {});
        } catch (cacheErr) {
          console.error(`writeCachedPrices(${provider}/${marketplace}) falhou (ignorando, best-effort):`, cacheErr);
        }
      }
    }
  }

  // 3) Marketplaces fora do grupo Google Shopping — caminho antigo, um
  // ServerPriceProvider próprio por marketplace.
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

  annotatePackPricing(responseByMarketplace);
  annotatePriceSanity(responseByMarketplace, items);
  annotateConfidenceSource(responseByMarketplace, provider);

  const reasons = collectMissReasons(responseByMarketplace, items, provider, {
    quotaExhausted: Boolean(internalSearchWarning),
  });

  return { byMarketplace: responseByMarketplace, warning: internalSearchWarning, reasons };
}
