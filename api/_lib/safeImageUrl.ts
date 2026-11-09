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
 * Reforços de nov/2026 (revisão de segurança, ver docs/seguranca-2026-11.md):
 * a foto do catálogo também tem que estar no PRÓPRIO host do app
 * (`isCatalogImageFromThisApp`), o download segue redirecionamento na mão
 * validando cada salto ANTES de requisitá-lo, e a lista de hosts internos
 * cobre CGNAT, TEST-NET, multicast, IPv6 embutido/NAT64 e "localhost.".
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
 * a maioria dos casos; cada passagem por aqui custa um crédito da chave
 * ScraperAPI do PRÓPRIO usuário (BYOK, set/2026 — ver
 * api/_lib/userSecrets.ts).
 */
function scraperApiImageUrl(target: string, scraperApiKey: string | undefined): string | null {
  const key = scraperApiKey?.trim();
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
  /\.localhost$/i,
  /^\[?::1?\]?$/, // loopback (::1) e o endereço não especificado (::)
  /^\[?fc[0-9a-f]{2}:/i, // IPv6 unique local
  /^\[?fd[0-9a-f]{2}:/i,
  /^\[?fe[89ab][0-9a-f]:/i, // IPv6 link-local (fe80::/10)
  /^\[?fe[c-f][0-9a-f]:/i, // IPv6 site-local (descontinuado) e afins
  /^\[?ff[0-9a-f]{2}:/i, // IPv6 multicast
  /^\[?::ffff:/i, // IPv4 embutido em IPv6 (::ffff:127.0.0.1 vira [::ffff:7f00:1] depois de normalizado)
  /^\[?64:ff9b:/i, // NAT64 — também embute IPv4
  /\.internal$/i,
  /\.local$/i,
  /\.lan$/i,
  /\.intranet$/i,
  /\.home\.arpa$/i,
  /^metadata\./i,
];

/**
 * Faixas IPv4 que nunca são destino legítimo de um download de imagem
 * (RFC 1122/1918/3927/5737/6598/2544/5771): "isto", rede privada,
 * CGNAT, loopback, link-local (metadata de nuvem), protocolo, documentação,
 * benchmarking, multicast e reservado.
 */
const PRIVATE_IPV4_RANGES: [number, number, number][] = [
  // [primeiro octeto, segundo octeto mínimo, segundo octeto máximo]
  [0, 0, 255],
  [10, 0, 255],
  [100, 64, 127], // CGNAT 100.64.0.0/10
  [127, 0, 255],
  [169, 254, 254], // link-local — inclui 169.254.169.254
  [172, 16, 31],
  [192, 168, 168],
  [198, 18, 19], // benchmarking 198.18.0.0/15
];

function isPrivateIPv4(hostname: string): boolean {
  const match = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(hostname);
  if (!match) return false;
  const [a, b, c] = [Number(match[1]), Number(match[2]), Number(match[3])];
  if (a >= 224) return true; // multicast (224/4) e reservado (240/4)
  if (a === 192 && b === 0 && (c === 0 || c === 2)) return true; // 192.0.0.0/24 e TEST-NET-1
  if ((a === 198 && b === 51 && c === 100) || (a === 203 && b === 0 && c === 113)) return true; // TEST-NET-2/3
  return PRIVATE_IPV4_RANGES.some(([first, min, max]) => a === first && b >= min && b <= max);
}

function isPrivateHost(rawHostname: string): boolean {
  // "localhost." (ponto final) é o MESMO host que "localhost" — sem tirar o
  // ponto, os padrões acima não pegariam. `URL` já normaliza IPv4 em
  // decimal/hex/octal (2130706433, 0x7f.1) pra forma pontuada.
  const hostname = rawHostname.replace(/\.$/, "");
  return isPrivateIPv4(hostname) || PRIVATE_HOST_PATTERNS.some((pattern) => pattern.test(hostname));
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

  // `https://usuario@host/` não tem uso legítimo aqui e é truque clássico pra
  // fazer um host parecer outro numa checagem feita só no texto da URL.
  if (url.username || url.password) {
    throw new UnsafeImageUrlError("URL de imagem não pode ter usuário ou senha.");
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
 * Hosts (com porta, em minúsculas) que são do PRÓPRIO app, pra travar a foto
 * do catálogo nele (ver `isCatalogImageFromThisApp`): o `Host` que o
 * navegador usou na requisição (é o mesmo `window.location.origin` com que
 * `uploadCatalogImage` monta a URL), o repassado pelo proxy da Vercel e os
 * domínios que a própria Vercel/o dono declaram em variáveis de ambiente.
 */
export function appHostsFromRequest(
  headers: Record<string, string | string[] | undefined> | undefined,
  env: Record<string, string | undefined> = process.env
): Set<string> {
  const hosts = new Set<string>();
  const add = (value: string | undefined) => {
    const trimmed = value?.trim().toLowerCase();
    if (trimmed) hosts.add(trimmed);
  };
  const first = (value: string | string[] | undefined) => (Array.isArray(value) ? value[0] : value);

  add(first(headers?.host));
  add(first(headers?.["x-forwarded-host"])?.split(",")[0]);
  for (const key of ["VERCEL_URL", "VERCEL_BRANCH_URL", "VERCEL_PROJECT_PRODUCTION_URL"]) add(env[key]);
  const base = env.APP_BASE_URL?.trim();
  if (base) {
    try {
      add(new URL(base).host);
    } catch {
      // APP_BASE_URL malformada: ignora, não derruba a validação
    }
  }
  return hosts;
}

/**
 * Além de ser a rota certa (`isSafeCatalogImageUrl`), a foto do catálogo
 * tem que estar hospedada NO PRÓPRIO app. Só checar o caminho deixava o
 * cliente apontar `https://qualquer-host-publico/api/catalog-image` e fazer
 * o servidor baixar de lá — um SSRF pra hosts públicos (e porta de entrada
 * pra DNS rebinding). Lista vazia = não dá pra decidir, então recusa.
 */
export function isCatalogImageFromThisApp(rawUrl: unknown, appHosts: Set<string>): boolean {
  if (!isSafeCatalogImageUrl(rawUrl)) return false;
  return appHosts.has(new URL(rawUrl as string).host.toLowerCase());
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
  signal: AbortSignal,
  scraperApiKey?: string
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

    const proxied = scraperApiImageUrl(rawUrl, scraperApiKey);
    if (!proxied) {
      console.warn(
        `[imagem] ${url.hostname} recusou o download (HTTP ${err.status}) e o usuário não tem chave ScraperAPI própria pra repetir por proxy.`
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

/** Máximo de redirecionamentos seguidos no download — cada salto é revalidado ANTES de ser requisitado. */
const MAX_REDIRECTS = 3;

/**
 * Faz o `fetch` seguindo redirecionamento NA MÃO: cada `Location` passa
 * pela mesma guarda de host/esquema antes de ser requisitado. Deixar o
 * `fetch` seguir sozinho só deixava revalidar o destino FINAL
 * (`response.url`), depois da requisição já ter sido feita — o servidor
 * já teria batido no host interno, mesmo sem devolver o corpo.
 */
async function fetchFollowingSafeRedirects(startUrl: string, signal: AbortSignal): Promise<Response> {
  let current = startUrl;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    assertFetchableImageUrl(current);
    const response = await fetch(current, { signal, redirect: "manual" });
    const isRedirect = response.status >= 300 && response.status < 400 && response.status !== 304;
    if (!isRedirect) return response;

    await response.body?.cancel?.().catch(() => {});
    const location = response.headers?.get("location");
    if (!location) throw new UnsafeImageUrlError("Não consegui baixar a imagem.");
    try {
      current = new URL(location, current).toString();
    } catch {
      throw new UnsafeImageUrlError("Não consegui baixar a imagem.");
    }
  }
  throw new UnsafeImageUrlError("Não consegui baixar a imagem.");
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

  const response = await fetchFollowingSafeRedirects(rawUrl, signal);

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

  // Os redirecionamentos já foram seguidos e validados um a um em
  // `fetchFollowingSafeRedirects`; esta checagem do destino final fica como
  // cinto-e-suspensório (e cobre runtimes que devolvem `response.url`).
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
