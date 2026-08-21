import type { CatalogItemQuery, MarketplaceId, MarketplacePriceResult } from "../types.js";
import { mapWithConcurrency } from "../concurrency.js";
import { describeProductImage, compareProductImages, GeminiVisionError, GeminiQuotaExhaustedError } from "../geminiVision.js";
import { getTopCandidates, popularityScore } from "../rankCandidates.js";
import { fetchStoreOffers, type ScrapedOffer } from "./internalSearchProvider.js";
import type { MarketplaceMatcher } from "./googleShoppingProvider.js";

/**
 * ══════════════════════════════════════════════════════════════════════
 * MOTOR INTERNO + IA — busca por foto sem SerpApi/SearchApi.io
 * ══════════════════════════════════════════════════════════════════════
 *
 * Substitui o Google Lens (via API paga de terceiro) por um pipeline de
 * três passos, cada um resolvendo o que o passo anterior não resolve
 * sozinho:
 *
 *   1. DESCREVER — a foto do catálogo vira uma frase de busca curta
 *      (`describeProductImage`, geminiVision.ts). Sem isso não tem query
 *      de texto pra alimentar o passo 2 — é o substituto do nome do
 *      catálogo quando o nome é ruim (OCR torto, "Item 42").
 *
 *   2. BUSCAR — a frase alimenta o MESMO motor de raspagem usado na
 *      busca por texto (`fetchStoreOffers`, internalSearchProvider.ts) —
 *      sem chave, sem custo por busca. Aqui NÃO se usa
 *      `pickBestCandidate` (que decidiria por similaridade de TEXTO):
 *      pega-se um punhado de candidatos (`getTopCandidates`) porque quem
 *      decide o vencedor de verdade é o passo 3.
 *
 *   3. CONFIRMAR — cada candidato tem uma foto própria (o thumbnail do
 *      anúncio). Compara-se essa foto com a foto ORIGINAL do catálogo
 *      (`compareProductImages`) e fica-se com a de maior similaridade
 *      visual. É esta comparação, não o texto, que decide o match final
 *      — o texto do passo 1/2 só serve pra ACHAR os candidatos, não pra
 *      escolher entre eles.
 *
 * Custo por produto: 1 chamada de descrição + até `CANDIDATES_PER_STORE`
 * chamadas de comparação POR loja pedida (ex.: 2 lojas × 3 candidatos = 6
 * comparações + 1 descrição = 7 chamadas Gemini). BYOK (chave própria do
 * usuário, campo `geminiApiKey` em Conta) — sem fallback compartilhado,
 * mesmo padrão de SerpApi/RapidAPI/SearchApi.io.
 *
 * ── Por que a concorrência é 1 (não 2, como os outros providers) ──────
 * O free tier do Gemini tem teto de requisições por MINUTO relativamente
 * baixo (valor exato varia por modelo/projeto — ver
 * aistudio.google.com/rate-limit — e não é publicado de forma estável na
 * doc pública o bastante pra hard-codar aqui). Cada item já gera várias
 * chamadas sozinho (ver custo acima) — processar itens em paralelo
 * multiplicaria isso e estouraria o limite em segundos, virando
 * `RESOURCE_EXHAUSTED` pro catálogo inteiro em vez de UM item lento.
 *
 * ── Diferença de contrato vs os outros providers de foto ──────────────
 * Google Lens (googleLensProvider.ts) devolve UM resultado por chamada
 * de API porque a busca visual já é feita pelo Google do lado de lá.
 * Aqui a busca visual é feita AQUI, chamada por chamada — por isso o
 * limiar de aceite (`MIN_ACCEPT_SCORE`) é sobre a NOTA que a própria IA
 * dá à comparação, não sobre similaridade de texto (`confidenceFromSimilarity`,
 * usado no resto do projeto, não se aplica: não houve match por texto
 * nenhum decidindo o vencedor).
 */

/** Ver comentário no topo do arquivo — teto de rate do free tier do Gemini exige serializar os itens. */
const CONCURRENCY = 1;

/**
 * Quantos candidatos por loja entram na comparação visual. Mais alto =
 * mais chance de achar o produto certo entre os candidatos de texto
 * ruim, mas custa uma chamada Gemini a mais por unidade — 3 é o
 * equilíbrio: cobre variação razoável de ranking de texto sem estourar o
 * orçamento de chamadas por item (ver custo total no comentário do
 * topo).
 */
const CANDIDATES_PER_STORE = 3;

/**
 * Nota mínima da comparação visual pra aceitar o candidato. Alinhado com
 * a escala pedida no prompt de comparação (geminiVision.ts,
 * COMPARE_PROMPT): 0.5 = "mesma categoria, modelo incerto" é o piso —
 * abaixo disso a própria IA está dizendo que pode ser produto diferente,
 * e mostrar isso como resultado seria pior que não mostrar nada.
 */
const MIN_ACCEPT_SCORE = 0.5;

/** Abaixo disso o match entra marcado como aproximado, mesmo tendo passado do piso de aceite acima — é a faixa "categoria bate, mas não é certeza de ser o mesmo modelo". */
const APPROXIMATE_BELOW_SCORE = 0.8;

interface BestVisualMatch {
  marketplace: MarketplaceId;
  label: string;
  candidate: ScrapedOffer;
  score: number;
  /** Quantas ofertas a loja retornou no total pra essa query — vira `competitorCount`, mesmo critério dos outros providers. */
  totalOffers: number;
}

/**
 * Busca de preço por FOTO usando o motor interno + IA de visão (BYOK,
 * Gemini). Mesma assinatura dos outros providers multi-marketplace
 * (`searchGoogleLensProductsShared` etc.) pra plugar em fetch-prices.ts
 * sem caso especial.
 *
 * Item sem `imageUrl` é pulado silenciosamente — mesmo comportamento do
 * Google Lens, não é erro sistêmico, só não tem o que comparar.
 *
 * Contrato de erro: falha isolada por item (uma foto ruim, um timeout do
 * Gemini) não derruba os demais. Só propaga exceção se TODOS os itens
 * com foto falharem — aí é sinal de problema sistêmico (chave inválida,
 * cota esgotada), não de um catálogo com fotos ruins.
 */
export async function searchVisionInternalShared(
  items: CatalogItemQuery[],
  matchers: MarketplaceMatcher[],
  userApiKey?: string
): Promise<Record<string, Record<string, MarketplacePriceResult>>> {
  const apiKey = userApiKey?.trim();
  if (!apiKey) {
    throw new Error(
      "Nenhuma chave Gemini própria configurada. Cadastre a sua em Conta antes de buscar por imagem com o motor interno + IA."
    );
  }

  const results = {} as Record<string, Record<string, MarketplacePriceResult>>;
  for (const { marketplace } of matchers) results[marketplace] = {};

  const itemsWithImage = items.filter((i) => i.imageUrl);
  if (itemsWithImage.length === 0) return results;

  let lastError: string | null = null;
  let failures = 0;

  // Cota do Gemini é um recurso COMPARTILHADO entre todos os itens do
  // lote (mesma chave, mesma janela de rate limit) — diferente de um
  // timeout ou foto ruim, que são problemas ISOLADOS de um item só. Uma
  // vez confirmado `GeminiQuotaExhaustedError` (já depois do retry
  // embutido em geminiVision.ts), insistir nos itens restantes é
  // praticamente certeza de repetir a mesma falha em cada um — só
  // queima o teto de execução da function (300s, vercel.json) sem
  // chance real de achar preço. Essa flag corta o resto do lote na
  // hora, deixando a mensagem de cota esgotada propagar rápido em vez
  // de "0 resultados" silencioso no fim.
  let quotaExhausted = false;

  // Só observabilidade (ago/2026) — antes, um candidato achado na loja
  // mas com nota de comparação visual abaixo do piso (MIN_ACCEPT_SCORE)
  // era descartado 100% em silêncio: nenhum warn, nenhum error, nada no
  // log. Ficava indistinguível de "loja bloqueou" ou "sem match nenhum"
  // — as três causas têm solução DIFERENTE (proxy/retry pra bloqueio,
  // ajustar o piso pra nota baixa, nada a fazer pra sem match de
  // verdade), então valia separar. Resumo no fim, não por item, pra não
  // inflar o log de um catálogo grande.
  let belowThresholdCount = 0;

  await mapWithConcurrency(itemsWithImage, CONCURRENCY, async (item) => {
    if (quotaExhausted) {
      failures++;
      return;
    }
    try {
      // Passo 1 — descrever.
      const query = await describeProductImage(item.imageUrl!, apiKey);

      // Passo 2 — buscar (motor interno, mesma raspagem da busca por
      // texto, sem custo por chamada).
      const storeOffers = await fetchStoreOffers(query, matchers);

      // Passo 3 — confirmar visualmente, loja por loja. Cada loja
      // concorre pelo seu próprio marketplace no resultado final — o
      // "Amazon" da vez não compete contra o "Mercado Livre" da vez,
      // cada um vira uma linha independente (mesmo modelo dos outros
      // providers multi-marketplace).
      for (const store of storeOffers) {
        if (quotaExhausted) break;
        const candidates = getTopCandidates(
          query,
          store.offers,
          (o) => o.title,
          (o) => popularityScore(o.reviewCount, o.rating),
          CANDIDATES_PER_STORE
        );
        if (candidates.length === 0) continue;

        let best: BestVisualMatch | null = null;
        for (const { candidate } of candidates) {
          if (quotaExhausted) break;
          // Sem foto no anúncio não tem o que comparar visualmente —
          // pular é o comportamento certo aqui (não dá pra confirmar
          // "é o mesmo produto" sem uma segunda imagem).
          if (!candidate.thumbnail) continue;
          try {
            const score = await compareProductImages(item.imageUrl!, candidate.thumbnail, apiKey);
            if (!best || score > best.score) {
              best = { marketplace: store.marketplace, label: store.label, candidate, score, totalOffers: store.offers.length };
            }
          } catch (err) {
            if (err instanceof GeminiQuotaExhaustedError) {
              quotaExhausted = true;
              lastError = err.message;
              break;
            }
            // Falha de UMA comparação (ex.: thumbnail quebrado, timeout)
            // não invalida os outros candidatos da mesma loja.
            console.warn(`[motor-interno+IA] comparação visual falhou (${store.label}, "${query}"):`, err);
          }
        }

        if (!best || best.score < MIN_ACCEPT_SCORE) {
          if (best) belowThresholdCount++;
          continue;
        }

        results[best.marketplace][item.sku] = {
          marketplace: best.marketplace,
          sku: item.sku,
          price: best.candidate.price,
          competitorCount: Math.max(0, best.totalOffers - 1),
          buyBoxEligible: true,
          // Confiança = a própria nota de similaridade visual, na mesma
          // escala 0-1 usada no resto do projeto pra `confidence` — não
          // passa por `confidenceFromSimilarity` porque não há
          // similaridade de TEXTO nenhuma decidindo esse resultado.
          confidence: best.score,
          link: best.candidate.link,
          matchedTitle: best.candidate.title,
          imageUrl: best.candidate.thumbnail,
          approximate: best.score < APPROXIMATE_BELOW_SCORE,
          matchedSource: best.label,
        };
      }
    } catch (err) {
      failures++;
      if (err instanceof GeminiQuotaExhaustedError) quotaExhausted = true;
      lastError =
        err instanceof GeminiVisionError
          ? err.message
          : err instanceof Error
            ? err.message
            : String(err);
      console.error(`[motor-interno+IA] falhou pra "${item.name}" (${item.sku}):`, err);
    }
  });

  if (itemsWithImage.length > 0 && failures === itemsWithImage.length && lastError) {
    throw new Error(lastError);
  }

  if (belowThresholdCount > 0) {
    console.warn(
      `[motor-interno+IA] ${belowThresholdCount} candidato(s) descartado(s) por nota visual abaixo do piso ` +
        `de aceite (${MIN_ACCEPT_SCORE}) — a busca achou produto na loja, a IA comparou a foto, mas não ` +
        "confiou o bastante pra aceitar como o mesmo produto. Não é bloqueio nem falta de resultado na loja."
    );
  }

  return results;
}
