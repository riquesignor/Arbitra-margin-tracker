import Papa from "papaparse";
import type { CatalogRow } from "../types";

/**
 * ══════════════════════════════════════════════════════════════════════
 * CONVERSOR PDF → PLANILHA (set/2026, pedido explícito do usuário)
 * ══════════════════════════════════════════════════════════════════════
 *
 * Motivo de existir: o fluxo normal de "processar catálogo" sempre
 * encadeia extração + busca de preço na hora. Esse módulo cobre um caso
 * de uso DIFERENTE — o usuário só quer converter um PDF de fornecedor
 * numa planilha (.csv) no formato que o próprio parseCatalog.ts já
 * aceita como entrada, SEM gastar nenhuma chamada de busca de preço.
 * Ideia do usuário: revisar/editar essa planilha manualmente (corrigir
 * nome/SKU que o parser leu errado, por exemplo) antes de decidir se e
 * quando vai rodar a busca de preço de verdade — inclusive escolhendo
 * rodar por TEXTO em vez de foto/IA depois de já ter a planilha pronta.
 *
 * Reaproveita exatamente o padrão de exportação já usado em
 * ResultsTable.tsx (`;` como delimitador — Excel pt-BR abre certo com
 * ele; vírgula decimal — combinação que evita "tudo numa coluna só" no
 * Excel configurado em pt-BR; BOM `﻿` — acento abre certo). Duplicar essa
 * função aqui (em vez de importar de ResultsTable.tsx) é proposital: um
 * componente de tela não é módulo pra outro importar, e mover a função
 * de lá pra cá sem necessidade arriscaria quebrar a exportação de
 * Resultados sem eu poder rodar o teste manual aqui.
 */
function formatNumberBR(value: number, digits: number): string {
  return value.toFixed(digits).replace(".", ",");
}

/**
 * Gera e baixa um .csv com o formato de ENTRADA do parseCatalog.ts (SKU,
 * Nome, Custo, EAN quando presente) — não o de SAÍDA de resultados (sem
 * preço de mercado, sem margem, sem link). Coluna EAN só aparece se pelo
 * menos uma linha tiver o campo preenchido, pra não gerar uma coluna
 * vazia inútil em catálogo sem código de barras.
 */
export function downloadCatalogRowsAsCsv(rows: CatalogRow[], filenamePrefix: string): void {
  const hasAnyEan = rows.some((r) => r.ean);

  const csvRows = rows.map((r) => {
    const base: Record<string, string> = {
      SKU: r.sku,
      Nome: r.name,
      "Custo (R$)": r.supplierPrice != null ? formatNumberBR(r.supplierPrice, 2) : "",
    };
    if (hasAnyEan) base["EAN"] = r.ean ?? "";
    return base;
  });

  const csv = Papa.unparse(csvRows, { delimiter: ";" });
  const blob = new Blob([`﻿${csv}`], { type: "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `${filenamePrefix}-${new Date().toISOString().slice(0, 10)}.csv`;
  a.click();
  URL.revokeObjectURL(url);
}
