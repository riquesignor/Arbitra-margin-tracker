import { createHash, createHmac } from "node:crypto";
import type { AmazonStructuredCandidate } from "./scraperApiSearchProvider.js";

/**
 * AMAZON PRODUCT ADVERTISING API (PA-API) 5.0 — CLIENTE PRÓPRIO (set/2026)
 * ══════════════════════════════════════════════════════════════════════
 * Fonte OFICIAL e GRATUITA (por chamada — sem custo por request, diferente
 * do endpoint estruturado da ScraperAPI, que cobra 5 créditos/busca) de
 * candidatos da Amazon, pedida explicitamente pelo usuário como alternativa
 * a depender só de raspagem de HTML ou de terceiro pago:
 *
 *   Motor interno/IA → raspagem → BLOQUEIA → hoje caía direto pra
 *   ScraperAPI (pago). Com este arquivo, entra um degrau gratuito no meio:
 *   raspagem → PA-API (grátis, 1ª parte) → ScraperAPI (pago, último recurso).
 *
 * ── Gate de negócio, não de código (⚠️ ler antes de configurar) ──────────
 * PA-API exige uma conta ativa no Amazon Associates (afiliados), com
 * REQUISITO CONTÍNUO — não é só cadastro único: pelo menos 3 vendas
 * qualificadas a cada 180 dias, ou o acesso à API é suspenso mesmo depois
 * de aprovado. Isto é decisão de negócio do usuário, não algo que este
 * código resolve sozinho — sem `AMAZON_PAAPI_ACCESS_KEY`/`_SECRET_KEY`/
 * `_PARTNER_TAG` configuradas, a função abaixo devolve `[]` silenciosamente
 * (mesmo padrão "fonte opcional" das outras duas: `fetchAmazonCandidatesForQuery`
 * e `fetchGoogleShoppingCandidatesForQuery`, scraperApiSearchProvider.ts).
 *
 * ── Assinatura AWS Signature Version 4 (SigV4), na mão ────────────────────
 * Sem SDK da AWS (não está no package.json e adicionaria peso só pra isto) —
 * implementado com `node:crypto` puro (createHash/createHmac), seguindo o
 * algoritmo padrão documentado em docs.aws.amazon.com/general/latest/gr/
 * sigv4-signing-process (canonical request → string to sign → chave
 * derivada → assinatura). PA-API 5.0 usa POST com corpo JSON e cinco
 * headers assinados (content-encoding, content-type, host, x-amz-date,
 * x-amz-target) — sem query string nem parâmetros extras, o caso mais
 * simples do algoritmo.
 *
 * ⚠️ Nuance conhecida: o header `host` setado abaixo pode ser descartado
 * silenciosamente pelo `fetch` nativo do Node (undici segue a lista de
 * "forbidden header names" da spec WHATWG, que inclui `host`) — MAS isso
 * não quebra a assinatura, porque o `fetch` sempre define o Host real a
 * partir da própria URL, e aqui a URL aponta pro mesmo host que foi
 * assinado (`HOST` abaixo). Ou seja: mesmo se o header explícito for
 * ignorado, o valor que efetivamente sai na rede bate com o assinado.
 * Mantido explícito mesmo assim por clareza e como salvaguarda caso o
 * runtime mude.
 *
 * ── Região/host por marketplace ────────────────────────────────────────
 * Fixo em `www.amazon.com.br` (único marketplace usado no projeto,
 * mesma escolha de tld="com.br"/country_code="br" já feita em
 * scraperApiSearchProvider.ts). Tabela oficial (docs.aws.amazon.com PA-API
 * 5.0): Brasil = host `webservices.amazon.com.br`, região `us-east-1`.
 *
 * ── Por que sem `reviewCount`/`rating` (deliberado) ────────────────────
 * PA-API 5.0 tem recursos de `CustomerReviews` na doc, mas a disponibilidade
 * por marketplace/conta não é garantida de forma estável o bastante pra
 * arriscar aqui — pedir um `Resources` inválido pra conta devolve ERRO na
 * requisição INTEIRA (não um campo vazio), o que derrubaria a busca de
 * preço/link/foto que É garantida. Mesma cautela já aplicada em
 * `GoogleShoppingStructuredResult` (scraperApiSearchProvider.ts) depois do
 * erro real de campo assumido sem existir em searchApiLensProvider.ts —
 * aqui o risco é maior (a request toda falha, não só o campo fica
 * `undefined`), por isso a lista de `Resources` abaixo fica restrita ao
 * que a doc pública confirma como universal: título, preço, imagem.
 */

const REGION = "us-east-1";
const HOST = "webservices.amazon.com.br";
const PATH = "/paapi5/searchitems";
const ENDPOINT = `https://${HOST}${PATH}`;
const SERVICE = "ProductAdvertisingAPI";
const TARGET = "com.amazon.paapi5.v1.ProductAdvertisingAPIv1.SearchItems";
const MARKETPLACE = "www.amazon.com.br";

/** Mesmo valor/racional de SCRAPERAPI_TIMEOUT_MS (scraperApiSearchProvider.ts) — fonte de fallback não pode ter paciência maior que a raspagem direta que ela substitui. */
const PAAPI_TIMEOUT_MS = 8000;

function hmac(key: Buffer | string, data: string): Buffer {
  return createHmac("sha256", key).update(data, "utf8").digest();
}

function sha256Hex(data: string): string {
  return createHash("sha256").update(data, "utf8").digest("hex");
}

/** Cadeia de derivação de chave do SigV4 — kDate → kRegion → kService → kSigning, padrão AWS. */
function deriveSigningKey(secretKey: string, dateStamp: string, region: string, service: string): Buffer {
  const kDate = hmac(`AWS4${secretKey}`, dateStamp);
  const kRegion = hmac(kDate, region);
  const kService = hmac(kRegion, service);
  return hmac(kService, "aws4_request");
}

interface PaApiPrice {
  Amount?: number;
  DisplayAmount?: string;
}

interface PaApiItem {
  ASIN?: string;
  DetailPageURL?: string;
  Images?: { Primary?: { Medium?: { URL?: string } } };
  ItemInfo?: { Title?: { DisplayValue?: string } };
  Offers?: { Listings?: { Price?: PaApiPrice }[] };
}

interface PaApiSearchResponse {
  SearchResult?: { Items?: PaApiItem[] };
  Errors?: { Code?: string; Message?: string }[];
}

/**
 * Candidatos NATIVOS e OFICIAIS da Amazon via PA-API 5.0 (SearchItems).
 * Mesmo contrato das outras fontes opcionais deste projeto: devolve `[]`
 * (nunca lança) quando não configurado ou a chamada falha — quem chama
 * decide o próximo degrau do fallback (ver `fetchCandidateOffers`,
 * visionInternalSearchProvider.ts).
 */
export async function fetchAmazonPaApiCandidatesForQuery(query: string): Promise<AmazonStructuredCandidate[]> {
  const accessKey = process.env.AMAZON_PAAPI_ACCESS_KEY?.trim();
  const secretKey = process.env.AMAZON_PAAPI_SECRET_KEY?.trim();
  const partnerTag = process.env.AMAZON_PAAPI_PARTNER_TAG?.trim();
  if (!accessKey || !secretKey || !partnerTag) return [];

  const payload = JSON.stringify({
    Keywords: query,
    SearchIndex: "All",
    ItemCount: 5,
    PartnerTag: partnerTag,
    PartnerType: "Associates",
    Marketplace: MARKETPLACE,
    Resources: ["ItemInfo.Title", "Images.Primary.Medium", "Offers.Listings.Price"],
  });

  const now = new Date();
  // Formato exigido pelo SigV4: ISO8601 "básico" (sem separadores) — ex.
  // "20260904T123456Z". `toISOString()` devolve "2026-09-04T12:34:56.789Z";
  // o replace tira "-", ":" e os milissegundos.
  const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, "");
  const dateStamp = amzDate.slice(0, 8);

  const canonicalHeaders =
    `content-encoding:amz-1.0\n` +
    `content-type:application/json; charset=utf-8\n` +
    `host:${HOST}\n` +
    `x-amz-date:${amzDate}\n` +
    `x-amz-target:${TARGET}\n`;
  const signedHeaders = "content-encoding;content-type;host;x-amz-date;x-amz-target";
  const payloadHash = sha256Hex(payload);
  const canonicalRequest = ["POST", PATH, "", canonicalHeaders, signedHeaders, payloadHash].join("\n");

  const credentialScope = `${dateStamp}/${REGION}/${SERVICE}/aws4_request`;
  const stringToSign = ["AWS4-HMAC-SHA256", amzDate, credentialScope, sha256Hex(canonicalRequest)].join("\n");
  const signingKey = deriveSigningKey(secretKey, dateStamp, REGION, SERVICE);
  const signature = createHmac("sha256", signingKey).update(stringToSign, "utf8").digest("hex");

  const authorization =
    `AWS4-HMAC-SHA256 Credential=${accessKey}/${credentialScope}, ` +
    `SignedHeaders=${signedHeaders}, Signature=${signature}`;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), PAAPI_TIMEOUT_MS);
  try {
    const response = await fetch(ENDPOINT, {
      method: "POST",
      headers: {
        "content-encoding": "amz-1.0",
        "content-type": "application/json; charset=utf-8",
        host: HOST,
        "x-amz-date": amzDate,
        "x-amz-target": TARGET,
        authorization,
      },
      body: payload,
      signal: controller.signal,
    });

    if (!response.ok) {
      const body = await response.text().catch(() => "");
      console.warn(`Amazon PA-API (SearchItems) "${query}" retornou ${response.status}: ${body.slice(0, 300)}`);
      return [];
    }

    const data = (await response.json()) as PaApiSearchResponse;
    if (data.Errors?.length) {
      console.warn(
        `Amazon PA-API (SearchItems) "${query}": ${data.Errors.map((e) => e.Message ?? e.Code).join("; ")}`
      );
      return [];
    }

    const candidates: AmazonStructuredCandidate[] = [];
    for (const item of data.SearchResult?.Items ?? []) {
      const price = item.Offers?.Listings?.[0]?.Price?.Amount;
      const title = item.ItemInfo?.Title?.DisplayValue;
      if (price == null || !title) continue;
      candidates.push({
        title,
        price,
        link: item.DetailPageURL,
        thumbnail: item.Images?.Primary?.Medium?.URL,
      });
    }
    return candidates;
  } catch (err) {
    if (err instanceof Error && err.name === "AbortError") {
      console.warn(`Amazon PA-API (SearchItems) não respondeu em ${PAAPI_TIMEOUT_MS / 1000}s (timeout) pra "${query}".`);
    } else {
      console.warn(`Amazon PA-API (SearchItems) falhou pra "${query}":`, err);
    }
    return [];
  } finally {
    clearTimeout(timeout);
  }
}
