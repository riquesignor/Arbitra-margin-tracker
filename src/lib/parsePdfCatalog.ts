import type { CatalogRow } from "../types";
import { parseCurrency } from "./parseCatalog";

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

interface PdfjsPage {
  getTextContent: () => Promise<{ items: PdfjsTextItem[] }>;
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

const Y_TOLERANCE = 3;

/** Agrupa itens de texto (posicionados em x/y) em linhas, na ordem visual. */
function groupIntoLines(items: PositionedText[]): string[] {
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
    .map((line) =>
      line
        .sort((a, b) => a.x - b.x)
        .map((i) => i.text)
        .join(" ")
        .replace(/\s+/g, " ")
        .trim()
    )
    .filter(Boolean);
}

// Preço: "R$ 1.234,56", "1234,56" ou "1234.56"
const PRICE_PATTERN = /R?\$?\s?(\d{1,3}(?:\.\d{3})*,\d{2}|\d+\.\d{2})/;
const PRICE_PATTERN_GLOBAL = new RegExp(PRICE_PATTERN.source, "g");
// SKU: código tipo "SKU-001", "REF12345" ou sequência de 4+ dígitos
const SKU_PATTERN = /\b([A-Z]{2,}[-\s]?\d{2,}|\d{4,})\b/;
// Acima disso, o "nome" quase certamente é lixo de mais de uma coluna
// mesclada, não um nome de produto real.
const MAX_PLAUSIBLE_NAME_LENGTH = 120;

export interface ExtractResult {
  rows: CatalogRow[];
  skippedAmbiguous: number;
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
/** Exportado pra teste unitário direto (sem precisar montar um PDF de verdade) — ver parsePdfCatalog.test.ts. */
export function extractRows(lines: string[]): ExtractResult {
  const rows: CatalogRow[] = [];
  let skippedAmbiguous = 0;

  for (const line of lines) {
    const priceMatches = line.match(PRICE_PATTERN_GLOBAL);
    if (!priceMatches || priceMatches.length === 0) continue;

    if (priceMatches.length > 1) {
      skippedAmbiguous++;
      continue;
    }

    const priceMatch = line.match(PRICE_PATTERN);
    if (!priceMatch) continue;

    const price = parseCurrency(priceMatch[1]);
    if (price <= 0) continue;

    const withoutPrice = line.replace(priceMatch[0], "").trim();
    const skuMatch = withoutPrice.match(SKU_PATTERN);
    const sku = skuMatch ? skuMatch[1] : `PDF-${rows.length + 1}`;
    const name = (skuMatch ? withoutPrice.replace(skuMatch[0], "") : withoutPrice).trim();

    if (!name || name.length > MAX_PLAUSIBLE_NAME_LENGTH) {
      skippedAmbiguous++;
      continue;
    }

    rows.push({ sku, name, supplierPrice: price });
  }

  return { rows, skippedAmbiguous };
}

export async function parsePdfCatalogFile(file: File, range?: PageRange): Promise<ExtractResult> {
  const doc = await loadDocument(file);
  const from = Math.max(1, range?.from ?? 1);
  const to = Math.min(doc.numPages, range?.to ?? doc.numPages);

  if (from > to) {
    throw new PdfParseError(`Intervalo de páginas inválido (${from}–${to})`);
  }

  const allLines: string[] = [];

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

    allLines.push(...groupIntoLines(items));
  }

  const result = extractRows(allLines);

  if (result.rows.length === 0) {
    throw new PdfParseError(
      `Nenhum produto reconhecido nas páginas ${from}–${to}. Se o PDF for escaneado (imagem), ` +
        "este parser não funciona — precisaria de OCR. Se for texto real, o layout pode não bater " +
        "com o padrão esperado (linha com nome + preço)."
    );
  }

  return result;
}
