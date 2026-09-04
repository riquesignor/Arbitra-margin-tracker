import type { CatalogRow } from "../types";
import { normalizeSkuForMatch } from "./geminiCatalogVision";

/**
 * Operações sobre a lista de produtos JÁ extraída, independentes de
 * formato de origem (PDF, CSV e, quando entrar, XLSX).
 *
 * Módulo próprio de propósito: `dedupeCatalogRows` nasceu dentro de
 * parsePdfCatalog.ts, mas o parser de CSV precisa da MESMA função — e
 * importá-la de lá criaria ciclo (parsePdfCatalog já importa
 * `parseCurrency` de parseCatalog). Com o comportamento comum aqui, os
 * dois parsers dependem deste arquivo e de mais nada um do outro.
 */

/**
 * Remove linhas com SKU repetido dentro do MESMO catálogo — proteção
 * pedida explicitamente ("evitar duplicatas", ago/2026), motivada por um
 * cenário plausível e não coberto: catálogo com uma página "vitrine"/
 * destaque (sem preço) reapresentando um produto que já aparece na grade
 * principal (com preço) mais adiante, planilha com o mesmo item em duas
 * abas exportadas juntas, ou um mesmo cartão lido duas vezes por acidente
 * de layout. Sem isto, cada duplicata vira uma busca de preço extra
 * (crédito/cota gastos à toa pelo MESMO produto) e uma linha a mais na
 * tabela de resultados — confuso pra decidir compra olhando "dois"
 * produtos que são o mesmo.
 *
 * Comparação por SKU normalizado (`normalizeSkuForMatch` — maiúsculas,
 * sem espaço) porque a mesma peça pode vir com caixa/espaçamento
 * diferentes entre páginas (ex: OCR numa, texto real na outra). Quando as
 * duas ocorrências têm SKU igual mas dados diferentes, mantém a que tem
 * `supplierPrice` — uma linha "vitrine sem preço" seguida da mesma linha
 * com preço deve virar UMA linha COM preço (a margem depende disso, ver
 * CatalogRow). Entre duas com preço (ou duas sem), mantém a PRIMEIRA, na
 * ordem de leitura: decisão simples e previsível, sem tentar adivinhar
 * qual está "mais certa" quando os dados divergem.
 *
 * Função pura (recebe/devolve `CatalogRow[]`) — testável sem mock de
 * pdfjs/OCR/canvas, ver parsePdfCatalog.test.ts.
 */
export function dedupeCatalogRows(rows: CatalogRow[]): { rows: CatalogRow[]; removed: number } {
  const dedupedRows: CatalogRow[] = [];
  const indexBySku = new Map<string, number>();
  let removed = 0;

  for (const row of rows) {
    const key = normalizeSkuForMatch(row.sku);
    const existingIndex = indexBySku.get(key);

    if (existingIndex == null) {
      indexBySku.set(key, dedupedRows.length);
      dedupedRows.push(row);
      continue;
    }

    removed++;
    const existing = dedupedRows[existingIndex];
    // A ocorrência anterior não tinha preço e esta tem — troca pra não
    // perder o custo de fornecedor (ver comentário da função acima).
    if (existing.supplierPrice == null && row.supplierPrice != null) {
      dedupedRows[existingIndex] = row;
    }
  }

  return { rows: dedupedRows, removed };
}
