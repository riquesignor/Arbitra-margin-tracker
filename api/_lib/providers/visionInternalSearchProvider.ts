import type { CatalogItemQuery, MarketplaceId, MarketplacePriceResult } from "../types.js";
import { mapWithConcurrency } from "../concurrency.js";
import * as gemini from "../geminiVision.js";
import * as mistral from "../mistralVision.js";
import { getTopCandidates, popularityScore } from "../rankCandidates.js";
import { fetchStoreOffers } from "./internalSearchProvider.js";
import type { ScrapedOffer, StoreOffers } from "./internalSearchProvider.js";
import {
  fetchAmazonCandidatesForQuery,
  fetchGoogleShoppingCandidatesForQuery,
} from "./scraperApiSearchProvider.js";
import type { MarketplaceMatcher } from "./googleShoppingProvider.js";

/**
 * Motor interno + IA aceita mais de um FORNECEDOR de IA de visão (ago/2026
 * — Gemini era o único, um 2º backend entrou depois do relato real de
 * "5+ minutos, só 2 de 68 produtos" com a cota do Gemini). A 1ª tentativa
 * de 2º backend foi Groq — removida depois (mesmo mês) por outro relato
 * real, "não traz nenhum resultado sequer": o free tier da Groq (8.000
 * tokens/minuto) zerava a cota dentro do PRIMEIRO produto do catálogo,
 * mesmo depois de otimizar as chamadas em lote (ver histórico de
 * groqVision.ts, se ainda existir no repo). Mistral entrou no lugar —
 * free tier de 500.000 tokens/minuto (ver mistralVision.ts), folga bem
 * maior pro mesmo padrão de uso. Toda a orquestração abaixo (buscar,
 * ranquear, decidir aceite/aproximado, montar warning) é IDÊNTICA pros
 * dois — só MUDA quem responde "descreva essa foto"/"essas duas fotos são
 * o mesmo produto?" — por isso um backend plugável em vez de duplicar
 * ~350 linhas de orquestração pra cada fornecedor. `label` entra nas
 * mensagens de erro/warning pro usuário saber qual das duas chaves
 * (Conta → Gemini/Mistral) está em jogo.
 */
/**
 * FONTE DE CANDIDATOS COM REDE DE SEGURANÇA (set/2026)
 * ══════════════════════════════════════════════════════════════════════
 *
 * A raspagem de HTML (`fetchStoreOffers`) é a fonte preferida quando
 * funciona: é gratuita, traz link, foto no tamanho do card e o sinal de
 * popularidade da loja. Mas ela falha de três jeitos — bloqueio anti-bot
 * (403/CAPTCHA), mudança de layout (parser devolve 0 ofertas) e timeout —
 * e nos três o item voltava sem preço, sem alternativa.
 *
 * Duas fontes estruturadas cobrem essa falha, uma por loja:
 *
 *   - **Amazon** → `fetchAmazonCandidatesForQuery` (5 créditos). Dado
 *     nativo: título, preço, link, foto, estrelas e nº de avaliações.
 *     Equivalente completo da raspagem.
 *   - **Mercado Livre** → Google Shopping estruturado filtrado pela
 *     origem (25 créditos). Substituto PARCIAL, assumido de olhos
 *     abertos: vem sem link do anúncio e sem "vendidos" (ver
 *     `fetchGoogleShoppingCandidatesForQuery`). A conta mudou quando o
 *     bloqueio deixou de ser intermitente — a comparação deixou de ser
 *     "com link x sem link" e passou a ser "sem link x sem preço nenhum".
 *
 * DISJUNTOR (`scrapeBlockedUntil`): depois que uma loja bloqueia, as
 * tentativas seguintes de raspar ELA no mesmo processo são puladas por
 * alguns minutos. Sem isso, cada produto do catálogo pagava de novo o
 * timeout/retry da loja bloqueada — num catálogo de 9 produtos isso é
 * minuto de orçamento da function (teto de 300s na Vercel) gasto pra
 * chegar no mesmo 403. Estado de módulo, então vive só enquanto a
 * instância serverless vive: some sozinho, sem cache pra invalidar.
 */
const SCRAPE_COOLDOWN_MS = 5 * 60_000;
const scrapeBlockedUntil = new Map<MarketplaceId, number>();

function scrapeIsOnCooldown(marketplace: MarketplaceId): boolean {
  return (scrapeBlockedUntil.get(marketplace) ?? 0) > Date.now();
}

/**
 * O Google Shopping estruturado custa 25 créditos por consulta e agora
 * tem DOIS consumidores no mesmo fluxo: o substituto do Mercado Livre
 * (abaixo) e o Passo 4 (busca "geral", opt-in). Sem esta memória de
 * curtíssimo prazo, um item cujo ML caiu no substituto E que depois cai
 * no Passo 4 pagaria 50 créditos pela MESMA string de busca.
 *
 * TTL curto e teto de entradas porque o objetivo não é cache de verdade
 * (isso é papel do `cache.ts`, por usuário e por marketplace) — é só
 * evitar a chamada duplicada dentro do processamento de um item.
 */
const SHOPPING_MEMO_TTL_MS = 60_000;
const SHOPPING_MEMO_MAX = 200;
const shoppingMemo = new Map<string, { at: number; value: Awaited<ReturnType<typeof fetchGoogleShoppingCandidatesForQuery>> }>();

async function fetchGoogleShoppingCandidatesMemo(query: string) {
  const hit = shoppingMemo.get(query);
  if (hit && Date.now() - hit.at < SHOPPING_MEMO_TTL_MS) return hit.value;

  const value = (await fetchGoogleShoppingCandidatesForQuery(query)) ?? [];
  if (shoppingMemo.size >= SHOPPING_MEMO_MAX) {
    // Descarte simples do mais antigo inserido — Map preserva ordem de
    // inserção, e aqui não vale a complexidade de um LRU de verdade.
    const oldest = shoppingMemo.keys().next().value;
    if (oldest !== undefined) shoppingMemo.delete(oldest);
  }
  shoppingMemo.set(query, { at: Date.now(), value });
  return value;
}

/**
 * Zera o disjuntor e a memória do Google Shopping. Existe pra TESTE: os
 * dois são estado de módulo (o que é correto em produção — vivem junto
 * com a instância serverless), e sem isto um caso que bota a Amazon em
 * cooldown contaminaria silenciosamente os casos seguintes do mesmo
 * arquivo.
 */
export function resetCandidateSourceState(): void {
  scrapeBlockedUntil.clear();
  shoppingMemo.clear();
}

export async function fetchCandidateOffers(
  query: string,
  matchers: MarketplaceMatcher[]
): Promise<StoreOffers[]> {
  let stores: StoreOffers[] = [];
  let scrapeError: unknown = null;

  const scrapable = matchers.filter((m) => !scrapeIsOnCooldown(m.marketplace));
  if (scrapable.length > 0) {
    try {
      stores = await fetchStoreOffers(query, scrapable);
    } catch (err) {
      // `fetchStoreOffers` só lança quando TODAS as lojas tentadas
      // falharam — então todas elas entram em cooldown.
      scrapeError = err;
      for (const m of scrapable) scrapeBlockedUntil.set(m.marketplace, Date.now() + SCRAPE_COOLDOWN_MS);
    }
    // Loja pedida que não voltou no resultado falhou isoladamente (o erro
    // dela foi engolido lá dentro pra não derrubar a outra) — mesmo
    // tratamento.
    for (const m of scrapable) {
      if (!stores.some((s) => s.marketplace === m.marketplace)) {
        scrapeBlockedUntil.set(m.marketplace, Date.now() + SCRAPE_COOLDOWN_MS);
      }
    }
  }

  const needsStructured = (marketplace: MarketplaceId) => {
    const scraped = stores.find((s) => s.marketplace === marketplace);
    return { scraped, empty: !scraped || scraped.offers.length === 0 };
  };

  const attach = (marketplace: MarketplaceId, label: string, offers: ScrapedOffer[]) => {
    const existing = stores.find((s) => s.marketplace === marketplace);
    if (existing) existing.offers = offers;
    else stores.push({ marketplace, label, offers });
  };

  if (matchers.some((m) => m.marketplace === "amazon")) {
    const { empty } = needsStructured("amazon");
    if (empty) {
      // Fonte OPCIONAL: falha dela não pode derrubar o item (a raspagem
      // já falhou; propagar aqui só trocaria um erro por outro).
      const structured = await fetchAmazonCandidatesForQuery(query).catch((err) => {
        console.warn(`[motor-interno+IA] endpoint estruturado da Amazon falhou pra "${query}":`, err);
        return [];
      });
      if (structured.length > 0) {
        console.warn(
          `[motor-interno+IA] Amazon sem oferta pela raspagem pra "${query}" — ` +
            `usando o endpoint estruturado (${structured.length} candidato(s)).`
        );
        attach("amazon", "Amazon", structured);
      }
    }
  }

  const mlMatcher = matchers.find((m) => m.marketplace === "mercadolivre");
  if (mlMatcher) {
    const { empty } = needsStructured("mercadolivre");
    if (empty) {
      const broad = await fetchGoogleShoppingCandidatesMemo(query).catch((err) => {
        console.warn(`[motor-interno+IA] Google Shopping estruturado falhou pra "${query}":`, err);
        return [];
      });
      const fromMl = broad.filter((c) => c.source && mlMatcher.matchesSource(c.source.toLowerCase()));
      const offers: ScrapedOffer[] = fromMl
        .filter((c): c is typeof c & { price: number } => c.price != null)
        .map((c) => ({
          title: c.title,
          price: c.price,
          thumbnail: c.thumbnail,
          // Sem `link` e sem `reviewCount` de propósito: essa fonte não
          // devolve nenhum dos dois (ver a doc citada em
          // fetchGoogleShoppingCandidatesForQuery). A UI já sabe lidar
          // com resultado sem link ("sem link" no lugar de "Ver anúncio").
        }));
      if (offers.length > 0) {
        console.warn(
          `[motor-interno+IA] Mercado Livre sem oferta pela raspagem pra "${query}" — ` +
            `usando Google Shopping estruturado (${offers.length} candidato(s), sem link de anúncio).`
        );
        attach("mercadolivre", "Mercado Livre", offers);
      }
    }
  }

  // Só faz sentido falar em "loja bloqueada" quando alguma loja RASPÁVEL
  // foi pedida. Com apenas "geral" marcado (Passo 4), não há loja focada
  // pra raspar e `[]` é a resposta certa — lançar aqui quebraria o
  // caminho de busca geral, que nem chega a passar pela raspagem.
  const askedScrapableStore = matchers.some(
    (m) => m.marketplace === "amazon" || m.marketplace === "mercadolivre"
  );

  if (stores.length === 0 && askedScrapableStore) {
    // Nada de nada: nem raspagem, nem fonte estruturada. A mensagem
    // precisa dizer QUAL das duas coisas checar — antes disso o usuário
    // recebia "a loja bloqueou, troque o mecanismo", conselho que não
    // resolve quando as duas lojas bloqueiam e o problema real é a chave
    // do proxy ausente ou sem crédito.
    if (!process.env.SCRAPERAPI_KEY) {
      throw new Error(
        "As lojas bloquearam a busca direta e não há SCRAPERAPI_KEY configurada no servidor — " +
          "sem ela não existe fonte alternativa de candidatos. Configure a chave nas variáveis de " +
          "ambiente (Vercel) pra liberar os endpoints estruturados."
      );
    }
    if (scrapeError) throw scrapeError;
    throw new Error(
      "As lojas bloquearam a busca direta e os endpoints estruturados da ScraperAPI não " +
        "devolveram candidato nenhum — verifique se a chave ainda tem crédito disponível."
    );
  }
  return stores;
}

export interface VisionBackend {
  label: string;
  describeProductImage(imageUrl: string, apiKey: string): Promise<string>;
  compareProductImages(catalogImageUrl: string, candidateImageUrl: string, apiKey: string): Promise<number>;
  /**
   * Variante em LOTE, OPCIONAL (ago/2026, mesma ideia usada primeiro pro
   * Groq — ver mistralVision.ts > compareProductImagesBatch). Quando o
   * backend implementa isto, `pickBestVisualMatch` abaixo usa em vez do
   * laço de comparação 1-a-1: manda a foto do catálogo + todos os
   * candidatos com foto numa chamada só, em vez de reenviar o catálogo a
   * cada comparação. Gemini NÃO implementa (fica `undefined`) —
   * comportamento bit-a-bit igual ao de antes desta mudança pra esse
   * backend, só o Mistral muda. Devolve nota na MESMA ORDEM dos
   * candidatos passados; `null` numa posição = "não comparável" (mesmo
   * tratamento de uma comparação isolada que falhou no laço 1-a-1).
   */
  compareProductImagesBatch?(
    catalogImageUrl: string,
    candidateImageUrls: string[],
    apiKey: string
  ): Promise<(number | null)[]>;
  isQuotaExhaustedError(err: unknown): boolean;
  isVisionError(err: unknown): boolean;
}

export const GEMINI_BACKEND: VisionBackend = {
  label: "Gemini",
  describeProductImage: gemini.describeProductImage,
  compareProductImages: gemini.compareProductImages,
  isQuotaExhaustedError: (err): boolean => err instanceof gemini.GeminiQuotaExhaustedError,
  isVisionError: (err): boolean => err instanceof gemini.GeminiVisionError,
};

export const MISTRAL_BACKEND: VisionBackend = {
  label: "Mistral",
  describeProductImage: mistral.describeProductImage,
  compareProductImages: mistral.compareProductImages,
  compareProductImagesBatch: mistral.compareProductImagesBatch,
  isQuotaExhaustedError: (err): boolean => err instanceof mistral.MistralQuotaExhaustedError,
  isVisionError: (err): boolean => err instanceof mistral.MistralVisionError,
};

/**
 * Resultado genérico de "qual candidato é o mesmo produto" — usado pelo
 * Passo 3 (lojas focadas) e pelo Passo 4 (busca geral), que só diferem
 * no TIPO de candidato (`ScrapedOffer` vs `GoogleShoppingCandidate`) e em
 * como o vencedor vira `MarketplacePriceResult` no fim (cada um faz isso
 * na própria chamada, ver os dois usos abaixo).
 */
interface VisualMatch<T> {
  candidate: T;
  score: number;
}

/**
 * Escolhe o candidato de maior nota visual entre uma lista — usa
 * comparação em LOTE quando `backend.compareProductImagesBatch` existe
 * (Mistral, ver comentário no VisionBackend acima), ou o laço de sempre, 1
 * chamada por candidato (Gemini, sem nenhuma mudança de comportamento).
 * Mesmo critério de escolha (maior nota) e mesmo tratamento de cota
 * esgotada nos dois caminhos — só muda QUANTAS chamadas de IA acontecem
 * por baixo. `quota.markExhausted`/`quota.isExhausted` são callbacks pro
 * chamador atualizar/consultar o estado compartilhado entre lojas
 * (`quotaExhausted`/`quotaExhaustedAtItem`/`lastError`, todos de escopo
 * de `searchVisionInternalShared`) sem esta função precisar conhecer
 * esse estado diretamente.
 */
async function pickBestVisualMatch<T>(
  backend: VisionBackend,
  apiKey: string,
  catalogImageUrl: string,
  candidates: T[],
  getThumbnail: (candidate: T) => string | undefined,
  quota: { isExhausted: () => boolean; markExhausted: (err: unknown) => void },
  logContext: string
): Promise<VisualMatch<T> | null> {
  const withThumbnail = candidates.filter((c) => getThumbnail(c));
  if (withThumbnail.length === 0) return null;

  let best: VisualMatch<T> | null = null;

  if (backend.compareProductImagesBatch) {
    try {
      const scores = await backend.compareProductImagesBatch(
        catalogImageUrl,
        withThumbnail.map((c) => getThumbnail(c)!),
        apiKey
      );
      withThumbnail.forEach((candidate, i) => {
        const score = scores[i];
        if (score != null && (!best || score > best.score)) best = { candidate, score };
      });
    } catch (err) {
      if (backend.isQuotaExhaustedError(err)) {
        quota.markExhausted(err);
      } else {
        console.warn(`[motor-interno+IA] comparação visual em lote falhou (${logContext}):`, err);
      }
    }
    return best;
  }

  for (const candidate of withThumbnail) {
    if (quota.isExhausted()) break;
    try {
      const score = await backend.compareProductImages(catalogImageUrl, getThumbnail(candidate)!, apiKey);
      if (!best || score > best.score) best = { candidate, score };
    } catch (err) {
      if (backend.isQuotaExhaustedError(err)) {
        quota.markExhausted(err);
        break;
      }
      // Falha de UMA comparação (ex.: thumbnail quebrado, timeout) não
      // invalida os outros candidatos.
      console.warn(`[motor-interno+IA] comparação visual falhou (${logContext}):`, err);
    }
  }
  return best;
}

/**
 * ══════════════════════════════════════════════════════════════════════
 * MOTOR INTERNO + IA — busca por foto sem SerpApi/SearchApi.io
 * ══════════════════════════════════════════════════════════════════════
 *
 * Substitui o Google Lens (via API paga de terceiro) por um pipeline de
 * até quatro passos, cada um resolvendo o que o passo anterior não
 * resolve sozinho:
 *
 *   1. DESCREVER — a IA descreve a foto (`describeProductImage`,
 *      geminiVision.ts) e essa frase é a query PRINCIPAL do passo 2/3,
 *      SEMPRE — é o sinal comprovado desde a criação deste motor. Quando
 *      o catálogo também tem um NOME de texto confiável (extraído do
 *      PDF, não um fallback tipo "nome = o próprio SKU") e a 1ª rodada
 *      (com a descrição da IA) não achou NENHUM candidato aceitável em
 *      loja nenhuma (nem aproximado — zero candidatos ou tudo rejeitado
 *      como "produto diferente"), tenta de novo com o nome do catálogo
 *      como REFORÇO — não troca a IA de lugar, só soma candidatos extras
 *      pro passo 3 escolher entre eles. Gatilho é DELIBERADAMENTE "achou
 *      zero" e não "não ficou confiante": uma versão anterior disparava
 *      o reforço pra qualquer match "aproximado" (a faixa mais comum na
 *      prática) e isso dobrava a raspagem em boa parte do catálogo —
 *      relato real: Amazon E Mercado Livre passaram a bloquear (antes só
 *      o ML). Match "aproximado" já sai marcado como tal pro usuário, não
 *      justifica pagar 2ª raspagem. Quem decide o vencedor continua
 *      sendo só a comparação visual do passo 3 — texto é auxílio, não
 *      método principal (uma versão ainda mais antiga usava o texto NO
 *      LUGAR da IA quando confiável; foi revertida — "achar algo por
 *      texto ainda pode ser qualquer coisa" sem a IA ter tido a chance de
 *      tentar primeiro).
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
 *   4. BUSCA GERAL (ago/2026, OPT-IN) — só roda quando o usuário marcou
 *      "Lojas gerais" no seletor (pseudo-marketplace `"geral"`, ver
 *      MarketplaceId em types.ts e o checkbox extra em Dashboard.tsx,
 *      visível só com este provider ativo) E nenhuma loja focada (passo
 *      2/3) confirmou o produto pra este item. Busca a MESMA frase do
 *      passo 1 no Google Shopping estruturado da ScraperAPI
 *      (`fetchGoogleShoppingCandidatesForQuery`, scraperApiSearchProvider.ts
 *      — mesma fonte multi-loja que os outros mecanismos já usam como
 *      fallback "aproximado"), filtra só lojas DE FORA das focadas, e
 *      confirma visualmente igual ao passo 3. Resultado vai pra
 *      `results.geral` (chave própria, não empresta o slot de Amazon/ML).
 *      Existe pra achar produto em lojas que a Arbitra não foca (Shopee,
 *      Magalu, loja própria...) em vez do item simplesmente ficar sem
 *      preço nenhum quando Amazon/ML não têm o produto — mas só quando o
 *      usuário PEDIU essa cobertura extra, não automaticamente.
 *
 * Custo por produto: 1 chamada de descrição (SEMPRE — é a query
 * principal) + até `CANDIDATES_PER_STORE` chamadas de comparação POR
 * loja pedida (ex.: 2 lojas × 3 candidatos = 6 comparações + 1 descrição
 * = 7 chamadas Gemini), mais uma 2ª RASPAGEM de loja (sem chamada de IA
 * nova pra descrever — reaproveita a mesma descrição já gerada, só troca
 * a query de busca) usando o nome do catálogo como reforço, só quando a
 * 1ª rodada não achou NENHUM candidato aceitável (zero ou tudo rejeitado
 * — não dispara pra "achou aproximado", ver Passo 1 acima) E o item tem
 * nome de texto confiável — isto é deliberadamente RARO, pra não dobrar
 * o volume de requisições pras lojas (risco real de bloqueio de IP,
 * ver StoreBlockedError em internalSearchProvider.ts — um gatilho mais
 * frequente já causou bloqueio em Amazon E Mercado Livre num catálogo
 * real), mais até `CANDIDATES_PER_STORE` chamadas extras SE o passo 4
 * disparar (só quando o passo 3 zerou pra este item — não é
 * incondicional, pra não agravar o teto de cota do free tier, ver
 * comentário mais abaixo). BYOK (chave própria do usuário, campo
 * `geminiApiKey` em Conta) — sem fallback compartilhado, mesmo padrão de
 * SerpApi/RapidAPI/SearchApi.io.
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
 *
 * ── Cota do Gemini free tier é o teto real, não a qualidade do match (ago/2026) ──
 * Relato: catálogo de 48 produtos, só 2 voltam com preço. Causa raiz:
 * cada item processado aqui gasta ATÉ 7 chamadas Gemini (1 descrição +
 * até `CANDIDATES_PER_STORE`(3) × lojas pedidas(2) comparações) — com o
 * free tier girando em torno de ~15 requisições/MINUTO, a cota se esgota
 * depois de só 2-3 itens. `quotaExhausted` (abaixo) já existia e cortava
 * o resto do lote CORRETAMENTE (evita queimar o teto de 300s da function
 * em requisições fadadas a falhar) — o bug era o SILÊNCIO: a função
 * devolvia só `results`, semjeito nenhum de dizer "processei 2 de 48
 * porque a cota acabou". Pro usuário, "2 de 48 com preço, sem nenhuma
 * explicação" parece bug de MATCHING — na real é rate-limit puro.
 * `warning` no retorno (mesmo padrão de `InternalSearchOutcome` em
 * internalSearchProvider.ts) resolve isso: agora a UI recebe o motivo
 * real, e o usuário sabe que é cota (aguardar/chave paga), não catálogo
 * ruim nem produto não encontrado.
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
 * Nota da comparação visual, escala do prompt (geminiVision.ts,
 * COMPARE_PROMPT): 1 = certamente o mesmo produto, 0.5 = mesma
 * categoria/modelo incerto, 0 = produtos diferentes.
 *
 * ── Piso rebaixado de 0.5 pra 0.2 (ago/2026, teste real Issam_completo) ──
 * Antes: `best.score < 0.5` descartava o candidato INTEIRO — nem
 * aproximado, sumia da tela igual "sem match nenhum". Teste real (12
 * produtos, catálogo eletrônicos variados): 0 de 12 voltaram com preço,
 * SEM nenhuma pista pro usuário — indistinguível de "a busca não achou
 * nada" quando na real pode ser "achou candidato, IA comparou, só não
 * ficou confiante o bastante pra 0.5". Mesma filantropia já aplicada em
 * googleShoppingProvider.ts/searchApiLensProvider.ts/
 * scraperApiSearchProvider.ts (fallback aproximado quando o candidato
 * existe mas não é confiança total) — aqui faltava o equivalente pro
 * pipeline visual. Abaixo de `MIN_APPROXIMATE_SCORE` continua descartado
 * de vez (a própria IA dizendo "provavelmente produto diferente" — exibir
 * isso é pior que não exibir nada, mesmo raciocínio de
 * MIN_ACCEPTABLE_SIMILARITY em rankCandidates.ts). Entre os dois pisos,
 * o candidato agora aparece marcado `approximate: true` em vez de
 * simplesmente sumir.
 */
const MIN_APPROXIMATE_SCORE = 0.2;

/** Abaixo disso o match entra marcado como aproximado — faixa "categoria bate, mas não é certeza de ser o mesmo modelo" (inclui toda a faixa nova entre MIN_APPROXIMATE_SCORE e aqui, ver comentário acima). */
const APPROXIMATE_BELOW_SCORE = 0.8;

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
/** Ver comentário "Cota do Gemini free tier..." no topo do arquivo. */
export interface VisionInternalSearchOutcome {
  results: Record<string, Record<string, MarketplacePriceResult>>;
  warning?: string;
}

export async function searchVisionInternalShared(
  items: CatalogItemQuery[],
  matchers: MarketplaceMatcher[],
  userApiKey: string | undefined,
  backend: VisionBackend
): Promise<VisionInternalSearchOutcome> {
  const apiKey = userApiKey?.trim();
  if (!apiKey) {
    throw new Error(
      `Nenhuma chave ${backend.label} própria configurada. Cadastre a sua em Conta antes de buscar por imagem com o motor interno + IA.`
    );
  }

  const results = {} as Record<string, Record<string, MarketplacePriceResult>>;
  for (const { marketplace } of matchers) results[marketplace] = {};

  // "geral" (ago/2026) é um pseudo-marketplace OPT-IN — só entra em
  // `matchers` quando o usuário marcou "Lojas gerais" no seletor (ver
  // Dashboard.tsx). `focusedMatchers` é o que sobra pra Amazon/ML de
  // verdade (Passo 2/3 abaixo); `geralRequested` decide se o Passo 4
  // (busca geral) sequer tenta rodar — sem a marcação explícita, o
  // comportamento é o de sempre (só Amazon/ML, sem chamada extra).
  const focusedMatchers = matchers.filter((m) => m.marketplace !== "geral");
  const geralRequested = matchers.some((m) => m.marketplace === "geral");

  const itemsWithImage = items.filter((i) => i.imageUrl);
  if (itemsWithImage.length === 0) return { results };

  let lastError: string | null = null;
  let failures = 0;
  /** Quantos itens nem chegaram a tentar — cota já tinha acabado quando a vez deles chegou (loop é sequencial, CONCURRENCY=1). Distingue "tentou e falhou" de "nem tentou" na mensagem final. */
  let skippedByQuota = 0;
  /** Em qual item (1-based, ordem de processamento) a cota estourou de fato — vira "processou N de M" na mensagem, sem sortear/estimar. */
  let quotaExhaustedAtItem: number | null = null;
  let processedCount = 0;

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

  // Observabilidade (ago/2026, reforçada após o teste real do
  // Issam_completo: 0 de 12 sem NENHUMA pista) — duas causas de "sem
  // resultado" que antes eram indistinguíveis uma da outra E do "cota
  // esgotada" acima, cada uma com solução diferente:
  //   - `noCandidatesCount`: passo 2 (busca por texto com a descrição da
  //     IA) não achou candidato NENHUM pra comparar — sinal de que a
  //     descrição curta gerada (DESCRIBE_PROMPT, geminiVision.ts) não
  //     está achando nada na loja, ou a loja bloqueou/mudou layout (mesma
  //     raspagem de fetchStoreOffers, internalSearchProvider.ts).
  //   - `rejectedAsNoiseCount`: passo 2 achou candidato, passo 3 (IA)
  //     comparou, mas a nota ficou abaixo até do piso de aproximado
  //     (MIN_APPROXIMATE_SCORE) — a IA está dizendo "provavelmente produto
  //     diferente", não "baixa confiança".
  let noCandidatesCount = 0;
  let rejectedAsNoiseCount = 0;

  await mapWithConcurrency(itemsWithImage, CONCURRENCY, async (item) => {
    if (quotaExhausted) {
      failures++;
      skippedByQuota++;
      return;
    }
    processedCount++;
    try {
      // Passo 1 — descrever. A IA SEMPRE descreve a foto — é a query
      // PRINCIPAL, comportamento de sempre (ver "texto como auxílio" no
      // comentário grande no topo do arquivo).
      const aiQuery = await backend.describeProductImage(item.imageUrl!, apiKey);
      const catalogName = item.name?.trim();
      const hasReliableName = Boolean(catalogName) && catalogName !== item.sku;
      // `query` alimenta o Passo 4 (busca geral) mais abaixo — sempre a
      // descrição da IA, não muda com o reforço de texto do Passo 2/3
      // (o reforço só amplia CANDIDATOS ali, não substitui a frase
      // "oficial" de busca do item).
      const query = aiQuery;

      // Passo 2/3 — buscar (motor interno, mesma raspagem da busca por
      // texto) + confirmar visualmente, loja por loja. Extraído em
      // função porque roda até 2x pro mesmo item: 1x com a descrição da
      // IA (sempre), 1x com o nome do catálogo como REFORÇO (só quando a
      // 1ª rodada não confirmou nada com confiança alta — ver abaixo).
      // Devolve o resultado POR LOJA em vez de já escrever em `results`:
      // a rodada de reforço precisa COMPARAR nota com nota e ficar só
      // com a melhor por loja, não sobrescrever a 1ª rodada cegamente.
      const attemptStores = async (
        q: string
      ): Promise<
        { marketplace: MarketplaceId; label: string; offersCount: number; best: VisualMatch<ScrapedOffer> | null }[]
      > => {
        const storeOffers = await fetchCandidateOffers(q, focusedMatchers);
        const attempts: {
          marketplace: MarketplaceId;
          label: string;
          offersCount: number;
          best: VisualMatch<ScrapedOffer> | null;
        }[] = [];

        for (const store of storeOffers) {
          if (quotaExhausted) break;
          const candidates = getTopCandidates(
            q,
            store.offers,
            (o) => o.title,
            (o) => popularityScore(o.reviewCount, o.rating),
            CANDIDATES_PER_STORE
          );
          if (candidates.length === 0) {
            noCandidatesCount++;
            attempts.push({ marketplace: store.marketplace, label: store.label, offersCount: store.offers.length, best: null });
            continue;
          }

          const best = await pickBestVisualMatch(
            backend,
            apiKey,
            item.imageUrl!,
            candidates.map((c) => c.candidate),
            (candidate) => candidate.thumbnail,
            {
              isExhausted: () => quotaExhausted,
              markExhausted: (err) => {
                quotaExhausted = true;
                quotaExhaustedAtItem ??= processedCount;
                lastError = err instanceof Error ? err.message : String(err);
              },
            },
            `${store.label}, "${q}"`
          );

          if (!best || best.score < MIN_APPROXIMATE_SCORE) {
            if (best) rejectedAsNoiseCount++;
            attempts.push({ marketplace: store.marketplace, label: store.label, offersCount: store.offers.length, best: null });
            continue;
          }

          attempts.push({ marketplace: store.marketplace, label: store.label, offersCount: store.offers.length, best });
        }

        return attempts;
      };

      const aiAttempts = await attemptStores(aiQuery);
      const bestByMarketplace = new Map(aiAttempts.map((a) => [a.marketplace, a]));

      // "Texto do catálogo como auxílio, não como método principal"
      // (correção explícita de projeto, ago/2026 — uma versão anterior
      // usava o texto NO LUGAR da IA quando confiável; foi revertida
      // porque "achar algo por texto ainda pode ser qualquer coisa" sem
      // a IA ter tido a chance de tentar primeiro). Design atual: a IA
      // sempre roda primeiro; o texto só entra numa 2ª rodada de busca —
      // mais candidatos pro passo 3 comparar, nunca decide sozinho.
      //
      // Gatilho é "a IA não achou NADA aceitável em loja nenhuma" (nem
      // aproximado), NÃO "a IA não ficou confiante" — de propósito, e já
      // é a 2ª versão deste gatilho (ago/2026): a 1ª usava "nota <
      // APPROXIMATE_BELOW_SCORE (0.8)", que dispara pra praticamente todo
      // match "aproximado" (a faixa mais comum na prática) — dobrando a
      // raspagem em boa parte do catálogo. Relato real: Amazon E Mercado
      // Livre passaram a bloquear (403/CAPTCHA, ver StoreBlockedError em
      // internalSearchProvider.ts) num catálogo que antes só esbarrava no
      // bloqueio de IP do ML — volume de requisição em rajada dobrando é a
      // causa mais provável. "Achou aproximado, mas não tentou reforçar"
      // é a troca aceita aqui: um match "aproximado" já sai marcado como
      // tal pro usuário (não é apresentado como certeza), então não
      // justifica pagar uma 2ª raspagem por loja — o reforço fica restrito
      // a quando a IA teve zero candidatos OU todos os candidatos foram
      // rejeitados como "provavelmente produto diferente" (nem aproximado
      // saiu), que é bem mais raro.
      const aiFoundAnyAcceptedMatch = aiAttempts.some((a) => a.best);
      if (hasReliableName && !aiFoundAnyAcceptedMatch && !quotaExhausted) {
        try {
          const textAttempts = await attemptStores(catalogName!);
          for (const attempt of textAttempts) {
            const current = bestByMarketplace.get(attempt.marketplace);
            if (attempt.best && (!current?.best || attempt.best.score > current.best.score)) {
              bestByMarketplace.set(attempt.marketplace, attempt);
            }
          }
        } catch (err) {
          if (backend.isQuotaExhaustedError(err)) {
            quotaExhausted = true;
            quotaExhaustedAtItem ??= processedCount;
            lastError = err instanceof Error ? err.message : String(err);
          }
          // Falha isolada na rodada de reforço (timeout, loja bloqueou)
          // — segue com o resultado da IA, não propaga.
        }
      }

      let matchedAnyStore = false;
      for (const attempt of bestByMarketplace.values()) {
        if (!attempt.best) continue;
        matchedAnyStore = true;
        results[attempt.marketplace][item.sku] = {
          marketplace: attempt.marketplace,
          sku: item.sku,
          price: attempt.best.candidate.price,
          competitorCount: Math.max(0, attempt.offersCount - 1),
          buyBoxEligible: true,
          // Confiança = a própria nota de similaridade visual, na mesma
          // escala 0-1 usada no resto do projeto pra `confidence` — não
          // passa por `confidenceFromSimilarity` porque não há
          // similaridade de TEXTO nenhuma decidindo esse resultado.
          confidence: attempt.best.score,
          link: attempt.best.candidate.link,
          matchedTitle: attempt.best.candidate.title,
          imageUrl: attempt.best.candidate.thumbnail,
          approximate: attempt.best.score < APPROXIMATE_BELOW_SCORE,
          matchedSource: attempt.label,
          // Popularidade do anúncio escolhido — já vinha do parser da
          // loja (ScrapedOffer) e já pesava no desempate; agora também
          // viaja até a tela (ver reviewCount em types.ts).
          reviewCount: attempt.best.candidate.reviewCount,
          rating: attempt.best.candidate.rating,
        };
      }

      // Passo 4 — busca geral (ago/2026, OPT-IN via marketplace "geral" —
      // ver Dashboard.tsx): só roda quando o usuário marcou "Lojas
      // gerais" explicitamente E nenhuma loja focada (Amazon/Mercado
      // Livre, via `fetchStoreOffers`) confirmou visualmente o produto
      // pra este item. Sem a marcação, comportamento é o de sempre (nada
      // muda) — antes desta opção existir, um produto fora de Amazon/ML
      // simplesmente ficava sem preço nenhum, sem jeito de pedir pro
      // motor tentar mais longe. Fonte: Google Shopping estruturado da
      // ScraperAPI (mesmo endpoint do mecanismo "scraperapi", cobre
      // várias lojas numa chamada só) — ver
      // `fetchGoogleShoppingCandidatesForQuery`.
      //
      // Mesmo com a opção marcada, só dispara quando as lojas focadas JÁ
      // falharam pra este item: custa comparação visual (Gemini) extra,
      // então não é feito incondicionalmente, pra não agravar o teto de
      // cota do free tier (ver comentário "Cota do Gemini free tier..."
      // no topo do arquivo).
      if (geralRequested && !matchedAnyStore && !quotaExhausted) {
        try {
          // Memoizado (ver fetchGoogleShoppingCandidatesMemo): se o
          // substituto do ML já consultou esta mesma string neste item,
          // reaproveita em vez de pagar 25 créditos de novo.
          const broadCandidates = await fetchGoogleShoppingCandidatesMemo(query);
          // Só interessa achar em lojas DE FORA das focadas — Amazon/ML
          // já foram tentadas (e falharam) no passo 3 acima. Exclui só
          // `focusedMatchers` daqui (não `matchers` cru): o matcher de
          // "geral" em si tem `matchesSource: () => false` (ver
          // GOOGLE_SHOPPING_MATCHERS) e nunca deveria contar como "já
          // coberta" — usar `matchers` funcionaria igual por acaso (never
          // exclui nada), mas `focusedMatchers` deixa a intenção clara.
          const otherStoreCandidates = broadCandidates.filter(
            (c) => c.source && !focusedMatchers.some((m) => m.matchesSource(c.source!.toLowerCase()))
          );
          const topBroad = getTopCandidates(
            query,
            otherStoreCandidates,
            (c) => c.title,
            () => 0,
            CANDIDATES_PER_STORE
          );

          const bestBroad = await pickBestVisualMatch(
            backend,
            apiKey,
            item.imageUrl!,
            topBroad.map((c) => c.candidate),
            (candidate) => candidate.thumbnail,
            {
              isExhausted: () => quotaExhausted,
              markExhausted: (err) => {
                quotaExhausted = true;
                quotaExhaustedAtItem ??= processedCount;
                lastError = err instanceof Error ? err.message : String(err);
              },
            },
            `busca geral, "${query}"`
          );

          if (bestBroad && bestBroad.score >= MIN_APPROXIMATE_SCORE && bestBroad.candidate.price != null) {
            // Chave PRÓPRIA "geral" — não empresta o slot de Amazon/ML
            // (diferente do fallback aproximado dos outros mecanismos,
            // que precisa reaproveitar `matchers[0]` por não ter um
            // marketplace "geral" de verdade). Aqui o usuário PEDIU
            // "geral" explicitamente, então tem coluna própria na tela de
            // Resultados.
            results.geral[item.sku] = {
              marketplace: "geral",
              sku: item.sku,
              price: bestBroad.candidate.price,
              competitorCount: Math.max(0, otherStoreCandidates.length - 1),
              buyBoxEligible: false,
              confidence: bestBroad.score,
              matchedTitle: bestBroad.candidate.title,
              imageUrl: bestBroad.candidate.thumbnail,
              approximate: true,
              matchedSource: bestBroad.candidate.source,
            };
          }
        } catch (err) {
          console.warn(`[motor-interno+IA] busca geral (outras lojas) falhou pra "${query}":`, err);
        }
      }
    } catch (err) {
      failures++;
      if (backend.isQuotaExhaustedError(err)) {
        quotaExhausted = true;
        quotaExhaustedAtItem ??= processedCount;
      }
      lastError =
        backend.isVisionError(err) || err instanceof Error
          ? (err as Error).message
          : String(err);
      console.error(`[motor-interno+IA] falhou pra "${item.name}" (${item.sku}):`, err);
    }
  });

  if (itemsWithImage.length > 0 && failures === itemsWithImage.length && lastError) {
    throw new Error(lastError);
  }

  if (rejectedAsNoiseCount > 0) {
    console.warn(
      `[motor-interno+IA] ${rejectedAsNoiseCount} candidato(s) descartado(s) por nota visual abaixo do piso ` +
        `de aproximado (${MIN_APPROXIMATE_SCORE}) — a IA comparou a foto e considerou provavelmente produto ` +
        "diferente, não só baixa confiança."
    );
  }
  if (noCandidatesCount > 0) {
    console.warn(
      `[motor-interno+IA] ${noCandidatesCount} busca(s) por texto (nome do catálogo ou descrição gerada ` +
        "pela IA) não achou candidato nenhum na loja pra comparar visualmente."
    );
  }

  // Ver comentário "Cota do Gemini free tier..." no topo do arquivo —
  // sem isto, estourar cota no meio do lote virava "poucos produtos com
  // preço" sem NENHUMA pista pro usuário, indistinguível de matching
  // ruim. `quotaExhaustedAtItem` marca em que ponto do lote (ordem de
  // processamento, não índice do array) a cota bateu.
  let warning: string | undefined;
  if (quotaExhausted && quotaExhaustedAtItem !== null) {
    const notReached = skippedByQuota;
    // "esgotada depois de" é o marcador ESTÁVEL que o client (Dashboard.tsx,
    // lastGeminiQuotaExhaustedAtRef) usa pra detectar esse warning
    // independente de QUAL backend gerou — não mudar essa frase sem
    // atualizar o marcador lá também.
    warning =
      `Cota gratuita do ${backend.label} esgotada depois de ${quotaExhaustedAtItem} de ${itemsWithImage.length} ` +
      `produto(s) — ${notReached > 0 ? `${notReached} produto(s) nem chegaram a ser buscados` : "o restante não foi buscado"}. ` +
      "O free tier libera cota de novo após ~1 minuto: tente de novo em instantes, processe em lotes menores, " +
      `ou use uma chave ${backend.label} paga em Conta pra não esbarrar nesse teto.`;
    console.warn(`[motor-interno+IA] ${warning}`);
  } else if (
    (noCandidatesCount > 0 || rejectedAsNoiseCount > 0) &&
    Object.values(results).every((r) => Object.keys(r).length === 0)
  ) {
    // Mesmo racional do warning de cota acima — antes disto, um lote que
    // terminou zerado por causa DIAGNOSTICÁVEL (busca não achou nada, ou
    // achou mas a IA rejeitou tudo) chegava na UI indistinguível de "0
    // resultados" genérico (ver ResultsTable.tsx > "Causas comuns"). Só
    // dispara quando o resultado final está TOTALMENTE vazio — se pelo
    // menos um item deu certo, os contadores acima já viraram log, não
    // precisam de banner (não é sistêmico).
    const parts: string[] = [];
    if (noCandidatesCount > 0) {
      parts.push(
        `${noCandidatesCount} produto(s): a busca por texto (nome do catálogo ou descrição da IA) não achou candidato nenhum na loja`
      );
    }
    if (rejectedAsNoiseCount > 0) {
      parts.push(
        `${rejectedAsNoiseCount} produto(s): achou candidato, mas a IA comparou a foto e considerou ` +
          "provavelmente produto diferente"
      );
    }
    warning =
      `Motor interno + IA não achou preço em nenhum produto deste lote — ${parts.join("; ")}. ` +
      "Confira se a foto extraída do catálogo está nítida (Resultados > coluna de foto) ou tente outro " +
      "mecanismo (busca por imagem via SerpApi/SearchApi.io, ou busca por nome).";
    console.warn(`[motor-interno+IA] ${warning}`);
  }

  return { results, warning };
}
