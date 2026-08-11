import type { CatalogItemQuery, MarketplaceId, MarketplacePriceResult } from "../types.js";
import { mapWithConcurrency } from "../concurrency.js";
import { confidenceFromSimilarity } from "../textSimilarity.js";
import { pickBestCandidate, popularityScore } from "../rankCandidates.js";
import type { MarketplaceMatcher } from "./googleShoppingProvider.js";

/**
 * ══════════════════════════════════════════════════════════════════════
 * MOTOR DE BUSCA INTERNO — sem intermediário pago
 * ══════════════════════════════════════════════════════════════════════
 *
 * Lê o preço direto da página de resultado de busca de cada loja
 * (Mercado Livre e Amazon BR), sem SerpApi, sem RapidAPI, sem chave
 * nenhuma. É o provider "nosso" — o único cujo custo marginal por busca
 * é ZERO, e a razão de existir: o usuário pagar a assinatura da
 * plataforma e mais US$ 40-100/mês de API de terceiro era inviável
 * comercialmente.
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

/** Abaixo disso o match entra marcado como aproximado — mesmo critério da busca por texto em googleShoppingProvider.ts (a busca foi feita PELO NOME, então o título tem que bater de verdade). */
const APPROXIMATE_BELOW_SIMILARITY = 0.35;

/**
 * Concorrência menor que a dos providers de API (que usam 2-3 contra um
 * endpoint feito pra receber tráfego automatizado). Aqui são páginas de
 * loja: rajada de requisição simultânea do mesmo IP é o padrão mais
 * óbvio de bot. 2 é lento de propósito.
 */
const CONCURRENCY = 2;

/** Teto por requisição. Função serverless tem limite de execução total — uma loja lenta não pode consumir o orçamento inteiro do lote e derrubar produtos que buscariam bem. */
const REQUEST_TIMEOUT_MS = 8000;

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
 * Bloqueio/desafio da loja — categoria de erro DIFERENTE de "não achei
 * o produto". Existe como classe própria pra `searchInternalShared`
 * poder propagar uma mensagem acionável ("o IP foi bloqueado, use outro
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
      `${storeLabel} recusou a requisição (HTTP 403) — o IP do servidor foi bloqueado. ` +
      "É a limitação conhecida de rodar o motor interno direto da Vercel (IP de datacenter). " +
      "Use RapidAPI/Mercado Livre no seletor enquanto isso."
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
 * Ponto ÚNICO de saída HTTP deste provider — é aqui que um proxy entra
 * no dia em que o IP da Vercel for bloqueado, sem tocar em parser nem
 * na lógica de ranking.
 */
async function fetchStoreHtml(url: string, scraper: StoreScraper): Promise<string> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  try {
    const response = await fetch(url, {
      headers: BROWSER_HEADERS,
      redirect: "follow",
      signal: controller.signal,
    });
    const html = await response.text();

    const blockReason = detectBlock(response.status, html, scraper.label);
    if (blockReason) throw new StoreBlockedError(blockReason, scraper.marketplace);

    return html;
  } catch (err) {
    if (err instanceof StoreBlockedError) throw err;
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
 * Busca de preço pelo motor interno. Mesma assinatura dos outros
 * providers multi-marketplace (`searchGoogleShoppingShared` etc.) pra
 * plugar em fetch-prices.ts sem caso especial — mas com uma diferença
 * de comportamento importante: aqui cada marketplace é uma requisição
 * própria (ver comentário no topo), então o `matchers` define quantas
 * lojas serão visitadas por produto.
 *
 * Contrato de erro, igual ao resto do projeto: produto sem match é
 * silencioso (normal, só reduz taxa de acerto); falha SISTÊMICA que
 * atingiu todas as tentativas vira exceção, pra UI poder explicar. Sem
 * isso, bloqueio de IP apareceria como "nenhum resultado" e mandaria o
 * usuário depurar o catálogo em vez da infra.
 */
export async function searchInternalShared(
  items: CatalogItemQuery[],
  matchers: MarketplaceMatcher[]
): Promise<Record<string, Record<string, MarketplacePriceResult>>> {
  const results = {} as Record<string, Record<string, MarketplacePriceResult>>;
  for (const { marketplace } of matchers) results[marketplace] = {};

  const scrapers = STORE_SCRAPERS.filter((s) => matchers.some((m) => m.marketplace === s.marketplace));
  if (scrapers.length === 0 || items.length === 0) return results;

  // Uma unidade de trabalho = 1 produto numa 1 loja.
  const jobs = items.flatMap((item) => scrapers.map((scraper) => ({ item, scraper })));

  let blockedError: string | null = null;
  let attempts = 0;
  let failures = 0;

  await mapWithConcurrency(jobs, CONCURRENCY, async ({ item, scraper }) => {
    attempts++;
    try {
      const html = await fetchStoreHtml(scraper.buildUrl(item.name), scraper);
      const offers = scraper.parse(html);

      if (offers.length === 0) {
        // HTML veio íntegro (passou por detectBlock) mas o parser não
        // achou nada: ou a busca não tem resultado mesmo, ou o layout
        // mudou. Registrado no log com o tamanho do HTML pra distinguir
        // os dois casos sem precisar reproduzir a busca.
        console.warn(
          `[motor-interno] ${scraper.label}: 0 ofertas pra "${item.name}" (HTML ${html.length} bytes — ` +
            "se isso acontecer com TODOS os produtos, o layout da loja provavelmente mudou; " +
            "ver os testes de parser em internalSearchProvider.test.ts)"
        );
        return;
      }

      const ranked = pickBestCandidate(
        item.name,
        offers,
        (o) => o.title,
        (o) => popularityScore(o.reviewCount, o.rating)
      );
      if (!ranked) return;

      results[scraper.marketplace][item.sku] = {
        marketplace: scraper.marketplace,
        sku: item.sku,
        price: ranked.candidate.price,
        competitorCount: Math.max(0, offers.length - 1),
        buyBoxEligible: true,
        confidence: confidenceFromSimilarity(ranked.similarity),
        link: ranked.candidate.link,
        matchedTitle: ranked.candidate.title,
        imageUrl: ranked.candidate.thumbnail,
        approximate: ranked.similarity < APPROXIMATE_BELOW_SIMILARITY,
        matchedSource: scraper.label,
      };
    } catch (err) {
      failures++;
      if (err instanceof StoreBlockedError) {
        blockedError = err.message;
      } else {
        blockedError = blockedError ?? (err instanceof Error ? err.message : String(err));
      }
      console.error(`[motor-interno] ${scraper.label} falhou pra "${item.name}":`, err);
    }
  });

  // Só propaga se TUDO falhou — mesmo critério dos outros providers.
  // Falha parcial (uma loja bloqueada, outra não) devolve o que deu
  // certo, em vez de descartar resultado bom por causa de erro alheio.
  if (attempts > 0 && failures === attempts && blockedError) {
    throw new Error(blockedError);
  }

  return results;
}
