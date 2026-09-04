import type { MarketplaceId } from "../types.js";
import { mapWithConcurrency } from "../concurrency.js";
import type { MarketplaceMatcher } from "./googleShoppingProvider.js";

/**
 * ══════════════════════════════════════════════════════════════════════
 * MOTOR DE BUSCA INTERNO — sem intermediário pago
 * ══════════════════════════════════════════════════════════════════════
 *
 * Lê o preço direto da página de resultado de busca de cada loja
 * (Mercado Livre e Amazon BR), sem SerpApi, sem RapidAPI, sem chave
 * nenhuma. Raspagem "nossa" — custo marginal por busca ZERO. Único
 * consumidor hoje é `fetchStoreOffers` (usado pelo motor interno + IA,
 * ver visionInternalSearchProvider.ts) — a rota de busca por TEXTO puro
 * sem IA (`searchInternalShared`) foi removida daqui (ago/2026, decisão
 * de produto pós teste A/B), mas a raspagem em si segue sendo a base do
 * "motor interno".
 *
 * ── Por que ir direto na loja e não replicar o Google Shopping ───────
 * Raspar o Google Shopping por conta própria trocaria "pagar a SerpApi"
 * por "brigar com o anti-bot do Google" — o mais agressivo que existe —
 * e ainda manteria a dependência do índice deles. Indo direto na loja,
 * o alvo é específico, o resultado já sai focado nos marketplaces que a
 * Arbitra usa, e não existe um terceiro no meio.
 *
 * ── Diferença de custo/tempo vs o provider compartilhado ─────────────
 * `searchGoogleShoppingShared` faz UMA chamada por produto e reparte
 * entre os marketplaces (o Google já agrega as lojas). Aqui não tem
 * agregador: cada loja é um site diferente, então o custo é
 * `nº de produtos × nº de lojas` requisições. Não custa dinheiro, mas
 * custa TEMPO — daí a concorrência controlada e o timeout por
 * requisição mais abaixo (função serverless tem teto de execução).
 *
 * ── ⚠️ O risco real deste provider (leia antes de mexer) ─────────────
 * Loja não publica contrato de API pra isso: o HTML PODE mudar sem
 * aviso, e aí o parser para de achar produto. Duas defesas foram
 * construídas de propósito:
 *
 *   1. `detectBlock` separa "fui bloqueado" de "não achei o produto".
 *      São problemas completamente diferentes (um é infra, outro é
 *      catálogo) e mostrá-los como a mesma coisa — "nenhum resultado" —
 *      esconde exatamente a informação que o operador precisa.
 *   2. Os parsers são funções PURAS e exportadas, testadas contra
 *      fixture de HTML (ver internalSearchProvider.test.ts). Quando o
 *      layout mudar, o teste quebra primeiro e o conserto é local — não
 *      é preciso reproduzir uma busca real pra descobrir o que quebrou.
 *
 * A estratégia de parse é em CAMADAS, da mais estável pra menos:
 * JSON-LD (padrão web, usado pelas lojas pra SEO — muda pouco) →
 * marcadores de card do design system da loja → nada. Se a primeira
 * camada funcionar, as outras nem rodam.
 *
 * ── Rodando de função serverless ────────────────────────────────────
 * Decisão consciente (fase 1): tentar direto do IP da Vercel, sem
 * proxy. IP de datacenter é justamente o que anti-bot bloqueia
 * primeiro, então isto PODE não funcionar em produção — e é por isso
 * que o erro de bloqueio é explícito e acionável em vez de genérico.
 * O ponto de injeção de proxy é único (`fetchStoreHtml`), então plugar
 * um depois não exige reescrever parser nem provider.
 */

/**
 * Concorrência menor que a dos providers de API (que usam 2-3 contra um
 * endpoint feito pra receber tráfego automatizado). Aqui são páginas de
 * loja: rajada de requisição simultânea do mesmo IP é o padrão mais
 * óbvio de bot. 2 é lento de propósito.
 */
const CONCURRENCY = 2;

/** Teto por requisição. Função serverless tem limite de execução total — uma loja lenta não pode consumir o orçamento inteiro do lote e derrubar produtos que buscariam bem. */
const REQUEST_TIMEOUT_MS = 8000;

/**
 * Retry com backoff SÓ pra HTTP 503 (ago/2026 — motivado por relato real:
 * catálogo com motor interno + IA devolvendo lote inteiro em branco,
 * log da function cheio de "Amazon devolveu HTTP 503"). 503 costuma ser
 * bloqueio anti-bot TRANSITÓRIO/rate-limit momentâneo — o mesmo IP,
 * poucos segundos depois, muitas vezes já não é mais barrado.
 *
 * 403 e CAPTCHA são bloqueio EXPLÍCITO: o IP já foi marcado como
 * automatizado, e a resposta não muda em segundos — insistir nesses só
 * queima o orçamento de execução da function sem chance real de
 * sucesso. Por isso só 503 entra no retry; os demais motivos de bloqueio
 * continuam falhando na 1ª tentativa, comportamento de antes.
 *
 * Não elimina o bloqueio (ver comentário "risco real" no topo do
 * arquivo) — só recupera parte dos casos em que o anti-bot foi
 * momentâneo, sem custo nenhum. Bloqueio persistente continua exigindo
 * proxy ou outro provider pra essa loja.
 */
const RETRY_ON_503_ATTEMPTS = 2; // tentativas EXTRAS, além da primeira
const RETRY_ON_503_BASE_DELAY_MS = 700;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Só os primeiros resultados interessam — página de busca traz dezenas, e os do fim são cada vez menos relevantes. Também limita o custo de parse de um HTML grande. */
const MAX_OFFERS_PER_STORE = 12;

/**
 * Cabeçalhos de navegador real. Não é "disfarce" — é o mínimo pra a
 * loja servir a página de busca normal: sem `User-Agent` e
 * `Accept-Language` plausíveis, muitos sites devolvem uma versão
 * degradada, um redirect de idioma, ou um desafio.
 *
 * `Accept-Encoding` NÃO é definido de propósito: deixar o runtime
 * negociar a compressão evita receber bytes comprimidos que o `.text()`
 * não sabe descomprimir (bug clássico e silencioso — vira "HTML vazio"
 * que parece bloqueio, mas não é).
 */
const BROWSER_HEADERS: Record<string, string> = {
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
  Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
  "Accept-Language": "pt-BR,pt;q=0.9,en-US;q=0.8,en;q=0.7",
  "Upgrade-Insecure-Requests": "1",
  "Sec-Fetch-Dest": "document",
  "Sec-Fetch-Mode": "navigate",
  "Sec-Fetch-Site": "none",
  "Sec-Fetch-User": "?1",
};

/**
 * Chave do ScraperAPI (ago/2026) — proxy que bypassa o anti-bot que
 * bloqueava Amazon/Mercado Livre direto do IP de datacenter da Vercel
 * (ver "risco real" no topo do arquivo, que já previa exatamente essa
 * troca).
 *
 * BYOK (set/2026, virou igual a Gemini/SerpApi/RapidAPI/SearchApi.io —
 * antes era secret de servidor, uma chave só da plataforma pagando por
 * TODO mundo). Motivo da virada: com a Arbitra pensada pra comercializar
 * pra qualquer pessoa acessar, uma chave compartilhada não escala — cada
 * usuário passa a cadastrar a própria em Conta
 * (`users/{uid}/secrets/keys.scraperApiKey`, ver userSecrets.ts nos dois
 * lados) e o parâmetro `scraperApiKey` abaixo chega já resolvido pelo
 * servidor a partir do uid autenticado, nunca de `process.env` nem do
 * corpo da requisição.
 *
 * Sem chave cadastrada pelo usuário, `fetchStoreHtmlOnce` cai pro `fetch`
 * direto de sempre — mesmo comportamento de antes de existir proxy
 * nenhum, só que agora por FALTA de BYOK, não por falta de variável de
 * ambiente.
 */
const SCRAPERAPI_ENDPOINT = "https://api.scraperapi.com/";

/**
 * Bloqueio/desafio da loja — categoria de erro DIFERENTE de "não achei
 * o produto". Existe como classe própria pra `fetchStoreOffers` poder
 * propagar uma mensagem acionável ("o IP foi bloqueado, use outro
 * provider ou configure proxy") em vez de deixar o usuário achando que
 * o catálogo dele é que está ruim.
 */
export class StoreBlockedError extends Error {
  constructor(
    message: string,
    readonly marketplace: MarketplaceId
  ) {
    super(message);
    this.name = "StoreBlockedError";
  }
}

/** Uma oferta encontrada na página de busca da loja, já normalizada — é o que os parsers devolvem, independente de qual loja/estratégia produziu. */
export interface ScrapedOffer {
  title: string;
  price: number;
  link?: string;
  thumbnail?: string;
  /** Sinal de popularidade quando a loja expõe (avaliações na Amazon, vendas no ML) — alimenta `popularityScore`, ver rankCandidates.ts. */
  reviewCount?: number;
  rating?: number;
}

// ── Utilitários de parse ─────────────────────────────────────────────

/** Entidades HTML mais comuns em título/preço de loja BR. Parser de HTML completo seria peso desnecessário aqui — só estes aparecem no texto que a gente extrai. */
function decodeHtmlEntities(text: string): string {
  return text
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;|&apos;/g, "'")
    .replace(/&nbsp;/g, " ")
    .replace(/&#(\d+);/g, (_, code: string) => String.fromCharCode(Number(code)))
    .replace(/&#x([0-9a-f]+);/gi, (_, code: string) => String.fromCharCode(parseInt(code, 16)));
}

function stripTags(html: string): string {
  return decodeHtmlEntities(html.replace(/<[^>]*>/g, " "))
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Preço em formato brasileiro ("R$ 1.234,56", "1.234", "99,90") pra
 * número. Ponto é SEMPRE separador de milhar aqui e vírgula sempre
 * decimal — diferente de `parseMoney` do rapidApiAmazonProvider.ts, que
 * precisa lidar com os dois formatos (a API dele pode devolver en-US).
 * Estas páginas são as versões .com.br, sempre pt-BR.
 */
export function parseBrazilianPrice(raw: string | null | undefined): number | null {
  if (!raw) return null;
  const cleaned = raw.replace(/[^\d.,]/g, "");
  if (!cleaned) return null;

  const normalized = cleaned.replace(/\./g, "").replace(",", ".");
  const value = Number(normalized);
  if (!Number.isFinite(value) || value <= 0) return null;
  return value;
}

/**
 * Camada 1 do parse: blocos `application/ld+json`. É a camada preferida
 * porque JSON-LD é padrão web público (schema.org) que as lojas mantêm
 * pro Google indexar — muda MUITO menos que classe de CSS, que troca a
 * cada redesign. Quando existe, é dado estruturado de verdade, não
 * texto raspado.
 */
export function parseJsonLdOffers(html: string): ScrapedOffer[] {
  const offers: ScrapedOffer[] = [];
  const blockPattern = /<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;

  let match: RegExpExecArray | null;
  while ((match = blockPattern.exec(html)) !== null) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(match[1].trim());
    } catch {
      // JSON-LD malformado é comum e não é motivo pra abortar o parse
      // inteiro — só ignora este bloco e tenta o próximo.
      continue;
    }
    collectJsonLdProducts(parsed, offers);
  }

  return offers;
}

interface JsonLdNode {
  "@type"?: string | string[];
  name?: string;
  url?: string;
  image?: string | string[] | { url?: string };
  offers?: JsonLdNode | JsonLdNode[];
  price?: string | number;
  lowPrice?: string | number;
  itemListElement?: unknown;
  item?: unknown;
  aggregateRating?: { ratingValue?: string | number; reviewCount?: string | number; ratingCount?: string | number };
  "@graph"?: unknown;
}

function hasType(node: JsonLdNode, type: string): boolean {
  const raw = node["@type"];
  if (!raw) return false;
  return Array.isArray(raw) ? raw.includes(type) : raw === type;
}

function firstImage(image: JsonLdNode["image"]): string | undefined {
  if (!image) return undefined;
  if (typeof image === "string") return image;
  if (Array.isArray(image)) return typeof image[0] === "string" ? image[0] : undefined;
  return image.url;
}

/** Percorre a árvore do JSON-LD (que pode vir como ItemList, @graph, ou array solto) juntando tudo que for Product com preço. */
function collectJsonLdProducts(node: unknown, out: ScrapedOffer[]): void {
  if (!node || typeof node !== "object") return;

  if (Array.isArray(node)) {
    for (const child of node) collectJsonLdProducts(child, out);
    return;
  }

  const typed = node as JsonLdNode;

  if (typed["@graph"]) collectJsonLdProducts(typed["@graph"], out);
  if (typed.itemListElement) collectJsonLdProducts(typed.itemListElement, out);
  if (typed.item) collectJsonLdProducts(typed.item, out);

  if (hasType(typed, "Product") && typed.name) {
    const offerNode = Array.isArray(typed.offers) ? typed.offers[0] : typed.offers;
    const rawPrice = offerNode?.price ?? offerNode?.lowPrice;
    const price =
      typeof rawPrice === "number" ? rawPrice : parseBrazilianPrice(rawPrice ? String(rawPrice) : null);

    // Preço em JSON-LD costuma vir no formato "1234.56" (padrão
    // schema.org, ponto decimal), NÃO no formato brasileiro — por isso a
    // tentativa direta com Number antes de cair no parser pt-BR.
    const numericPrice =
      typeof rawPrice === "string" && /^\d+(\.\d+)?$/.test(rawPrice) ? Number(rawPrice) : price;

    if (numericPrice != null && numericPrice > 0) {
      const rating = typed.aggregateRating?.ratingValue;
      const reviews = typed.aggregateRating?.reviewCount ?? typed.aggregateRating?.ratingCount;
      out.push({
        title: decodeHtmlEntities(typed.name),
        price: numericPrice,
        link: typed.url ?? offerNode?.url,
        thumbnail: firstImage(typed.image),
        rating: rating != null ? Number(rating) : undefined,
        reviewCount: reviews != null ? Number(reviews) : undefined,
      });
    }
  }
}

// ── Mercado Livre ────────────────────────────────────────────────────

/**
 * Slug de busca do Mercado Livre. A URL de busca deles é baseada em
 * caminho (`lista.mercadolivre.com.br/termo-de-busca`), não em query
 * string — acento e caractere especial precisam sair, senão o ML
 * redireciona ou devolve 404.
 */
export function buildMercadoLivreSearchUrl(query: string): string {
  const slug = query
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9\s-]/g, " ")
    .trim()
    .replace(/\s+/g, "-")
    .slice(0, 120);
  return `https://lista.mercadolivre.com.br/${encodeURIComponent(slug)}`;
}

/**
 * Camada 2 pro Mercado Livre: marcadores do design system deles
 * ("Andes" — as classes `andes-money-amount__*` e `poly-component__*`).
 * São bem mais estáveis que classe utilitária gerada, porque fazem parte
 * de uma biblioteca de componentes versionada e usada no site inteiro,
 * não de uma página específica.
 *
 * O preço no ML vem QUEBRADO em dois elementos (parte inteira em
 * `__fraction`, centavos em `__cents`) — juntar os dois é obrigatório,
 * senão "R$ 1.299,90" vira 1299 ou, pior, 90.
 */
export function parseMercadoLivreHtml(html: string): ScrapedOffer[] {
  const fromJsonLd = parseJsonLdOffers(html);
  if (fromJsonLd.length > 0) return fromJsonLd.slice(0, MAX_OFFERS_PER_STORE);

  const offers: ScrapedOffer[] = [];

  // O título é âncora melhor que o container do card: o container mudou
  // de nome várias vezes (ui-search-layout__item → poly-card), mas o
  // link do título sempre existe e sempre precede o preço no card.
  const titlePattern =
    /<a[^>]+class="[^"]*(?:poly-component__title|ui-search-item__group__element\s+ui-search-link|ui-search-link)[^"]*"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi;

  const matches: { link: string; title: string; index: number }[] = [];
  let match: RegExpExecArray | null;
  while ((match = titlePattern.exec(html)) !== null) {
    const title = stripTags(match[2]);
    if (title) matches.push({ link: decodeHtmlEntities(match[1]), title, index: match.index });
  }

  for (let i = 0; i < matches.length && offers.length < MAX_OFFERS_PER_STORE; i++) {
    // Janela pra frente = do título atual até o próximo. É onde ficam
    // preço e "vendidos" — pegar o primeiro preço evita capturar o
    // "de/por" riscado do card seguinte.
    const windowEnd = i + 1 < matches.length ? matches[i + 1].index : html.length;
    const chunk = html.slice(matches[i].index, windowEnd);

    const price = extractMercadoLivrePrice(chunk);
    if (price == null) continue;

    // ⚠️ A FOTO fica ANTES do título no card do ML (ordem real do DOM:
    // <img> → <h3><a título></h3> → preço). Procurar pra frente pegava a
    // foto do PRÓXIMO produto — bug pego pelo teste de fixture, e do tipo
    // mais perigoso possível: não quebra nada, só mostra a imagem errada
    // ao lado do preço certo. Por isso a busca é pra TRÁS, do título
    // anterior até este, ficando com a última imagem do trecho.
    const backStart = i > 0 ? matches[i - 1].index : 0;
    const beforeChunk = html.slice(backStart, matches[i].index);

    offers.push({
      title: matches[i].title,
      price,
      link: matches[i].link,
      // Fallback pra frente cobre layout em que a foto venha depois do
      // título (variação de grid/lista do próprio ML).
      thumbnail: extractLastImageSrc(beforeChunk) ?? extractFirstImageSrc(chunk),
      reviewCount: extractMercadoLivreSoldCount(chunk),
    });
  }

  return offers;
}

function extractMercadoLivrePrice(chunk: string): number | null {
  const fraction = /<span[^>]*class="[^"]*andes-money-amount__fraction[^"]*"[^>]*>([\s\S]*?)<\/span>/i.exec(
    chunk
  );
  if (!fraction) return null;

  const cents = /<span[^>]*class="[^"]*andes-money-amount__cents[^"]*"[^>]*>([\s\S]*?)<\/span>/i.exec(chunk);
  const whole = stripTags(fraction[1]).replace(/\./g, "");
  const centsText = cents ? stripTags(cents[1]).replace(/\D/g, "") : "";

  const value = Number(centsText ? `${whole}.${centsText.padEnd(2, "0").slice(0, 2)}` : whole);
  return Number.isFinite(value) && value > 0 ? value : null;
}

/** "+1000 vendidos" / "50 vendidos" — sinal de popularidade do ML (equivalente a nº de avaliações na Amazon). Ver popularityScore em rankCandidates.ts. */
function extractMercadoLivreSoldCount(chunk: string): number | undefined {
  const text = stripTags(chunk);
  const match = /(\+?\s*[\d.]+)\s*(?:mil\s*)?vendido/i.exec(text);
  if (!match) return undefined;

  const digits = match[1].replace(/[^\d]/g, "");
  if (!digits) return undefined;
  const value = Number(digits);
  if (!Number.isFinite(value)) return undefined;
  return /mil/i.test(match[0]) ? value * 1000 : value;
}

// ── Amazon BR ────────────────────────────────────────────────────────

export function buildAmazonSearchUrl(query: string): string {
  const url = new URL("https://www.amazon.com.br/s");
  url.searchParams.set("k", query.slice(0, 200));
  // Restringe ao catálogo BR e evita a página de "resultados
  // internacionais", que traz preço em outra moeda.
  url.searchParams.set("__mk_pt_BR", "ÅMÅŽÕÑ");
  return url.toString();
}

/**
 * Camada 2 pra Amazon: `data-component-type="s-search-result"` e
 * `class="a-offscreen"`. São dos marcadores mais estáveis da web —
 * existem há anos porque a Amazon os usa pra acessibilidade e
 * instrumentação própria, não pra estilo (o que os torna caros de
 * renomear).
 *
 * `a-offscreen` é onde mora o preço COMPLETO e formatado ("R$ 1.299,90")
 * — o preço visível na tela é montado em pedaços (símbolo, inteiro,
 * centavos em `<sup>`) e raspar dali dá erro de centavos com facilidade.
 */
export function parseAmazonHtml(html: string): ScrapedOffer[] {
  const offers: ScrapedOffer[] = [];

  // Cada card de resultado começa num elemento com data-asin preenchido
  // (ASIN = id do produto na Amazon). data-asin vazio aparece em
  // separadores/banners — por isso o `[A-Z0-9]{6,}` em vez de `[^"]*`.
  const cardPattern = /data-asin="([A-Z0-9]{6,})"/gi;
  const positions: { asin: string; index: number }[] = [];
  let match: RegExpExecArray | null;
  while ((match = cardPattern.exec(html)) !== null) {
    positions.push({ asin: match[1], index: match.index });
  }

  const seenAsins = new Set<string>();

  for (let i = 0; i < positions.length && offers.length < MAX_OFFERS_PER_STORE; i++) {
    const { asin, index } = positions[i];
    // O mesmo ASIN aparece mais de uma vez (card + carrossel de
    // patrocinado) — a primeira ocorrência é a do resultado orgânico.
    if (seenAsins.has(asin)) continue;

    const end = i + 1 < positions.length ? positions[i + 1].index : html.length;
    const chunk = html.slice(index, end);

    const priceMatch = /<span[^>]*class="[^"]*a-offscreen[^"]*"[^>]*>([\s\S]*?)<\/span>/i.exec(chunk);
    const price = parseBrazilianPrice(priceMatch ? stripTags(priceMatch[1]) : null);
    if (price == null) continue;

    const title = extractAmazonTitle(chunk);
    if (!title) continue;

    seenAsins.add(asin);
    offers.push({
      title,
      price,
      link: `https://www.amazon.com.br/dp/${asin}`,
      thumbnail: extractAmazonImage(chunk),
      rating: extractAmazonRating(chunk),
      reviewCount: extractAmazonReviewCount(chunk),
    });
  }

  return offers;
}

function extractAmazonTitle(chunk: string): string | null {
  // Layout atual: <h2 ...><span>Título</span></h2>. Layouts anteriores
  // colocavam o texto direto no <h2> ou num aria-label — as três formas
  // são tentadas em ordem, da mais recente pra mais antiga.
  const h2 = /<h2[^>]*>([\s\S]*?)<\/h2>/i.exec(chunk);
  if (h2) {
    const inner = stripTags(h2[1]);
    if (inner) return inner;
  }

  const ariaLabel = /<h2[^>]*aria-label="([^"]+)"/i.exec(chunk);
  if (ariaLabel) return decodeHtmlEntities(ariaLabel[1]);

  const titleSpan = /<span[^>]*class="[^"]*a-text-normal[^"]*"[^>]*>([\s\S]*?)<\/span>/i.exec(chunk);
  return titleSpan ? stripTags(titleSpan[1]) || null : null;
}

function extractAmazonImage(chunk: string): string | undefined {
  const match = /<img[^>]*class="[^"]*s-image[^"]*"[^>]*src="([^"]+)"/i.exec(chunk);
  return match ? decodeHtmlEntities(match[1]) : extractFirstImageSrc(chunk);
}

/** "4,5 de 5 estrelas" (pt-BR) — a nota vem com vírgula decimal no domínio brasileiro. */
function extractAmazonRating(chunk: string): number | undefined {
  const match = /(\d+[.,]\d+)\s*de\s*5\s*estrelas/i.exec(stripTags(chunk));
  if (!match) return undefined;
  const value = Number(match[1].replace(",", "."));
  return Number.isFinite(value) ? value : undefined;
}

function extractAmazonReviewCount(chunk: string): number | undefined {
  const match = /aria-label="([\d.]+)\s*(?:avalia|classifica)/i.exec(chunk);
  if (!match) return undefined;
  const value = Number(match[1].replace(/\./g, ""));
  return Number.isFinite(value) ? value : undefined;
}

// ── Genéricos ────────────────────────────────────────────────────────

/** `data-src` antes de `src`: as duas lojas usam lazy-load, e nesse caso o `src` inicial é um placeholder 1x1 transparente (data:image/gif), não a foto do produto. */
function extractFirstImageSrc(chunk: string): string | undefined {
  const lazy = /<img[^>]*data-src="(https?:\/\/[^"]+)"/i.exec(chunk);
  if (lazy) return decodeHtmlEntities(lazy[1]);
  const direct = /<img[^>]*src="(https?:\/\/[^"]+)"/i.exec(chunk);
  return direct ? decodeHtmlEntities(direct[1]) : undefined;
}

/**
 * Última imagem do trecho — usada quando a foto vem ANTES da âncora do
 * card (caso do Mercado Livre, ver parseMercadoLivreHtml). Num trecho
 * que vai do card anterior até o atual, a última imagem é a do card
 * atual; a primeira ainda seria do anterior.
 *
 * O `https?://` no padrão é o que descarta o placeholder de lazy-load
 * (`src="data:image/gif;base64,..."`) sem precisar tratá-lo à parte.
 */
function extractLastImageSrc(chunk: string): string | undefined {
  const pattern = /<img[^>]*?(?:data-src|src)="(https?:\/\/[^"]+)"/gi;
  let last: string | undefined;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(chunk)) !== null) last = match[1];
  return last ? decodeHtmlEntities(last) : undefined;
}

interface StoreScraper {
  marketplace: MarketplaceId;
  label: string;
  buildUrl: (query: string) => string;
  parse: (html: string) => ScrapedOffer[];
}

const STORE_SCRAPERS: StoreScraper[] = [
  {
    marketplace: "mercadolivre",
    label: "Mercado Livre",
    buildUrl: buildMercadoLivreSearchUrl,
    parse: parseMercadoLivreHtml,
  },
  {
    marketplace: "amazon",
    label: "Amazon",
    buildUrl: buildAmazonSearchUrl,
    parse: parseAmazonHtml,
  },
];

/**
 * Diferencia BLOQUEIO de "busca sem resultado". Devolve a mensagem de
 * erro quando identifica bloqueio, ou `null` quando a resposta parece
 * uma página de busca legítima.
 *
 * Exportada pra teste: é a lógica mais importante do arquivo do ponto de
 * vista de operação — se ela classificar errado, o usuário recebe o
 * diagnóstico errado e vai caçar problema no lugar errado.
 */
export function detectBlock(status: number, html: string, storeLabel: string): string | null {
  if (status === 403) {
    return (
      // Mensagem atualizada (set/2026): a versão anterior mandava "Use
      // RapidAPI/Mercado Livre no seletor", e nenhum dos dois está mais no
      // seletor (ver AB_TEST_PROVIDER_IDS em Dashboard.tsx) — o usuário
      // procurava uma opção que não existe e concluía que o app estava
      // quebrado. Só citar alternativa que ele consegue clicar de fato.
      `${storeLabel} recusou a requisição (HTTP 403) — o IP do servidor foi bloqueado pelo anti-bot da loja. ` +
      "É a limitação conhecida de raspar a loja direto de um IP de datacenter (Vercel), mesmo via proxy. " +
      'Troque o mecanismo no seletor: "ScraperAPI" (endpoints estruturados, sem chave) ou ' +
      '"Busca por imagem (SearchApi.io)" costumam passar quando a raspagem direta está barrada.'
    );
  }
  if (status === 429) {
    return `${storeLabel} limitou a taxa de requisições (HTTP 429) — buscas demais em pouco tempo. Tente de novo em alguns minutos.`;
  }
  if (status === 503) {
    return `${storeLabel} devolveu HTTP 503 — normalmente é o anti-bot barrando, não a loja fora do ar.`;
  }
  if (status >= 400) {
    return `${storeLabel} retornou HTTP ${status}.`;
  }

  // Página de desafio/CAPTCHA vem com HTTP 200 — só o conteúdo denuncia.
  if (/validateCaptcha|\/errors\/validateCaptcha|Digite os caracteres|Enter the characters you see/i.test(html)) {
    return (
      `${storeLabel} respondeu com CAPTCHA em vez do resultado — o IP do servidor foi marcado como ` +
      "automatizado. Use outro provider no seletor, ou configure proxy pro motor interno."
    );
  }

  // Página real de busca tem dezenas de KB. Resposta minúscula com 200
  // é quase sempre desafio/redirect disfarçado, não busca vazia.
  if (html.trim().length < 2000) {
    return (
      `${storeLabel} devolveu uma página vazia/curta demais pra ser um resultado de busca — ` +
      "provável bloqueio silencioso do IP do servidor."
    );
  }

  return null;
}

/**
 * Uma tentativa HTTP crua — sem retry, sem classificar bloqueio. Devolve
 * status + corpo pra quem chama decidir (`fetchStoreHtml` abaixo).
 *
 * Com `scraperApiKey` (BYOK do usuário) presente, a requisição vai pro endpoint do
 * ScraperAPI (`url` da loja vira parâmetro, não o destino direto) — ele
 * repassa por padrão o status HTTP de origem da loja, então `detectBlock`
 * continua funcionando sem mudança (403/429/503/CAPTCHA/página curta
 * classificam igual). Headers de navegador próprios (`BROWSER_HEADERS`)
 * só fazem sentido indo direto na loja: o ScraperAPI monta os dele do
 * lado de lá, e sobrepor os nossos não ajuda.
 *
 * `render` (JS rendering) continua DESLIGADO de propósito — Amazon/ML
 * servem HTML pronto pros parsers atuais (JSON-LD/cards), então ligar
 * isso só aumentaria o custo em crédito sem ganho.
 *
 * `premium` (pool de proxy residencial/mobile da ScraperAPI, em vez do
 * datacenter padrão) LIGADO desde ago/2026 — relato real: com
 * chave ScraperAPI cadastrada (proxy ativo) e AINDA ASSIM Amazon E
 * Mercado Livre bloqueando (403/CAPTCHA, ver `StoreBlockedError`), sinal
 * de que o pool datacenter padrão da ScraperAPI já está tão visado
 * quanto o IP direto da Vercel — exatamente o cenário que este comentário
 * já previa como "próximo botão a virar". Custa mais crédito por
 * requisição no plano ScraperAPI (residencial/mobile é a categoria mais
 * cara lá) — se isso pesar no plano contratado, o primeiro lugar pra
 * cortar de volta é este parâmetro (remove a query string, sem tocar em
 * parser nem no resto de `fetchStoreHtml`), não o volume de busca do
 * motor interno + IA.
 */
async function fetchStoreHtmlOnce(
  url: string,
  scraper: StoreScraper,
  scraperApiKey: string | undefined
): Promise<{ status: number; html: string }> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  const useProxy = Boolean(scraperApiKey);
  const targetUrl = useProxy
    ? `${SCRAPERAPI_ENDPOINT}?api_key=${scraperApiKey}&url=${encodeURIComponent(url)}&premium=true`
    : url;

  try {
    const response = await fetch(targetUrl, {
      headers: useProxy ? undefined : BROWSER_HEADERS,
      redirect: "follow",
      signal: controller.signal,
    });
    const html = await response.text();
    return { status: response.status, html };
  } catch (err) {
    if (err instanceof Error && err.name === "AbortError") {
      throw new StoreBlockedError(
        `${scraper.label} não respondeu em ${REQUEST_TIMEOUT_MS / 1000}s (timeout).`,
        scraper.marketplace
      );
    }
    throw err;
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Ponto ÚNICO de saída HTTP deste provider — é aqui que um proxy entra
 * no dia em que o IP da Vercel for bloqueado, sem tocar em parser nem
 * na lógica de ranking.
 *
 * Faz retry com backoff especificamente pra 503 (ver
 * RETRY_ON_503_ATTEMPTS acima) — as outras classes de bloqueio
 * (403/CAPTCHA/timeout/página curta) continuam falhando na 1ª tentativa.
 */
async function fetchStoreHtml(
  url: string,
  scraper: StoreScraper,
  scraperApiKey: string | undefined
): Promise<string> {
  let lastBlockReason: string | null = null;

  for (let attempt = 0; attempt <= RETRY_ON_503_ATTEMPTS; attempt++) {
    if (attempt > 0) {
      await sleep(RETRY_ON_503_BASE_DELAY_MS * attempt);
    }

    const { status, html } = await fetchStoreHtmlOnce(url, scraper, scraperApiKey);
    const blockReason = detectBlock(status, html, scraper.label);
    if (!blockReason) return html;

    lastBlockReason = blockReason;
    // Só 503 justifica gastar as tentativas extras — qualquer outro
    // motivo de bloqueio para aqui na primeira, ver comentário acima.
    if (status !== 503) break;
  }

  throw new StoreBlockedError(lastBlockReason!, scraper.marketplace);
}

/** Ofertas cruas de UMA loja pra UMA query — saída de `fetchStoreOffers`, ainda sem ranking nenhum aplicado. */
export interface StoreOffers {
  marketplace: MarketplaceId;
  label: string;
  offers: ScrapedOffer[];
}

/**
 * Busca ofertas CRUAS (sem ranking por similaridade de texto, sem
 * `MarketplacePriceResult`) pra uma única query de texto, nas lojas
 * presentes em `matchers`. Usa a mesma raspagem de sempre (STORE_SCRAPERS,
 * `fetchStoreHtml`, `scraper.parse`).
 *
 * Único consumidor: motor interno + IA (visionInternalSearchProvider.ts) —
 * lá a decisão de qual candidato é o produto certo não é por similaridade
 * de TEXTO (a query já veio de uma descrição gerada por IA, não do nome do
 * catálogo), e sim por comparação visual das fotos — então o consumidor
 * precisa da lista de ofertas em si, não de um único "melhor" já escolhido
 * por ranking de texto. `getTopCandidates` (rankCandidates.ts) entra DEPOIS
 * desta função, sobre a lista aqui devolvida.
 *
 * Erro por loja é isolado (uma bloqueada não derruba a outra) — só propaga
 * se TODAS as lojas tentadas falharem.
 */
export async function fetchStoreOffers(
  query: string,
  matchers: MarketplaceMatcher[],
  scraperApiKey?: string
): Promise<StoreOffers[]> {
  const scrapers = STORE_SCRAPERS.filter((s) => matchers.some((m) => m.marketplace === s.marketplace));
  if (scrapers.length === 0) return [];

  const results: StoreOffers[] = [];
  let lastError: string | null = null;
  let failures = 0;

  await mapWithConcurrency(scrapers, CONCURRENCY, async (scraper) => {
    try {
      const html = await fetchStoreHtml(scraper.buildUrl(query), scraper, scraperApiKey);
      const offers = scraper.parse(html);
      if (offers.length === 0) {
        // Sem isso, HTML que passa por `detectBlock` (sem
        // bloqueio explícito) mas que o parser não reconhece (layout
        // mudou, ou é uma página de resultado vazio de verdade) virava
        // "0 ofertas" 100% silencioso: nem erro, nem warning, nada no
        // log — exatamente o cenário que fazia catálogo inteiro voltar
        // zerado sem NENHUMA pista no log da function.
        console.warn(
          `[motor-interno+IA] ${scraper.label}: 0 ofertas pra "${query}" (HTML ${html.length} bytes — ` +
            "se isso acontecer com TODOS os produtos, o layout da loja provavelmente mudou; " +
            "ver os testes de parser em internalSearchProvider.test.ts)"
        );
      }
      results.push({ marketplace: scraper.marketplace, label: scraper.label, offers });
    } catch (err) {
      failures++;
      lastError = err instanceof Error ? err.message : String(err);
      console.error(`[motor-interno+IA] ${scraper.label} falhou pra "${query}":`, err);
    }
  });

  if (failures === scrapers.length && lastError) {
    throw new Error(lastError);
  }

  return results;
}

// `searchInternalShared` (motor interno SEM IA, busca por TEXTO direto
// pra amazon/ml) foi REMOVIDO daqui (ago/2026) — decisão de produto pós
// teste A/B: entre os dois "motor interno" testados, só a variante com
// Gemini (`searchVisionInternalShared`, visionInternalSearchProvider.ts)
// seguiu. `fetchStoreOffers` acima continua — é o que essa variante usa
// pro passo de busca por texto (a partir da descrição gerada pela IA, não
// do nome do catálogo).
