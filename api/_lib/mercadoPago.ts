import crypto from "node:crypto";

/**
 * Cliente mínimo pra API de assinaturas (Preapproval) do Mercado Pago —
 * cobrança recorrente do fee fixo da plataforma (~R$50/mês, ver
 * config/plans.ts e docs/legal/termos-de-uso.md § 4). Deliberadamente sem
 * SDK oficial (`mercadopago` npm) pra manter o footprint de dependência
 * mínimo — é só um `fetch` com Bearer token, a API é REST simples.
 *
 * IMPORTANTE (não verificado nesta sessão — sem acesso a build/sandbox
 * real): o formato do header `x-signature` e o texto do manifest HMAC
 * seguem a documentação pública do Mercado Pago em "Configurar notificações
 * webhook" (formato `ts=...,v1=...`). Teste no ambiente de sandbox deles
 * antes de ligar em produção — ver README de billing.
 */

const MP_API_BASE = "https://api.mercadopago.com";

function getAccessToken(): string {
  const token = process.env.MERCADOPAGO_ACCESS_TOKEN;
  if (!token) {
    throw new Error(
      "MERCADOPAGO_ACCESS_TOKEN ausente — configure a credencial de produção (ou de teste, no sandbox) da sua conta Mercado Pago."
    );
  }
  return token;
}

function getWebhookSecret(): string {
  const secret = process.env.MERCADOPAGO_WEBHOOK_SECRET;
  if (!secret) {
    throw new Error(
      "MERCADOPAGO_WEBHOOK_SECRET ausente — copie a 'Chave secreta' configurada na notificação webhook do painel do Mercado Pago."
    );
  }
  return secret;
}

/** Preço fixo da plataforma — R$50/mês por padrão, sobrescrevível via env sem precisar de deploy de código. */
export function getPlatformFeeBRL(): number {
  const raw = process.env.MERCADOPAGO_PLAN_PRICE_BRL;
  const parsed = raw ? Number(raw) : NaN;
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 50;
}

function getAppBaseUrl(): string {
  const configured = process.env.APP_BASE_URL;
  if (configured) return configured.replace(/\/+$/, "");
  // Fallback pro domínio que a própria Vercel injeta em cada deploy —
  // não cobre domínio customizado, por isso APP_BASE_URL é a via
  // recomendada em produção (ver .env.example).
  if (process.env.VERCEL_URL) return `https://${process.env.VERCEL_URL}`;
  throw new Error("APP_BASE_URL ausente — defina a URL pública do app (ex.: https://arbitra.seu-dominio.com.br).");
}

export interface PreapprovalResult {
  id: string;
  status: string;
  initPoint: string;
}

/**
 * Cria uma assinatura (preapproval) pendente e devolve a URL de checkout
 * hospedada pelo próprio Mercado Pago (`init_point`) — o front-end só
 * redireciona (`window.location.href = initPoint`), nunca coleta dado de
 * cartão. Isso mantém o Arbitra fora do escopo PCI e sem precisar de
 * allowance de CSP pra SDK de cartão.
 */
export async function createPreapproval(params: {
  uid: string;
  payerEmail?: string;
}): Promise<PreapprovalResult> {
  const baseUrl = getAppBaseUrl();
  const body = {
    reason: "Assinatura Arbitra — plano da plataforma",
    external_reference: params.uid,
    payer_email: params.payerEmail,
    back_url: `${baseUrl}/?billing=retorno`,
    auto_recurring: {
      frequency: 1,
      frequency_type: "months",
      transaction_amount: getPlatformFeeBRL(),
      currency_id: "BRL",
    },
    status: "pending",
  };

  const resp = await fetch(`${MP_API_BASE}/preapproval`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${getAccessToken()}`,
    },
    body: JSON.stringify(body),
  });

  const json = (await resp.json().catch(() => ({}))) as Record<string, unknown>;
  if (!resp.ok) {
    const detail = typeof json.message === "string" ? json.message : JSON.stringify(json);
    throw new Error(`Mercado Pago recusou a criação da assinatura (HTTP ${resp.status}): ${detail}`);
  }

  const id = json.id;
  const initPoint = json.init_point;
  const status = json.status;
  if (typeof id !== "string" || typeof initPoint !== "string" || typeof status !== "string") {
    throw new Error("Resposta inesperada do Mercado Pago ao criar a assinatura (campos ausentes).");
  }
  return { id, status, initPoint };
}

export interface PreapprovalDetails {
  id: string;
  status: string;
  externalReference: string | null;
}

/** Busca o estado atual de uma assinatura — usado pelo webhook pra confirmar o que a notificação alega. */
export async function getPreapproval(preapprovalId: string): Promise<PreapprovalDetails> {
  const resp = await fetch(`${MP_API_BASE}/preapproval/${encodeURIComponent(preapprovalId)}`, {
    headers: { Authorization: `Bearer ${getAccessToken()}` },
  });
  const json = (await resp.json().catch(() => ({}))) as Record<string, unknown>;
  if (!resp.ok) {
    const detail = typeof json.message === "string" ? json.message : JSON.stringify(json);
    throw new Error(`Mercado Pago recusou a consulta da assinatura ${preapprovalId} (HTTP ${resp.status}): ${detail}`);
  }
  const id = json.id;
  const status = json.status;
  const externalReference = json.external_reference;
  if (typeof id !== "string" || typeof status !== "string") {
    throw new Error("Resposta inesperada do Mercado Pago ao consultar a assinatura (campos ausentes).");
  }
  return { id, status, externalReference: typeof externalReference === "string" ? externalReference : null };
}

/**
 * Valida a assinatura HMAC do header `x-signature` (formato
 * `ts=<epoch>,v1=<hex>`) contra o manifest
 * `id:<data.id>;request-id:<x-request-id>;ts:<ts>;`, conforme a doc pública
 * do Mercado Pago pra notificações webhook. Sem isso, qualquer um que
 * descobrisse a URL do webhook poderia forjar "assinatura aprovada" e
 * ganhar o plano pago de graça — equivalente ao P0-3 da auditoria de
 * set/2026 (contador de cota), mas pro lado de billing.
 */
export function verifyWebhookSignature(params: {
  signatureHeader: string | undefined;
  requestId: string | undefined;
  dataId: string;
}): boolean {
  const { signatureHeader, requestId, dataId } = params;
  if (!signatureHeader || !requestId) return false;

  const parts = Object.fromEntries(
    signatureHeader.split(",").map((chunk) => {
      const [key, ...rest] = chunk.split("=");
      return [key.trim(), rest.join("=").trim()];
    })
  );
  const ts = parts.ts;
  const v1 = parts.v1;
  if (!ts || !v1) return false;

  const manifest = `id:${dataId};request-id:${requestId};ts:${ts};`;
  const expected = crypto.createHmac("sha256", getWebhookSecret()).update(manifest).digest("hex");

  // Comparação em tempo constante — evita timing attack pra "adivinhar" o hash.
  const expectedBuf = Buffer.from(expected, "hex");
  const receivedBuf = Buffer.from(v1, "hex");
  if (expectedBuf.length !== receivedBuf.length) return false;
  return crypto.timingSafeEqual(expectedBuf, receivedBuf);
}

/** Status MP que consideramos "plano pago ativo" — o resto (cancelled/paused/expired) volta pro Free. */
export function isActiveSubscriptionStatus(status: string): boolean {
  return status === "authorized";
}
