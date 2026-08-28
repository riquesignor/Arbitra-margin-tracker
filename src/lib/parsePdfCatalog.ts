import type { CatalogRow } from "../types";
import { parseCurrency } from "./parseCatalog";
import { mapWithConcurrency } from "./concurrency";
import { assertPubliclyReachable, uploadCatalogImage } from "./catalogImages";
import {
  extractCatalogPageProductsWithGemini,
  extractCatalogPageWithGemini,
  GeminiCatalogQuotaExhaustedError,
  normalizeSkuForMatch,
} from "./geminiCatalogVision";

export class PdfParseError extends Error {}

export interface PageRange {
  from: number;
  to: number;
}

interface PdfjsModule {
  GlobalWorkerOptions: { workerSrc: string };
  getDocument: (src: { data: ArrayBuffer }) => { promise: Promise<PdfjsDocument> };
}

interface PdfjsDocument {
  numPages: number;
  getPage: (n: number) => Promise<PdfjsPage>;
}

interface PdfjsViewport {
  width: number;
  height: number;
}

interface PdfjsRenderContext {
  canvasContext: CanvasRenderingContext2D;
  viewport: PdfjsViewport;
}

interface PdfjsPage {
  getTextContent: () => Promise<{ items: PdfjsTextItem[] }>;
  getViewport: (params: { scale: number }) => PdfjsViewport;
  render: (params: PdfjsRenderContext) => { promise: Promise<void> };
}

interface PdfjsTextItem {
  str?: string;
  transform?: number[];
  width?: number;
}

/**
 * pdfjs-dist é carregado sob demanda (import dinâmico) — quem só usa
 * catálogo CSV nunca paga esse peso no bundle. Mesmo princípio de
 * lazy-load usado em lib/firebase.ts.
 */
let pdfjsPromise: Promise<PdfjsModule> | null = null;
async function loadPdfjs(): Promise<PdfjsModule> {
  if (!pdfjsPromise) {
    pdfjsPromise = (async () => {
      const pdfjsLib = (await import("pdfjs-dist")) as unknown as PdfjsModule;
      const workerUrl = (await import("pdfjs-dist/build/pdf.worker.min.mjs?url")).default;
      pdfjsLib.GlobalWorkerOptions.workerSrc = workerUrl;
      return pdfjsLib;
    })();
  }
  return pdfjsPromise;
}

async function loadDocument(file: File): Promise<PdfjsDocument> {
  const pdfjsLib = await loadPdfjs();
  const buffer = await file.arrayBuffer();
  return pdfjsLib.getDocument({ data: buffer }).promise;
}

export async function getPdfPageCount(file: File): Promise<number> {
  const doc = await loadDocument(file);
  return doc.numPages;
}

interface PositionedText {
  text: string;
  x: number;
  /** Largura renderizada do item (pdfjs `TextItem.width`) — usada pra
   * saber onde ele TERMINA (x + width) e decidir se o próximo item é
   * continuação da mesma palavra/número ou uma palavra nova (ver
   * juntarTextoAdaptativo). */
  width: number;
  y: number;
}

interface PositionedLine {
  text: string;
  /** Em espaço PDF (y cresce pra CIMA), não pixel de canvas. */
  y: number;
}

const Y_TOLERANCE = 3;

// Alguns PDFs (geradores/templates que quebram um número em runs de
// fonte diferentes) partem um único token em vários itens de texto
// CONTÍGUOS, sem espaço real entre eles (gap ≈ 0pt) — ex: "13,50" virou
// os itens "1" (termina em x=162.77) e "3,50" (começa em x=162.77,
// gap=0). A versão antiga sempre juntava itens da mesma linha com um
// espaço fixo, o que produzia "1 3,50" e quebrava o preço de novo (ver
// fix da regex acima). Threshold escolhido com dado real: gap de
// continuação de token = 0pt; menor gap de PALAVRA real observado (ex:
// "Unid.CX:" → "13,50") = ~2.8pt. 1.5pt fica seguro entre os dois.
const SAME_TOKEN_GAP_THRESHOLD = 1.5;

/**
 * Agrupa itens de texto (posicionados em x/y) em linhas, na ordem
 * visual, mantendo os ITENS BRUTOS de cada linha (não só o texto
 * final) — necessário pra detecção de colunas em catálogos em grade
 * (ver extractGridBlocks), que precisa saber o X de cada item
 * individual, não só o texto já concatenado.
 */
function groupItemsIntoLines(items: PositionedText[]): PositionedText[][] {
  const sorted = [...items].sort((a, b) => b.y - a.y || a.x - b.x);
  const lines: PositionedText[][] = [];

  for (const item of sorted) {
    const currentLine = lines[lines.length - 1];
    if (currentLine && Math.abs(currentLine[0].y - item.y) <= Y_TOLERANCE) {
      currentLine.push(item);
    } else {
      lines.push([item]);
    }
  }

  return lines.map((line) => [...line].sort((a, b) => a.x - b.x));
}

/** Junta os itens (já ordenados por X) de uma linha em texto, inserindo espaço só entre PALAVRAS de verdade (ver SAME_TOKEN_GAP_THRESHOLD). */
function joinLineText(sortedLine: PositionedText[]): string {
  let text = "";
  let prevEndX: number | null = null;
  for (const item of sortedLine) {
    if (prevEndX != null && item.x - prevEndX > SAME_TOKEN_GAP_THRESHOLD) {
      text += " ";
    }
    text += item.text;
    prevEndX = item.x + item.width;
  }
  return text.replace(/\s+/g, (m) => (m.length > 1 ? " " : m)).trim();
}

/**
 * Versão com posição Y da linha (não só o texto), usada pelo modo
 * imagem pra recortar a faixa da página correspondente a cada linha
 * (ver cropRowBand).
 */
function groupIntoLinesWithY(items: PositionedText[]): PositionedLine[] {
  return groupItemsIntoLines(items)
    .map((line) => ({ text: joinLineText(line), y: line[0].y }))
    .filter((l) => l.text);
}

// Preço: 3 formatos aceitos —
//   1. "R$ 1.234,56" ou "R$ 3800" (com "R$", decimal OPCIONAL — o "R$"
//      é o que desambigua um número solto de um SKU/quantidade na
//      mesma linha; sem "R$" na frente, um inteiro puro tipo "1200"
//      fica ambíguo demais pra virar preço com segurança)
//   2. "1234,56" (BR, decimal com vírgula, sem precisar de "R$") — tanto
//      com separador de milhar próprio ("1.234,56") quanto sem
//      ("1234,56"), desde que a vírgula decimal esteja lá.
//   3. "1234.56" (US, decimal com ponto, sem precisar de "R$")
// Preço tipo "POR 1200" (sem "R$" e sem decimal) continua fora do
// escopo — ver aviso no card de Catálogo do Dashboard.
//
// ⚠️ Regressão corrigida: o grupo 2 antigo era
// `\d{1,3}(?:\.\d{3})*,\d{2}` — o `{1,3}` sem âncora de início deixava
// o regex casar no MEIO de um número maior sem separador de milhar
// (ex: em "3800,00" ele casava só "800,00", devorando o "3" e
// corrompendo preço E nome). Agora a alternativa sem separador usa
// `\d+` (sem teto) com lookbehind `(?<!\d)` garantindo que o match
// começa no primeiro dígito de verdade — mesma estratégia já usada no
// grupo 1 (R$) pra esse caso.
const PRICE_PATTERN =
  /R\$\s?(\d{1,3}(?:\.\d{3})+(?:,\d{2})?|\d+(?:,\d{2})?)|(\d{1,3}(?:\.\d{3})+,\d{2}|(?<!\d)\d+,\d{2})|(\d+\.\d{2})/;
const PRICE_PATTERN_GLOBAL = new RegExp(PRICE_PATTERN.source, "g");

/**
 * `priceMatch` tem 3 grupos alternativos (R$/BR/US) — pega o que bateu.
 * Grupo 1 (prefixado por "R$") merece um cuidado extra: um ponto aí
 * SEMPRE é separador de milhar, nunca decimal — a regex exige
 * exatamente 3 dígitos depois do ponto (`\.\d{3}`), e centavos nunca
 * têm 3 dígitos. Mas isso só é óbvio AQUI, que sabe qual grupo bateu;
 * `parseCurrency` (compartilhado com o parser de CSV) não tem como
 * saber — "1.200" sem vírgula depois é ambíguo pra ela (decimal 1,2 ou
 * milhar 1200?) e ela assume decimal. Por isso remove o(s) ponto(s) de
 * milhar ANTES de chamar parseCurrency, só quando não tem vírgula
 * decimal junto (com vírgula, ex. "3.800,00", parseCurrency já acerta).
 */
function extractPriceGroup(match: RegExpMatchArray): string {
  const raw = match[1] ?? match[2] ?? match[3] ?? "";
  if (match[1] && raw.includes(".") && !raw.includes(",")) {
    return raw.replace(/\./g, "");
  }
  return raw;
}
// SKU: código tipo "SKU-001", "REF12345" ou sequência de 4+ dígitos
const SKU_PATTERN = /\b([A-Z]{2,}[-\s]?\d{2,}|\d{4,})\b/;
/** Versão global de SKU_PATTERN — só pra CONTAR/localizar ocorrências (ver trySplitMultiPriceLine abaixo), nunca usada pra extrair o SKU de verdade (isso continua sendo SKU_PATTERN, primeiro match de cada segmento). */
const SKU_PATTERN_GLOBAL = new RegExp(SKU_PATTERN.source, "g");
// Label explícito de código de produto usado por catálogos em grade
// (ver extractGridBlocks) — "MODELO: BMG-50" (às vezes sem espaço antes
// dos dois pontos ou com dois-pontos ausente) ou "CÓD. 002168"/"CÓDIGO:
// 002168" (catálogo real: Issam Distribuidora, 4.585 produtos, ver
// parsePdfCatalog.test.ts). Mais rótulos podem entrar aqui no futuro se
// aparecer catálogo com outra convenção — cada um exige guarda de
// word-boundary (`\b` nas DUAS pontas do grupo) pra não casar no meio
// de uma palavra qualquer que comece com as mesmas letras (ex.: sem a
// guarda, "COD" casaria dentro de "crocodilo" — testado com o texto
// real do catálogo Issam pra confirmar que não há colisão; "código"
// batendo sozinho em prosa comum é inofensivo, só conta como grade
// quando aparece 2+ vezes na MESMA linha).
const MODEL_LABEL_PATTERN = /\b(?:MODELO|C[ÓO]D(?:IGO)?)\b:?\.?\s*(.+)/i;
// Versão SEM captura gulosa, só pra CONTAR quantas vezes o label
// aparece numa linha (ver detecção de cabeçalho de grade) — o `(.+)` de
// MODEL_LABEL_PATTERN é ilimitado à direita, então com flag global ele
// devora a linha inteira na 1ª ocorrência e nunca acha uma 2ª.
const MODEL_LABEL_COUNT_PATTERN = /\b(?:MODELO|C[ÓO]D(?:IGO)?)\b:?\.?/gi;
// Acima disso, o "nome" quase certamente é lixo de mais de uma coluna
// mesclada, não um nome de produto real.
const MAX_PLAUSIBLE_NAME_LENGTH = 120;

// ── Limpeza de nome (lixo de OCR / arte da página) ───────────────────
//
// Problema real observado: com OCR (ou PDF cuja arte tem texto solto), o
// nome do produto vinha assim —
//   'Timm 15 sda E o SE E e "Econ. NS ss. YE, rs ZA Kit: Organizadores de'
// — ou seja, o nome de verdade ("Kit: Organizadores...") afogado em
// fragmentos que o OCR leu de logotipo, selo e textura de fundo. Esse
// nome ruim é usado em DOIS lugares críticos: como texto da busca por
// preço e como rótulo na tela — então lixo aqui contamina tudo.
//
// Estratégia (deliberadamente conservadora): não tentar "adivinhar" o
// nome certo, e sim CORTAR a string nos tokens que são inequivocamente
// ruído, e ficar com o maior pedaço contíguo que sobrar. Nome limpo não
// tem nenhum token de ruído → nenhum corte → string inalterada. Isso dá
// a propriedade que importa: catálogo que já funcionava não muda em
// nada, só o caso quebrado é tocado.

/** Tokens curtos que SÃO conteúdo real em catálogo BR (unidade, medida, conector) — sem isso, "kit", "cm", "un" cairiam na regra de "token curto = ruído". */
const REAL_SHORT_TOKENS = new Set([
  "de", "da", "do", "das", "dos", "e", "em", "no", "na", "ao", "a", "o", "as", "os",
  "com", "sem", "por", "para", "pra", "kit", "cm", "mm", "ml", "kg", "un", "pc", "cx",
  "tv", "led", "usb", "abs", "pvc", "pet", "gg", "xl", "p", "m", "g", "l",
]);

/** Conectores que nunca abrem um nome de produto — um nome que COMEÇA com eles é sinal de recorte no meio de uma frase. */
const LEADING_CONNECTORS = new Set([
  "de", "da", "do", "das", "dos", "e", "em", "no", "na", "ao", "com", "sem", "por", "para", "pra",
]);

function normalizeToken(raw: string): string {
  return raw
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]/g, "");
}

/**
 * Ruído inequívoco: só pontuação/aspas, sigla curta solta ("SE", "NS",
 * "YE", "ZA", "rs", "ss") ou sequência sem nenhuma vogal. Qualquer token
 * com dígito passa direto — número é quase sempre informação real
 * (medida, capacidade, modelo), e é justamente o que distingue um
 * produto do outro na busca.
 */
function isNoiseToken(raw: string): boolean {
  const normalized = normalizeToken(raw);
  if (!normalized) return true;
  if (/\d/.test(normalized)) return false;
  if (REAL_SHORT_TOKENS.has(normalized)) return false;
  if (normalized.length <= 2) return true;
  return !/[aeiou]/.test(normalized);
}

/**
 * Devolve o maior trecho contíguo do nome sem tokens de ruído (ver
 * comentário do bloco acima). "Maior" por soma de caracteres úteis, não
 * por número de tokens — um trecho com uma palavra longa e específica
 * ("Organizadores") vale mais que três fragmentos curtos.
 *
 * Exportado pra teste unitário direto — ver parsePdfCatalog.test.ts.
 */
export function sanitizeProductName(raw: string): string {
  const tokens = raw.split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return "";

  const segments: string[][] = [];
  let current: string[] = [];
  for (const token of tokens) {
    if (isNoiseToken(token)) {
      if (current.length > 0) segments.push(current);
      current = [];
    } else {
      current.push(token);
    }
  }
  if (current.length > 0) segments.push(current);
  if (segments.length === 0) return "";

  const weigh = (segment: string[]) =>
    segment.reduce((sum, token) => sum + normalizeToken(token).length, 0);

  let best = segments[0];
  let bestWeight = weigh(best);
  for (const segment of segments.slice(1)) {
    const weight = weigh(segment);
    if (weight > bestWeight) {
      best = segment;
      bestWeight = weight;
    }
  }

  // Conector solto na frente ("de Organizadores") denuncia recorte no
  // meio de uma frase — não se tira do FIM de propósito: "POR" e afins
  // no fim podem ser parte legítima do texto da linha (ver o caso
  // "VIDEOGAME SONY POR" em parsePdfCatalog.test.ts).
  while (best.length > 1 && LEADING_CONNECTORS.has(normalizeToken(best[0]))) {
    best = best.slice(1);
  }

  // Pontuação órfã que sobrou na borda do corte (aspas, vírgula, ponto).
  return best
    .join(" ")
    .replace(/^[^A-Za-zÀ-ÿ0-9]+/, "")
    .trim();
}

/**
 * Hash determinístico simples (djb2) — só precisa ser estável e barato,
 * não criptográfico. Usado pra gerar SKU sintético a partir do NOME do
 * produto (ver skuFor abaixo), não da posição da linha.
 */
function hashString(input: string): string {
  let hash = 5381;
  for (let i = 0; i < input.length; i++) {
    hash = (hash * 33 + input.charCodeAt(i)) | 0;
  }
  return Math.abs(hash).toString(36);
}

/**
 * SKU sintético pro caso sem código explícito na linha (ver SKU_PATTERN).
 * ⚠️ Regressão corrigida: a versão anterior gerava "PDF-1", "PDF-2"...
 * por POSIÇÃO da linha. Como o cache de preço no servidor
 * (api/_lib/cache.ts) é global por sku+provider+marketplace, sem
 * namespace por catálogo/usuário, dois uploads DIFERENTES sem SKU
 * explícito geravam os MESMOS ids ("PDF-1", "PDF-2"...) e um catálogo
 * lia o cache (TTL 2h) deixado pelo outro — preço/produto errado sem
 * relação nenhuma com o PDF atual. Agora o id deriva do CONTEÚDO
 * (nome do produto): catálogos diferentes com produtos diferentes não
 * colidem mais; o mesmo nome de produto continua reaproveitando cache
 * de propósito (é o comportamento certo). `seen` desambigua o caso raro
 * de nome duplicado DENTRO do mesmo catálogo, pra não sobrescrever
 * `imagesBySku`.
 */
function skuFor(name: string, seen: Set<string>): string {
  const base = `PDF-${hashString(name)}`;
  let candidate = base;
  let suffix = 2;
  while (seen.has(candidate)) {
    candidate = `${base}-${suffix++}`;
  }
  seen.add(candidate);
  return candidate;
}

export interface ExtractResult {
  rows: CatalogRow[];
  skippedAmbiguous: number;
  /**
   * SKU → URL pública temporária da foto do produto (ver
   * catalogImages.ts) — só populado quando `parsePdfCatalogFile` é
   * chamado com `{ withImages: true }`. Um SKU pode faltar aqui mesmo
   * em modo imagem (falha no upload de um item isolado não derruba o
   * catálogo inteiro — ver extractRowImageBands).
   */
  imagesBySku?: Record<string, string>;
  /**
   * true se QUALQUER página do intervalo processado precisou cair pro
   * fallback de OCR (ver comentário grande acima de ocrPageToPositionedText)
   * — ou seja, o PDF não tem camada de texto real, pelo menos numa parte
   * das páginas pedidas. Usado pelo Dashboard pra travar a busca por
   * NOME (SerpApi texto, RapidAPI Amazon, Mercado Livre direto): produto
   * cujo nome veio de OCR de imagem tende a ficar ilegível/impreciso
   * demais pra busca por texto acertar — esses catálogos só devem seguir
   * por busca por FOTO (google_lens_products), que casa pela imagem, não
   * pelo nome. Catálogo com texto real (mesmo com nome ruim por outro
   * motivo) não é afetado por este flag.
   */
  usedOcr?: boolean;
  /**
   * true se QUALQUER página do intervalo precisou cair pro fallback
   * genérico de IA de visão (ver extractCatalogPageProductsWithGemini,
   * geminiCatalogVision.ts) — ou seja, pelo menos uma página não bateu
   * em NENHUMA heurística conhecida (grade com rótulo tipo MODELO:/
   * CÓD., linha única, bloco sem preço) e foi lida direto por IA.
   * Informativo, não bloqueia nada na UI (diferente de `usedOcr`): o
   * texto vem de leitura real da página pela IA, não de OCR pixel a
   * pixel, então a confiabilidade pra busca por NOME é boa — mas ainda
   * vale avisar o usuário, já que é uma leitura probabilística (a IA
   * pode errar um caractere ocasionalmente), diferente da extração
   * determinística de sempre.
   */
  usedGeminiPageExtraction?: boolean;
  /**
   * Números (1-based, absolutos no PDF) das páginas do intervalo
   * processado que não bateram em NENHUMA heurística (grade, linha
   * única, bloco "vitrine" sem preço) nem no fallback de IA — ou seja,
   * zero produto veio dessa página específica. Antes desta contagem
   * existir, um catálogo de N páginas com só ALGUMAS reconhecidas
   * simplesmente devolvia menos produto que o esperado sem NENHUMA pista
   * de qual página falhou nem por quê (regressão real reportada: "6
   * páginas processadas, só 3 produtos voltaram", sem saber quais 3
   * páginas ficaram de fora). Página cujo layout é só um divisor de
   * categoria (sem produto de verdade) também cai aqui — não é
   * necessariamente erro, mas listar sempre é mais honesto que omitir.
   * `undefined`/array vazio = todas as páginas do intervalo contribuíram
   * com pelo menos 1 produto.
   */
  pagesWithNoProducts?: number[];
}

/**
 * ⚠️ Heurística, não parser estruturado. Cada linha de texto vira um
 * produto se tiver exatamente UM padrão de preço reconhecível; SKU é o
 * primeiro código "tipo SKU" na linha (ou um id sequencial se não
 * achar); nome é o que sobra. Funciona bem pra catálogos com uma linha
 * de texto por produto.
 *
 * Linha com MAIS de um preço é normalmente célula de tabela multi-coluna
 * que o agrupamento por Y colou numa linha só — duas situações bem
 * diferentes, tratadas de forma diferente (ver `trySplitMultiPriceLine`
 * logo abaixo):
 *   - Vários produtos DIFERENTES lado a lado na mesma linha Y (grade de
 *     2+ colunas sem cabeçalho "MODELO:", ver extractGridBlocks) — cada
 *     um com o PRÓPRIO código de SKU antes do próprio preço. Recuperável
 *     com segurança: a ORDEM esquerda-pra-direita da linha já é a mesma
 *     ordem visual das colunas, então cada trecho "código...preço" é
 *     inequivocamente um produto (ver trySplitMultiPriceLine).
 *   - Preços de FAIXA/QUANTIDADE do MESMO produto numa célula só (ex:
 *     "30PCS/CX Unid.CX: 24PCS/CX Unid.CX: 32,00 5 0PCS/CX
 *     Unid.CX:23,00") — não tem código de SKU repetido, só texto de
 *     unidade/quantidade solto entre os preços. Não dá pra saber com
 *     segurança qual preço é o "certo" pro produto, então a linha é
 *     DESCARTADA (não vira produto com nome corrompido) e contada em
 *     `skippedAmbiguous`, reportado ao usuário. Preferir "faltou um
 *     produto" a "produto com nome ilegível ou preço errado".
 *
 * Layouts multi-coluna sem código de SKU por célula, tabelas com célula
 * de preço muito distante do nome, ou PDFs escaneados (sem camada de
 * texto — pdfjs não extrai nada) continuam fora do escopo deste
 * heurístico — precisariam de parser de tabela real ou OCR.
 */
interface IndexedExtractResult {
  rows: (CatalogRow & { lineIndex: number })[];
  skippedAmbiguous: number;
}

/**
 * Recuperação de linha ambígua (ago/2026, regressão real "12 produtos
 * numa página, só 8 reconhecidos" — grade de 2 colunas sem "MODELO:",
 * ver comentário acima de extractRowsIndexed): quando uma linha tem N
 * preços E pelo menos N ocorrências de SKU_PATTERN, é bem provável que
 * sejam N produtos DIFERENTES colados na mesma linha Y pelo agrupamento
 * — não uma tabela de faixa de preço/quantidade do mesmo produto (essas
 * não costumam ter um código de SKU antes de cada preço, ver o exemplo
 * "30PCS/CX..." no comentário acima, que tem 0 ocorrências de
 * SKU_PATTERN e por isso nunca passa nesta guarda).
 *
 * Divide a linha em N segmentos, um por preço encontrado — cada segmento
 * vai do fim do preço ANTERIOR (ou início da linha, no primeiro) até o
 * fim do preço ATUAL. Como a leitura de texto já segue a ordem visual
 * esquerda→direita (ver joinLineText), isso reconstrói exatamente
 * "código + nome + preço" de cada produto, na mesma ordem das colunas.
 *
 * Conservador de propósito: exige um SKU_PATTERN de verdade em CADA
 * segmento (não gera SKU sintético aqui) e só aceita a divisão se
 * recuperar 2+ produtos válidos — uma divisão que só rescata 1 segmento
 * não é melhor que descartar a linha inteira, e arrisca mais nome errado
 * do que vale a pena. Se a guarda ou a extração por segmento falhar em
 * qualquer ponto, devolve `null` e o chamador cai no comportamento de
 * sempre (descarta a linha inteira, conta em `skippedAmbiguous`).
 */
function trySplitMultiPriceLine(
  line: string,
  priceMatchCount: number
): { sku: string; name: string; supplierPrice: number }[] | null {
  const skuMatchCount = (line.match(SKU_PATTERN_GLOBAL) ?? []).length;
  if (skuMatchCount < priceMatchCount) return null;

  const priceMatches = [...line.matchAll(PRICE_PATTERN_GLOBAL)];
  const segments: string[] = [];
  let cursor = 0;
  for (const m of priceMatches) {
    const end = (m.index ?? 0) + m[0].length;
    segments.push(line.slice(cursor, end));
    cursor = end;
  }

  const results: { sku: string; name: string; supplierPrice: number }[] = [];
  for (const segment of segments) {
    const priceMatch = segment.match(PRICE_PATTERN);
    if (!priceMatch) continue;
    const price = parseCurrency(extractPriceGroup(priceMatch));
    if (price <= 0) continue;

    const withoutPrice = segment.replace(priceMatch[0], "").trim();
    const skuMatch = withoutPrice.match(SKU_PATTERN);
    if (!skuMatch) continue; // sem código próprio neste segmento — não arrisca inventar um sintético aqui

    const rawName = withoutPrice.replace(skuMatch[0], "").trim();
    const name = sanitizeProductName(rawName);
    if (!name || name.length > MAX_PLAUSIBLE_NAME_LENGTH) continue;

    results.push({ sku: skuMatch[1], name, supplierPrice: price });
  }

  return results.length >= 2 ? results : null;
}

/**
 * Mesma lógica de `extractRows` (abaixo), mas carrega o índice da linha
 * original de cada produto aceito — usado pelo modo imagem pra saber
 * QUAL linha (posição Y na página) corresponde a cada SKU, e assim
 * recortar a foto certa (ver extractRowImageBands). `extractRows`
 * público é só esta função com `lineIndex` removido, pra não mudar o
 * contrato testado em parsePdfCatalog.test.ts.
 */
function extractRowsIndexed(lines: string[], seenSyntheticSkus: Set<string> = new Set()): IndexedExtractResult {
  const rows: (CatalogRow & { lineIndex: number })[] = [];
  let skippedAmbiguous = 0;

  lines.forEach((line, lineIndex) => {
    const priceMatches = line.match(PRICE_PATTERN_GLOBAL);
    if (!priceMatches || priceMatches.length === 0) return;

    if (priceMatches.length > 1) {
      const split = trySplitMultiPriceLine(line, priceMatches.length);
      if (split) {
        for (const { sku, name, supplierPrice } of split) {
          rows.push({ sku, name, supplierPrice, lineIndex });
        }
      } else {
        skippedAmbiguous++;
      }
      return;
    }

    const priceMatch = line.match(PRICE_PATTERN);
    if (!priceMatch) return;

    const price = parseCurrency(extractPriceGroup(priceMatch));
    if (price <= 0) return;

    const withoutPrice = line.replace(priceMatch[0], "").trim();
    const skuMatch = withoutPrice.match(SKU_PATTERN);
    const rawName = (skuMatch ? withoutPrice.replace(skuMatch[0], "") : withoutPrice).trim();
    // Corta lixo de OCR/arte da página (ver sanitizeProductName) — no-op
    // pra linha limpa. Se sobrar vazio, a linha era só ruído e cai no
    // mesmo caminho de "nome implausível" logo abaixo.
    const name = sanitizeProductName(rawName);

    if (!name || name.length > MAX_PLAUSIBLE_NAME_LENGTH) {
      skippedAmbiguous++;
      return;
    }

    const sku = skuMatch ? skuMatch[1] : skuFor(name, seenSyntheticSkus);
    rows.push({ sku, name, supplierPrice: price, lineIndex });
  });

  return { rows, skippedAmbiguous };
}

/** Exportado pra teste unitário direto (sem precisar montar um PDF de verdade) — ver parsePdfCatalog.test.ts. */
export function extractRows(lines: string[]): ExtractResult {
  const { rows, skippedAmbiguous } = extractRowsIndexed(lines);
  return { rows: rows.map(({ lineIndex: _lineIndex, ...row }) => row), skippedAmbiguous };
}

// ── Catálogo "vitrine" sem preço (bloco multi-linha, sem "MODELO:") ──
//
// Alguns catálogos (mostruário de fornecedor, ex.: catalogo_bonito.pdf)
// não têm preço NENHUM por produto (fica só no orçamento à parte,
// combinado fora do PDF) e não usam o rótulo "MODELO:" da grade
// normal (ver extractGridBlocks) — cada produto é um bloco de VÁRIAS
// linhas: um código de SKU sozinho numa linha própria (ex.: "TOP2905"),
// seguido do nome, especificações (CX MASTER, NCM), cores, e às vezes
// um código de referência numérico solto — sem "R$", sem decimal, então
// nunca bate no PRICE_PATTERN. Nem `extractRowsIndexed` (exige preço na
// MESMA linha) nem `extractGridBlocks` (exige "MODELO:") reconhecem
// esse layout — os dois devolvem zero produto.
//
// Só roda como ÚLTIMO recurso (ver uso em parsePdfCatalogFile): a
// página já tentou grade E linha-única e não achou nada. Zero risco de
// regressão pra catálogo que já funciona — só entra em ação quando os
// dois caminhos testados e estáveis já desistiram.
//
// ⚠️ Limitação conhecida: produtos lado a lado na MESMA linha Y (grade
// de 2 colunas sem cabeçalho "MODELO:") viram uma linha só com os dois
// códigos de SKU juntos (ex.: "TOP2977          TOP2978") — o marcador
// abaixo exige a linha INTEIRA ser um código só, então essas linhas não
// batem e os dois produtos ficam de fora. Produto empilhado numa coluna
// só (a maioria, no catálogo real que motivou isso) é reconhecido
// normalmente. Resolver o caso lado a lado exigiria detecção de coluna
// por X como a grade — não implementado aqui de propósito (escopo
// deliberadamente contido: melhor recuperar parte do catálogo agora do
// que não recuperar nada esperando um parser perfeito).

/** Linha que é SÓ um código de SKU (ex.: "TOP2905"), sem mais nada — marca o INÍCIO de um novo produto neste layout. Mais restrito que SKU_PATTERN (que casa um SKU embutido em qualquer lugar da linha): aqui a linha inteira precisa ser o código, senão qualquer medida/quantidade no meio de uma frase viraria marcador por engano. */
const STANDALONE_SKU_LINE_PATTERN = /^[A-Z]{2,6}-?\d{3,6}$/;

/** Linhas de metadado deste tipo de catálogo — nunca fazem parte do NOME do produto, mesmo dentro do bloco. */
const BOILERPLATE_LINE_PATTERN = /^(CX\s*MASTER|NCM|CORES?)\s*:?/i;

/** Linha que é só dígitos (código de referência/barra solto, sem "R$" nem decimal) — não é preço utilizável (ver PRICE_PATTERN) nem parte do nome. */
const STANDALONE_DIGITS_LINE_PATTERN = /^\d+$/;

/**
 * Extrai produtos de um layout em BLOCO MULTI-LINHA sem preço (ver
 * comentário acima). Devolve `[]` se não achar nenhum marcador de SKU
 * standalone — chamador cai no comportamento de sempre (página sem
 * produto reconhecido).
 *
 * Se o bloco tiver, por acaso, um preço reconhecível (raro nesse tipo de
 * catálogo, mas acontece), ele é aproveitado — melhor usar um dado que
 * existe do que descartar. Mais de um preço no mesmo bloco é ambíguo
 * demais pra decidir sozinho: o produto ainda é aceito, só sem preço.
 *
 * Exportado pra teste unitário direto — ver parsePdfCatalog.test.ts.
 */
/**
 * Versão indexada (ago/2026) — mesma extração acima, mas carrega o
 * `lineIndex` do MARCADOR de cada produto junto (posição dentro de
 * `lines`), pro chamador conseguir recortar a foto do bloco (ver uso em
 * parsePdfCatalogFile, mesmo mecanismo de `cropRowBand` que o layout
 * linha-única já usa). Confirmado com PDF real (Catálogo TOPUTIL/DL
 * Grupo — o mesmo layout que originou este heurístico, ver comentário
 * acima) que este é justamente o caminho que catálogos assim acionam;
 * antes desta mudança, "vitrine sem preço" tinha nome/preço reconhecidos
 * mas NUNCA foto, mesmo com modo imagem selecionado — travava qualquer
 * provider de foto (Google Lens, SearchApi.io, motor interno + IA) com
 * "não consegui extrair nenhuma foto".
 */
export function extractProductBlocksWithoutPriceIndexed(lines: string[]): (CatalogRow & { lineIndex: number })[] {
  const markers: { sku: string; index: number }[] = [];
  lines.forEach((line, index) => {
    const trimmed = line.trim();
    if (STANDALONE_SKU_LINE_PATTERN.test(trimmed)) markers.push({ sku: trimmed, index });
  });
  if (markers.length === 0) return [];

  const rows: (CatalogRow & { lineIndex: number })[] = [];
  for (let i = 0; i < markers.length; i++) {
    const { sku, index } = markers[i];
    const end = i + 1 < markers.length ? markers[i + 1].index : lines.length;
    const bodyLines = lines.slice(index + 1, end);
    const bodyText = bodyLines.join(" ");

    const priceMatches = bodyText.match(PRICE_PATTERN_GLOBAL);
    let supplierPrice: number | undefined;
    if (priceMatches && priceMatches.length === 1) {
      const priceMatch = bodyText.match(PRICE_PATTERN);
      const price = priceMatch ? parseCurrency(extractPriceGroup(priceMatch)) : 0;
      if (price > 0) supplierPrice = price;
    }

    const nameLines = bodyLines.filter((l) => {
      const t = l.trim();
      return t && !BOILERPLATE_LINE_PATTERN.test(t) && !STANDALONE_DIGITS_LINE_PATTERN.test(t);
    });
    let name = sanitizeProductName(nameLines.join(" ").trim());
    // Ver mesmo fallback em extractGridBlocks: sem nome de texto (comum
    // quando a descrição só existe gravada na foto), usa o SKU — melhor
    // que descartar o produto inteiro.
    if (!name) name = sku;
    if (name.length > MAX_PLAUSIBLE_NAME_LENGTH) name = name.slice(0, MAX_PLAUSIBLE_NAME_LENGTH).trim();

    rows.push({ ...(supplierPrice != null ? { sku, name, supplierPrice } : { sku, name }), lineIndex: index });
  }

  return rows;
}

/** Exportado pra teste unitário direto (sem posição, mesma interface de antes desta mudança) — ver parsePdfCatalog.test.ts. */
export function extractProductBlocksWithoutPrice(lines: string[]): CatalogRow[] {
  return extractProductBlocksWithoutPriceIndexed(lines).map(({ lineIndex: _lineIndex, ...row }) => row);
}

// ── Catálogo em GRADE (cartões) ──────────────────────────────────────
//
// Alguns catálogos (ex: fornecedores que exportam de um site pra PDF)
// não têm 1 produto por linha — têm N produtos por PÁGINA, em cartões
// lado a lado (ex: grade 3x3), cada cartão com "MODELO: <código>" no
// topo, foto, nome, bullets de característica, e "NPCS/CX Unid.CX:
// preço" no rodapé. `extractRowsIndexed` (1 linha = 1 produto) não dá
// conta disso — o nome fica numa linha, o preço em outra, bem abaixo,
// e a mesma linha Y da página tem 2-3 produtos diferentes lado a lado.
//
// Detecção: se alguma linha da página tem 2+ ocorrências de
// MODEL_LABEL_PATTERN, é uma "linha de cabeçalho" de grade — o X de
// cada ocorrência marca o INÍCIO de uma coluna (cartão). Página sem
// nenhuma linha assim usa o modo linha-única de sempre (sem mudança de
// comportamento pra catálogos em tabela).

// Gap mínimo (pt) entre o fim de um item e o começo do próximo pra
// considerar FRONTEIRA DE COLUNA (cartão novo), não só um espaço normal
// dentro do mesmo cartão. Dado real: maior gap intra-cartão observado
// (label→valor, ex: "60PCS/CX" → "Unid.CX:") ≈ 39pt; menor gap
// inter-cartão observado ≈ 80pt. 55pt fica seguro no meio.
const COLUMN_GAP_THRESHOLD = 55;
// Margem (pt) somada acima da linha "MODELO:" e abaixo da última linha
// da grade, pra não cortar o topo/rodapé do cartão nem vazar pro rodapé
// de navegação da página (ex: "VOLTAR", "Fale Conosco").
const ROW_BAND_MARGIN = 20;
const PAGE_FOOTER_MARGIN = 55;

interface GridColumn {
  xMin: number;
  xMax: number;
}

interface GridRowBand {
  yTop: number;
  yBottom: number;
}

/** Agrupa os X de início de coluna (um por ocorrência de MODEL_LABEL_PATTERN em cada linha-cabeçalho) em colunas canônicas da página — linhas diferentes têm um pequeno desvio de X entre si, then clusteriza com tolerância. */
function detectColumns(headerLinesItems: PositionedText[][], pageWidth: number): GridColumn[] | null {
  const columnStartXs: number[] = [];

  for (const lineItems of headerLinesItems) {
    // Fronteira de coluna = gap grande entre o fim de um item e o
    // início do próximo (ver COLUMN_GAP_THRESHOLD). O primeiro item da
    // linha sempre começa uma coluna.
    let prevEndX: number | null = null;
    for (const item of lineItems) {
      if (prevEndX == null || item.x - prevEndX > COLUMN_GAP_THRESHOLD) {
        columnStartXs.push(item.x);
      }
      prevEndX = item.x + item.width;
    }
  }

  if (columnStartXs.length === 0) return null;

  columnStartXs.sort((a, b) => a - b);
  const clustered: number[] = [];
  for (const x of columnStartXs) {
    const last = clustered[clustered.length - 1];
    if (last == null || x - last > 25) clustered.push(x);
    // Se estiver perto de um cluster existente, ignora (já representado).
  }

  if (clustered.length < 2) return null; // grade precisa de 2+ colunas

  // ⚠️ NÃO usar o ponto médio entre âncoras como fronteira: o rótulo
  // "MODELO:" fica na borda ESQUERDA do cartão, mas o conteúdo (preço,
  // "Unid.CX:") se estende bem mais pra direita, com frequência
  // ULTRAPASSANDO o ponto médio até a próxima coluna — mesmo ainda
  // pertencendo ao cartão atual (dado real: cartão de ~187pt de largura,
  // mas o valor do preço só some por volta de +150pt da própria âncora,
  // enquanto o ponto médio pra coluna vizinha cai em ~+94pt, cortando
  // o preço no meio e jogando ele pra coluna errada). A fronteira certa
  // fica perto do INÍCIO da PRÓXIMA coluna, não do meio do caminho.
  // MARGIN pequena porque a própria âncora varia ±1-3pt entre linhas
  // (jitter de posição do PDF) — sem ela, um item alinhado bem rente à
  // âncora podia cair fora por 1pt.
  const MARGIN = 10;
  return clustered.map((xStart, i) => ({
    xMin: i === 0 ? 0 : Math.max(0, xStart - MARGIN),
    xMax: i === clustered.length - 1 ? pageWidth : clustered[i + 1] - MARGIN,
  }));
}

export interface GridBlock {
  sku: string;
  name: string;
  supplierPrice: number;
  /** Bounding box do cartão em espaço PDF — usado pro recorte de imagem (ver cropGridBlock). */
  yTop: number;
  yBottom: number;
  xMin: number;
  xMax: number;
}

/**
 * Cartão de grade com MODELO/nome reconhecidos mas SEM preço legível (ver
 * findPriceInBlockLines) — carrega o mesmo bounding box de `GridBlock`
 * (pra permitir recorte de imagem e, se recuperado depois, virar produto
 * de verdade) mas nenhum `supplierPrice`. Existe especificamente pro caso
 * de correção via Gemini (ver extractCatalogPageWithGemini,
 * geminiCatalogVision.ts, e uso em `parsePdfCatalogFile`): páginas que
 * passaram por OCR podem ter o preço "invisível" pro Tesseract (banner
 * colorido/diagonal) mesmo com MODELO/nome lidos corretamente — sem esse
 * registro, o cartão seria descartado direto e não sobraria SKU nenhum
 * pra tentar recuperar.
 */
export interface GridBlockPriceless {
  sku: string;
  name: string;
  yTop: number;
  yBottom: number;
  xMin: number;
  xMax: number;
}

/** Acha, entre as linhas locais de UM cartão, a que contém o preço — prioriza linha com "Unid" (rótulo padrão desse tipo de catálogo) pra não confundir com preço promocional tipo "5CXS: 27,60". */
function findPriceInBlockLines(lines: PositionedLine[]): number | null {
  const withUnid = lines.filter((l) => /unid/i.test(l.text) && PRICE_PATTERN.test(l.text));
  const candidates = withUnid.length > 0 ? withUnid : lines.filter((l) => PRICE_PATTERN.test(l.text));
  if (candidates.length === 0) return null;

  const match = candidates[0].text.match(PRICE_PATTERN);
  if (!match) return null;
  const price = parseCurrency(extractPriceGroup(match));
  return price > 0 ? price : null;
}

/**
 * Extrai produtos de uma página em GRADE (ver comentário acima). Devolve
 * `null` se a página não parecer uma grade (sem linha de cabeçalho com
 * 2+ "MODELO:") — nesse caso o chamador cai pro modo linha-única normal.
 */
/** Exportado pra teste unitário direto com dados reais de x/y/width extraídos de PDF real — ver parsePdfCatalog.test.ts. */
export function extractGridBlocks(
  items: PositionedText[],
  pageWidth: number
): { blocks: GridBlock[]; skippedAmbiguous: number; priceless: GridBlockPriceless[] } | null {
  const lines = groupItemsIntoLines(items);

  const headerLines = lines.filter((lineItems) => {
    const text = joinLineText(lineItems);
    const matches = text.match(MODEL_LABEL_COUNT_PATTERN);
    return matches && matches.length >= 2;
  });

  if (headerLines.length === 0) return null;

  const columns = detectColumns(headerLines, pageWidth);
  if (!columns) return null;

  const headerYs = headerLines.map((l) => l[0].y).sort((a, b) => b - a); // desc: topo da página primeiro
  const rowHeights = headerYs.slice(0, -1).map((y, i) => y - headerYs[i + 1]);
  const avgRowHeight = rowHeights.length > 0 ? rowHeights.reduce((a, b) => a + b, 0) / rowHeights.length : 250;

  const rowBands: GridRowBand[] = headerYs.map((y, i) => ({
    yTop: y + ROW_BAND_MARGIN,
    yBottom: i === headerYs.length - 1 ? Math.max(PAGE_FOOTER_MARGIN, y - avgRowHeight) : headerYs[i + 1] + ROW_BAND_MARGIN,
  }));

  const blocks: GridBlock[] = [];
  const priceless: GridBlockPriceless[] = [];
  let skippedAmbiguous = 0;

  for (const row of rowBands) {
    for (const col of columns) {
      const blockItems = items.filter(
        (it) => it.x >= col.xMin && it.x < col.xMax && it.y <= row.yTop && it.y >= row.yBottom
      );
      if (blockItems.length === 0) continue;

      const blockLines = groupIntoLinesWithY(blockItems);
      const modelLine = blockLines.find((l) => MODEL_LABEL_PATTERN.test(l.text));
      if (!modelLine) continue; // pedaço de cartão sem rótulo de código (MODELO:/CÓD.) nesse recorte — provavelmente vazio/ruído

      const modelMatch = modelLine.text.match(MODEL_LABEL_PATTERN);
      const skuRaw = modelMatch?.[1]?.trim() ?? "";
      const skuCleanMatch = skuRaw.match(SKU_PATTERN);
      const sku = skuCleanMatch ? skuCleanMatch[1] : skuRaw;
      if (!sku) continue;

      // Nome calculado ANTES do preço de propósito: mesmo um cartão sem
      // preço legível (ver GridBlockPriceless acima) precisa do nome pra
      // virar produto de verdade se a correção via Gemini recuperar o
      // preço depois.
      const nameLines = blockLines.filter(
        (l) => l !== modelLine && !l.text.startsWith("•") && !PRICE_PATTERN.test(l.text) && !/^\d+\s?PCS\/CX$/i.test(l.text.trim())
      );
      // Catálogo em grade é o caso que MAIS sofre com lixo de OCR: o
      // cartão inteiro (selo, logo, textura) cai dentro do bounding box,
      // e todas as linhas viram "nome". sanitizeProductName corta os
      // fragmentos e fica com o maior trecho coerente — ver o bloco de
      // comentário acima da função.
      let name = sanitizeProductName(
        nameLines
          .map((l) => l.text)
          .join(" ")
          .trim()
      );
      // Nome baixado do PDF vem vazio quando o nome/descrição do
      // produto está "gravado" na própria foto (gráfico), não como
      // texto real — comum nesse tipo de catálogo. Cai pro SKU como
      // identificador (melhor que descartar o produto inteiro; a busca
      // por FOTO, se ativada, ainda funciona nesse caso).
      if (!name) name = sku;
      if (name.length > MAX_PLAUSIBLE_NAME_LENGTH) name = name.slice(0, MAX_PLAUSIBLE_NAME_LENGTH).trim();

      const price = findPriceInBlockLines(blockLines);
      if (price == null) {
        skippedAmbiguous++;
        priceless.push({ sku, name, yTop: row.yTop, yBottom: row.yBottom, xMin: col.xMin, xMax: col.xMax });
        continue;
      }

      blocks.push({ sku, name, supplierPrice: price, yTop: row.yTop, yBottom: row.yBottom, xMin: col.xMin, xMax: col.xMax });
    }
  }

  return { blocks, skippedAmbiguous, priceless };
}

// Resolução de renderização pro modo imagem — alta o bastante pra o
// Google Lens reconhecer o produto, sem gerar canvas gigante (a foto é
// recomprimida/redimensionada de qualquer forma antes do upload, ver
// catalogImages.ts). 2.0 é o dobro do "tamanho de tela" do PDF (72dpi
// base), suficiente pra a maioria dos catálogos.
const IMAGE_RENDER_SCALE = 2.0;

/** Renderiza uma página inteira num canvas — só usado no modo imagem. */
async function renderPageToCanvas(
  page: PdfjsPage,
  scale: number
): Promise<{ canvas: HTMLCanvasElement; viewport: PdfjsViewport }> {
  const viewport = page.getViewport({ scale });
  const canvas = document.createElement("canvas");
  canvas.width = Math.ceil(viewport.width);
  canvas.height = Math.ceil(viewport.height);
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new PdfParseError("Não consegui renderizar a página em canvas (contexto 2d indisponível).");
  await page.render({ canvasContext: ctx, viewport }).promise;
  return { canvas, viewport };
}

/**
 * Recorta, do canvas da página já renderizada, a faixa horizontal (toda
 * a largura, uma banda vertical) correspondente a cada linha aceita
 * como produto — usa o PONTO MÉDIO entre linhas vizinhas como fronteira
 * de cada banda, então ela cobre tanto o texto quanto qualquer foto
 * próxima daquela linha, sem precisar adivinhar uma altura fixa (layouts
 * de catálogo variam muito). Heurística, não recorte estruturado: se o
 * layout tiver a foto bem longe do texto correspondente, o recorte pode
 * não capturar a imagem certa — por isso o modo imagem é OPCIONAL, não
 * substitui a busca por texto.
 */
function cropRowBand(
  canvas: HTMLCanvasElement,
  viewport: PdfjsViewport,
  scale: number,
  lineYPdf: number,
  prevLineYPdf: number | null,
  nextLineYPdf: number | null
): HTMLCanvasElement {
  // PDF: y cresce pra cima. Canvas: y cresce pra baixo. y_pixel = (pageHeightPdf - y_pdf) * scale.
  const pageHeightPdf = viewport.height / scale;
  const toPixelY = (yPdf: number) => (pageHeightPdf - yPdf) * scale;

  const yPixel = toPixelY(lineYPdf);
  const boundAbove = prevLineYPdf != null ? (toPixelY(prevLineYPdf) + yPixel) / 2 : Math.max(0, yPixel - 60);
  const boundBelow =
    nextLineYPdf != null ? (yPixel + toPixelY(nextLineYPdf)) / 2 : Math.min(canvas.height, yPixel + 60);

  const sy = Math.max(0, Math.round(boundAbove));
  const sh = Math.max(1, Math.round(boundBelow) - sy);

  const cropped = document.createElement("canvas");
  cropped.width = canvas.width;
  cropped.height = sh;
  const ctx = cropped.getContext("2d");
  if (!ctx) throw new PdfParseError("Não consegui recortar a imagem (contexto 2d indisponível).");
  ctx.drawImage(canvas, 0, sy, canvas.width, sh, 0, 0, canvas.width, sh);
  return cropped;
}

// Teto de largura (px) da imagem mandada pro Gemini na correção de preço
// por página (ver geminiCatalogVision.ts) — INDEPENDENTE da resolução do
// canvas usado pro recorte de foto por produto (IMAGE_RENDER_SCALE=2.0,
// que precisa ficar alta pra qualidade da foto de referência). Ler
// "MODELO: BM-F1324" e um preço de banner não exige a mesma resolução
// que recortar uma foto de produto pra comparação visual — mandar o
// canvas inteiro (JPEG qualidade 0.92, ~1200×1700px numa página A4)
// pesava demais e vinha estourando o timeout de 45s em chamadas
// sequenciais (ver REQUEST_TIMEOUT_MS em geminiCatalogVision.ts,
// reportado pelo usuário: páginas 2 e 3 de um catálogo de 6 páginas
// deram timeout). Reduzir o payload aqui é estritamente sobre ESTA
// chamada — não afeta a foto que vai pro motor interno + IA.
const GEMINI_PAGE_MAX_WIDTH = 1400;

/**
 * Gera um JPEG menor (redimensionado) do canvas da página pra mandar ao
 * Gemini na correção de preço — ver GEMINI_PAGE_MAX_WIDTH acima pro
 * porquê. No-op de qualidade (não recorta nada, só reduz escala) — o
 * texto continua legível pro Gemini nessa resolução (testado com a
 * página real do usuário).
 */
function canvasToDownscaledJpegDataUrl(canvas: HTMLCanvasElement, maxWidth: number, quality: number): string {
  if (canvas.width <= maxWidth) return canvas.toDataURL("image/jpeg", quality);

  const scale = maxWidth / canvas.width;
  const small = document.createElement("canvas");
  small.width = Math.round(canvas.width * scale);
  small.height = Math.round(canvas.height * scale);
  const ctx = small.getContext("2d");
  if (!ctx) return canvas.toDataURL("image/jpeg", quality); // fallback: manda o tamanho original em vez de falhar
  ctx.drawImage(canvas, 0, 0, small.width, small.height);
  return small.toDataURL("image/jpeg", quality);
}

/**
 * Versão do recorte pra catálogo em GRADE (ver extractGridBlocks) — usa
 * o bounding box do CARTÃO inteiro (linha de coluna X + banda de linha
 * Y), não uma faixa de linha única. Mais preciso que cropRowBand nesse
 * caso: o bloco já sabe exatamente onde o cartão começa/termina nos
 * dois eixos, não precisa adivinhar altura fixa.
 */
function cropGridBlock(
  canvas: HTMLCanvasElement,
  viewport: PdfjsViewport,
  scale: number,
  block: Pick<GridBlock, "yTop" | "yBottom" | "xMin" | "xMax">
): HTMLCanvasElement {
  const pageHeightPdf = viewport.height / scale;
  const toPixelY = (yPdf: number) => (pageHeightPdf - yPdf) * scale;

  const sy = Math.max(0, Math.round(toPixelY(block.yTop)));
  const syBottom = Math.min(canvas.height, Math.round(toPixelY(block.yBottom)));
  const sh = Math.max(1, syBottom - sy);

  const sx = Math.max(0, Math.round(block.xMin * scale));
  const sxRight = Math.min(canvas.width, Math.round(block.xMax * scale));
  const sw = Math.max(1, sxRight - sx);

  const cropped = document.createElement("canvas");
  cropped.width = sw;
  cropped.height = sh;
  const ctx = cropped.getContext("2d");
  if (!ctx) throw new PdfParseError("Não consegui recortar a imagem (contexto 2d indisponível).");
  ctx.drawImage(canvas, sx, sy, sw, sh, 0, 0, sw, sh);
  return cropped;
}

/**
 * Recorte pra produto achado pela extração GENÉRICA via Gemini (ver
 * extractCatalogPageProductsWithGemini, geminiCatalogVision.ts) — usa
 * `box_2d` normalizado (0-1000, convenção nativa do Gemini pra detecção
 * de objeto), não coordenada PDF como `cropGridBlock`/`cropRowBand`
 * (aqueles vêm de posição de TEXTO extraída localmente, isto vem de
 * estimativa espacial da própria IA sobre a imagem que ela recebeu).
 * Normalizado = independente de resolução: aplica a mesma fração
 * diretamente no canvas de RENDER COMPLETO (`c`, IMAGE_RENDER_SCALE),
 * não no JPEG reduzido que foi mandado pro Gemini (GEMINI_PAGE_MAX_WIDTH)
 * — a foto final sai na resolução alta de sempre, só a ESTIMATIVA da
 * caixa veio de uma imagem menor.
 */
function cropNormalizedBox(
  canvas: HTMLCanvasElement,
  box: { yMin: number; xMin: number; yMax: number; xMax: number }
): HTMLCanvasElement {
  const toX = (v: number) => Math.round((v / 1000) * canvas.width);
  const toY = (v: number) => Math.round((v / 1000) * canvas.height);

  const sx = Math.max(0, toX(box.xMin));
  const sy = Math.max(0, toY(box.yMin));
  const sxRight = Math.min(canvas.width, toX(box.xMax));
  const syBottom = Math.min(canvas.height, toY(box.yMax));
  const sw = Math.max(1, sxRight - sx);
  const sh = Math.max(1, syBottom - sy);

  const cropped = document.createElement("canvas");
  cropped.width = sw;
  cropped.height = sh;
  const ctx = cropped.getContext("2d");
  if (!ctx) throw new PdfParseError("Não consegui recortar a imagem (contexto 2d indisponível).");
  ctx.drawImage(canvas, sx, sy, sw, sh, 0, 0, sw, sh);
  return cropped;
}

// ── OCR fallback (páginas sem NENHUMA camada de texto) ───────────────
//
// Descoberto via diagnóstico real (usuário mandou o PDF): alguns
// catálogos de fornecedor (exportados de ferramenta de design com
// fonte "outline"/vetorizada, ou scan de verdade) não têm UM SÓ
// caractere de texto extraível — `page.getTextContent()` devolve array
// vazio. Antes disso o parser só sabia falhar com "nenhum produto
// reconhecido". Só quando uma página não tem texto NENHUM, tentamos
// OCR (Tesseract.js, roda inteiro no navegador — sem chave de API,
// sem custo por página, mesmo padrão BYOK-free do resto do app) como
// último recurso. Página com texto real nunca passa por aqui — então
// catálogo que já funcionava continua bit-a-bit igual, zero risco de
// regressão pra esse caso (só o `if (items.length === 0)` abaixo).
//
// Tesseract.js é carregado sob demanda (mesmo padrão do pdfjs no topo
// deste arquivo) — quem nunca precisa de OCR não paga o peso do
// WASM/dado de idioma no bundle nem no tempo de carregamento.
interface TesseractBbox {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}
interface TesseractWord {
  text: string;
  bbox: TesseractBbox;
}
interface TesseractLine {
  bbox: TesseractBbox;
  words: TesseractWord[];
}
interface TesseractWorker {
  recognize: (image: HTMLCanvasElement) => Promise<{ data: { lines: TesseractLine[] } }>;
  terminate: () => Promise<unknown>;
}
interface TesseractModule {
  createWorker: (langs: string) => Promise<TesseractWorker>;
}

// Detecta celular/tablet só pra decidir o TETO de páginas de OCR por
// chamada (ver MAX_OCR_PAGES_PER_CALL abaixo) — não muda resolução de
// render nem precisão do OCR, só limita quanto trabalho pesado tenta
// rodar de uma vez num aparelho com CPU/memória bem mais fraca que
// notebook (risco real: navegador mobile — Safari iOS em especial —
// mata a aba que passa do teto de memória).
const isMobileDevice =
  typeof navigator !== "undefined" && /Mobi|Android|iPhone|iPad|iPod/i.test(navigator.userAgent);

// Teto de páginas que tentam OCR NUMA MESMA chamada de
// `parsePdfCatalogFile`. Proteção contra catálogo grande sem texto
// (centenas de página) travar a aba por minutos ou estourar memória —
// página que passa do teto simplesmente não tenta OCR (melhor um
// catálogo parcial do que a aba travar ou morrer). Menor em mobile de
// propósito (ver isMobileDevice acima). Usuário vê o aviso no console e
// pode reprocessar em intervalos menores pra cobrir o restante.
const MAX_OCR_PAGES_PER_CALL = isMobileDevice ? 10 : 25;

let tesseractWorkerPromise: Promise<TesseractWorker> | null = null;
async function getTesseractWorker(): Promise<TesseractWorker> {
  if (!tesseractWorkerPromise) {
    tesseractWorkerPromise = (async () => {
      const tesseract = (await import("tesseract.js")) as unknown as TesseractModule;
      // "por" — catálogos desse tipo trazem rótulo em português
      // ("MODELO:", "Unid.CX:"); dígito/preço não depende de idioma.
      return tesseract.createWorker("por");
    })();
  }
  return tesseractWorkerPromise;
}

/**
 * Roda OCR no canvas já renderizado da página e devolve no MESMO
 * formato `PositionedText[]` que `content.items` do pdfjs produziria —
 * é o que permite reaproveitar `extractGridBlocks`/`extractRowsIndexed`
 * SEM NENHUMA mudança nelas, como se o texto tivesse vindo do PDF de
 * verdade. Usa o Y da LINHA detectada pelo Tesseract (não da palavra
 * individual) pra todas as palavras daquela linha — bbox palavra-a-
 * palavra oscila alguns pixels por causa de descendente de fonte ("p",
 * "g"), o que quebraria o agrupamento por Y_TOLERANCE se cada palavra
 * carregasse o próprio Y.
 */
async function ocrPageToPositionedText(
  canvas: HTMLCanvasElement,
  viewport: PdfjsViewport,
  scale: number
): Promise<PositionedText[]> {
  const worker = await getTesseractWorker();
  const { data } = await worker.recognize(canvas);
  const pageHeightPdf = viewport.height / scale;

  const items: PositionedText[] = [];
  for (const line of data.lines ?? []) {
    const lineYPdf = pageHeightPdf - line.bbox.y1 / scale;
    for (const word of line.words ?? []) {
      const text = word.text?.trim();
      if (!text) continue;
      items.push({
        text,
        x: word.bbox.x0 / scale,
        width: (word.bbox.x1 - word.bbox.x0) / scale,
        y: lineYPdf,
      });
    }
  }
  return items;
}

export interface ParsePdfOptions {
  /**
   * Ativa o modo imagem: renderiza cada página e recorta/sobe (Firestore,
   * ver catalogImages.ts) uma foto de referência por produto detectado.
   * Exige `userId` (BYOK do modo imagem é por conta, mesmo padrão do
   * resto do app) e deixa o parse bem mais lento (renderização de página
   * inteira + upload por item) — por isso é opt-in, não default.
   */
  withImages?: boolean;
  userId?: string;
  /**
   * Chave Gemini própria do usuário (BYOK, mesma de Conta/motor interno +
   * IA) — quando presente, é usada pra CORRIGIR preço em páginas que
   * caíram no fallback de OCR e ficaram com produto sem preço legível
   * (ver GridBlockPriceless e geminiCatalogVision.ts). Opcional e só tem
   * efeito em página que precisou de OCR — catálogo com texto real nunca
   * aciona isso, zero custo/latência extra pro caso comum.
   */
  geminiApiKey?: string;
}

// Uploads de imagem em paralelo controlado — mesmo motivo de concorrência
// baixa dos providers de preço: não afogar a conexão com dezenas de
// writes simultâneos no Firestore.
const IMAGE_UPLOAD_CONCURRENCY = 4;

export async function parsePdfCatalogFile(
  file: File,
  range?: PageRange,
  options?: ParsePdfOptions
): Promise<ExtractResult> {
  const doc = await loadDocument(file);
  const from = Math.max(1, range?.from ?? 1);
  const to = Math.min(doc.numPages, range?.to ?? doc.numPages);

  if (from > to) {
    throw new PdfParseError(`Intervalo de páginas inválido (${from}–${to})`);
  }

  const withImages = Boolean(options?.withImages && options.userId);
  // Falha rápido e UMA vez, com motivo claro — sem isso, cada linha do
  // catálogo tentaria subir a própria foto e falharia pelo MESMO motivo
  // (localhost inalcançável pela SerpApi), engolido num console.warn por
  // item lá embaixo, e o usuário só veria o erro genérico "não consegui
  // extrair nenhuma foto" sem saber por quê.
  if (withImages) assertPubliclyReachable();

  const rows: CatalogRow[] = [];
  let skippedAmbiguous = 0;
  const imagesBySku: Record<string, string> = {};
  // Compartilhado entre páginas do MESMO catálogo — garante SKU sintético
  // único dentro deste upload; um novo Set por chamada de
  // parsePdfCatalogFile já isola catálogos diferentes um do outro (ver
  // skuFor acima).
  const seenSyntheticSkus = new Set<string>();
  // true se QUALQUER página do intervalo precisou cair pro fallback de
  // OCR (ver ocrPageToPositionedText) — só usado pra customizar a
  // mensagem de erro final, caso nenhuma página produza produto algum.
  let ocrAttempted = false;
  // Quantas páginas já TENTARAM OCR nesta chamada — ver MAX_OCR_PAGES_PER_CALL.
  let ocrPagesUsed = 0;
  // true se QUALQUER página precisou do fallback genérico de IA de visão
  // (ver extractCatalogPageProductsWithGemini) — só pra reportar no
  // ExtractResult final (usedGeminiPageExtraction).
  let geminiPageExtractionUsed = false;
  // true assim que o Gemini confirmar cota esgotada (RESOURCE_EXHAUSTED,
  // ver GeminiCatalogQuotaExhaustedError) — a partir daí, NENHUMA chamada
  // Gemini nova é tentada pro resto do catálogo (nem correção de preço
  // pós-OCR, nem extração genérica), pros dois usos deste arquivo.
  // Catálogo de centenas de páginas sem rótulo reconhecido bateria a
  // cota já na primeira e ficaria martelando as próximas sem chance
  // nenhuma de sucesso — só timeout/erro repetido gastando tempo.
  let geminiQuotaExhausted = false;
  // Páginas (número absoluto, 1-based) que não contribuíram NENHUM
  // produto — ver `pagesWithNoProducts` em ExtractResult pro porquê.
  const pagesWithNoProducts: number[] = [];

  // try/finally garante que o worker do Tesseract (WASM + dado de
  // idioma, alguns MB) é liberado ao final do processamento — mesmo se
  // o parse lançar erro no meio — em vez de ficar vivo indefinidamente
  // na memória da aba entre catálogos diferentes na mesma sessão.
  // `tesseractWorkerPromise` só existe se ALGUMA página precisou de OCR
  // (ver getTesseractWorker) — catálogo com texto normal nunca cria o
  // worker, então nunca paga esse custo de encerrar algo que não existe.
  try {
    for (let pageNum = from; pageNum <= to; pageNum++) {
      // Marca ANTES de processar a página — comparado com `rows.length`
      // no fim da iteração (ver `continue`s abaixo, todos passam por lá)
      // pra saber se ESTA página especificamente contribuiu algo.
      const rowsBeforePage = rows.length;
      const page = await doc.getPage(pageNum);
      const content = await page.getTextContent();
      // scale:1 só pra pegar a largura da página em pt — não renderiza
      // nada, é barato o bastante pra chamar sempre (mesmo fora do modo
      // imagem), precisa pra detecção de coluna da grade.
      const pageWidthPdf = page.getViewport({ scale: 1 }).width;

      let items: PositionedText[] = content.items
        .filter(
          (item): item is Required<Pick<PdfjsTextItem, "str" | "transform">> & Pick<PdfjsTextItem, "width"> =>
            Boolean(item.str?.trim() && item.transform)
        )
        .map((item) => ({
          text: item.str,
          x: item.transform[4],
          y: item.transform[5],
          width: item.width ?? 0,
        }));

      let canvas: HTMLCanvasElement | null = null;
      let viewport: PdfjsViewport | null = null;
      const ensureCanvas = async () => {
        if (!canvas || !viewport) {
          ({ canvas, viewport } = await renderPageToCanvas(page, IMAGE_RENDER_SCALE));
        }
        return { canvas, viewport };
      };

      // true só quando ESTA página precisou de OCR (diferente do
      // `ocrAttempted` de escopo do catálogo inteiro, usado só na
      // mensagem de erro final) — é o que decide se vale tentar a
      // correção de preço via Gemini logo abaixo: catálogo com texto real
      // nunca passa por aqui, então nunca paga esse custo extra.
      let pageUsedOcr = false;

      // Página sem NENHUM texto embutido (ver comentário de
      // ocrPageToPositionedText acima) — só entra aqui quando pdfjs não
      // achou nada; página com texto real nunca passa por este bloco.
      if (items.length === 0) {
        if (ocrPagesUsed >= MAX_OCR_PAGES_PER_CALL) {
          // Teto de segurança (ver MAX_OCR_PAGES_PER_CALL) — protege
          // celular/aparelho fraco de travar processando OCR página após
          // página sem limite. Página fica sem produtos reconhecidos;
          // usuário pode reprocessar um intervalo menor pra cobri-la.
          console.warn(
            `Página ${pageNum} sem texto ignorada — limite de ${MAX_OCR_PAGES_PER_CALL} páginas de OCR por processamento atingido.`
          );
        } else {
          ocrPagesUsed++;
          try {
            const { canvas: c, viewport: v } = await ensureCanvas();
            items = await ocrPageToPositionedText(c, v, IMAGE_RENDER_SCALE);
            if (items.length > 0) {
              ocrAttempted = true;
              pageUsedOcr = true;
            }
          } catch (err) {
            console.warn(`OCR falhou na página ${pageNum} (seguindo sem texto nesta página):`, err);
          }
        }
      }

      // Catálogo em GRADE (N cartões por página, ver extractGridBlocks) é
      // tentado primeiro; página sem esse padrão (sem 2+ "MODELO:" na
      // mesma linha) cai pro modo linha-única de sempre, sem mudança de
      // comportamento. Funciona igual pra texto real ou vindo do OCR
      // acima — os dois produzem o mesmo formato `PositionedText[]`.
      const grid = extractGridBlocks(items, pageWidthPdf);

      if (grid) {
        let gridSkippedAmbiguous = grid.skippedAmbiguous;
        const gridBlocks: GridBlock[] = [...grid.blocks];

        // Correção de preço via Gemini — só quando ESTA página passou
        // por OCR, sobrou pelo menos um cartão sem preço legível, e o
        // usuário tem chave própria configurada (BYOK, opcional). Ver
        // geminiCatalogVision.ts pro porquê: banner de preço
        // colorido/diagonal (comum nesse tipo de catálogo) é ilegível
        // pro Tesseract, mas não pra um modelo de visão. UMA chamada por
        // PÁGINA (não por produto) — reaproveita o canvas já renderizado
        // pro próprio OCR, sem custo de renderização extra.
        if (pageUsedOcr && grid.priceless.length > 0 && options?.geminiApiKey && !geminiQuotaExhausted) {
          try {
            const { canvas: c } = await ensureCanvas();
            const pageDataUrl = canvasToDownscaledJpegDataUrl(c, GEMINI_PAGE_MAX_WIDTH, 0.85);
            const geminiProducts = await extractCatalogPageWithGemini(pageDataUrl, options.geminiApiKey);
            const bySku = new Map(geminiProducts.map((p) => [normalizeSkuForMatch(p.sku), p]));

            for (const p of grid.priceless) {
              const match = bySku.get(normalizeSkuForMatch(p.sku));
              if (!match) continue; // Gemini não achou esse SKU na página — mantém como ambíguo, sem palpite

              if (!match.inStock || match.price == null) {
                // Esgotado/indisponível: é uma EXCLUSÃO real, não
                // ambiguidade — não faz sentido levar pro catálogo um
                // produto que a própria página marca como sem preço.
                gridSkippedAmbiguous--;
                continue;
              }

              gridBlocks.push({
                sku: p.sku,
                name: p.name,
                supplierPrice: match.price,
                yTop: p.yTop,
                yBottom: p.yBottom,
                xMin: p.xMin,
                xMax: p.xMax,
              });
              gridSkippedAmbiguous--;
            }
          } catch (err) {
            if (err instanceof GeminiCatalogQuotaExhaustedError) geminiQuotaExhausted = true;
            // Falha na correção (chave inválida, rede, cota) não derruba
            // o catálogo inteiro — os produtos ficam como ambíguos, mesmo
            // comportamento de antes dessa correção existir.
            console.warn(`Correção de preço via Gemini falhou na página ${pageNum} (seguindo sem ela):`, err);
          }
        }

        skippedAmbiguous += gridSkippedAmbiguous;
        rows.push(...gridBlocks.map(({ yTop: _yTop, yBottom: _yBottom, xMin: _xMin, xMax: _xMax, ...row }) => row));

        if (withImages && gridBlocks.length > 0) {
          const { canvas: c, viewport: v } = await ensureCanvas();
          await mapWithConcurrency(gridBlocks, IMAGE_UPLOAD_CONCURRENCY, async (block) => {
            try {
              const cropped = cropGridBlock(c!, v!, IMAGE_RENDER_SCALE, block);
              const url = await uploadCatalogImage(options!.userId!, block.sku, cropped);
              imagesBySku[block.sku] = url;
            } catch (err) {
              console.warn(`Falha ao extrair/subir imagem do produto "${block.sku}":`, err);
            }
          });
        }
        if (rows.length === rowsBeforePage) pagesWithNoProducts.push(pageNum);
        continue;
      }

      const pageLines = groupIntoLinesWithY(items);
      const { rows: pageRows, skippedAmbiguous: pageSkipped } = extractRowsIndexed(
        pageLines.map((l) => l.text),
        seenSyntheticSkus
      );
      skippedAmbiguous += pageSkipped;

      if (pageRows.length > 0) {
        rows.push(...pageRows.map(({ lineIndex: _lineIndex, ...row }) => row));

        if (withImages) {
          const { canvas: c, viewport: v } = await ensureCanvas();

          await mapWithConcurrency(pageRows, IMAGE_UPLOAD_CONCURRENCY, async (row) => {
            try {
              const prevY = row.lineIndex > 0 ? pageLines[row.lineIndex - 1].y : null;
              const nextY = row.lineIndex < pageLines.length - 1 ? pageLines[row.lineIndex + 1].y : null;
              const cropped = cropRowBand(c!, v!, IMAGE_RENDER_SCALE, pageLines[row.lineIndex].y, prevY, nextY);
              const url = await uploadCatalogImage(options!.userId!, row.sku, cropped);
              imagesBySku[row.sku] = url;
            } catch (err) {
              // Falha em UM item (upload, recorte) não derruba o catálogo
              // inteiro — esse produto só fica sem imagem, busca por texto
              // continua disponível pra ele.
              console.warn(`Falha ao extrair/subir imagem do produto "${row.sku}":`, err);
            }
          });
        }
      } else {
        // Nem grade nem linha-única acharam produto nesta página —
        // próximo recurso ANTES da IA: layout "vitrine" sem preço (ver
        // extractProductBlocksWithoutPriceIndexed acima). Suporte a foto
        // (ago/2026, confirmado com PDF real — Catálogo TOPUTIL/DL Grupo,
        // o mesmo layout que motivou este heurístico): cada marcador de
        // SKU já tem posição Y conhecida, então o recorte usa o mesmo
        // `cropRowBand` do layout linha-única, com o marcador ANTERIOR/
        // PRÓXIMO como limite (não a linha de texto adjacente — o bloco
        // aqui tem várias linhas, precisa da posição do PRODUTO vizinho,
        // não da linha vizinha).
        const noPriceRowsIndexed = extractProductBlocksWithoutPriceIndexed(pageLines.map((l) => l.text));

        if (noPriceRowsIndexed.length > 0) {
          rows.push(...noPriceRowsIndexed.map(({ lineIndex: _lineIndex, ...row }) => row));

          if (withImages) {
            const { canvas: c, viewport: v } = await ensureCanvas();
            const cropTargets = noPriceRowsIndexed.map((row, i) => ({
              row,
              prevY: i > 0 ? pageLines[noPriceRowsIndexed[i - 1].lineIndex].y : null,
              nextY:
                i < noPriceRowsIndexed.length - 1 ? pageLines[noPriceRowsIndexed[i + 1].lineIndex].y : null,
            }));
            await mapWithConcurrency(cropTargets, IMAGE_UPLOAD_CONCURRENCY, async ({ row, prevY, nextY }) => {
              try {
                const cropped = cropRowBand(c!, v!, IMAGE_RENDER_SCALE, pageLines[row.lineIndex].y, prevY, nextY);
                const url = await uploadCatalogImage(options!.userId!, row.sku, cropped);
                imagesBySku[row.sku] = url;
              } catch (err) {
                console.warn(`Falha ao extrair/subir imagem do produto "${row.sku}" (layout vitrine sem preço):`, err);
              }
            });
          }
        } else if (options?.geminiApiKey && !geminiQuotaExhausted) {
          // ÚLTIMO recurso de todos: NENHUMA heurística (grade com rótulo
          // conhecido, linha única, bloco sem preço) reconheceu produto
          // algum nesta página — em vez de desistir, manda a página
          // inteira pra IA de visão ler como um humano leria, sem
          // depender de rótulo/layout conhecido (ver
          // extractCatalogPageProductsWithGemini, geminiCatalogVision.ts,
          // e o comentário no topo daquele arquivo pro porquê). Opt-in
          // (só roda com chave Gemini própria configurada, BYOK) e
          // opt-out automático assim que a cota esgotar (ver
          // geminiQuotaExhausted acima) — sem isso, um catálogo de
          // centenas de páginas com layout desconhecido bateria a cota
          // na primeira e ficaria martelando o resto sem chance nenhuma.
          //
          // Suporte a foto (ago/2026) — antes "v1" não tinha: um catálogo
          // real que só reconhecia produto por AQUI (grade+linha não
          // bateram em nada) ficava com `imagesBySku` sempre vazio,
          // travando qualquer provider de foto com "não consegui extrair
          // nenhuma foto" mesmo com modo imagem selecionado ANTES do
          // upload. Ver box_2d em geminiCatalogVision.ts (a própria IA
          // estima a caixa da foto, normalizada) e cropNormalizedBox
          // acima. Continua best-effort: produto sem `box` (IA não
          // confiante o bastante) ainda entra pra busca por texto, só
          // sem imagem — nenhuma regressão pro comportamento antigo.
          try {
            const { canvas: c } = await ensureCanvas();
            const pageDataUrl = canvasToDownscaledJpegDataUrl(c, GEMINI_PAGE_MAX_WIDTH, 0.85);
            const geminiProducts = await extractCatalogPageProductsWithGemini(pageDataUrl, options.geminiApiKey);

            if (geminiProducts.length > 0) {
              geminiPageExtractionUsed = true;
              const inStockProducts = geminiProducts.filter((p) => p.inStock);
              rows.push(
                ...inStockProducts.map((p) =>
                  p.price != null
                    ? { sku: p.sku, name: p.name, supplierPrice: p.price }
                    : { sku: p.sku, name: p.name } // sem preço legível — vira "sem_custo" mais adiante (marginCalculator.ts)
                )
              );

              if (withImages) {
                const withBox = inStockProducts.filter((p) => p.box);
                await mapWithConcurrency(withBox, IMAGE_UPLOAD_CONCURRENCY, async (p) => {
                  try {
                    const cropped = cropNormalizedBox(c!, p.box!);
                    const url = await uploadCatalogImage(options!.userId!, p.sku, cropped);
                    imagesBySku[p.sku] = url;
                  } catch (err) {
                    console.warn(`Falha ao extrair/subir imagem do produto "${p.sku}" (extração genérica via IA):`, err);
                  }
                });
              }
            }
          } catch (err) {
            if (err instanceof GeminiCatalogQuotaExhaustedError) geminiQuotaExhausted = true;
            // Mesma filosofia do resto do parser: falha numa página (rede,
            // chave inválida, cota) não derruba o catálogo inteiro — essa
            // página só fica sem produto, as outras seguem tentando.
            console.warn(`Leitura genérica via IA falhou na página ${pageNum} (seguindo sem ela):`, err);
          }
        }
      }

      if (rows.length === rowsBeforePage) pagesWithNoProducts.push(pageNum);
    }

    if (rows.length === 0) {
      // Complementa a mensagem de sempre com o que aconteceu (ou não)
      // com o fallback de IA — sem isso, quem já tem chave Gemini
      // configurada não sabe se ela chegou a ser tentada.
      const geminiHint = !options?.geminiApiKey
        ? " Configure sua chave Gemini própria em Conta pra habilitar uma leitura genérica por IA " +
          "como último recurso, útil quando o layout do catálogo é fora do padrão."
        : geminiQuotaExhausted
          ? " Tentamos ler via IA (Gemini) como último recurso, mas a cota gratuita esgotou antes de " +
            "conseguir — tente de novo em alguns minutos ou reprocesse um intervalo de páginas menor."
          : " Tentamos ler via IA (Gemini) como último recurso, mas ela também não conseguiu " +
            "identificar produto nenhum nas páginas processadas.";

      throw new PdfParseError(
        (ocrAttempted
          ? `Nenhum produto reconhecido nas páginas ${from}–${to} mesmo com OCR (este PDF não tem ` +
            "texto embutido, então tentamos ler por OCR). O layout pode ser complexo demais, ou a " +
            "qualidade da página renderizada ficou baixa demais pro OCR reconhecer."
          : `Nenhum produto reconhecido nas páginas ${from}–${to}. Se for texto real, o layout pode ` +
            "não bater com o padrão esperado (linha com nome + preço).") + geminiHint
      );
    }

    return {
      rows,
      skippedAmbiguous,
      imagesBySku: withImages ? imagesBySku : undefined,
      usedOcr: ocrAttempted,
      usedGeminiPageExtraction: geminiPageExtractionUsed,
      pagesWithNoProducts: pagesWithNoProducts.length > 0 ? pagesWithNoProducts : undefined,
    };
  } finally {
    // Libera o worker do Tesseract (WASM + dado de idioma "por", alguns MB
    // de memória) assim que este catálogo termina de processar — evita
    // acúmulo indefinido na aba se o usuário sobe vários catálogos na
    // mesma sessão. Só existe algo a liberar se ALGUMA página deste
    // catálogo (ou de um catálogo anterior na mesma sessão) precisou de
    // OCR; catálogo com texto real nunca cria o worker (ver
    // getTesseractWorker) e este bloco vira no-op.
    if (tesseractWorkerPromise) {
      const promise = tesseractWorkerPromise;
      tesseractWorkerPromise = null;
      void promise.then((w) => w.terminate()).catch(() => {});
    }
  }
}
