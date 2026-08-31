/**
 * ══════════════════════════════════════════════════════════════════════
 * PONTE COM IA DE VISÃO — motor interno + IA (variante Mistral)
 * ══════════════════════════════════════════════════════════════════════
 *
 * Segunda opção de backend de visão pro motor interno + IA (ver
 * visionInternalSearchProvider.ts), ao lado de geminiVision.ts — MESMO
 * contrato de função (`describeProductImage`/`compareProductImages`/
 * `compareProductImagesBatch`), pra `searchVisionInternalShared` conseguir
 * plugar qualquer um dos dois sem saber qual é (ver `VisionBackend`
 * naquele arquivo).
 *
 * SUBSTITUIU o backend Groq (ago/2026, mesmo mês — ver git blame/histórico
 * se groqVision.ts ainda existir no repo). Groq foi a 1ª tentativa de 2º
 * backend, motivada pelo mesmo problema que motiva este arquivo agora:
 * relato real de "5+ minutos, só 2 de 68 produtos" com a cota do Gemini.
 * Groq prometia RPM mais alto, mas na prática o teto real era outro eixo
 * — TPM (tokens/minuto) de só 8.000 no tier gratuito — e mesmo depois de
 * implementar comparação em LOTE (mandar catálogo + N candidatos numa
 * chamada só, cortando o reenvio redundante do catálogo) o relato
 * seguinte foi "não traz nenhum resultado sequer": o teto continuava
 * baixo demais pro padrão de uso daqui (várias comparações visuais por
 * produto, catálogos de dezenas/centenas de itens).
 *
 * Por que Mistral resolve o mesmo problema melhor (ago/2026, verificado em
 * help.mistral.ai/en/articles/225174 e docs.mistral.ai/studio/
 * conversations/vision): tier gratuito ("Experiment", sem cartão) com
 * 1 requisição/SEGUNDO (60/min) + 500.000 tokens/MINUTO + 1 bilhão de
 * tokens/mês — a TPM sozinha é 62× a da Groq. "Comparar imagens" é
 * literalmente um caso de uso oficial listado na doc de vision deles.
 * Ainda assim, implementamos `compareProductImagesBatch` aqui (mesma
 * ideia que não salvou o Groq) por dois motivos: (1) é praticamente grátis
 * de manter — mesmo shape de `VisionBackend`, já provado — e (2) com uma
 * folga de TPM tão maior, o batching aqui deve extinguir o risco de
 * estouro em vez de só mitigá-lo (o inverso do que aconteceu com Groq).
 * Sem validação em catálogo real de centenas de produtos ainda — se
 * aparecer relato de cota estourando de novo, o próximo suspeito é o teto
 * de 1 req/SEGUNDO (concorrência do motor interno já é 1, ver
 * visionInternalSearchProvider.ts > CONCURRENCY, então isso não deveria
 * ser problema), não TPM.
 *
 * Modelo em `ministral-8b-2512` — verificado ago/2026 em
 * docs.mistral.ai/studio/conversations/vision (multimodal, um dos
 * "Recommended Models with Vision Capabilities"). Ministral 8B em vez de
 * Mistral Large/Medium: modelo leve — mais rápido e mais barato por
 * chamada — e a tarefa aqui (descrever produto em 1 frase curta, dar nota
 * de similaridade 0-1) não exige raciocínio pesado. Se a qualidade do
 * match provar insuficiente num teste real, o candidato óbvio pra trocar
 * é `mistral-small-2506` (mesma família "Recommended", mais robusto).
 */

const MODEL = "ministral-8b-2512";
const ENDPOINT = "https://api.mistral.ai/v1/chat/completions";

/** Ver REQUEST_TIMEOUT_MS em geminiVision.ts — mesmo raciocínio (teto de 300s da function, vários passos encadeados por item). */
const REQUEST_TIMEOUT_MS = 20000;

/**
 * Teto de segurança pro retry quando o header `retry-after` (ver
 * MistralQuotaExhaustedError) não vier ou vier absurdo — nunca esperamos
 * mais que isso numa function serverless com teto de 300s.
 */
const MAX_RETRY_DELAY_MS = 20000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export class MistralVisionError extends Error {}

/**
 * HTTP 429 (rate limit) — ver GeminiQuotaExhaustedError pro mesmo papel
 * do lado Gemini. `retryAfterMs`, quando presente, vem do header
 * `retry-after` (segundos) que a Mistral devolve JUNTO com o 429 — mais
 * preciso que o retry às cegas de 15s fixo usado pro Gemini (que não
 * documenta esse header), então usamos o valor real quando ele vem.
 */
export class MistralQuotaExhaustedError extends MistralVisionError {
  constructor(message: string, public readonly retryAfterMs: number | null) {
    super(message);
  }
}

/**
 * Formato de imagem da Mistral é DIFERENTE do padrão OpenAI/Groq
 * (`image_url: { url: string }`) — aqui `image_url` é a própria STRING da
 * URL/data-URI, sem objeto aninhado (confirmado em docs.mistral.ai/studio/
 * conversations/vision, exemplos "Passing an Image URL"/"Passing a Base64
 * Encoded Image"). Atenção se algum dia comparar/copiar código deste
 * arquivo com groqVision.ts — é o detalhe mais fácil de errar entre os
 * dois.
 */
interface MistralImageContent {
  type: "image_url";
  image_url: string;
}
interface MistralTextContent {
  type: "text";
  text: string;
}
type MistralContent = MistralTextContent | MistralImageContent;

interface MistralResponse {
  choices?: { message?: { content?: string } }[];
  message?: string;
}

/** Mesma função de geminiVision.ts/groqVision.ts, duplicada de propósito (arquivos irmãos) — baixa a imagem e devolve como data URI base64, formato que o `image_url` da Mistral aceita pra imagem não hospedada publicamente. */
async function fetchImageAsDataUri(imageUrl: string): Promise<string> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const response = await fetch(imageUrl, { signal: controller.signal });
    if (!response.ok) {
      throw new MistralVisionError(`Não consegui baixar a imagem (${imageUrl}): HTTP ${response.status}`);
    }
    const mimeType = response.headers.get("content-type")?.split(";")[0] || "image/jpeg";
    const buffer = await response.arrayBuffer();
    const data = Buffer.from(buffer).toString("base64");
    return `data:${mimeType};base64,${data}`;
  } catch (err) {
    if (err instanceof MistralVisionError) throw err;
    if (err instanceof Error && err.name === "AbortError") {
      throw new MistralVisionError(`Baixar a imagem demorou mais que ${REQUEST_TIMEOUT_MS / 1000}s.`);
    }
    throw new MistralVisionError(`Falha ao baixar imagem: ${err instanceof Error ? err.message : String(err)}`);
  } finally {
    clearTimeout(timeout);
  }
}

async function callMistralOnce(content: MistralContent[], apiKey: string): Promise<string> {
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
        max_tokens: 200,
        temperature: 0.2,
      }),
      signal: controller.signal,
    });

    if (response.status === 429) {
      const retryAfterHeader = response.headers.get("retry-after");
      const retryAfterMs = retryAfterHeader ? Number(retryAfterHeader) * 1000 : null;
      throw new MistralQuotaExhaustedError(
        "Mistral sem cota disponível agora (limite de requisições/tokens do tier gratuito, ver " +
          "admin.mistral.ai/plateforme/limits) — tente novamente em instantes, ou considere um tier " +
          "pago se isso for frequente.",
        Number.isFinite(retryAfterMs) ? retryAfterMs : null
      );
    }

    const data = (await response.json()) as MistralResponse;

    if (!response.ok) {
      throw new MistralVisionError(`Mistral retornou HTTP ${response.status}${data.message ? `: ${data.message}` : ""}`);
    }

    const text = data.choices?.[0]?.message?.content?.trim();
    if (!text) throw new MistralVisionError("Mistral não devolveu texto na resposta.");
    return text;
  } catch (err) {
    if (err instanceof MistralVisionError) throw err;
    if (err instanceof Error && err.name === "AbortError") {
      throw new MistralVisionError(`Mistral não respondeu em ${REQUEST_TIMEOUT_MS / 1000}s (timeout).`);
    }
    throw new MistralVisionError(`Falha ao chamar Mistral: ${err instanceof Error ? err.message : String(err)}`);
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Ver QUOTA_RETRY_DELAY_MS/callGemini em geminiVision.ts — mesma ideia
 * (1 retry só, e só pra rate-limit), mas usando o `retry-after` real da
 * Mistral quando disponível em vez de um valor fixo chutado.
 */
async function callMistral(content: MistralContent[], apiKey: string): Promise<string> {
  try {
    return await callMistralOnce(content, apiKey);
  } catch (err) {
    if (!(err instanceof MistralQuotaExhaustedError)) throw err;
    const delay = Math.min(err.retryAfterMs ?? MAX_RETRY_DELAY_MS, MAX_RETRY_DELAY_MS);
    console.warn(`[motor-interno+IA/Mistral] cota esgotada, aguardando ${Math.round(delay / 1000)}s pra 1 nova tentativa...`);
    await sleep(delay);
    return callMistralOnce(content, apiKey);
  }
}

/** Mesmo critério de DESCRIBE_PROMPT em geminiVision.ts/groqVision.ts — texto idêntico de propósito, pra comparação de qualidade entre backends não ser contaminada por prompt diferente. */
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
  const text = await callMistral(
    [
      { type: "text", text: DESCRIBE_PROMPT },
      { type: "image_url", image_url: dataUri },
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

/** Ver compareProductImages em geminiVision.ts — mesmo contrato (0-1, uma comparação por chamada). */
export async function compareProductImages(
  catalogImageUrl: string,
  candidateImageUrl: string,
  apiKey: string
): Promise<number> {
  const [catalogUri, candidateUri] = await Promise.all([
    fetchImageAsDataUri(catalogImageUrl),
    fetchImageAsDataUri(candidateImageUrl),
  ]);

  const text = await callMistral(
    [
      { type: "text", text: COMPARE_PROMPT },
      { type: "image_url", image_url: catalogUri },
      { type: "image_url", image_url: candidateUri },
    ],
    apiKey
  );

  const value = Number(text.match(/[\d.]+/)?.[0]);
  if (!Number.isFinite(value)) {
    throw new MistralVisionError(`Mistral devolveu algo que não é um número de similaridade: "${text}"`);
  }
  return Math.min(1, Math.max(0, value));
}

/**
 * ── Comparação em LOTE ──
 * Mesma técnica implementada primeiro pro Groq (mandar catálogo + N
 * candidatos numa chamada só, em vez de reenviar a foto do catálogo a
 * cada comparação) — ver o comentário grande no topo do arquivo pro
 * porquê de manter isso aqui mesmo com folga de TPM bem maior. Devolve um
 * array na MESMA ORDEM de `candidateImageUrls`; `null` numa posição
 * quando a resposta não trouxe nota utilizável pra aquele índice
 * (chamador trata igual a uma comparação isolada que falhou — "não
 * comparável", não erro fatal).
 *
 * Chunka em grupos de até MAX_CANDIDATES_PER_BATCH quando a lista é maior
 * que isso (defensivo — CANDIDATES_PER_STORE de hoje, 3, sempre cabe numa
 * chamada só; isso só entra em ação se esse número mudar no futuro). Foto
 * do catálogo é baixada UMA VEZ só (fora do laço de chunks) e reaproveitada
 * em todos os chunks — nenhum download redundante além do que o próprio
 * batching já evita. Erro de COTA (429) em qualquer chunk propaga na
 * hora, mesmo contrato de `compareProductImages` — quem chamou decide o
 * que fazer com os chunks anteriores que já resolveram.
 */
const MAX_CANDIDATES_PER_BATCH = 7; // teto de imagens/requisição da Mistral (8) menos 1 pra foto do catálogo

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
  apiKey: string
): Promise<(number | null)[]> {
  if (candidateImageUrls.length === 0) return [];

  const catalogUri = await fetchImageAsDataUri(catalogImageUrl);
  const results: (number | null)[] = [];

  for (let i = 0; i < candidateImageUrls.length; i += MAX_CANDIDATES_PER_BATCH) {
    const chunk = candidateImageUrls.slice(i, i + MAX_CANDIDATES_PER_BATCH);
    const candidateUris = await Promise.all(chunk.map((url) => fetchImageAsDataUri(url)));

    const content: MistralContent[] = [
      { type: "text", text: buildBatchComparePrompt(chunk.length) },
      { type: "image_url", image_url: catalogUri },
      ...candidateUris.map((url): MistralImageContent => ({ type: "image_url", image_url: url })),
    ];

    const text = await callMistral(content, apiKey);
    const numbers = text.match(/[\d.]+/g) ?? [];

    if (numbers.length !== chunk.length) {
      // Contagem não bate com a quantidade de candidatos mandados — não
      // dá pra saber com segurança qual nota é de qual candidato (a IA
      // pode ter pulado um, juntado dois, ou devolvido texto extra que a
      // regex confundiu com número). Mais seguro tratar o CHUNK inteiro
      // como "não comparável" do que arriscar atribuir nota errada.
      console.warn(
        `[mistralVision] resposta em lote veio com ${numbers.length} nota(s) pra ${chunk.length} candidato(s) — descartando o lote ("${text}").`
      );
      results.push(...chunk.map(() => null));
      continue;
    }

    results.push(...numbers.map((n) => Math.min(1, Math.max(0, Number(n)))));
  }

  return results;
}
