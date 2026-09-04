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

/**
 * Marcador interno (set/2026): a loja respondeu, mas RECUSOU o download
 * (403/429/503 — bloqueio de bot, não erro de URL). Existe pra separar
 * "essa imagem não existe" de "essa imagem existe e a loja não deixou o
 * servidor pegar", que é o caso em que vale repetir via proxy. Nunca sai
 * daqui: o erro que chega em quem chama continua sendo genérico, pra não
 * virar oráculo de varredura (ver cabeçalho).
 */
class ImageDownloadBlockedError extends UnsafeImageUrlError {
  constructor(readonly status: number) {
    super("Não consegui baixar a imagem.");
  }
}

/**
 * Status que indicam BLOQUEIO (a loja viu a requisição e recusou), não
 * ausência do recurso. 404/410 ficam de fora de propósito: repetir por
 * proxy uma imagem que não existe só queima crédito.
 */
const BLOCKED_STATUSES = new Set([401, 403, 405, 429, 503]);

/**
 * Repete o download por trás da ScraperAPI quando a loja bloqueou o IP da
 * function (set/2026). O vetor era invisível: a foto do anúncio ia direto
 * pro `fetch()`, e quando a Amazon/ML recusava, o candidato ficava sem
 * comparação visual e sumia em silêncio — o sintoma chegava ao usuário
 * como "a IA não confirmou nada", sem nada no log dizendo que o problema
 * tinha sido o download da imagem, não o modelo.
 *
 * Só entra como SEGUNDA tentativa: o caminho direto é gratuito e resolve
 * a maioria dos casos; cada passagem por aqui custa um crédito.
 */
function scraperApiImageUrl(target: string): string | null {
  const key = process.env.SCRAPERAPI_KEY;
  if (!key) return null;
  const proxied = new URL("https://api.scraperapi.com/");
  proxied.searchParams.set("api_key", key);
  proxied.searchParams.set("url", target);
  return proxied.toString();
}

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
 * oráculo de varredura. O detalhe (host + status) vai só pro log do
 * servidor, ver `downloadImage`.
 *
 * Quando a loja BLOQUEIA (403/429/503, ver BLOCKED_STATUSES), repete uma
 * vez via ScraperAPI — ver `scraperApiImageUrl`.
 */
export async function fetchImageWithLimit(
  rawUrl: string,
  signal: AbortSignal
): Promise<{ buffer: Buffer; mimeType: string }> {
  const url = assertFetchableImageUrl(rawUrl);

  try {
    return await downloadImage(rawUrl, signal);
  } catch (err) {
    if (!(err instanceof ImageDownloadBlockedError)) throw err;

    // Foto do próprio app (rota /api/catalog-image) nunca é bloqueada por
    // anti-bot — se ela falhou, o problema é outro, e mandar a URL do
    // nosso storage pra um terceiro não resolveria nada.
    if (url.pathname === CATALOG_IMAGE_PATH) throw err;

    const proxied = scraperApiImageUrl(rawUrl);
    if (!proxied) {
      console.warn(
        `[imagem] ${url.hostname} recusou o download (HTTP ${err.status}) e não há SCRAPERAPI_KEY pra repetir por proxy.`
      );
      throw err;
    }

    console.warn(`[imagem] ${url.hostname} recusou o download (HTTP ${err.status}) — repetindo via ScraperAPI.`);
    try {
      return await downloadImage(proxied, signal);
    } catch (proxyErr) {
      const detail =
        proxyErr instanceof ImageDownloadBlockedError
          ? `HTTP ${proxyErr.status}`
          : proxyErr instanceof Error
            ? proxyErr.message
            : String(proxyErr);
      console.warn(`[imagem] ScraperAPI também não trouxe a imagem de ${url.hostname}: ${detail}`);
      // Erro genérico e ORIGINAL (não o do proxy): quem chama só precisa
      // saber que a imagem não veio.
      throw err;
    }
  }
}

/**
 * Uma tentativa de download, com todas as guardas. Separada de
 * `fetchImageWithLimit` só pra permitir a 2ª tentativa por proxy sem
 * duplicar validação/teto de bytes.
 */
async function downloadImage(
  rawUrl: string,
  signal: AbortSignal
): Promise<{ buffer: Buffer; mimeType: string }> {
  assertFetchableImageUrl(rawUrl);

  const response = await fetch(rawUrl, { signal });

  if (!response.ok) {
    // Instrumentação (set/2026): o status e o HOST ficam no log do
    // servidor — a mensagem que sobe pro chamador continua sem eles. Sem
    // isso não havia como saber se a comparação visual falhava por
    // bloqueio de loja, imagem removida ou erro de rede.
    let hostname = "desconhecido";
    try {
      hostname = new URL(rawUrl).hostname;
    } catch {
      /* URL já validada acima; guarda só por segurança */
    }
    if (BLOCKED_STATUSES.has(response.status)) {
      throw new ImageDownloadBlockedError(response.status);
    }
    console.warn(`[imagem] download de ${hostname} falhou com HTTP ${response.status}.`);
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
