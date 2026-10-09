import { GEMINI_MODEL, GeminiQuotaExhaustedError, GeminiVisionError } from "./geminiVision.js";

/**
 * Chamadas do Assistente de produto (out/2026, ver api/product-assistant.ts).
 * Separado de geminiVision.ts de propósito: lá o output é travado em 200
 * tokens e temperatura baixa (frase de busca, score numérico); aqui a
 * resposta é texto corrido pro usuário ler, multi-turno.
 */

const ENDPOINT = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`;
const REQUEST_TIMEOUT_MS = 30000;

export interface ChatTurn {
  role: "user" | "model";
  text: string;
}

interface Part {
  text?: string;
  inline_data?: { mime_type: string; data: string };
}

interface GeminiResponse {
  candidates?: { content?: { parts?: { text?: string }[] } }[];
  error?: { message?: string; status?: string };
  promptFeedback?: { blockReason?: string };
}

async function generate(
  apiKey: string,
  contents: { role: "user" | "model"; parts: Part[] }[],
  systemInstruction: string | undefined,
  maxOutputTokens: number
): Promise<string> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const response = await fetch(`${ENDPOINT}?key=${encodeURIComponent(apiKey)}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents,
        ...(systemInstruction ? { systemInstruction: { parts: [{ text: systemInstruction }] } } : {}),
        generationConfig: { maxOutputTokens, temperature: 0.4 },
      }),
      signal: controller.signal,
    });
    const data = (await response.json()) as GeminiResponse;
    if (!response.ok) {
      if (data.error?.status === "RESOURCE_EXHAUSTED") {
        throw new GeminiQuotaExhaustedError(
          "Sua chave Gemini está sem cota agora — tente de novo em alguns minutos."
        );
      }
      throw new GeminiVisionError(
        `Gemini retornou HTTP ${response.status}${data.error?.message ? `: ${data.error.message}` : ""}`
      );
    }
    if (data.promptFeedback?.blockReason) {
      throw new GeminiVisionError(`Gemini recusou responder (${data.promptFeedback.blockReason}).`);
    }
    const text = data.candidates?.[0]?.content?.parts?.map((p) => p.text ?? "").join("").trim();
    if (!text) throw new GeminiVisionError("Gemini não devolveu texto na resposta.");
    return text;
  } catch (err) {
    if (err instanceof GeminiVisionError) throw err;
    if (err instanceof Error && err.name === "AbortError") {
      throw new GeminiVisionError(`Gemini não respondeu em ${REQUEST_TIMEOUT_MS / 1000}s.`);
    }
    throw new GeminiVisionError(`Falha ao chamar Gemini: ${err instanceof Error ? err.message : String(err)}`);
  } finally {
    clearTimeout(timeout);
  }
}

const IDENTIFY_PROMPT =
  "Identifique o produto desta foto pra uma busca de preço em loja online brasileira. Responda " +
  "SOMENTE com um termo de busca curto (até 10 palavras) em português: categoria, características " +
  "visuais distintas e, SÓ se um logotipo/modelo estiver legível na foto, marca e modelo. Sem aspas, " +
  "sem explicação.";

/** Foto enviada pelo usuário (base64, já reduzida no navegador) → termo de busca. */
export async function identifyProductFromPhoto(
  apiKey: string,
  imageBase64: string,
  mimeType: string
): Promise<string> {
  const text = await generate(
    apiKey,
    [{ role: "user", parts: [{ text: IDENTIFY_PROMPT }, { inline_data: { mime_type: mimeType, data: imageBase64 } }] }],
    undefined,
    80
  );
  return text.replace(/^["'“”]+|["'“”.]+$/g, "").trim();
}

/** Conversa com o contexto do produto (descrição + ofertas achadas) injetado como instrução de sistema. */
export async function chatAboutProduct(
  apiKey: string,
  systemInstruction: string,
  turns: ChatTurn[]
): Promise<string> {
  return generate(
    apiKey,
    turns.map((t) => ({ role: t.role, parts: [{ text: t.text }] })),
    systemInstruction,
    800
  );
}
