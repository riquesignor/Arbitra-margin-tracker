import type { MarginResult } from "../types";
import { brl, pct } from "./format";

/**
 * Relatório imprimível dos resultados (out/2026, recurso de plano pago —
 * ver `features.printableReport` em config/plans.ts). Abre uma janela
 * nova só com o relatório (sem menu/filtros do app) e chama a impressão
 * do navegador — "Salvar como PDF" no próprio diálogo gera o PDF, sem lib
 * nenhuma. Usa o conjunto FILTRADO inteiro (não só a página visível),
 * mesmo critério do Exportar CSV.
 */

export interface ReportSummary {
  total: number;
  recommended: number;
  toAvoid: number;
  medianMarginPct: number | null;
  targetMarginPct: number;
}

function esc(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export function openPrintableReport(
  rows: MarginResult[],
  summary: ReportSummary,
  labels: { marketplace: (r: MarginResult) => string; status: (r: MarginResult) => string }
): boolean {
  const win = window.open("", "_blank");
  if (!win) return false;

  const generatedAt = new Date().toLocaleString("pt-BR");
  const body = rows
    .map(
      (r) => `<tr>
  <td>${esc(r.sku)}</td>
  <td>${esc(r.name)}</td>
  <td>${esc(labels.marketplace(r))}</td>
  <td class="n">${r.supplierPrice != null ? esc(brl(r.supplierPrice)) : "—"}</td>
  <td class="n">${esc(brl(r.marketplacePrice))}</td>
  <td class="n">${r.suggestedPrice != null ? esc(brl(r.suggestedPrice)) : "—"}</td>
  <td class="n">${r.marginPct != null ? esc(pct(r.marginPct)) : "—"}</td>
  <td>${esc(labels.status(r))}${r.approximate ? " · aprox." : ""}</td>
</tr>`
    )
    .join("");

  win.document.write(`<!doctype html>
<html lang="pt-BR"><head><meta charset="utf-8"><title>Relatório Arbitra — ${esc(generatedAt)}</title>
<style>
  body { font: 12px/1.45 system-ui, -apple-system, "Segoe UI", sans-serif; color: #111; margin: 24px; }
  h1 { font-size: 18px; margin: 0 0 4px; }
  .meta { color: #555; margin: 0 0 16px; }
  .kpis { display: flex; gap: 24px; margin: 0 0 16px; }
  .kpis div { border: 1px solid #ccc; border-radius: 6px; padding: 8px 12px; }
  .kpis strong { display: block; font-size: 16px; }
  table { width: 100%; border-collapse: collapse; }
  th, td { border-bottom: 1px solid #ddd; padding: 5px 6px; text-align: left; vertical-align: top; }
  th { background: #f2f2f2; font-weight: 600; }
  td.n, th.n { text-align: right; white-space: nowrap; font-variant-numeric: tabular-nums; }
  tr { page-break-inside: avoid; }
  .foot { color: #777; margin-top: 16px; font-size: 10px; }
</style></head><body>
<h1>Relatório de precificação — Arbitra</h1>
<p class="meta">Gerado em ${esc(generatedAt)} · ${rows.length} produto(s) · meta de margem ${esc(pct(summary.targetMarginPct))}</p>
<div class="kpis">
  <div>Total<strong>${summary.total}</strong></div>
  <div>Recomendados<strong>${summary.recommended}</strong></div>
  <div>A evitar<strong>${summary.toAvoid}</strong></div>
  <div>Margem mediana<strong>${summary.medianMarginPct != null ? esc(pct(summary.medianMarginPct)) : "—"}</strong></div>
</div>
<table><thead><tr>
  <th>SKU</th><th>Produto</th><th>Marketplace</th><th class="n">Custo</th><th class="n">Preço</th>
  <th class="n">Preço sugerido</th><th class="n">Margem</th><th>Status</th>
</tr></thead><tbody>${body}</tbody></table>
<p class="foot">Preços de mercado são estimativas obtidas automaticamente e podem não refletir o valor exato no momento da compra.</p>
</body></html>`);
  win.document.close();
  win.focus();
  // Um tick antes de imprimir: alguns navegadores ainda não pintaram o
  // documento recém-escrito quando o diálogo de impressão abre.
  setTimeout(() => {
    if (!win.closed) win.print();
  }, 300);
  return true;
}
