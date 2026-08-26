/**
 * ══════════════════════════════════════════════════════════════════════
 * LEITURA DE PÁGINA DE CATÁLOGO COM GEMINI
 * ══════════════════════════════════════════════════════════════════════
 *
 * Duas funções, dois papéis:
 *
 * 1. `extractCatalogPageWithGemini` — CORREÇÃO de preço pós-OCR. Existe
 *    pra resolver um problema específico do fallback de OCR em
 *    parsePdfCatalog.ts: alguns catálogos de fornecedor usam um banner
 *    DIAGONAL e COLORIDO (ex.: faixa amarela "Unid.CX: 17,00", faixa
 *    vermelha/laranja "ESGOTADO") pro preço/status de estoque — um
 *    elemento gráfico, não texto simples. Tesseract (OCR pixel a pixel,
 *    sem entendimento de LAYOUT) reconhece bem o "MODELO: BM-F1324"
 *    (texto preto reto sobre fundo claro), mas sistematicamente PERDE o
 *    conteúdo desse banner. Chamada só quando o cartão já tem SKU/nome
 *    (achados pelo OCR) e falta só o preço.
 *
 * 2. `extractCatalogPageProductsWithGemini` (ago/2026) — EXTRAÇÃO
 *    GENÉRICA de página inteira, usada como ÚLTIMO recurso em
 *    parsePdfCatalogFile quando NENHUMA heurística (grade com rótulo
 *    conhecido, linha única, bloco sem preço) reconhece produto algum
 *    numa página. Existe pra não precisar de uma regra nova cada vez que
 *    aparece um fornecedor com layout/rótulo diferente (ver histórico:
 *    "MODELO:" → "CÓD." → próximo vai ser outro) — a IA de visão lê a
 *    página como um humano leria, sem depender de nenhum rótulo
 *    específico. Diferente da correção de preço (que só busca o preço de
 *    um SKU já conhecido), esta pede SKU + NOME + preço de tudo que
 *    estiver visível na página.
 *
 * As duas compartilham a chamada de rede (`callGeminiForPage` abaixo) —
 * só o prompt e o parsing da resposta mudam.
 *
 * Um modelo de VISÃO como o Gemini não tem o ponto cego do OCR pixel a
 * pixel: ele lê a imagem como um todo (cor, posição, contexto). As duas
 * funções mandam a PÁGINA INTEIRA (não um recorte por produto) numa
 * ÚNICA chamada — mais barato E mais confiável que uma chamada por
 * produto (testado com página real: os N produtos de uma página saem
 * certos numa chamada só).
 *
 * Roda DIRETO DO NAVEGADOR (fetch nativo, sem Buffer/Node) — diferente de
 * api/_lib/geminiVision.ts (usado na BUSCA de preço, que roda no servidor
 * porque fetch-prices.ts já centraliza ali a orquestração de todos os
 * providers, incluindo os que exigem chamada server-side por CORS). Aqui
 * não há esse motivo: o parse de PDF (pdfjs, canvas, Tesseract) já é 100%
 * client-side, e a API do Gemini aceita chamada direta do browser com a
 * própria chave do usuário (BYOK, mesmo padrão do resto do app) — evitar
 * um upload prévio da página pro nosso servidor só pra repassar ao Gemini
 * economiza uma ida e volta de rede inteira, sem trade-off de segurança
 * (a chave já trafega em claro até o cliente hoje, ver Dashboard.tsx).
 */

export class GeminiCatalogVisionError extends Error {}

/**
 * Subclasse específica pra esgotamento de cota (`RESOURCE_EXHAUSTED`) —
 * mesmo padrão de `GeminiQuotaExhaustedError` em api/_lib/geminiVision.ts
 * (busca de preço). Deixa o chamador (parsePdfCatalogFile) distinguir
 * "essa página específica falhou" de "a cota inteira esgotou, não vale
 * tentar mais nenhuma página" — importante aqui porque um catálogo de
 * centenas de páginas SEM nenhum rótulo reconhecido bateria a cota na
 * primeira página e ficaria martelando as próximas 392 sem chance
 * nenhuma de sucesso, só gastando tempo com timeout/erro repetido.
 */
export class GeminiCatalogQuotaExhaustedError extends GeminiCatalogVisionError {}

interface GeminiPart {
  text?: string;
  inline_data?: { mime_type: string; data: string };
}

interface GeminiResponse {
  candidates?: { content?: { parts?: { text?: string }[] } }[];
  error?: { message?: string; status?: string };
  promptFeedback?: { blockReason?: string };
}

// Mesma família/modelo usada em api/_lib/geminiVision.ts — ver aquele
// arquivo pra histórico da troca de modelo (2.5 → 3.1 Flash-Lite, ago/2026)
// e link da lista de modelos "Stable" atual. Trocar aqui também se aquele
// mudar de novo — os dois ficam desalinhados de propósito só se o
// throughput/custo de cada uso justificar modelos diferentes; por ora,
// mesma família serve bem os dois casos (leitura simples de imagem).
const MODEL = "gemini-3.1-flash-lite";
const ENDPOINT_BASE = `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent`;

// Página inteira (várias fotos + texto) gera payload e resposta bem
// maiores que o describe/compare de item único (api/_lib/geminiVision.ts,
// timeout 15s) — teto maior de propósito pra não abortar antes da hora
// numa página com bastante produto. 45s (não 30s): relato real de
// timeout em 30s com página JPEG grande — o payload já foi reduzido no
// lado de quem chama (ver GEMINI_PAGE_MAX_WIDTH em parsePdfCatalog.ts),
// mas o teto aqui também subiu de propósito pra dar folga extra em
// catálogo com várias páginas OCR seguidas, onde o free tier do Gemini
// pode ir ficando mais lento por throttling entre chamadas próximas.
const REQUEST_TIMEOUT_MS = 45000;

export interface CatalogPageProduct {
  /** Código de modelo/SKU exatamente como o Gemini leu na página (comparado por normalizeSkuForMatch, não por igualdade exata — ver uso em parsePdfCatalog.ts). */
  sku: string;
  inStock: boolean;
  /** null quando esgotado/indisponível OU quando o preço não ficou legível nem pro Gemini. */
  price: number | null;
}

const CATALOG_PAGE_PROMPT =
  "Você está vendo uma página de catálogo de produtos de um fornecedor (venda no atacado). Cada " +
  "produto tem um código de modelo (geralmente rotulado 'MODELO:'), uma foto, um nome/descrição, e " +
  "uma informação de estoque/preço — às vezes num banner ou faixa colorida (ex.: faixa amarela com " +
  "'Unid.CX: 17,00' = em estoque com preço unitário; faixa vermelha ou laranja com 'ESGOTADO' = fora " +
  "de estoque, sem preço). Para CADA produto visível na página, identifique: 1) o código de modelo " +
  "exatamente como aparece (ex.: 'BM-F1324'); 2) se está em estoque (true) ou esgotado/indisponível " +
  "(false); 3) se em estoque, o preço UNITÁRIO (o número ao lado do rótulo de preço por unidade, tipo " +
  "'Unid.CX:' — NÃO o preço da caixa fechada se vier separado, e ignore quantidade por caixa tipo " +
  "'32PCS/CX', isso não é preço). Se esgotado ou o preço não estiver legível, use null. Responda " +
  "SOMENTE com um array JSON, sem texto antes ou depois, sem markdown: " +
  '[{"sku": "BM-F1324", "inStock": true, "price": 17.00}, ...]. Use ponto decimal (não vírgula) no preço.';

/** Converte um data URL (`canvas.toDataURL(...)`) em {mimeType, data} pro payload do Gemini — sem download de rede, o canvas já está em memória (diferente de api/_lib/geminiVision.ts, que baixa foto por URL). */
function dataUrlToInlineData(dataUrl: string): { mimeType: string; data: string } {
  const match = dataUrl.match(/^data:([^;]+);base64,(.+)$/);
  if (!match) {
    throw new GeminiCatalogVisionError("Formato de imagem inesperado (não é um data URL base64).");
  }
  return { mimeType: match[1], data: match[2] };
}

/**
 * Exportado pra teste direto (sem precisar mockar `fetch`) — parseia a
 * resposta de texto do Gemini num array de produtos. Tolerante a cerca de
 * código (```json ... ```) que o modelo às vezes devolve mesmo pedindo
 * pra não, e a entradas malformadas ISOLADAS dentro do array (uma entrada
 * ruim não derruba a página inteira — mesma filosofia do resto do parser:
 * preferir "faltou um produto" a explodir tudo).
 */
export function parseCatalogPageResponse(text: string): CatalogPageProduct[] {
  const cleaned = text.replace(/^```json\s*|^```\s*|\s*```$/g, "").trim();

  let parsed: unknown;
  try {
    parsed = JSON.parse(cleaned);
  } catch {
    throw new GeminiCatalogVisionError("Gemini não devolveu um JSON válido pra página do catálogo.");
  }
  if (!Array.isArray(parsed)) {
    throw new GeminiCatalogVisionError("Gemini não devolveu uma lista de produtos pra página do catálogo.");
  }

  const products: CatalogPageProduct[] = [];
  for (const entry of parsed) {
    if (!entry || typeof entry !== "object") continue;
    const rawSku = (entry as Record<string, unknown>).sku;
    const sku = typeof rawSku === "string" ? rawSku.trim() : "";
    if (!sku) continue;

    const rawInStock = (entry as Record<string, unknown>).inStock;
    const inStock = rawInStock !== false; // ausente/tipo errado => assume em estoque, deixa o preço decidir

    const rawPrice = (entry as Record<string, unknown>).price;
    const price = typeof rawPrice === "number" && Number.isFinite(rawPrice) && rawPrice > 0 ? rawPrice : null;

    products.push({ sku, inStock, price });
  }
  return products;
}

/** Normaliza SKU pra comparação entre o que o OCR leu (via MODEL_LABEL_PATTERN, parsePdfCatalog.ts) e o que o Gemini devolveu — mesma fonte visual, mas cada um pode variar espaço/caixa. */
export function normalizeSkuForMatch(sku: string): string {
  return sku.toUpperCase().replace(/\s+/g, "");
}

/**
 * Chamada de rede compartilhada pelas duas funções públicas deste
 * módulo — só o PROMPT muda entre correção de preço e extração
 * genérica, toda a mecânica de request/timeout/erro é idêntica. Devolve
 * o texto bruto da resposta; quem chama decide como parsear (formatos
 * de saída diferentes pra cada caso).
 *
 * `mensagemCota` é customizável porque o texto de erro precisa fazer
 * sentido pro contexto de quem chamou (uma frase pra "a correção de
 * preço foi pulada", outra pra "a leitura genérica da página foi
 * pulada") — o `status` HTTP/motivo é o mesmo Gemini API pros dois usos.
 */
async function callGeminiForPage(
  pageDataUrl: string,
  apiKey: string,
  prompt: string,
  mensagemCota: string
): Promise<string> {
  const { mimeType, data } = dataUrlToInlineData(pageDataUrl);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  try {
    const response = await fetch(`${ENDPOINT_BASE}?key=${encodeURIComponent(apiKey)}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [
          {
            parts: [{ text: prompt }, { inline_data: { mime_type: mimeType, data } }] as GeminiPart[],
          },
        ],
        // JSON mode: o Gemini força a resposta a ser JSON sintaticamente
        // válido — reduz (não elimina, daí o parse tolerante em cada
        // função pública) o risco de cerca de código ou texto solto em
        // volta do array.
        generationConfig: { maxOutputTokens: 4000, temperature: 0.1, responseMimeType: "application/json" },
      }),
      signal: controller.signal,
    });

    const json = (await response.json()) as GeminiResponse;

    if (!response.ok) {
      const status = json.error?.status;
      if (status === "RESOURCE_EXHAUSTED") {
        throw new GeminiCatalogQuotaExhaustedError(
          `Gemini sem cota disponível agora (limite de requisições do tier gratuito, ver ` +
            `aistudio.google.com/rate-limit) — ${mensagemCota}`
        );
      }
      throw new GeminiCatalogVisionError(
        `Gemini retornou HTTP ${response.status}${json.error?.message ? `: ${json.error.message}` : ""}`
      );
    }

    if (json.promptFeedback?.blockReason) {
      throw new GeminiCatalogVisionError(`Gemini recusou processar a página (${json.promptFeedback.blockReason}).`);
    }

    const text = json.candidates?.[0]?.content?.parts?.[0]?.text?.trim();
    if (!text) throw new GeminiCatalogVisionError("Gemini não devolveu texto na resposta.");

    return text;
  } catch (err) {
    if (err instanceof GeminiCatalogVisionError) throw err;
    if (err instanceof Error && err.name === "AbortError") {
      throw new GeminiCatalogVisionError(`Gemini não respondeu em ${REQUEST_TIMEOUT_MS / 1000}s (timeout).`);
    }
    throw new GeminiCatalogVisionError(`Falha ao chamar Gemini: ${err instanceof Error ? err.message : String(err)}`);
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Lê a página INTEIRA de um catálogo (já renderizada como data URL de
 * canvas) numa ÚNICA chamada Gemini, devolvendo preço/status de TODOS os
 * produtos visíveis nela — ver comentário no topo do arquivo pro porquê.
 *
 * UMA chamada por PÁGINA, não uma por produto: uma página com 9 produtos
 * custaria 9x mais em chamadas (e tempo, e risco de `RESOURCE_EXHAUSTED`
 * no tier gratuito) se fosse por item — o Gemini lê a página inteira de
 * uma vez com a mesma confiabilidade prática (o teste da página real do
 * usuário confirma: os 9 modelos/preços da página saem certos numa
 * chamada só). Chamado apenas como CORREÇÃO pontual, sobre produtos que o
 * OCR já localizou mas não conseguiu precificar — ver uso em
 * parsePdfCatalog.ts.
 */
export async function extractCatalogPageWithGemini(
  pageDataUrl: string,
  apiKey: string
): Promise<CatalogPageProduct[]> {
  const text = await callGeminiForPage(
    pageDataUrl,
    apiKey,
    CATALOG_PAGE_PROMPT,
    "a correção de preço via IA foi pulada pra esta página."
  );
  return parseCatalogPageResponse(text);
}

export interface CatalogPageFullProduct {
  /** Código/SKU exatamente como o Gemini leu na página. */
  sku: string;
  /** Nome/descrição do produto, também lido da página (diferente de CatalogPageProduct, que não precisa de nome pois já o recebe de outra fonte). */
  name: string;
  inStock: boolean;
  /** null quando esgotado/indisponível OU quando o preço não ficou legível nem pro Gemini. */
  price: number | null;
  /**
   * Caixa delimitadora da FOTO do produto, normalizada 0-1000 na ordem
   * [yMin, xMin, yMax, xMax] — convenção nativa do Gemini pra detecção de
   * objeto (ver FULL_PAGE_EXTRACTION_PROMPT). Opcional: ausente quando a
   * IA não identificou a foto com confiança — item ainda é válido pra
   * busca por texto, só não vai ter imagem pro modo foto (ver
   * cropNormalizedBox em parsePdfCatalog.ts).
   */
  box?: { yMin: number; xMin: number; yMax: number; xMax: number };
}

// Deliberadamente GENÉRICO — não assume nenhum rótulo específico
// ("MODELO:", "CÓD.", etc.), nenhuma disposição de grade fixa, nem
// idioma de rótulo. É exatamente o ponto: catálogo de fornecedor novo
// com convenção nunca vista antes não deve precisar de código novo aqui,
// só funcionar direto (ver comentário no topo do arquivo).
// `box_2d` (ago/2026): campo NOVO, adicionado depois de um catálogo real
// (layout fora do padrão de grade/linha, foto não extraída pra NENHUM
// mecanismo de busca por imagem — só texto funcionava). Causa raiz: esta
// extração genérica é o ÚNICO caminho que reconhecia produto nesse
// catálogo, mas devolvia só sku+name+price, sem posição nenhuma na
// página — `parsePdfCatalogFile` não tinha o que recortar, então
// `imagesBySku` ficava vazio e qualquer provider de FOTO (Google Lens,
// SearchApi.io, motor interno + IA) travava com "não consegui extrair
// nenhuma foto" mesmo o usuário já tendo escolhido modo imagem ANTES de
// subir o arquivo. `box_2d` normalizado 0-1000 no formato
// [yMin, xMin, yMax, xMax] é a convenção NATIVA do Gemini pra detecção de
// objeto (o modelo foi de fato treinado nesse formato pra tarefas
// espaciais, ao contrário de inventar um esquema de coordenada próprio) —
// ver cropNormalizedBox em parsePdfCatalog.ts pro recorte. Campo
// OPCIONAL de propósito: se a IA não conseguir estimar a caixa da foto
// (produto sem foto visível, ou baixa confiança espacial), o item ainda
// entra no catálogo com sku+nome+preço — só fica sem imagem, mesmo
// comportamento de antes desta mudança (busca por texto nunca dependeu
// disso).
const FULL_PAGE_EXTRACTION_PROMPT =
  "Você está vendo uma página de um catálogo de produtos de um fornecedor (venda no atacado ou " +
  "varejo). Cada produto tem um código/referência (rotulado como 'SKU', 'CÓD.', 'CÓDIGO', 'MODELO', " +
  "'REF' ou qualquer outra convenção — analise visualmente, o rótulo exato varia entre fornecedores " +
  "e o layout pode ser grade de cartões ou lista), uma foto, um nome/descrição, e um preço em reais " +
  "(R$) — às vezes num banner ou faixa colorida em vez de texto simples. Para CADA produto visível " +
  "na página, identifique: 1) o código/SKU exatamente como aparece; 2) o nome/descrição do produto; " +
  "3) se está em estoque (true) ou esgotado/indisponível (false, ex.: faixa 'ESGOTADO'); 4) se em " +
  "estoque, o preço UNITÁRIO em reais (ignore quantidade por caixa tipo '32PCS/CX' ou código de " +
  "referência numérico solto sem 'R$' — isso não é preço; ignore também o preço da caixa fechada se " +
  "vier separado do preço unitário); 5) a caixa delimitadora (bounding box) SÓ DA FOTO do produto " +
  "(não do texto/preço ao redor), como \"box_2d\": [yMin, xMin, yMax, xMax] normalizado de 0 a 1000 " +
  "relativo ao tamanho da imagem inteira — omita este campo se não conseguir identificar a foto do " +
  "produto com confiança. Se esgotado ou o preço não estiver legível, use null pro preço mas AINDA " +
  "ASSIM inclua o produto com sku e name. Se não conseguir identificar nem um código/SKU pra um " +
  "produto, pule-o (não invente nada). Responda SOMENTE com um array JSON, sem texto antes ou depois, " +
  "sem markdown: [{\"sku\": \"BM-F1324\", \"name\": \"Nome do produto\", \"inStock\": true, " +
  '"price": 17.00, "box_2d": [100, 50, 300, 250]}, ...]. Use ponto decimal (não vírgula) no preço.';

/**
 * Exportado pra teste direto — parseia a resposta de texto do Gemini pra
 * extração GENÉRICA (sku+nome+preço), mesma tolerância a cerca de código
 * e entrada malformada isolada de `parseCatalogPageResponse`. Diferença
 * chave: aqui `name` é obrigatório (sem nome, a linha não serve pra
 * nada — nem busca de preço por texto nem exibição na tela fazem
 * sentido com nome vazio), então entrada sem nome utilizável é
 * descartada, não incluída com string vazia.
 */
export function parseCatalogPageFullResponse(text: string): CatalogPageFullProduct[] {
  const cleaned = text.replace(/^```json\s*|^```\s*|\s*```$/g, "").trim();

  let parsed: unknown;
  try {
    parsed = JSON.parse(cleaned);
  } catch {
    throw new GeminiCatalogVisionError("Gemini não devolveu um JSON válido pra página do catálogo.");
  }
  if (!Array.isArray(parsed)) {
    throw new GeminiCatalogVisionError("Gemini não devolveu uma lista de produtos pra página do catálogo.");
  }

  const products: CatalogPageFullProduct[] = [];
  for (const entry of parsed) {
    if (!entry || typeof entry !== "object") continue;
    const rawSku = (entry as Record<string, unknown>).sku;
    const sku = typeof rawSku === "string" ? rawSku.trim() : "";
    if (!sku) continue;

    const rawName = (entry as Record<string, unknown>).name;
    const name = typeof rawName === "string" ? rawName.trim() : "";
    if (!name) continue;

    const rawInStock = (entry as Record<string, unknown>).inStock;
    const inStock = rawInStock !== false; // ausente/tipo errado => assume em estoque, deixa o preço decidir

    const rawPrice = (entry as Record<string, unknown>).price;
    const price = typeof rawPrice === "number" && Number.isFinite(rawPrice) && rawPrice > 0 ? rawPrice : null;

    // box_2d é opcional e TOLERANTE — formato inesperado (não é array de
    // 4 números, valor fora de 0-1000) descarta só a caixa, nunca o
    // produto inteiro: sku+nome+preço continuam válidos pra busca por
    // texto mesmo sem foto (mesma filosofia "faltou uma imagem" do resto
    // deste parser, não "faltou um produto").
    const rawBox = (entry as Record<string, unknown>).box_2d;
    let box: CatalogPageFullProduct["box"];
    if (
      Array.isArray(rawBox) &&
      rawBox.length === 4 &&
      rawBox.every((v) => typeof v === "number" && Number.isFinite(v) && v >= 0 && v <= 1000)
    ) {
      const [yMin, xMin, yMax, xMax] = rawBox as number[];
      if (yMax > yMin && xMax > xMin) box = { yMin, xMin, yMax, xMax };
    }

    products.push({ sku, name, inStock, price, box });
  }
  return products;
}

/**
 * Extração GENÉRICA de página inteira — sku, nome e preço de TODOS os
 * produtos visíveis, sem depender de rótulo/layout conhecido. Ver
 * comentário no topo do arquivo pro porquê e uso em parsePdfCatalog.ts
 * (só chamado quando grade + linha-única + bloco-sem-preço não acharem
 * NADA numa página, com chave Gemini própria do usuário configurada).
 */
export async function extractCatalogPageProductsWithGemini(
  pageDataUrl: string,
  apiKey: string
): Promise<CatalogPageFullProduct[]> {
  const text = await callGeminiForPage(
    pageDataUrl,
    apiKey,
    FULL_PAGE_EXTRACTION_PROMPT,
    "a leitura genérica desta página por IA foi pulada."
  );
  return parseCatalogPageFullResponse(text);
}
