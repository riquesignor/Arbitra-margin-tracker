import type { CatalogRow } from "../types";
import { parseCurrency } from "./parseCatalog";
import { mapWithConcurrency } from "./concurrency";
import { assertPubliclyReachable, uploadCatalogImage } from "./catalogImages";

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
// Label explícito de código de produto usado por catálogos em grade
// (ver extractGridBlocks) — "MODELO: BMG-50", às vezes sem espaço antes
// dos dois pontos ou com dois-pontos ausente.
const MODEL_LABEL_PATTERN = /MODELO:?\s*(.+)/i;
// Versão SEM captura gulosa, só pra CONTAR quantas vezes o label
// aparece numa linha (ver detecção de cabeçalho de grade) — o `(.+)` de
// MODEL_LABEL_PATTERN é ilimitado à direita, então com flag global ele
// devora a linha inteira na 1ª ocorrência e nunca acha uma 2ª.
const MODEL_LABEL_COUNT_PATTERN = /MODELO:?/gi;
// Acima disso, o "nome" quase certamente é lixo de mais de uma coluna
// mesclada, não um nome de produto real.
const MAX_PLAUSIBLE_NAME_LENGTH = 120;

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
}

/**
 * ⚠️ Heurística, não parser estruturado. Cada linha de texto vira um
 * produto se tiver exatamente UM padrão de preço reconhecível; SKU é o
 * primeiro código "tipo SKU" na linha (ou um id sequencial se não
 * achar); nome é o que sobra. Funciona bem pra catálogos com uma linha
 * de texto por produto.
 *
 * Linha com MAIS de um preço (ex: "30PCS/CX Unid.CX: 24PCS/CX
 * Unid.CX: 32,00 5 0PCS/CX Unid.CX:23,00") normalmente é célula de
 * tabela multi-coluna que o agrupamento por Y colou numa linha só —
 * nesse caso não dá pra saber com segurança qual preço é de qual
 * produto, então a linha é DESCARTADA (não vira produto com nome
 * corrompido) e contada em `skippedAmbiguous`, reportado ao usuário.
 * Preferir "faltou um produto" a "produto com nome ilegível".
 *
 * Layouts multi-coluna persistentes, tabelas com célula de preço muito
 * distante do nome, ou PDFs escaneados (sem camada de texto — pdfjs não
 * extrai nada) continuam fora do escopo deste heurístico — precisariam
 * de parser de tabela real ou OCR.
 */
interface IndexedExtractResult {
  rows: (CatalogRow & { lineIndex: number })[];
  skippedAmbiguous: number;
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
      skippedAmbiguous++;
      return;
    }

    const priceMatch = line.match(PRICE_PATTERN);
    if (!priceMatch) return;

    const price = parseCurrency(extractPriceGroup(priceMatch));
    if (price <= 0) return;

    const withoutPrice = line.replace(priceMatch[0], "").trim();
    const skuMatch = withoutPrice.match(SKU_PATTERN);
    const name = (skuMatch ? withoutPrice.replace(skuMatch[0], "") : withoutPrice).trim();

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
): { blocks: GridBlock[]; skippedAmbiguous: number } | null {
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
  let skippedAmbiguous = 0;

  for (const row of rowBands) {
    for (const col of columns) {
      const blockItems = items.filter(
        (it) => it.x >= col.xMin && it.x < col.xMax && it.y <= row.yTop && it.y >= row.yBottom
      );
      if (blockItems.length === 0) continue;

      const blockLines = groupIntoLinesWithY(blockItems);
      const modelLine = blockLines.find((l) => MODEL_LABEL_PATTERN.test(l.text));
      if (!modelLine) continue; // pedaço de cartão sem "MODELO:" nesse recorte — provavelmente vazio/ruído

      const modelMatch = modelLine.text.match(MODEL_LABEL_PATTERN);
      const skuRaw = modelMatch?.[1]?.trim() ?? "";
      const skuCleanMatch = skuRaw.match(SKU_PATTERN);
      const sku = skuCleanMatch ? skuCleanMatch[1] : skuRaw;
      if (!sku) continue;

      const price = findPriceInBlockLines(blockLines);
      if (price == null) {
        skippedAmbiguous++;
        continue;
      }

      const nameLines = blockLines.filter(
        (l) => l !== modelLine && !l.text.startsWith("•") && !PRICE_PATTERN.test(l.text) && !/^\d+\s?PCS\/CX$/i.test(l.text.trim())
      );
      let name = nameLines
        .map((l) => l.text)
        .join(" ")
        .trim();
      // Nome baixado do PDF vem vazio quando o nome/descrição do
      // produto está "gravado" na própria foto (gráfico), não como
      // texto real — comum nesse tipo de catálogo. Cai pro SKU como
      // identificador (melhor que descartar o produto inteiro; a busca
      // por FOTO, se ativada, ainda funciona nesse caso).
      if (!name) name = sku;
      if (name.length > MAX_PLAUSIBLE_NAME_LENGTH) name = name.slice(0, MAX_PLAUSIBLE_NAME_LENGTH).trim();

      blocks.push({ sku, name, supplierPrice: price, yTop: row.yTop, yBottom: row.yBottom, xMin: col.xMin, xMax: col.xMax });
    }
  }

  return { blocks, skippedAmbiguous };
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

  for (let pageNum = from; pageNum <= to; pageNum++) {
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

    // Página sem NENHUM texto embutido (ver comentário de
    // ocrPageToPositionedText acima) — só entra aqui quando pdfjs não
    // achou nada; página com texto real nunca passa por este bloco.
    if (items.length === 0) {
      try {
        const { canvas: c, viewport: v } = await ensureCanvas();
        items = await ocrPageToPositionedText(c, v, IMAGE_RENDER_SCALE);
        if (items.length > 0) ocrAttempted = true;
      } catch (err) {
        console.warn(`OCR falhou na página ${pageNum} (seguindo sem texto nesta página):`, err);
      }
    }

    // Catálogo em GRADE (N cartões por página, ver extractGridBlocks) é
    // tentado primeiro; página sem esse padrão (sem 2+ "MODELO:" na
    // mesma linha) cai pro modo linha-única de sempre, sem mudança de
    // comportamento. Funciona igual pra texto real ou vindo do OCR
    // acima — os dois produzem o mesmo formato `PositionedText[]`.
    const grid = extractGridBlocks(items, pageWidthPdf);

    if (grid) {
      skippedAmbiguous += grid.skippedAmbiguous;
      rows.push(...grid.blocks.map(({ yTop: _yTop, yBottom: _yBottom, xMin: _xMin, xMax: _xMax, ...row }) => row));

      if (withImages && grid.blocks.length > 0) {
        const { canvas: c, viewport: v } = await ensureCanvas();
        await mapWithConcurrency(grid.blocks, IMAGE_UPLOAD_CONCURRENCY, async (block) => {
          try {
            const cropped = cropGridBlock(c!, v!, IMAGE_RENDER_SCALE, block);
            const url = await uploadCatalogImage(options!.userId!, block.sku, cropped);
            imagesBySku[block.sku] = url;
          } catch (err) {
            console.warn(`Falha ao extrair/subir imagem do produto "${block.sku}":`, err);
          }
        });
      }
      continue;
    }

    const pageLines = groupIntoLinesWithY(items);
    const { rows: pageRows, skippedAmbiguous: pageSkipped } = extractRowsIndexed(
      pageLines.map((l) => l.text),
      seenSyntheticSkus
    );
    skippedAmbiguous += pageSkipped;
    rows.push(...pageRows.map(({ lineIndex: _lineIndex, ...row }) => row));

    if (withImages && pageRows.length > 0) {
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
  }

  if (rows.length === 0) {
    throw new PdfParseError(
      ocrAttempted
        ? `Nenhum produto reconhecido nas páginas ${from}–${to} mesmo com OCR (este PDF não tem ` +
          "texto embutido, então tentamos ler por OCR). O layout pode ser complexo demais, ou a " +
          "qualidade da página renderizada ficou baixa demais pro OCR reconhecer — tente um " +
          "intervalo de páginas menor ou confira se o catálogo segue o padrão esperado (nome + preço " +
          "por produto)."
        : `Nenhum produto reconhecido nas páginas ${from}–${to}. Se for texto real, o layout pode ` +
          "não bater com o padrão esperado (linha com nome + preço)."
    );
  }

  return {
    rows,
    skippedAmbiguous,
    imagesBySku: withImages ? imagesBySku : undefined,
  };
}
