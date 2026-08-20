import { isUsableSearchTerm } from "./textSimilarity.js";

/**
 * ══════════════════════════════════════════════════════════════════════
 * LIMPEZA DE QUERY DE BUSCA
 * ══════════════════════════════════════════════════════════════════════
 *
 * Problema real reportado pelo usuário: catálogo de 40 produtos, busca
 * (motor interno) voltou 3 resultados, e "aproximados". Causa raiz #1
 * (das quatro identificadas): TODOS os providers de busca por texto
 * (internalSearchProvider.ts, mercadoLivreDirectProvider.ts,
 * rapidApiAmazonProvider.ts, googleShoppingProvider.ts,
 * unwrangleMercadoLivreProvider.ts) mandavam o NOME BRUTO do catálogo
 * direto pro campo de busca da loja/API — sem nenhuma limpeza.
 *
 * Nome de catálogo de fornecedor no atacado carrega informação que NUNCA
 * aparece no título de um anúncio de marketplace: código de referência
 * interno do fornecedor ("ref 790862"), medida de embalagem
 * ("9x10cm"), rótulo de catalogação ("MODELO:", "CÓD."). Mandar isso
 * junto na busca por texto completo não refina o resultado — dilui: a
 * maioria dos motores de busca de e-commerce pondera TODOS os termos da
 * query, então um código de 6 dígitos que não existe em nenhum anúncio
 * puxa a relevância pra baixo do produto certo, ou zera o resultado.
 *
 * Esta função limpa só o que é RUÍDO SINTÁTICO claro (rótulo + código,
 * medida com unidade) — não tenta reescrever ou adivinhar sinônimo (isso
 * ficaria pro fallback de IA, mais caro, se um dia for necessário). É
 * puramente determinística e sem custo, então roda em TODA busca por
 * texto, não é opt-in.
 *
 * ⚠️ Rede de segurança: o `similarity`/ranking (rankCandidates.ts)
 * continua comparando contra o NOME ORIGINAL do catálogo, não contra a
 * query limpa — a limpeza afeta só o que é MANDADO pra busca, nunca o
 * critério de "isso é o produto certo?".
 */

/**
 * Rótulo de código de produto ("ref", "referência", "cód.", "código",
 * "mod.", "modelo") seguido do código em si — mesmos rótulos que
 * MODEL_LABEL_PATTERN reconhece no parser de PDF
 * (src/lib/parsePdfCatalog.ts), mas aqui o objetivo é REMOVER, não
 * capturar: o código interno do fornecedor não ajuda a busca, só suja.
 */
const LABELED_CODE_PATTERN = /\b(?:ref|refer[eê]ncia|c[oó]d(?:igo)?|mod(?:elo)?)\.?:?\s*[a-z0-9-]+/gi;

/** Dimensão de embalagem ("9x10cm", "10 x 15 x 20mm") — específica do catálogo do fornecedor, quase nunca está no título do anúncio. */
const DIMENSION_PATTERN = /\b\d+(?:[.,]\d+)?\s*[x×]\s*\d+(?:[.,]\d+)?(?:\s*[x×]\s*\d+(?:[.,]\d+)?)?\s*(?:cm|mm|m)\b/gi;

/**
 * Código numérico solto de 5+ dígitos, sem letra junto — praticamente
 * sempre é SKU/referência interna do fornecedor (não confundir com
 * modelo alfanumérico tipo "RTX4090", que tem letra e passa direto).
 * `(?<![a-z0-9-])`/`(?![a-z0-9-])` garante que só pega o token INTEIRO,
 * não morde o fim de um número maior nem o começo de um token com letra.
 */
const STANDALONE_LONG_CODE_PATTERN = /(?<![a-z0-9-])\d{5,}(?![a-z0-9-])/gi;

/** Teto de palavras mandadas pra busca — cauda longa de palavras pouco discriminantes dilui a relevância tanto quanto ruído explícito. Generoso o bastante pra não cortar nome de produto legítimo (a maioria tem 3-8 palavras úteis). */
const MAX_QUERY_WORDS = 12;

/**
 * Limpa o nome do catálogo pra virar uma query de busca melhor. Nunca
 * devolve string vazia ou curta demais pra ser útil (ver
 * `isUsableSearchTerm`) — nesse caso volta o nome ORIGINAL sem
 * modificação, é mais seguro buscar com ruído do que buscar com uma
 * query vazia/genérica demais que dependeria dela pra distinguir do
 * resto do catálogo.
 *
 * Exportado pra teste unitário direto (função pura) — ver searchQuery.test.ts.
 */
export function buildSearchQuery(rawName: string): string {
  if (!rawName?.trim()) return "";

  const cleaned = rawName
    .replace(LABELED_CODE_PATTERN, " ")
    .replace(DIMENSION_PATTERN, " ")
    .replace(STANDALONE_LONG_CODE_PATTERN, " ")
    .replace(/\s+/g, " ")
    .trim();

  const capped = cleaned.split(" ").slice(0, MAX_QUERY_WORDS).join(" ").trim();

  // Rede de segurança: limpeza agressiva demais (nome que era SÓ código +
  // medida, ex. "REF 790862 9x10cm") não pode resultar numa busca vazia
  // ou genérica demais — melhor manter o ruído original do que buscar
  // "" ou um fragmento de 1 palavra sem poder discriminante nenhum.
  if (!isUsableSearchTerm(capped)) return rawName.trim();

  return capped;
}
