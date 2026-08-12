/**
 * ══════════════════════════════════════════════════════════════════════
 * LEITURA DE PÁGINA DE CATÁLOGO COM GEMINI — correção de preço pós-OCR
 * ══════════════════════════════════════════════════════════════════════
 *
 * Existe pra resolver um problema específico do fallback de OCR em
 * parsePdfCatalog.ts: alguns catálogos de fornecedor usam um banner
 * DIAGONAL e COLORIDO (ex.: faixa amarela "Unid.CX: 17,00", faixa
 * vermelha/laranja "ESGOTADO") pro preço/status de estoque — um elemento
 * gráfico, não texto simples. Tesseract (OCR pixel a pixel, sem
 * entendimento de LAYOUT) reconhece bem o "MODELO: BM-F1324" (texto preto
 * reto sobre fundo claro), mas sistematicamente PERDE o conteúdo desse
 * banner (confirmado com o PDF real do usuário: nome/modelo saem
 * corretos, preço sai vazio em quase todo produto da página). Sem preço,
 * `extractGridBlocks` descarta o produto inteiro — daí o catálogo inteiro
 * (~50 produtos em 6 páginas) virar "2 produtos reconhecidos".
 *
 * Um modelo de VISÃO como o Gemini não tem esse ponto cego: ele lê a
 * imagem como um todo (cor, posição, contexto), não caractere isolado
 * binarizado em preto/branco. Este módulo manda a PÁGINA INTEIRA (não um
 * recorte por produto) numa ÚNICA chamada e pede de volta o preço/status
 * de TODOS os produtos daquela página — ver comentário em
 * `extractCatalogPageWithGemini` sobre por que "página inteira" é a
 * escolha certa (mais barato E mais confiável que uma chamada por
 * produto).
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
            parts: [{ text: CATALOG_PAGE_PROMPT }, { inline_data: { mime_type: mimeType, data } }] as GeminiPart[],
          },
        ],
        // JSON mode: o Gemini força a resposta a ser JSON sintaticamente
        // válido — reduz (não elimina, daí o parse tolerante acima) o
        // risco de cerca de código ou texto solto em volta do array.
        generationConfig: { maxOutputTokens: 4000, temperature: 0.1, responseMimeType: "application/json" },
      }),
      signal: controller.signal,
    });

    const json = (await response.json()) as GeminiResponse;

    if (!response.ok) {
      const status = json.error?.status;
      throw new GeminiCatalogVisionError(
        status === "RESOURCE_EXHAUSTED"
          ? "Gemini sem cota disponível agora (limite de requisições do tier gratuito, ver " +
            "aistudio.google.com/rate-limit) — a correção de preço via IA foi pulada pra esta página."
          : `Gemini retornou HTTP ${response.status}${json.error?.message ? `: ${json.error.message}` : ""}`
      );
    }

    if (json.promptFeedback?.blockReason) {
      throw new GeminiCatalogVisionError(`Gemini recusou processar a página (${json.promptFeedback.blockReason}).`);
    }

    const text = json.candidates?.[0]?.content?.parts?.[0]?.text?.trim();
    if (!text) throw new GeminiCatalogVisionError("Gemini não devolveu texto na resposta.");

    return parseCatalogPageResponse(text);
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
