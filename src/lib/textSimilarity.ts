/**
 * Cópia client-side de api/_lib/textSimilarity.ts (Jaccard sobre
 * tokens) — mesma duplicação intencional já usada entre client/server
 * neste projeto pra tipos compartilhados (ver comentário no topo de
 * src/types/index.ts). `api/_lib` roda num tsconfig/bundle separado do
 * frontend (Vite só empacota `src/`), então reimportar de lá não é
 * seguro; a lógica é pura (só string), então duplicar é mais simples e
 * mais seguro que tentar compartilhar módulo entre os dois projetos.
 *
 * Usada por supplierCompare.ts pra casar o MESMO produto entre
 * catálogos de fornecedores diferentes pelo nome (sem SKU comum entre
 * fornecedores distintos, não tem outro critério disponível).
 */
const DIACRITICS_PATTERN = /[̀-ͯ]/g;

function normalize(text: string): string[] {
  return text
    .toLowerCase()
    .normalize("NFD")
    .replace(DIACRITICS_PATTERN, "")
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter(Boolean);
}

export function textSimilarity(a: string, b: string): number {
  const tokensA = new Set(normalize(a));
  const tokensB = new Set(normalize(b));
  if (tokensA.size === 0 || tokensB.size === 0) return 0;

  let intersection = 0;
  for (const token of tokensA) {
    if (tokensB.has(token)) intersection++;
  }
  const union = new Set([...tokensA, ...tokensB]).size;
  return union === 0 ? 0 : intersection / union;
}
