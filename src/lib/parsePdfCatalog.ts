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
  y: number;
}

interface PositionedLine {
  text: string;
  /** Em espaço PDF (y cresce pra CIMA), não pixel de canvas. */
  y: number;
}

const Y_TOLERANCE = 3;

/**
 * Agrupa itens de texto (posicionados em x/y) em linhas, na ordem
 * visual — versão com posição Y da linha (não só o texto), usada pelo
 * modo imagem pra recortar a faixa da página correspondente a cada
 * linha (ver cropRowBand). Substituiu uma versão anterior que só
 * devolvia `string[]` (sem posição) — todo call site já usa esta.
 */
function groupIntoLinesWithY(items: PositionedText[]): PositionedLine[] {
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

  return lines
    .map((line) => ({
      text: line
        .sort((a, b) => a.x - b.x)
        .map((i) => i.text)
        .join(" ")
        .replace(/\s+/g, " ")
        .trim(),
      y: line[0].y,
    }))
    .filter((l) => l.text);
}

// Preço: 3 formatos aceitos —
//   1. "R$ 1.234,56" ou "R$ 3800" (com "R$", decimal OPCIONAL — o "R$"
//      é o que desambigua um número solto de um SKU/quantidade na
//      mesma linha; sem "R$" na frente, um inteiro puro tipo "1200"
//      fica ambíguo demais pra virar preço com segurança)
//   2. "1234,56" (BR, decimal com vírgula, sem precisar de "R$")
//   3. "1234.56" (US, decimal com ponto, sem precisar de "R$")
// Preço tipo "POR 1200" (sem "R$" e sem decimal) continua fora do
// escopo — ver aviso no card de Catálogo do Dashboard.
const PRICE_PATTERN =
  /R\$\s?(\d{1,3}(?:\.\d{3})+(?:,\d{2})?|\d+(?:,\d{2})?)|(\d{1,3}(?:\.\d{3})*,\d{2})|(\d+\.\d{2})/;
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
// Acima disso, o "nome" quase certamente é lixo de mais de uma coluna
// mesclada, não um nome de produto real.
const MAX_PLAUSIBLE_NAME_LENGTH = 120;

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
function extractRowsIndexed(lines: string[], syntheticSkuOffset = 0): IndexedExtractResult {
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
    const sku = skuMatch ? skuMatch[1] : `PDF-${syntheticSkuOffset + rows.length + 1}`;
    const name = (skuMatch ? withoutPrice.replace(skuMatch[0], "") : withoutPrice).trim();

    if (!name || name.length > MAX_PLAUSIBLE_NAME_LENGTH) {
      skippedAmbiguous++;
      return;
    }

    rows.push({ sku, name, supplierPrice: price, lineIndex });
  });

  return { rows, skippedAmbiguous };
}

/** Exportado pra teste unitário direto (sem precisar montar um PDF de verdade) — ver parsePdfCatalog.test.ts. */
export function extractRows(lines: string[]): ExtractResult {
  const { rows, skippedAmbiguous } = extractRowsIndexed(lines);
  return { rows: rows.map(({ lineIndex: _lineIndex, ...row }) => row), skippedAmbiguous };
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

  for (let pageNum = from; pageNum <= to; pageNum++) {
    const page = await doc.getPage(pageNum);
    const content = await page.getTextContent();

    const items: PositionedText[] = content.items
      .filter((item): item is Required<Pick<PdfjsTextItem, "str" | "transform">> =>
        Boolean(item.str?.trim() && item.transform)
      )
      .map((item) => ({
        text: item.str,
        x: item.transform[4],
        y: item.transform[5],
      }));

    const pageLines = groupIntoLinesWithY(items);
    const { rows: pageRows, skippedAmbiguous: pageSkipped } = extractRowsIndexed(
      pageLines.map((l) => l.text),
      rows.length // offset — sku sintético "PDF-N" fica único entre páginas
    );
    skippedAmbiguous += pageSkipped;
    rows.push(...pageRows.map(({ lineIndex: _lineIndex, ...row }) => row));

    if (withImages && pageRows.length > 0) {
      const { canvas, viewport } = await renderPageToCanvas(page, IMAGE_RENDER_SCALE);

      await mapWithConcurrency(pageRows, IMAGE_UPLOAD_CONCURRENCY, async (row) => {
        try {
          const prevY = row.lineIndex > 0 ? pageLines[row.lineIndex - 1].y : null;
          const nextY = row.lineIndex < pageLines.length - 1 ? pageLines[row.lineIndex + 1].y : null;
          const cropped = cropRowBand(
            canvas,
            viewport,
            IMAGE_RENDER_SCALE,
            pageLines[row.lineIndex].y,
            prevY,
            nextY
          );
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
      `Nenhum produto reconhecido nas páginas ${from}–${to}. Se o PDF for escaneado (imagem), ` +
        "este parser não funciona — precisaria de OCR. Se for texto real, o layout pode não bater " +
        "com o padrão esperado (linha com nome + preço)."
    );
  }

  return {
    rows,
    skippedAmbiguous,
    imagesBySku: withImages ? imagesBySku : undefined,
  };
}
