/**
 * Similaridade de texto (Jaccard sobre tokens) — usada pra derivar
 * "confiança" real do match de busca, em vez de um valor fixo (ver
 * Session 3 do critique de design: "Confiança" travada em 50% em toda
 * linha era pior que não ter a coluna, porque não carregava nenhuma
 * informação de fato).
 */
const DIACRITICS_PATTERN = /[̀-ͯ]/g;

function normalize(text: string): string[] {
  return text
    .toLowerCase()
    .normalize("NFD")
    .replace(DIACRITICS_PATTERN, "") // remove acentos
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

/**
 * Mapeia similaridade (0-1) pra confiança exibida (0.3-0.9). Nunca cai
 * a 0 (achou um resultado, então tem alguma base) nem sobe a 1.0 (é
 * heurística de texto, nunca é garantia de ser o mesmo produto/SKU).
 */
export function confidenceFromSimilarity(similarity: number): number {
  const clamped = Math.min(1, Math.max(0, similarity));
  return Number((0.3 + clamped * 0.6).toFixed(2));
}
