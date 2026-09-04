/**
 * ══════════════════════════════════════════════════════════════════════
 * GUARDA DE SSRF PRA DOWNLOAD DE IMAGEM NO SERVIDOR
 * ══════════════════════════════════════════════════════════════════════
 *
 * Brecha real corrigida (set/2026, ver docs/auditoria-2026-09.md > P0-2):
 * `item.imageUrl` chega no corpo de POST /api/fetch-prices e ia DIRETO
 * pra um `fetch()` do lado servidor (geminiVision.ts / mistralVision.ts)
 * — sem validar esquema, host nem tamanho. Qualquer conta autenticada
 * conseguia fazer a function serverless buscar `http://169.254.169.254/…`
 * (metadata da nuvem), `http://localhost:…` ou qualquer serviço interno,
 * e a mensagem de erro ainda devolvia o status HTTP recebido — um oráculo
 * de varredura de rede interna.
 *
 * Duas camadas, com níveis de confiança diferentes:
 *
 *   1) `assertCatalogImageUrl` — ESTRITA, pra URL que veio do CLIENTE
 *      (foto do catálogo). Só aceita o formato que o próprio app gera em
 *      `uploadCatalogImage` (src/lib/catalogImages.ts): mesma rota
 *      `/api/catalog-image`, em HTTPS. Usada no ponto de entrada
 *      (api/fetch-prices.ts) — é lá que fica a fronteira de confiança.
 *
 *   2) `assertFetchableImageUrl` — genérica, pra URL que veio da RESPOSTA
 *      de um provider (thumbnail do anúncio na Amazon/ML/Google Shopping).
 *      Essa não é escolhida pelo usuário, mas continua sendo dado externo:
 *      exige HTTPS e recusa host que resolva pra faixa privada/loopback/
 *      link-local escrita literalmente na URL.
 *
 * `fetchImageWithLimit` aplica a camada 2 sempre, recusa redirecionamento
 * pra host privado e corta o download num teto de bytes — sem isso, um
 * host hostil poderia devolver um stream infinito e derrubar a function
 * por memória.
 *
 * O que esta guarda NÃO cobre (aceito conscientemente): DNS rebinding
 * (host público que resolve pra IP privado no momento da conexão). Fechar
 * isso exigiria resolver o DNS na mão e conectar por IP, o que quebra SNI/
 * TLS e CDN — desproporcional pro risco aqui, já que a camada 1 amarra a
 * URL do cliente numa rota fixa do próprio app.
 */

export class UnsafeImageUrlError extends Error {}

/** Teto do download de UMA imagem. Foto de catálogo real sai em ~100-300KB (ver compressForUpload, teto de 700KB antes do base64); thumbnail de marketplace é menor ainda. 8MB é folga de sobra pro caso legítimo e ainda impede um stream sem fim. */
export const MAX_IMAGE_BYTES = 8 * 1024 * 1024;

/** Rota do próprio app que serve a foto do catálogo (ver api/catalog-image.ts e uploadCatalogImage). */
const CATALOG_IMAGE_PATH = "/api/catalog-image";

/**
 * Hosts que nunca devem ser alvo de um fetch do servidor. Cobre o que dá
 * pra decidir olhando só o texto da URL — IP literal em faixa privada,
 * loopback, link-local (metadata de nuvem) e sufixos de rede interna.
 */
const PRIVATE_HOST_PATTERNS: RegExp[] = [
  /^localhost$/i,
  /^127\./,
  /^0\./,
  /^10\./,
  /^192\.168\./,
  /^172\.(1[6-9]|2\d|3[01])\./,
  /^169\.254\./, // link-local — inclui 169.254.169.254 (metadata AWS/GCP/Azure)
  /^\[?::1\]?$/,
  /^\[?fc[0-9a-f]{2}:/i, // IPv6 unique local
  /^\[?fd[0-9a-f]{2}:/i,
  /^\[?fe80:/i, // IPv6 link-local
  /\.internal$/i,
  /\.local$/i,
  /^metadata\./i,
];

function isPrivateHost(hostname: string): boolean {
  return PRIVATE_HOST_PATTERNS.some((pattern) => pattern.test(hostname));
}

/**
 * `vercel dev` local serve em http://localhost:3000 — sem esta exceção,
 * o modo imagem ficaria impossível de testar fora de deploy. Só vale
 * quando NÃO estamos num deploy da Vercel (`VERCEL_ENV` sempre existe lá).
 */
function isLocalDevelopment(): boolean {
  return !process.env.VERCEL_ENV;
}

function parseOrThrow(rawUrl: string): URL {
  try {
    return new URL(rawUrl);
  } catch {
    throw new UnsafeImageUrlError("URL de imagem inválida.");
  }
}

/**
 * Camada 2 (ver topo): esquema + host. Usada em TODO download de imagem
 * do servidor, inclusive thumbnail de anúncio vindo de provider.
 */
export function assertFetchableImageUrl(rawUrl: string): URL {
  const url = parseOrThrow(rawUrl);

  const httpAllowed = url.protocol === "http:" && isLocalDevelopment();
  if (url.protocol !== "https:" && !httpAllowed) {
    throw new UnsafeImageUrlError("URL de imagem precisa ser HTTPS.");
  }

  if (isPrivateHost(url.hostname) && !isLocalDevelopment()) {
    throw new UnsafeImageUrlError("URL de imagem aponta pra um endereço de rede interna.");
  }

  return url;
}

/**
 * Camada 1 (ver topo): a foto do catálogo SÓ pode ser a que o próprio app
 * hospedou. É o que impede a requisição do cliente de escolher livremente
 * o alvo do fetch do servidor.
 */
export function assertCatalogImageUrl(rawUrl: string): URL {
  const url = assertFetchableImageUrl(rawUrl);

  if (url.pathname !== CATALOG_IMAGE_PATH) {
    throw new UnsafeImageUrlError(
      `Foto do catálogo precisa ser servida por ${CATALOG_IMAGE_PATH} (ver uploadCatalogImage).`
    );
  }

  return url;
}

/** `true` se a URL é aceitável como foto de catálogo — versão booleana pra validação de requisição, sem try/catch no chamador. */
export function isSafeCatalogImageUrl(rawUrl: unknown): boolean {
  if (typeof rawUrl !== "string" || !rawUrl.trim()) return false;
  try {
    assertCatalogImageUrl(rawUrl);
    return true;
  } catch {
    return false;
  }
}

/**
 * Baixa uma imagem com todas as guardas: host validado antes e DEPOIS do
 * redirecionamento (`response.url`), teto de bytes e timeout de quem
 * chama (via `signal`). Devolve o buffer cru — quem chama decide se vira
 * base64 puro (Gemini) ou data URI (Mistral).
 *
 * Erros são propositalmente genéricos: não ecoam a URL nem o status HTTP
 * recebido do alvo — era exatamente isso que transformava a falha num
 * oráculo de varredura.
 */
export async function fetchImageWithLimit(
  rawUrl: string,
  signal: AbortSignal
): Promise<{ buffer: Buffer; mimeType: string }> {
  assertFetchableImageUrl(rawUrl);

  const response = await fetch(rawUrl, { signal });

  if (!response.ok) {
    throw new UnsafeImageUrlError("Não consegui baixar a imagem.");
  }

  // Redirecionamento é seguido por padrão pelo fetch — então revalida o
  // host de DESTINO, senão um `https://host-publico/redir?to=…` levaria
  // o download pra rede interna mesmo com a checagem inicial passando.
  if (response.url) {
    assertFetchableImageUrl(response.url);
  }

  const declaredLength = Number(response.headers.get("content-length") ?? "");
  if (Number.isFinite(declaredLength) && declaredLength > MAX_IMAGE_BYTES) {
    throw new UnsafeImageUrlError("Imagem grande demais.");
  }

  const mimeType = response.headers.get("content-type")?.split(";")[0]?.trim() || "image/jpeg";

  const body = response.body as ReadableStream<Uint8Array> | null | undefined;
  if (!body?.getReader) {
    // Sem stream disponível (runtime antigo, ou Response mockado em
    // teste): cai pro caminho simples, ainda com verificação de tamanho
    // depois de baixar — protege memória num segundo momento, não no
    // primeiro, mas é o melhor possível sem stream.
    const buffer = Buffer.from(await response.arrayBuffer());
    if (buffer.byteLength > MAX_IMAGE_BYTES) {
      throw new UnsafeImageUrlError("Imagem grande demais.");
    }
    return { buffer, mimeType };
  }

  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value) continue;

    total += value.byteLength;
    if (total > MAX_IMAGE_BYTES) {
      await reader.cancel().catch(() => {});
      throw new UnsafeImageUrlError("Imagem grande demais.");
    }
    chunks.push(value);
  }

  return { buffer: Buffer.concat(chunks), mimeType };
}
