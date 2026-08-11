/**
 * ══════════════════════════════════════════════════════════════════════
 * PONTE COM IA DE VISÃO — motor interno + IA
 * ══════════════════════════════════════════════════════════════════════
 *
 * Duas chamadas isoladas, cada uma resolvendo UM problema específico do
 * fluxo híbrido (ver visionInternalSearchProvider.ts pra orquestração):
 *
 *   1. `describeProductImage` — a foto do catálogo vira uma frase de
 *      busca. Existe pra catálogo com nome ruim (OCR torto, "Item 42")
 *      onde a única informação confiável é a FOTO — sem isso, não tem
 *      texto usável pra alimentar o motor interno (que só busca por
 *      nome, ver internalSearchProvider.ts).
 *
 *   2. `compareProductImages` — depois que o motor interno acha
 *      candidatos pela descrição, esta função confirma visualmente qual
 *      deles é o produto de verdade, comparando a foto do catálogo com a
 *      foto de cada candidato. Sem isso, a escolha final dependeria só
 *      da qualidade da descrição gerada no passo 1 — um degrau a menos
 *      de confiança que vale a pena fechar com uma segunda chamada.
 *
 * BYOK: usa a chave do PRÓPRIO usuário (Google AI Studio, campo
 * `geminiApiKey`, ver userSecrets.ts) — mesmo padrão SerpApi/RapidAPI/
 * SearchApi.io do resto do app. Vendor escolhido por ser o único com
 * camada gratuita permanente sem cartão (ver comparação feita com o
 * usuário) — mas GRÁTIS aqui é limite de RATE, não "sem chave"; por isso
 * continua BYOK, não vira mecanismo compartilhado sem custo pro usuário
 * configurar. Número exato de req/min e req/dia do tier gratuito varia
 * por modelo e não é publicado de forma confiável na doc pública — quem
 * quiser o valor exato do MOMENTO deve conferir em
 * aistudio.google.com/rate-limit (por projeto, não por chave).
 *
 * Modelo em `gemini-3.1-flash-lite` (trocado de `gemini-2.5-flash-lite`
 * em ago/2026 — a família 2.5 Flash-Lite passou a devolver HTTP 404
 * "no longer available to new users" pra chave nova, ver
 * ai.google.dev/gemini-api/docs/models). "Flash-Lite" continua sendo a
 * família certa pro caso de uso (o objetivo aqui é throughput dentro do
 * free tier, não raciocínio complexo — descrever uma foto de produto e
 * comparar duas fotos são tarefas simples pra qualquer modelo de visão
 * atual), só a versão específica mudou. Se este modelo também for
 * descontinuado no futuro, o sintoma é o MESMO HTTP 404 "no longer
 * available" — troque a constante abaixo consultando a lista atual de
 * modelos "Stable" em ai.google.dev/gemini-api/docs/models.
 */

const MODEL = "gemini-3.1-flash-lite";
const ENDPOINT_BASE = `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent`;

/** Teto de tempo por chamada — função serverless tem limite de execução total, e um lote inteiro depende de várias chamadas em sequência (ver CONCURRENCY em visionInternalSearchProvider.ts). */
const REQUEST_TIMEOUT_MS = 15000;

export class GeminiVisionError extends Error {}

interface GeminiPart {
  text?: string;
  inline_data?: { mime_type: string; data: string };
}

interface GeminiResponse {
  candidates?: { content?: { parts?: { text?: string }[] } }[];
  error?: { message?: string; status?: string };
  promptFeedback?: { blockReason?: string };
}

/**
 * Baixa a imagem e devolve como base64 — a API do Gemini aceita imagem
 * por URL pública em alguns fluxos, mas `inline_data` (base64 direto no
 * payload) é o único jeito documentado e estável pra imagem hospedada
 * fora do Google Cloud Storage, que é exatamente o nosso caso (foto vive
 * no Firestore, servida por `/api/catalog-image`).
 */
async function fetchImageAsBase64(imageUrl: string): Promise<{ data: string; mimeType: string }> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const response = await fetch(imageUrl, { signal: controller.signal });
    if (!response.ok) {
      throw new GeminiVisionError(`Não consegui baixar a imagem (${imageUrl}): HTTP ${response.status}`);
    }
    const mimeType = response.headers.get("content-type")?.split(";")[0] || "image/jpeg";
    const buffer = await response.arrayBuffer();
    // Node/Vercel runtime: Buffer está disponível globalmente, sem import.
    const data = Buffer.from(buffer).toString("base64");
    return { data, mimeType };
  } catch (err) {
    if (err instanceof GeminiVisionError) throw err;
    if (err instanceof Error && err.name === "AbortError") {
      throw new GeminiVisionError(`Baixar a imagem demorou mais que ${REQUEST_TIMEOUT_MS / 1000}s.`);
    }
    throw new GeminiVisionError(`Falha ao baixar imagem: ${err instanceof Error ? err.message : String(err)}`);
  } finally {
    clearTimeout(timeout);
  }
}

async function callGemini(parts: GeminiPart[], apiKey: string): Promise<string> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  try {
    const response = await fetch(`${ENDPOINT_BASE}?key=${encodeURIComponent(apiKey)}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [{ parts }],
        // Resposta curta de propósito — descrição de busca e score de
        // similaridade não precisam de mais que uma frase/número, e
        // manter o output pequeno é o que faz o custo (mesmo no tier
        // pago) ficar em fração de centavo por chamada.
        generationConfig: { maxOutputTokens: 200, temperature: 0.2 },
      }),
      signal: controller.signal,
    });

    const data = (await response.json()) as GeminiResponse;

    if (!response.ok) {
      const status = data.error?.status;
      throw new GeminiVisionError(
        status === "RESOURCE_EXHAUSTED"
          ? "Gemini sem cota disponível agora (limite de requisições do tier gratuito, ver " +
            "aistudio.google.com/rate-limit) — tente novamente em alguns minutos, ou considere " +
            "o tier pago se isso for frequente."
          : `Gemini retornou HTTP ${response.status}${data.error?.message ? `: ${data.error.message}` : ""}`
      );
    }

    if (data.promptFeedback?.blockReason) {
      throw new GeminiVisionError(`Gemini recusou processar a imagem (${data.promptFeedback.blockReason}).`);
    }

    const text = data.candidates?.[0]?.content?.parts?.[0]?.text?.trim();
    if (!text) throw new GeminiVisionError("Gemini não devolveu texto na resposta.");
    return text;
  } catch (err) {
    if (err instanceof GeminiVisionError) throw err;
    if (err instanceof Error && err.name === "AbortError") {
      throw new GeminiVisionError(`Gemini não respondeu em ${REQUEST_TIMEOUT_MS / 1000}s (timeout).`);
    }
    throw new GeminiVisionError(`Falha ao chamar Gemini: ${err instanceof Error ? err.message : String(err)}`);
  } finally {
    clearTimeout(timeout);
  }
}

const DESCRIBE_PROMPT =
  "Você é parte de um sistema de busca de preço. Veja a foto de um produto de catálogo de " +
  "fornecedor e escreva, em português do Brasil, uma frase CURTA (até 8 palavras) que funcione " +
  "como termo de busca numa loja online (tipo Mercado Livre ou Amazon) — categoria do produto, " +
  "cor, material e características visuais distintas. NÃO invente marca/modelo a menos que um " +
  "logotipo real apareça legível na foto. Responda SOMENTE com a frase de busca, sem aspas, sem " +
  "explicação, sem pontuação final.";

/**
 * Foto do catálogo → frase de busca. Ver DESCRIBE_PROMPT pra critério
 * exato (proibido chutar marca sem ver logotipo — inventar marca é pior
 * que não achar nada, faz a busca convergir pro produto errado com
 * confiança falsa).
 */
export async function describeProductImage(imageUrl: string, apiKey: string): Promise<string> {
  const { data, mimeType } = await fetchImageAsBase64(imageUrl);
  const text = await callGemini(
    [{ text: DESCRIBE_PROMPT }, { inline_data: { mime_type: mimeType, data } }],
    apiKey
  );
  // Remove aspas/pontuação que o modelo às vezes devolve mesmo pedindo
  // pra não — texto usado como QUERY de busca, não como exibição, então
  // limpar aqui é mais barato que arriscar um resultado ruim.
  return text.replace(/^["'“”]+|["'“”.]+$/g, "").trim();
}

const COMPARE_PROMPT =
  "Você é parte de um sistema de busca de preço. Estas são DUAS fotos: a primeira é de um " +
  "catálogo de fornecedor, a segunda é de um anúncio encontrado numa loja online. Elas mostram O " +
  "MESMO PRODUTO (mesmo modelo, não só a mesma categoria)? Responda SOMENTE com um número decimal " +
  "de 0 a 1: 1 = certamente o mesmo produto, 0.5 = mesma categoria mas modelo/versão incerta ou " +
  "diferente, 0 = claramente produtos diferentes. Responda só o número, sem texto.";

/**
 * Compara a foto do catálogo com a foto de UM candidato achado pelo
 * motor interno — devolve 0-1. Chamada isolada por candidato (não em
 * lote) de propósito: mensagem de erro/timeout fica localizada num
 * candidato só, os outros continuam sendo avaliados normalmente (ver
 * comportamento em visionInternalSearchProvider.ts, que trata falha de
 * comparação como "esse candidato não pôde ser confirmado", não como
 * erro sistêmico).
 */
export async function compareProductImages(
  catalogImageUrl: string,
  candidateImageUrl: string,
  apiKey: string
): Promise<number> {
  const [catalogImage, candidateImage] = await Promise.all([
    fetchImageAsBase64(catalogImageUrl),
    fetchImageAsBase64(candidateImageUrl),
  ]);

  const text = await callGemini(
    [
      { text: COMPARE_PROMPT },
      { inline_data: { mime_type: catalogImage.mimeType, data: catalogImage.data } },
      { inline_data: { mime_type: candidateImage.mimeType, data: candidateImage.data } },
    ],
    apiKey
  );

  const value = Number(text.match(/[\d.]+/)?.[0]);
  if (!Number.isFinite(value)) {
    throw new GeminiVisionError(`Gemini devolveu algo que não é um número de similaridade: "${text}"`);
  }
  return Math.min(1, Math.max(0, value));
}
