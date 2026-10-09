import type { MarketplaceId, SearchProviderId } from "../types";
import { getCurrentIdToken } from "./auth";

/** Espelha AssistantOffer/AssistantContext de api/product-assistant.ts — MANTER EM SINCRONIA. */
export interface AssistantOffer {
  marketplace: MarketplaceId;
  price: number;
  title?: string;
  link?: string;
  competitorCount: number;
  approximate: boolean;
}

export interface AssistantContext {
  query: string;
  offers: AssistantOffer[];
  supplierPrice?: number;
}

export interface ChatTurn {
  role: "user" | "model";
  text: string;
}

export const ASSISTANT_PROVIDERS: { id: SearchProviderId; label: string }[] = [
  { id: "serpapi", label: "Google Shopping (SerpApi) — Amazon + Mercado Livre" },
  { id: "scraperapi", label: "ScraperAPI — Amazon + Mercado Livre" },
  { id: "rapidapi_amazon", label: "Amazon direto (RapidAPI)" },
];

const MAX_SIDE_PX = 1024;

/**
 * Reduz a foto no navegador antes de enviar (lado maior ≤ 1024px, JPEG) —
 * foto de celular passa fácil de 4MB, acima do limite de corpo da
 * function na Vercel, e o modelo não precisa de mais resolução que isso
 * pra reconhecer um produto.
 */
export async function shrinkPhoto(file: File): Promise<{ base64: string; mimeType: string; previewUrl: string }> {
  const bitmap = await createImageBitmap(file);
  const scale = Math.min(1, MAX_SIDE_PX / Math.max(bitmap.width, bitmap.height));
  const canvas = document.createElement("canvas");
  canvas.width = Math.round(bitmap.width * scale);
  canvas.height = Math.round(bitmap.height * scale);
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("Não consegui processar a imagem neste navegador.");
  ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  bitmap.close();
  const dataUrl = canvas.toDataURL("image/jpeg", 0.85);
  return { base64: dataUrl.split(",")[1], mimeType: "image/jpeg", previewUrl: dataUrl };
}

export interface AssistantRequest {
  messages: ChatTurn[];
  context?: AssistantContext | null;
  imageBase64?: string;
  imageMimeType?: string;
  provider?: SearchProviderId;
  supplierPrice?: number;
}

export async function askProductAssistant(
  req: AssistantRequest
): Promise<{ reply: string; context: AssistantContext }> {
  const idToken = await getCurrentIdToken();
  const response = await fetch("/api/product-assistant", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(idToken ? { Authorization: `Bearer ${idToken}` } : {}),
    },
    body: JSON.stringify(req),
  });
  if (!response.ok) {
    let detail = `Assistente falhou (${response.status})`;
    try {
      const body = (await response.json()) as { error?: string; detail?: string };
      detail = body.error || body.detail || detail;
    } catch {
      // corpo não-JSON (ex.: 413 da própria Vercel) — fica a mensagem genérica
    }
    throw new Error(detail);
  }
  return (await response.json()) as { reply: string; context: AssistantContext };
}
