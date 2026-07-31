import Papa from "papaparse";
import type { CatalogRow } from "../types";

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

export async function parseCatalogFile(file: File): Promise<CatalogRow[]> {
  const extension = file.name.split(".").pop()?.toLowerCase();

  if (extension !== "csv") {
    // Fase 2 do scaffold: só CSV. Excel entra quando o CDN do SheetJS for
    // adicionado (ver nota de risco acima) — não bloqueado por arquitetura,
    // só por dependência ainda não instalada.
    throw new CatalogParseError(
      `Formato ".${extension}" ainda não suportado neste scaffold. Use .csv (suporte a .xlsx é o próximo passo).`
    );
  }

  const text = await file.text();
  const parsed = Papa.parse<Record<string, string>>(text, {
    header: true,
    skipEmptyLines: true,
  });

  if (parsed.errors.length > 0) {
    throw new CatalogParseError(`Erro ao ler CSV: ${parsed.errors[0].message}`);
  }

  const headers = parsed.meta.fields ?? [];
  const skuCol = findColumn(headers, SKU_ALIASES);
  const nameCol = findColumn(headers, NAME_ALIASES);
  const priceCol = findColumn(headers, PRICE_ALIASES);

  if (!skuCol || !priceCol) {
    throw new CatalogParseError(
      `Não encontrei colunas de SKU e/ou custo. Colunas detectadas: ${headers.join(", ")}`
    );
  }

  return parsed.data
    .filter((row) => row[skuCol]?.trim())
    .map((row) => ({
      sku: row[skuCol].trim(),
      name: nameCol ? row[nameCol]?.trim() ?? "" : "",
      supplierPrice: parseCurrency(row[priceCol] ?? "0"),
    }));
}
