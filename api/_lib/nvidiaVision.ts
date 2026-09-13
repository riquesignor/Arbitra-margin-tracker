/**
 * ══════════════════════════════════════════════════════════════════════
 * PONTE COM IA DE VISÃO — motor interno + IA (variante NVIDIA, BETA)
 * ══════════════════════════════════════════════════════════════════════
 *
 * Terceira opção de backend de visão pro motor interno + IA (ver
 * geminiVision.ts/mistralVision.ts), MESMO contrato de função
 * (`describeProductImage`/`compareProductImages`/`compareProductImagesBatch`)
 * pra `searchVisionInternalShared` plugar sem saber qual dos três é (ver
 * `VisionBackend` em visionInternalSearchProvider.ts).
 *
 * Entra como BETA (set/2026, pedido explícito do usuário depois de
 * pesquisa sobre APIs NVIDIA) — não substitui Gemini/Mistral, é uma 3ª
 * opção lado a lado pro usuário comparar. Marcado como "Beta" no seletor
 * (Dashboard.tsx) até ter validação real de acurácia/latência num
 * catálogo real, mesmo cuidado que "vision_mistral" teve antes de virar
 * opção "normal".
 *
 * ── Acesso: BYOK igual Gemini/Mistral, SEM login do usuário final ──────
 * A API é servida via NVIDIA NIM (build.nvidia.com/explore), catálogo de
 * 100+ modelos com endpoint OpenAI-compatible. Pra conseguir a chave, o
 * usuário cria conta grátis em build.nvidia.com (só email, sem cartão) —
 * EXATAMENTE o mesmo passo que já é exigido hoje pra Gemini
 * (aistudio.google.com/apikey) ou Mistral (console.mistral.ai): criar
 * conta na PLATAFORMA de origem, uma vez, fora do Arbitra. Depois disso a
 * chave é colada em Conta → "NVIDIA (motor interno + IA, beta)", igual
 * às outras — nenhum OAuth, nenhum login em NVIDIA na hora de USAR a
 * busca dentro do Arbitra. Free tier: 40 requisições/minuto + 1.000
 * créditos iniciais, sem cartão de crédito (build.nvidia.com, verificado
 * set/2026).
 *
 * ── Modelo ──────────────────────────────────────────────────────────────
 * `meta/llama-3.2-90b-vision-instruct` — modelo multimodal (visão +
 * texto) hospedado no catálogo NIM, estável e amplamente documentado.
 * NVIDIA atualiza o catálogo de modelos com frequência (novos Nemotron
 * multimodais entrando, outros saindo do free tier) — se este modelo
 * parar de responder, o 1º lugar pra checar é build.nvidia.com/explore/
 * discover (filtro "Vision Language Models") e trocar a constante MODEL
 * abaixo. Mantido como constante única, não espalhado pelo arquivo, de
 * propósito pra essa troca ser 1 linha.
 */

import { fetchImageWithLimit, UnsafeImageUrlError } from "./safeImageUrl.js";

const MODEL = "meta/llama-3.2-90b-vision-instruct";
const ENDPOINT = "https://integrate.api.nvidia.com/v1/chat/completions";

/** Ver REQUEST_TIMEOUT_MS em geminiVision.ts/mistralVision.ts — mesmo raciocínio. */
const REQUEST_TIMEOUT_MS = 20000;

/** Teto de segurança pro retry quando não há `retry-after` utilizável — ver mistralVision.ts. */
const MAX_RETRY_DELAY_MS = 20000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export class NvidiaVisionError extends Error {}

/** HTTP 429 (rate limit do free tier NIM) — mesmo papel de GeminiQuotaExhaustedError/MistralQuotaExhaustedError. */
export class NvidiaQuotaExhaustedError extends NvidiaVisionError {
  constructor(message: string, public readonly retryAfterMs: number | null) {
    super(message);
  }
}

/**
 * Formato de imagem OpenAI-compatible (NIM segue o padrão da OpenAI, ao
 * contrário da Mistral — ver comentário equivalente em mistralVision.ts):
 * `image_url` é um OBJETO `{ url: string }`, não a string crua.
 */
interface NvidiaImageContent {
  type: "image_url";
  image_url: { url: string };
}
interface NvidiaTextContent {
  type: "text";
  text: string;
}
type NvidiaContent = NvidiaTextContent | NvidiaImageContent;

interface NvidiaResponse {
  choices?: { message?: { content?: string } }[];
  message?: string;
  detail?: string;
}

/** Mesma função de geminiVision.ts/mistralVision.ts, duplicada de propósito (arquivos irmãos). */
async function fetchImageAsDataUri(imageUrl: string, scraperApiKey: string | undefined): Promise<string> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const { buffer, mimeType } = await fetchImageWithLimit(imageUrl, controller.signal, scraperApiKey);
    return `data:${mimeType};base64,${buffer.toString("base64")}`;
  } catch (err) {
    if (err instanceof NvidiaVisionError) throw err;
    if (err instanceof UnsafeImageUrlError) {
      throw new NvidiaVisionError(err.message);
    }
    if (err instanceof Error && err.name === "AbortError") {
      throw new NvidiaVisionError(`Baixar a imagem demorou mais que ${REQUEST_TIMEOUT_MS / 1000}s.`);
    }
    throw new NvidiaVisionError(`Falha ao baixar imagem: ${err instanceof Error ? err.message : String(err)}`);
  } finally {
    clearTimeout(timeout);
  }
}

async function callNvidiaOnce(content: NvidiaContent[], apiKey: string): Promise<string> {
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
        messages: [{ role: "user", content }],
        max_tokens: 200,
        temperature: 0.2,
      }),
      signal: controller.signal,
    });

    if (response.status === 429) {
      const retryAfterHeader = response.headers.get("retry-after");
      const retryAfterMs = retryAfterHeader ? Number(retryAfterHeader) * 1000 : null;
      throw new NvidiaQuotaExhaustedError(
        "NVIDIA NIM sem cota disponível agora (limite do free tier — 40 requisições/minuto, ver " +
          "build.nvidia.com) — tente novamente em instantes, ou considere um tier pago se isso for frequente.",
        Number.isFinite(retryAfterMs) ? retryAfterMs : null
      );
    }

    const data = (await response.json()) as NvidiaResponse;

    if (!response.ok) {
      throw new NvidiaVisionError(
        `NVIDIA NIM retornou HTTP ${response.status}${data.detail ?? data.message ? `: ${data.detail ?? data.message}` : ""}`
      );
    }

    const text = data.choices?.[0]?.message?.content?.trim();
    if (!text) throw new NvidiaVisionError("NVIDIA NIM não devolveu texto na resposta.");
    return text;
  } catch (err) {
    if (err instanceof NvidiaVisionError) throw err;
    if (err instanceof Error && err.name === "AbortError") {
      throw new NvidiaVisionError(`NVIDIA NIM não respondeu em ${REQUEST_TIMEOUT_MS / 1000}s (timeout).`);
    }
    throw new NvidiaVisionError(`Falha ao chamar NVIDIA NIM: ${err instanceof Error ? err.message : String(err)}`);
  } finally {
    clearTimeout(timeout);
  }
}

/** Ver callMistral em mistralVision.ts — mesma ideia (1 retry só, e só pra rate-limit). */
async function callNvidia(content: NvidiaContent[], apiKey: string): Promise<string> {
  try {
    return await callNvidiaOnce(content, apiKey);
  } catch (err) {
    if (!(err instanceof NvidiaQuotaExhaustedError)) throw err;
    const delay = Math.min(err.retryAfterMs ?? MAX_RETRY_DELAY_MS, MAX_RETRY_DELAY_MS);
    console.warn(`[motor-interno+IA/NVIDIA] cota esgotada, aguardando ${Math.round(delay / 1000)}s pra 1 nova tentativa...`);
    await sleep(delay);
    return callNvidiaOnce(content, apiKey);
  }
}

/** Mesmo texto de DESCRIBE_PROMPT em geminiVision.ts/mistralVision.ts, de propósito (comparação justa entre backends). */
const DESCRIBE_PROMPT =
  "Você é parte de um sistema de busca de preço. Veja a foto de um produto de catálogo de " +
  "fornecedor e escreva, em português do Brasil, uma frase CURTA (até 8 palavras) que funcione " +
  "como termo de busca numa loja online (tipo Mercado Livre ou Amazon) — categoria do produto, " +
  "cor, material e características visuais distintas. NÃO invente marca/modelo a menos que um " +
  "logotipo real apareça legível na foto. Responda SOMENTE com a frase de busca, sem aspas, sem " +
  "explicação, sem pontuação final.";

/** Ver describeProductImage em geminiVision.ts/mistralVision.ts — mesmo contrato. */
export async function describeProductImage(
  imageUrl: string,
  apiKey: string,
  scraperApiKey?: string
): Promise<string> {
  const dataUri = await fetchImageAsDataUri(imageUrl, scraperApiKey);
  const text = await callNvidia(
    [
      { type: "text", text: DESCRIBE_PROMPT },
      { type: "image_url", image_url: { url: dataUri } },
    ],
    apiKey
  );
  return text.replace(/^["'“”]+|["'“”.]+$/g, "").trim();
}

const COMPARE_PROMPT =
  "Você é parte de um sistema de busca de preço. Estas são DUAS fotos: a primeira é de um " +
  "catálogo de fornecedor, a segunda é de um anúncio encontrado numa loja online. Elas mostram O " +
  "MESMO PRODUTO (mesmo modelo, não só a mesma categoria)? Responda SOMENTE com um número decimal " +
  "de 0 a 1: 1 = certamente o mesmo produto, 0.5 = mesma categoria mas modelo/versão incerta ou " +
  "diferente, 0 = claramente produtos diferentes. Responda só o número, sem texto.";

/** Ver compareProductImages em geminiVision.ts/mistralVision.ts — mesmo contrato (0-1, uma comparação por chamada). */
export async function compareProductImages(
  catalogImageUrl: string,
  candidateImageUrl: string,
  apiKey: string,
  scraperApiKey?: string
): Promise<number> {
  const [catalogUri, candidateUri] = await Promise.all([
    fetchImageAsDataUri(catalogImageUrl, scraperApiKey),
    fetchImageAsDataUri(candidateImageUrl, scraperApiKey),
  ]);

  const text = await callNvidia(
    [
      { type: "text", text: COMPARE_PROMPT },
      { type: "image_url", image_url: { url: catalogUri } },
      { type: "image_url", image_url: { url: candidateUri } },
    ],
    apiKey
  );

  const value = Number(text.match(/[\d.]+/)?.[0]);
  if (!Number.isFinite(value)) {
    throw new NvidiaVisionError(`NVIDIA NIM devolveu algo que não é um número de similaridade: "${text}"`);
  }
  return Math.min(1, Math.max(0, value));
}

/**
 * ── Comparação em LOTE ──
 * Mesma técnica de mistralVision.ts > compareProductImagesBatch — manda
 * catálogo + N candidatos numa chamada só. Chunka em grupos de até
 * MAX_CANDIDATES_PER_BATCH (mesmo valor conservador da Mistral — sem
 * benchmark próprio ainda do teto real de imagens/requisição do NIM pra
 * este modelo, mais seguro herdar o mesmo número já validado ali do que
 * arriscar um teto mais alto sem confirmação).
 */
const MAX_CANDIDATES_PER_BATCH = 7;

function buildBatchComparePrompt(count: number): string {
  const example = Array.from({ length: count }, (_, i) => (i === 0 ? "0.9" : i === 1 ? "0.2" : "0")).join(",");
  return (
    "Você é parte de um sistema de busca de preço. A PRIMEIRA foto é de um catálogo de " +
    `fornecedor. As próximas ${count} foto(s) são candidatos numerados de 1 a ${count}, encontrados ` +
    "numa loja online. Pra CADA candidato, diga se é O MESMO PRODUTO (mesmo modelo, não só a mesma " +
    "categoria) que a primeira foto, com um número decimal de 0 a 1: 1 = certamente o mesmo produto, " +
    "0.5 = mesma categoria mas modelo/versão incerta ou diferente, 0 = claramente produtos diferentes. " +
    `Responda SOMENTE ${count} número(s) separados por vírgula, na MESMA ordem dos candidatos (do 1 ao ` +
    `${count}), sem texto nenhum antes ou depois. Exemplo com ${count} candidato(s): ${example}`
  );
}

export async function compareProductImagesBatch(
  catalogImageUrl: string,
  candidateImageUrls: string[],
  apiKey: string,
  scraperApiKey?: string
): Promise<(number | null)[]> {
  if (candidateImageUrls.length === 0) return [];

  const catalogUri = await fetchImageAsDataUri(catalogImageUrl, scraperApiKey);
  const results: (number | null)[] = [];

  for (let i = 0; i < candidateImageUrls.length; i += MAX_CANDIDATES_PER_BATCH) {
    const chunk = candidateImageUrls.slice(i, i + MAX_CANDIDATES_PER_BATCH);
    const candidateUris = await Promise.all(chunk.map((url) => fetchImageAsDataUri(url, scraperApiKey)));

    const content: NvidiaContent[] = [
      { type: "text", text: buildBatchComparePrompt(chunk.length) },
      { type: "image_url", image_url: { url: catalogUri } },
      ...candidateUris.map((url): NvidiaImageContent => ({ type: "image_url", image_url: { url } })),
    ];

    const text = await callNvidia(content, apiKey);
    const numbers = text.match(/[\d.]+/g) ?? [];

    if (numbers.length !== chunk.length) {
      // Mesmo tratamento defensivo de mistralVision.ts — contagem que não
      // bate é tratada como lote inteiro "não comparável", não risco de
      // atribuir nota errada a um candidato.
      console.warn(
        `[nvidiaVision] resposta em lote veio com ${numbers.length} nota(s) pra ${chunk.length} candidato(s) — descartando o lote ("${text}").`
      );
      results.push(...chunk.map(() => null));
      continue;
    }

    results.push(...numbers.map((n) => Math.min(1, Math.max(0, Number(n)))));
  }

  return results;
}
