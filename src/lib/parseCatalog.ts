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
// "titulo"/"título" (set/2026): nome de coluna comum em export de ERP/
// marketplace (Bling, Tiny e afins) — catálogo real testado tinha só essa
// coluna pro nome do produto, sem nenhuma das variações já cobertas, e
// ficava com `name: ""` em toda linha (busca por texto sem nome nenhum
// pra usar).
const NAME_ALIASES = ["nome", "produto", "name", "descricao", "descrição", "titulo", "título"];
const PRICE_ALIASES = ["custo", "preco", "preço", "price", "cost", "valor"];
// EAN/GTIN (set/2026, ideia validada de uma spec externa revisada com o
// usuário): coluna OPCIONAL — a maioria dos catálogos de fornecedor hoje
// não traz isso, e sem ela o comportamento é idêntico a antes (busca por
// nome). Quando presente, vira prioridade de busca (ver resolveSearchQuery
// em api/_lib/searchQuery.ts) por ser busca EXATA de código de barras.
// `findColumn` compara o header NORMALIZADO INTEIRO (não substring) — uma
// coluna chamada só "Código" ainda bate primeiro em SKU_ALIASES (é
// procurado antes), então não há colisão real com "código de barras"/
// "cod barras" aqui, mesmo os dois compartilhando a palavra "código".
const EAN_ALIASES = ["ean", "gtin", "codigo de barras", "código de barras", "cod barras", "cód barras", "barcode"];

const DIACRITICS_REGEX = new RegExp("[\\u0300-\\u036f]", "g");

function normalizeHeader(header: string): string {
  return header
    .trim()
    .toLowerCase()
    .normalize("NFD")
    .replace(DIACRITICS_REGEX, ""); // remove acentos
}

function findColumnExact(headers: string[], aliases: string[]): string | undefined {
  const normalized = headers.map((h) => ({ original: h, normalized: normalizeHeader(h) }));
  const normalizedAliases = aliases.map(normalizeHeader);
  const match = normalized.find((h) => normalizedAliases.includes(h.normalized));
  return match?.original;
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * 2º passo, só quando NENHUM header bateu no match exato acima pra essa
 * categoria — caso real (set/2026): planilha de fornecedor com cabeçalho
 * "Custo (R$)" em vez de só "Custo", `findColumnExact` não achava (exige
 * o header inteiro ser igual ao alias) e o app recusava um catálogo com
 * as colunas certas na cara do usuário. Aceita o alias como PALAVRA
 * inteira dentro de um header decorado ("Custo (R$)", "Nome do Produto"),
 * não como substring solta — evita, por ex., "cod" (alias de SKU) casando
 * dentro de "código" sem fronteira de palavra.
 *
 * `usedHeaders`: colunas já resolvidas por OUTRA categoria ficam de fora
 * da busca — sem isso, o alias curto e genérico de uma categoria (ex.:
 * "cod" de SKU) podia roubar a coluna de uma categoria mais específica
 * já resolvida (ex.: "Cód. Barras" já batido como EAN por
 * `findColumnExact`) — mesma preocupação já documentada no comentário de
 * EAN_ALIASES acima, agora também válida pro fallback fuzzy.
 */
function findColumnFuzzy(headers: string[], aliases: string[], usedHeaders: Set<string>): string | undefined {
  const candidates = headers.filter((h) => h && !usedHeaders.has(h));
  // Alias mais longo primeiro: "codigo de barras" tem que ganhar de
  // "codigo" quando os dois batem no mesmo header.
  const sortedAliases = [...aliases].sort((a, b) => b.length - a.length);

  for (const alias of sortedAliases) {
    const pattern = new RegExp(`(^|[^a-z0-9])${escapeRegExp(normalizeHeader(alias))}([^a-z0-9]|$)`);
    const match = candidates.find((h) => pattern.test(normalizeHeader(h)));
    if (match) return match;
  }

  return undefined;
}

/**
 * Resolve as 4 colunas tentando match EXATO primeiro pra cada categoria
 * (comportamento de sempre — zero regressão em catálogo que já funciona)
 * e só cai pro fuzzy (`findColumnFuzzy`) pra quem ainda ficou sem coluna.
 * Ordem do fallback — EAN, custo, nome, SKU — é dos aliases mais
 * específicos/compridos pros mais genéricos/curtos ("cod" de SKU é o
 * caso mais arriscado de colisão, ver comentário de `findColumnFuzzy`,
 * por isso roda por último).
 */
function resolveColumns(headers: string[]): {
  skuCol?: string;
  nameCol?: string;
  priceCol?: string;
  eanCol?: string;
} {
  const exact = {
    skuCol: findColumnExact(headers, SKU_ALIASES),
    nameCol: findColumnExact(headers, NAME_ALIASES),
    priceCol: findColumnExact(headers, PRICE_ALIASES),
    eanCol: findColumnExact(headers, EAN_ALIASES),
  };

  const used = new Set<string>([exact.skuCol, exact.nameCol, exact.priceCol, exact.eanCol].filter((h): h is string => !!h));

  const eanCol = exact.eanCol ?? findColumnFuzzy(headers, EAN_ALIASES, used);
  if (eanCol) used.add(eanCol);
  const priceCol = exact.priceCol ?? findColumnFuzzy(headers, PRICE_ALIASES, used);
  if (priceCol) used.add(priceCol);
  const nameCol = exact.nameCol ?? findColumnFuzzy(headers, NAME_ALIASES, used);
  if (nameCol) used.add(nameCol);
  const skuCol = exact.skuCol ?? findColumnFuzzy(headers, SKU_ALIASES, used);

  return { skuCol, nameCol, priceCol, eanCol };
}

/**
 * Quantas linhas do topo tentamos como candidata a cabeçalho antes de
 * desistir e usar a linha 0 (comportamento de sempre). Cobre catálogo com
 * linha de TÍTULO/instrução antes do cabeçalho de verdade — regressão
 * real (set/2026) pega no PRÓPRIO modelo-catalogo.xlsx que este app
 * distribui: linha 1 era um texto de instrução mesclado ("Modelo de
 * catálogo — preencha uma linha por produto..."), "SKU/Nome/Custo/EAN"
 * só aparecia na linha 2 — o usuário baixava NOSSO modelo oficial,
 * preenchia, subia, e caía no erro "não encontrei colunas de SKU e/ou
 * custo" olhando pras colunas certinhas na tela do Excel.
 */
const MAX_HEADER_SCAN_ROWS = 5;

/**
 * Acha a linha de cabeçalho de verdade dentro das primeiras
 * `MAX_HEADER_SCAN_ROWS` linhas — a primeira que resolve SKU E custo (ver
 * `resolveColumns`). Não achando nenhuma na janela, devolve 0 (mesmo
 * comportamento de sempre): o erro final continua saindo e reportando a
 * linha 0, sem fingir que sabe qual seria "a linha certa" quando a
 * planilha realmente não tem cabeçalho reconhecível em lugar nenhum.
 */
function findHeaderRowIndex(matrix: string[][]): number {
  const scanLimit = Math.min(matrix.length, MAX_HEADER_SCAN_ROWS);

  for (let i = 0; i < scanLimit; i++) {
    const { skuCol, priceCol } = resolveColumns(matrix[i] ?? []);
    if (skuCol && priceCol) return i;
  }

  return 0;
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
  const { skuCol, nameCol, priceCol, eanCol } = resolveColumns(headers);

  if (!skuCol || !priceCol) {
    throw new CatalogParseError(
      `Não encontrei colunas de SKU e/ou custo. Colunas detectadas: ${headers.join(", ")}`
    );
  }

  const skuIndex = headers.indexOf(skuCol);
  const nameIndex = nameCol ? headers.indexOf(nameCol) : -1;
  const priceIndex = headers.indexOf(priceCol);
  const eanIndex = eanCol ? headers.indexOf(eanCol) : -1;

  return dataRows
    .filter((row) => row[skuIndex]?.trim())
    .map((row) => {
      // Célula de EAN em planilha às vezes vem com ".0" (Excel tratando o
      // código como número) ou espaço/hífen de formatação — normaliza pra
      // só dígitos antes de decidir se é válido (a validação de formato
      // em si, 8-14 dígitos, fica em resolveSearchQuery/searchQuery.ts, o
      // parser aqui só limpa e repassa o que achou).
      const eanRaw = eanIndex >= 0 ? row[eanIndex]?.trim() : undefined;
      const ean = eanRaw ? eanRaw.replace(/\.0$/, "").replace(/[^\d]/g, "") : undefined;

      return {
        sku: row[skuIndex].trim(),
        name: nameIndex >= 0 ? row[nameIndex]?.trim() ?? "" : "",
        supplierPrice: parseCurrency(row[priceIndex] ?? "0"),
        ...(ean ? { ean } : {}),
      };
    });
}

export async function parseCatalogFile(file: File): Promise<CatalogRow[]> {
  const extension = file.name.split(".").pop()?.toLowerCase();

  // .xlsx/.xlsm (set/2026, ver xlsxReader.ts): fornecedor manda planilha
  // direto o tempo todo — antes disso o usuário precisava reexportar como
  // CSV antes de conseguir usar o app. Lido sem dependência nova (o
  // pacote `xlsx` do npm tem CVEs abertas, ver nota no topo).
  if (extension === "xlsx" || extension === "xlsm") {
    const matrix = await readXlsxSheet(await file.arrayBuffer());
    const headerIndex = findHeaderRowIndex(matrix);
    const headerRow = matrix[headerIndex] ?? [];
    const dataRows = matrix.slice(headerIndex + 1);

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
  // — ver rowsFromMatrix acima. `findHeaderRowIndex` (mesma lógica do
  // XLSX) cobre CSV com linha de título antes do cabeçalho de verdade —
  // menos comum aqui (skipEmptyLines já tira linha em branco sozinho),
  // mas nada garante que um CSV exportado de outro sistema não tenha uma
  // linha assim também.
  const headerIndex = findHeaderRowIndex(parsed.data);
  const dataRows = parsed.data.slice(headerIndex + 1);
  const rows = rowsFromMatrix(
    (parsed.data[headerIndex] ?? []).map((h) => h?.trim() ?? ""),
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
