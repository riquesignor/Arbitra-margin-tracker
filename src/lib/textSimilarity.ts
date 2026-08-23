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

/**
 * Stemming leve de plural PT-BR — mesma regra de api/_lib/textSimilarity.ts
 * (mantida em paridade aqui, ago/2026): sem isso, "Facas" no catálogo do
 * fornecedor A e "Faca" no do fornecedor B não casavam por causa só do
 * "s", mesmo produto tratado como diferente.
 */
function stemPortugueseWord(token: string): string {
  if (/\d/.test(token)) return token;

  if (token.length > 4 && token.endsWith("oes")) return token.slice(0, -3) + "ao";
  if (token.length > 4 && token.endsWith("aes")) return token.slice(0, -3) + "ao";
  if (token.length > 4 && token.endsWith("eis")) return token.slice(0, -3) + "el";
  if (token.length > 4 && token.endsWith("ais")) return token.slice(0, -3) + "al";
  if (token.length > 3 && token.endsWith("s")) return token.slice(0, -1);

  return token;
}

// Palavras genéricas de catálogo (embalagem/unidade/qualificador de
// marketing) que aparecem em produtos DIFERENTES e não ajudam a
// distinguir um do outro — ao contrário, contam a favor da similaridade
// mesmo entre produtos não relacionados, inflando falso-positivo em
// buildSupplierComparison (ver comentário lá: "sempre traz nomes
// errados"). Números NÃO entram aqui de propósito — "kit 5" vs "kit 10"
// são produtos diferentes, o dígito é sinal real, só o rótulo "kit" que
// é ruído.
const GENERIC_TOKENS = new Set([
  "kit", "kits", "unidade", "unidades", "unid", "und", "uni", "un",
  "cx", "caixa", "caixas", "pacote", "pacotes", "pct", "pc", "pcs",
  "peca", "pecas", "profissional", "premium", "original", "novo", "nova",
  "novos", "novas", "modelo", "tipo", "com", "sem", "de", "da", "do",
  "das", "dos", "para", "pra", "e", "ou", "a", "o", "as", "os",
]);

function normalize(text: string, filterGeneric: boolean): string[] {
  const tokens = text
    .toLowerCase()
    .normalize("NFD")
    .replace(DIACRITICS_PATTERN, "")
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter(Boolean)
    .map(stemPortugueseWord);

  if (!filterGeneric) return tokens;

  // Se filtrar deixar a lista vazia (nome era só termos genéricos, ex.
  // "Kit Profissional"), volta pro conjunto sem filtro — melhor
  // comparar por algo do que não ter token nenhum pra comparar.
  const filtered = tokens.filter((t) => !GENERIC_TOKENS.has(t));
  return filtered.length > 0 ? filtered : tokens;
}

/**
 * `ignoreGenericTerms` (default true): descarta rótulos genéricos de
 * catálogo (ver GENERIC_TOKENS) antes de comparar — reduz falso-
 * positivo no matching entre fornecedores (buildSupplierComparison),
 * onde dois produtos DIFERENTES que só compartilham "Kit Profissional
 * Inox" batiam acima do threshold por causa só do texto genérico.
 */
export function textSimilarity(a: string, b: string, ignoreGenericTerms = true): number {
  const tokensA = new Set(normalize(a, ignoreGenericTerms));
  const tokensB = new Set(normalize(b, ignoreGenericTerms));
  if (tokensA.size === 0 || tokensB.size === 0) return 0;

  let intersection = 0;
  for (const token of tokensA) {
    if (tokensB.has(token)) intersection++;
  }
  const union = new Set([...tokensA, ...tokensB]).size;
  return union === 0 ? 0 : intersection / union;
}
