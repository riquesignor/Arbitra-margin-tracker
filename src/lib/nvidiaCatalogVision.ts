/**
 * ══════════════════════════════════════════════════════════════════════
 * LEITURA DE PÁGINA DE CATÁLOGO COM NVIDIA (NIM) — BETA
 * ══════════════════════════════════════════════════════════════════════
 *
 * Arquivo IRMÃO de geminiCatalogVision.ts — MESMO contrato (duas funções,
 * dois papéis: correção de preço pós-OCR e extração genérica de página
 * inteira), MESMOS prompts (comparação justa entre backends, texto
 * idêntico de propósito), só troca o vendor. Ver o comentário grande no
 * topo daquele arquivo pro raciocínio completo de por que essas duas
 * funções existem — não duplicado aqui.
 *
 * ── Por que NVIDIA aqui é um modelo de instrução geral, não "Nemotron
 * Parse" ──────────────────────────────────────────────────────────────
 * A NVIDIA tem um modelo especializado em parsing de documento
 * ("nemotron-parse", ver build.nvidia.com) — mas o formato de saída dele
 * é uma string PRÓPRIA (bounding box + classe semântica embutidos,
 * "encodes text content... as well as bounding boxes and class
 * attributes", conforme o model card), não JSON livre por instrução de
 * prompt. Sem um exemplo real desse formato pra validar o parser, usar
 * esse modelo aqui seria apostar num contrato não confirmado. Em vez
 * disso, este arquivo usa o MESMO modelo de instrução geral já validado
 * em api/_lib/nvidiaVision.ts (`meta/llama-3.2-90b-vision-instruct`,
 * catálogo NIM) — um modelo de visão treinado pra seguir instrução em
 * linguagem natural, exatamente a mesma tarefa que o Gemini já resolve
 * bem aqui ("leia esta página, devolva um array JSON de produtos").
 * Se "nemotron-parse" provar, num teste real, que lê catálogo melhor que
 * um modelo de instrução geral, trocar o MODEL abaixo e ajustar o
 * parsing é o próximo passo natural — não feito agora por falta de
 * validação do formato de saída.
 *
 * Roda DIRETO DO NAVEGADOR (fetch nativo) — mesmo motivo de
 * geminiCatalogVision.ts: o parse de PDF já é 100% client-side, e a API
 * NIM aceita chamada direta do browser com a chave própria do usuário
 * (BYOK, mesmo padrão do resto do app).
 */

export class NvidiaCatalogVisionError extends Error {}

/** Ver GeminiCatalogQuotaExhaustedError em geminiCatalogVision.ts — mesmo papel, esgotamento do free tier NIM (40 req/min). */
export class NvidiaCatalogQuotaExhaustedError extends NvidiaCatalogVisionError {}

const MODEL = "meta/llama-3.2-90b-vision-instruct";
const ENDPOINT = "https://integrate.api.nvidia.com/v1/chat/completions";

/** Ver REQUEST_TIMEOUT_MS em geminiCatalogVision.ts — mesmo raciocínio (payload de página inteira, maior que describe/compare de item único). */
const REQUEST_TIMEOUT_MS = 45000;

export interface CatalogPageProduct {
  sku: string;
  inStock: boolean;
  price: number | null;
}

/** Mesmo texto de CATALOG_PAGE_PROMPT em geminiCatalogVision.ts, de propósito (comparação justa entre backends). */
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

function dataUrlToInlineData(dataUrl: string): { mimeType: string; data: string } {
  const match = dataUrl.match(/^data:([^;]+);base64,(.+)$/);
  if (!match) {
    throw new NvidiaCatalogVisionError("Formato de imagem inesperado (não é um data URL base64).");
  }
  return { mimeType: match[1], data: match[2] };
}

/** Ver parseCatalogPageResponse em geminiCatalogVision.ts — mesma tolerância a cerca de código e entrada malformada isolada. */
export function parseCatalogPageResponse(text: string): CatalogPageProduct[] {
  const cleaned = text.replace(/^```json\s*|^```\s*|\s*```$/g, "").trim();

  let parsed: unknown;
  try {
    parsed = JSON.parse(cleaned);
  } catch {
    throw new NvidiaCatalogVisionError("NVIDIA NIM não devolveu um JSON válido pra página do catálogo.");
  }
  if (!Array.isArray(parsed)) {
    throw new NvidiaCatalogVisionError("NVIDIA NIM não devolveu uma lista de produtos pra página do catálogo.");
  }

  const products: CatalogPageProduct[] = [];
  for (const entry of parsed) {
    if (!entry || typeof entry !== "object") continue;
    const rawSku = (entry as Record<string, unknown>).sku;
    const sku = typeof rawSku === "string" ? rawSku.trim() : "";
    if (!sku) continue;

    const rawInStock = (entry as Record<string, unknown>).inStock;
    const inStock = rawInStock !== false;

    const rawPrice = (entry as Record<string, unknown>).price;
    const price = typeof rawPrice === "number" && Number.isFinite(rawPrice) && rawPrice > 0 ? rawPrice : null;

    products.push({ sku, inStock, price });
  }
  return products;
}

interface NvidiaContent {
  type: "text" | "image_url";
  text?: string;
  image_url?: { url: string };
}

interface NvidiaResponse {
  choices?: { message?: { content?: string } }[];
  detail?: string;
  message?: string;
}

/** Ver callGeminiForPage em geminiCatalogVision.ts — mesma mecânica de request/timeout/erro compartilhada pelas duas funções públicas, só o prompt muda. */
async function callNvidiaForPage(
  pageDataUrl: string,
  apiKey: string,
  prompt: string,
  mensagemCota: string
): Promise<string> {
  const { mimeType, data } = dataUrlToInlineData(pageDataUrl);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  try {
    const response = await fetch(ENDPOINT, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: MODEL,
        messages: [
          {
            role: "user",
            content: [
              { type: "text", text: prompt },
              { type: "image_url", image_url: { url: `data:${mimeType};base64,${data}` } },
            ] as NvidiaContent[],
          },
        ],
        max_tokens: 4000,
        temperature: 0.1,
      }),
      signal: controller.signal,
    });

    if (response.status === 429) {
      throw new NvidiaCatalogQuotaExhaustedError(
        `NVIDIA NIM sem cota disponível agora (limite do free tier — 40 requisições/minuto, ver ` +
          `build.nvidia.com) — ${mensagemCota}`
      );
    }

    const json = (await response.json()) as NvidiaResponse;

    if (!response.ok) {
      throw new NvidiaCatalogVisionError(
        `NVIDIA NIM retornou HTTP ${response.status}${json.detail ?? json.message ? `: ${json.detail ?? json.message}` : ""}`
      );
    }

    const text = json.choices?.[0]?.message?.content?.trim();
    if (!text) throw new NvidiaCatalogVisionError("NVIDIA NIM não devolveu texto na resposta.");

    return text;
  } catch (err) {
    if (err instanceof NvidiaCatalogVisionError) throw err;
    if (err instanceof Error && err.name === "AbortError") {
      throw new NvidiaCatalogVisionError(`NVIDIA NIM não respondeu em ${REQUEST_TIMEOUT_MS / 1000}s (timeout).`);
    }
    throw new NvidiaCatalogVisionError(`Falha ao chamar NVIDIA NIM: ${err instanceof Error ? err.message : String(err)}`);
  } finally {
    clearTimeout(timeout);
  }
}

/** Ver extractCatalogPageWithGemini em geminiCatalogVision.ts — mesmo contrato (correção pontual de preço pós-OCR). */
export async function extractCatalogPageWithNvidia(
  pageDataUrl: string,
  apiKey: string
): Promise<CatalogPageProduct[]> {
  const text = await callNvidiaForPage(
    pageDataUrl,
    apiKey,
    CATALOG_PAGE_PROMPT,
    "a correção de preço via IA foi pulada pra esta página."
  );
  return parseCatalogPageResponse(text);
}

export interface CatalogPageFullProduct {
  sku: string;
  name: string;
  inStock: boolean;
  price: number | null;
  box?: { yMin: number; xMin: number; yMax: number; xMax: number };
}

/** Mesmo texto de FULL_PAGE_EXTRACTION_PROMPT em geminiCatalogVision.ts, de propósito. */
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

/** Ver parseCatalogPageFullResponse em geminiCatalogVision.ts — mesma tolerância. */
export function parseCatalogPageFullResponse(text: string): CatalogPageFullProduct[] {
  const cleaned = text.replace(/^```json\s*|^```\s*|\s*```$/g, "").trim();

  let parsed: unknown;
  try {
    parsed = JSON.parse(cleaned);
  } catch {
    throw new NvidiaCatalogVisionError("NVIDIA NIM não devolveu um JSON válido pra página do catálogo.");
  }
  if (!Array.isArray(parsed)) {
    throw new NvidiaCatalogVisionError("NVIDIA NIM não devolveu uma lista de produtos pra página do catálogo.");
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
    const inStock = rawInStock !== false;

    const rawPrice = (entry as Record<string, unknown>).price;
    const price = typeof rawPrice === "number" && Number.isFinite(rawPrice) && rawPrice > 0 ? rawPrice : null;

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

/** Ver extractCatalogPageProductsWithGemini em geminiCatalogVision.ts — mesmo contrato (extração genérica, último recurso). */
export async function extractCatalogPageProductsWithNvidia(
  pageDataUrl: string,
  apiKey: string
): Promise<CatalogPageFullProduct[]> {
  const text = await callNvidiaForPage(
    pageDataUrl,
    apiKey,
    FULL_PAGE_EXTRACTION_PROMPT,
    "a leitura genérica desta página por IA foi pulada."
  );
  return parseCatalogPageFullResponse(text);
}
