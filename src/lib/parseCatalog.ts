import Papa from "papaparse";
import type { CatalogRow } from "../types";
import { dedupeCatalogRows } from "./catalogRows";
import { readXlsxSheet } from "./xlsxReader";

/**
 * Detecção fuzzy de colunas: aceita variações comuns de nomenclatura em
 * catálogos de fornecedor (PT-BR, com/sem acento).
 *
 * Nota (extensibilidade): parsing de .xlsx (SheetJS) entra aqui depois,
 * como um segundo branch por extensão de arquivo. Não instalar `xlsx` via
 * npm — a versão publicada tem 2 CVEs sem correção (prototype pollution +
 * ReDoS). Usar o tarball do CDN oficial:
 *   npm install https://cdn.sheetjs.com/xlsx-0.20.3/xlsx-0.20.3.tgz
 * Ver docs/adr/0001-marketplace-adapter-pattern.md > Riscos herdados.
 */

const SKU_ALIASES = ["sku", "codigo", "código", "cod"];
const NAME_ALIASES = ["nome", "produto", "name", "descricao", "descrição"];
const PRICE_ALIASES = ["custo", "preco", "preço", "price", "cost", "valor"];

const DIACRITICS_REGEX = new RegExp("[\\u0300-\\u036f]", "g");

function normalizeHeader(header: string): string {
  return header
    .trim()
    .toLowerCase()
    .normalize("NFD")
    .replace(DIACRITICS_REGEX, ""); // remove acentos
}

function findColumn(headers: string[], aliases: string[]): string | undefined {
  const normalized = headers.map((h) => ({ original: h, normalized: normalizeHeader(h) }));
  const normalizedAliases = aliases.map(normalizeHeader);
  const match = normalized.find((h) => normalizedAliases.includes(h.normalized));
  return match?.original;
}

/** Converte formatos BR ("R$ 1.234,56") e US ("1234.56") pra number. */
export function parseCurrency(raw: string | number): number {
  if (typeof raw === "number") return raw;
  const cleaned = raw.replace(/R\$\s?/g, "").trim();

  if (/,\d{1,2}$/.test(cleaned)) {
    // formato BR: milhar com ponto, decimal com vírgula
    return Number(cleaned.replace(/\./g, "").replace(",", ".")) || 0;
  }
  return Number(cleaned.replace(/,/g, "")) || 0;
}

export class CatalogParseError extends Error {}

/**
 * Converte a matriz crua (cabeçalho + linhas) em `CatalogRow[]`, achando
 * as colunas pela mesma detecção fuzzy do CSV. Compartilhado entre CSV e
 * XLSX de propósito: são formatos de transporte diferentes pro MESMO
 * conteúdo, e ter duas detecções de coluna divergindo com o tempo seria
 * uma fonte silenciosa de "no CSV funciona, no Excel não".
 */
function rowsFromMatrix(headers: string[], dataRows: string[][]): CatalogRow[] {
  const skuCol = findColumn(headers, SKU_ALIASES);
  const nameCol = findColumn(headers, NAME_ALIASES);
  const priceCol = findColumn(headers, PRICE_ALIASES);

  if (!skuCol || !priceCol) {
    throw new CatalogParseError(
      `Não encontrei colunas de SKU e/ou custo. Colunas detectadas: ${headers.join(", ")}`
    );
  }

  const skuIndex = headers.indexOf(skuCol);
  const nameIndex = nameCol ? headers.indexOf(nameCol) : -1;
  const priceIndex = headers.indexOf(priceCol);

  return dataRows
    .filter((row) => row[skuIndex]?.trim())
    .map((row) => ({
      sku: row[skuIndex].trim(),
      name: nameIndex >= 0 ? row[nameIndex]?.trim() ?? "" : "",
      supplierPrice: parseCurrency(row[priceIndex] ?? "0"),
    }));
}

export async function parseCatalogFile(file: File): Promise<CatalogRow[]> {
  const extension = file.name.split(".").pop()?.toLowerCase();

  // .xlsx/.xlsm (set/2026, ver xlsxReader.ts): fornecedor manda planilha
  // direto o tempo todo — antes disso o usuário precisava reexportar como
  // CSV antes de conseguir usar o app. Lido sem dependência nova (o
  // pacote `xlsx` do npm tem CVEs abertas, ver nota no topo).
  if (extension === "xlsx" || extension === "xlsm") {
    const [headerRow = [], ...dataRows] = await readXlsxSheet(await file.arrayBuffer());

    if (headerRow.length === 0) {
      throw new CatalogParseError("A primeira planilha do arquivo está vazia.");
    }

    return dedupeCatalogRows(rowsFromMatrix(headerRow, dataRows)).rows;
  }

  if (extension !== "csv") {
    throw new CatalogParseError(
      `Formato ".${extension}" não suportado. Envie .csv, .xlsx ou .pdf. ` +
        "(.xls antigo não é lido — reexporte como .xlsx ou .csv no próprio Excel.)"
    );
  }

  const text = await file.text();
  const parsed = Papa.parse<string[]>(text, { skipEmptyLines: true });

  if (parsed.errors.length > 0) {
    throw new CatalogParseError(`Erro ao ler CSV: ${parsed.errors[0].message}`);
  }

  // `header: false` + primeira linha como cabeçalho (em vez do modo
  // `header: true` do Papa) pra usar exatamente o mesmo caminho do XLSX
  // — ver rowsFromMatrix acima.
  const [headerRow = [], ...dataRows] = parsed.data;
  const rows = rowsFromMatrix(
    headerRow.map((h) => h?.trim() ?? ""),
    dataRows
  );

  // Mesma deduplicação por SKU do parser de PDF (set/2026 — ver
  // dedupeCatalogRows em parsePdfCatalog.ts pro raciocínio completo).
  // Planilha de fornecedor repete SKU com frequência: mesma peça listada
  // em duas abas exportadas juntas, linha de "destaque" no topo repetindo
  // um item da lista, variação de cor com o mesmo código. Cada repetição
  // custava uma busca de preço a mais pelo MESMO produto (cota/crédito) e
  // uma linha duplicada na tela de resultados.
  return dedupeCatalogRows(rows).rows;
}
