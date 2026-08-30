/**
 * ══════════════════════════════════════════════════════════════════════
 * PONTE COM IA DE VISÃO — motor interno + IA (variante Groq)
 * ══════════════════════════════════════════════════════════════════════
 *
 * Segunda opção de backend de visão pro motor interno + IA (ver
 * visionInternalSearchProvider.ts), ao lado de geminiVision.ts — MESMO
 * contrato de função (`describeProductImage`/`compareProductImages`),
 * pra `searchVisionInternalShared` conseguir plugar qualquer um dos dois
 * sem saber qual é (ver `VisionBackend` naquele arquivo).
 *
 * Por quê Groq como 2ª opção (ago/2026, decisão do produto após relato
 * real de "5+ minutos, só 2 de 68 produtos" com Gemini): o teto real que
 * limitava o Gemini era cota do free tier por MINUTO (RPM) — Groq
 * anuncia RPM mais alto pro modelo de visão usado aqui (30 vs 15 do
 * Gemini flash-lite, ver aistudio.google.com/rate-limit e
 * console.groq.com/docs/rate-limits). Ainda NÃO validado em produção com
 * catálogo real — ver ressalva de TPM abaixo, e o objetivo desta 2ª
 * opção é justamente permitir comparar qualidade/velocidade real lado a
 * lado (mesmo catálogo, trocando só o provider no seletor), não uma
 * promessa de que resolve o gargalo sozinho.
 *
 * ⚠️ Ressalva importante de TPM (tokens/minuto): o modelo usado aqui
 * conta cada IMAGEM como ~2048 tokens de entrada (ver
 * console.groq.com/docs/vision), e o tier gratuito tem TPM = 8.000. Uma
 * comparação (2 fotos) já consome ~4.100 tokens só de imagem — ou seja,
 * na prática cabem uns 2 comparações por minuto antes do TPM (não o RPM)
 * virar o teto real, MESMO com RPM=30 (o dobro do Gemini). Isso é uma
 * ressalva HONESTA, não um problema já resolvido aqui: `compareProductImages`
 * abaixo segue 1 candidato por chamada (mesmo contrato do Gemini, pra
 * comparação de qualidade lado a lado não ficar viesada por formato de
 * prompt diferente). Uma otimização real e ainda NÃO implementada: o
 * modelo aceita até 5 imagens por requisição, então uma chamada só com
 * catálogo + N candidatos (em vez de N chamadas repetindo a foto do
 * catálogo) cortaria o custo de token proporcionalmente — fica como
 * próximo passo se o teste real mostrar que TPM é de fato o gargalo
 * (antes de otimizar, vale medir).
 *
 * Modelo em `qwen/qwen3.6-27b` — verificado ago/2026 em
 * console.groq.com/docs/vision (multimodal, até 5 imagens/requisição,
 * modo "thinking"/"non-thinking", JSON mode). Groq depreca modelo com
 * aviso prévio (ver console.groq.com/docs/deprecations, exemplo real:
 * `llama-4-scout` saiu de linha em jun/2026) — se este endpoint começar a
 * devolver 404/"model decommissioned", troque a constante abaixo
 * consultando a lista atual de "Supported Models" em
 * console.groq.com/docs/vision.
 */

const MODEL = "qwen/qwen3.6-27b";
const ENDPOINT = "https://api.groq.com/openai/v1/chat/completions";

/** Ver REQUEST_TIMEOUT_MS em geminiVision.ts — mesmo raciocínio (teto de 300s da function, vários passos encadeados por item). */
const REQUEST_TIMEOUT_MS = 20000;

/**
 * Teto de segurança pro retry quando o header `retry-after` (ver
 * GroqQuotaExhaustedError) não vier ou vier absurdo — nunca esperamos
 * mais que isso numa function serverless com teto de 300s.
 */
const MAX_RETRY_DELAY_MS = 20000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export class GroqVisionError extends Error {}

/**
 * HTTP 429 (rate limit) — ver GeminiQuotaExhaustedError pro mesmo papel
 * do lado Gemini. `retryAfterMs`, quando presente, vem do header
 * `retry-after` (segundos) que a Groq devolve JUNTO com o 429 — mais
 * preciso que o retry às cegas de 15s fixo usado pro Gemini (que não
 * documenta esse header), então usamos o valor real quando ele vem.
 */
export class GroqQuotaExhaustedError extends GroqVisionError {
  constructor(message: string, public readonly retryAfterMs: number | null) {
    super(message);
  }
}

interface GroqImageContent {
  type: "image_url";
  image_url: { url: string };
}
interface GroqTextContent {
  type: "text";
  text: string;
}
type GroqContent = GroqTextContent | GroqImageContent;

interface GroqResponse {
  choices?: { message?: { content?: string } }[];
  error?: { message?: string; type?: string; code?: string };
}

/** Mesma função de geminiVision.ts, duplicada de propósito (arquivos irmãos, ver comentário no topo) — baixa a imagem e devolve como data URI base64, formato que o `image_url` da Groq aceita pra imagem não hospedada no storage deles. */
async function fetchImageAsDataUri(imageUrl: string): Promise<string> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const response = await fetch(imageUrl, { signal: controller.signal });
    if (!response.ok) {
      throw new GroqVisionError(`Não consegui baixar a imagem (${imageUrl}): HTTP ${response.status}`);
    }
    const mimeType = response.headers.get("content-type")?.split(";")[0] || "image/jpeg";
    const buffer = await response.arrayBuffer();
    const data = Buffer.from(buffer).toString("base64");
    return `data:${mimeType};base64,${data}`;
  } catch (err) {
    if (err instanceof GroqVisionError) throw err;
    if (err instanceof Error && err.name === "AbortError") {
      throw new GroqVisionError(`Baixar a imagem demorou mais que ${REQUEST_TIMEOUT_MS / 1000}s.`);
    }
    throw new GroqVisionError(`Falha ao baixar imagem: ${err instanceof Error ? err.message : String(err)}`);
  } finally {
    clearTimeout(timeout);
  }
}

async function callGroqOnce(content: GroqContent[], apiKey: string): Promise<string> {
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
        // Ver generationConfig em geminiVision.ts — mesmo raciocínio,
        // resposta curta de propósito (frase de busca ou score, nunca
        // texto longo).
        max_completion_tokens: 200,
        temperature: 0.2,
      }),
      signal: controller.signal,
    });

    if (response.status === 429) {
      const retryAfterHeader = response.headers.get("retry-after");
      const retryAfterMs = retryAfterHeader ? Number(retryAfterHeader) * 1000 : null;
      throw new GroqQuotaExhaustedError(
        "Groq sem cota disponível agora (limite de requisições/tokens do tier gratuito, ver " +
          "console.groq.com/settings/limits) — tente novamente em instantes, ou considere o tier pago " +
          "se isso for frequente.",
        Number.isFinite(retryAfterMs) ? retryAfterMs : null
      );
    }

    const data = (await response.json()) as GroqResponse;

    if (!response.ok) {
      throw new GroqVisionError(
        `Groq retornou HTTP ${response.status}${data.error?.message ? `: ${data.error.message}` : ""}`
      );
    }

    const text = data.choices?.[0]?.message?.content?.trim();
    if (!text) throw new GroqVisionError("Groq não devolveu texto na resposta.");
    return text;
  } catch (err) {
    if (err instanceof GroqVisionError) throw err;
    if (err instanceof Error && err.name === "AbortError") {
      throw new GroqVisionError(`Groq não respondeu em ${REQUEST_TIMEOUT_MS / 1000}s (timeout).`);
    }
    throw new GroqVisionError(`Falha ao chamar Groq: ${err instanceof Error ? err.message : String(err)}`);
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Ver QUOTA_RETRY_DELAY_MS/callGemini em geminiVision.ts — mesma ideia
 * (1 retry só, e só pra rate-limit), mas usando o `retry-after` real da
 * Groq quando disponível em vez de um valor fixo chutado.
 */
async function callGroq(content: GroqContent[], apiKey: string): Promise<string> {
  try {
    return await callGroqOnce(content, apiKey);
  } catch (err) {
    if (!(err instanceof GroqQuotaExhaustedError)) throw err;
    const delay = Math.min(err.retryAfterMs ?? MAX_RETRY_DELAY_MS, MAX_RETRY_DELAY_MS);
    console.warn(`[motor-interno+IA/Groq] cota esgotada, aguardando ${Math.round(delay / 1000)}s pra 1 nova tentativa...`);
    await sleep(delay);
    return callGroqOnce(content, apiKey);
  }
}

/** Mesmo critério de DESCRIBE_PROMPT em geminiVision.ts — texto idêntico de propósito, pra comparação de qualidade entre backends não ser contaminada por prompt diferente. */
const DESCRIBE_PROMPT =
  "Você é parte de um sistema de busca de preço. Veja a foto de um produto de catálogo de " +
  "fornecedor e escreva, em português do Brasil, uma frase CURTA (até 8 palavras) que funcione " +
  "como termo de busca numa loja online (tipo Mercado Livre ou Amazon) — categoria do produto, " +
  "cor, material e características visuais distintas. NÃO invente marca/modelo a menos que um " +
  "logotipo real apareça legível na foto. Responda SOMENTE com a frase de busca, sem aspas, sem " +
  "explicação, sem pontuação final.";

/** Ver describeProductImage em geminiVision.ts — mesmo contrato. */
export async function describeProductImage(imageUrl: string, apiKey: string): Promise<string> {
  const dataUri = await fetchImageAsDataUri(imageUrl);
  const text = await callGroq(
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

/** Ver compareProductImages em geminiVision.ts — mesmo contrato (0-1, uma comparação por chamada, ver ressalva de TPM/batch no topo do arquivo). */
export async function compareProductImages(
  catalogImageUrl: string,
  candidateImageUrl: string,
  apiKey: string
): Promise<number> {
  const [catalogUri, candidateUri] = await Promise.all([
    fetchImageAsDataUri(catalogImageUrl),
    fetchImageAsDataUri(candidateImageUrl),
  ]);

  const text = await callGroq(
    [
      { type: "text", text: COMPARE_PROMPT },
      { type: "image_url", image_url: { url: catalogUri } },
      { type: "image_url", image_url: { url: candidateUri } },
    ],
    apiKey
  );

  const value = Number(text.match(/[\d.]+/)?.[0]);
  if (!Number.isFinite(value)) {
    throw new GroqVisionError(`Groq devolveu algo que não é um número de similaridade: "${text}"`);
  }
  return Math.min(1, Math.max(0, value));
}
