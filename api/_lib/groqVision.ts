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
 * ⚠️ Ressalva de TPM (tokens/minuto) — CONFIRMADA como o gargalo real
 * (ago/2026, relato "testei Groq, não trouxe nenhum resultado"): o
 * modelo usado aqui conta cada IMAGEM como ~2048 tokens de entrada (ver
 * console.groq.com/docs/vision), e o tier gratuito tem TPM = 8.000.
 * `compareProductImages` abaixo é 1 candidato por chamada (mesmo
 * contrato do Gemini) e reenvia a foto do CATÁLOGO inteira a cada
 * chamada — com CANDIDATES_PER_STORE=3 × 2 lojas (ver
 * visionInternalSearchProvider.ts), um produto só já estoura o TPM antes
 * de terminar de processar. `compareProductImagesBatch` (mais abaixo)
 * é o fix: manda catálogo + até 4 candidatos numa chamada só, cortando o
 * reenvio redundante do catálogo — `searchVisionInternalShared` usa essa
 * versão automaticamente quando o backend a implementa (Groq sim, Gemini
 * não, ver VisionBackend). Não elimina o risco de estourar TPM em
 * catálogos grandes (o custo de token dos candidatos em si continua o
 * mesmo), mas reduz o consumo por produto o bastante pra sair do "zero
 * resultado" — ver o comentário completo em compareProductImagesBatch.
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

/**
 * ── Comparação em LOTE (ago/2026, fix do estouro real de TPM do tier gratuito) ──
 * Diagnóstico do relato real "testei Groq, não trouxe nenhum resultado":
 * `compareProductImages` acima é 1 chamada por candidato, e CADA chamada
 * reenvia a foto do CATÁLOGO inteira de novo (2.048 tokens flat/imagem,
 * ver console.groq.com/docs/vision) — com CANDIDATES_PER_STORE=3 (ver
 * visionInternalSearchProvider.ts) × 2 lojas, um produto só já gasta
 * ~6× a foto do catálogo + 6× foto de candidato ≈ 24.500 tokens, MUITO
 * acima do teto de 8.000 TPM do tier gratuito (console.groq.com/docs/
 * rate-limits) — a cota estoura dentro do PRIMEIRO produto do catálogo,
 * antes de qualquer resultado sair. RPM (30, mais folgado que o Gemini)
 * nunca chega a ser o teto real; TPM é.
 *
 * Fix: manda a foto do catálogo UMA VEZ + até MAX_CANDIDATES_PER_BATCH
 * fotos de candidato NA MESMA chamada, em vez de reenviar o catálogo a
 * cada comparação. Não elimina o custo de token das fotos dos candidatos
 * (cada uma ainda conta os 2.048 tokens de sempre), mas corta o reenvio
 * REDUNDANTE do catálogo: 3 candidatos por loja passa de ~4 imagens
 * "efetivas" × 3 chamadas = 12.288 tokens pra 4 imagens × 1 chamada =
 * 8.192 tokens (redução de ~33% só nessa parte). Ainda pode esbarrar no
 * teto de TPM em catálogos grandes/lojas com muito candidato — isso é
 * uma mitigação real, não uma garantia de "nunca mais estoura cota".
 */
const MAX_CANDIDATES_PER_BATCH = 4; // teto de imagens/requisição do modelo (5) menos 1 pra foto do catálogo

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

/**
 * Compara a foto do catálogo com VÁRIOS candidatos numa chamada só — ver
 * comentário acima pro porquê. Devolve um array na MESMA ORDEM de
 * `candidateImageUrls`; `null` numa posição quando a resposta não trouxe
 * nota utilizável pra aquele índice (chamador trata igual a uma
 * comparação isolada que falhou — "não comparável", não erro fatal).
 *
 * Chunka em grupos de até MAX_CANDIDATES_PER_BATCH quando a lista é
 * maior que isso (defensivo — CANDIDATES_PER_STORE de hoje, 3, sempre
 * cabe numa chamada só; isso só entra em ação se esse número mudar no
 * futuro). Erro de COTA (429) em qualquer chunk propaga na hora, mesmo
 * contrato de `compareProductImages` — quem chamou decide o que fazer
 * com os chunks anteriores que já resolveram.
 */
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

    const content: GroqContent[] = [
      { type: "text", text: buildBatchComparePrompt(chunk.length) },
      { type: "image_url", image_url: { url: catalogUri } },
      ...candidateUris.map((url): GroqImageContent => ({ type: "image_url", image_url: { url } })),
    ];

    const text = await callGroq(content, apiKey);
    const numbers = text.match(/[\d.]+/g) ?? [];

    if (numbers.length !== chunk.length) {
      // Contagem não bate com a quantidade de candidatos mandados — não
      // dá pra saber com segurança qual nota é de qual candidato (a IA
      // pode ter pulado um, juntado dois, ou devolvido texto extra que a
      // regex confundiu com número). Mais seguro tratar o CHUNK inteiro
      // como "não comparável" do que arriscar atribuir nota errada.
      console.warn(
        `[groqVision] resposta em lote veio com ${numbers.length} nota(s) pra ${chunk.length} candidato(s) — descartando o lote ("${text}").`
      );
      results.push(...chunk.map(() => null));
      continue;
    }

    results.push(...numbers.map((n) => Math.min(1, Math.max(0, Number(n)))));
  }

  return results;
}
