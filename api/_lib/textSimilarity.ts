/**
 * Similaridade de texto (Jaccard sobre tokens) — usada pra derivar
 * "confiança" real do match de busca, em vez de um valor fixo (ver
 * Session 3 do critique de design: "Confiança" travada em 50% em toda
 * linha era pior que não ter a coluna, porque não carregava nenhuma
 * informação de fato).
 */
const DIACRITICS_PATTERN = /[̀-ͯ]/g;

/**
 * Stemming LEVE de plural PT-BR — não é um stemmer completo (tipo
 * RSLP/Snowball), só as regras de plural mais comuns, pra não perder
 * match só porque o catálogo diz "bexigas" e o anúncio diz "bexiga".
 * Antes disso, Jaccard sobre token EXATO tratava plural/singular como
 * palavras totalmente diferentes — penalidade artificial que não tem a
 * ver com o produto ser o mesmo ou não.
 *
 * Aplicado nos DOIS lados de toda comparação (`normalize` abaixo), então
 * mesmo quando a regra "erra" o singular certo (heurística, não
 * dicionário), o resultado continua CONSISTENTE — nunca faz uma
 * comparação que já dava match parar de dar, só ajuda casos que hoje
 * davam match parcial por causa só do "s" a mais.
 *
 * Ordem importa: sufixos mais específicos (3 letras) primeiro, "-s"
 * simples por último — senão "botões" cairia na regra genérica e viraria
 * "botõe" em vez de "botao" pela regra de "-ões" abaixo.
 */
function stemPortugueseWord(token: string): string {
  if (/\d/.test(token)) return token; // número/código não é plural de nada — não mexe

  if (token.length > 4 && token.endsWith("oes")) return token.slice(0, -3) + "ao"; // botões→botao, corações→coracao
  if (token.length > 4 && token.endsWith("aes")) return token.slice(0, -3) + "ao"; // pães→pao, capitães→capitao
  if (token.length > 4 && token.endsWith("eis")) return token.slice(0, -3) + "el"; // papéis→papel, anéis→anel
  if (token.length > 4 && token.endsWith("ais")) return token.slice(0, -3) + "al"; // artesanais→artesanal
  if (token.length > 3 && token.endsWith("s")) return token.slice(0, -1); // bexigas→bexiga, canetas→caneta

  return token;
}

function normalize(text: string): string[] {
  return text
    .toLowerCase()
    .normalize("NFD")
    .replace(DIACRITICS_PATTERN, "") // remove acentos
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter(Boolean)
    .map(stemPortugueseWord);
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
 * O nome serve como termo de busca de verdade? Usado pelos providers de
 * busca por FOTO (googleLensProvider.ts, searchApiLensProvider.ts), que
 * mandam o nome do catálogo em `q` junto com a imagem: um nome
 * degradado (resto de OCR, um fragmento só, um SKU solto) usado como
 * `q` FILTRA os resultados do Lens em vez de refiná-los — some com o
 * match que a foto teria achado sozinha. Nesse caso é melhor buscar só
 * pela imagem.
 *
 * Critério: pelo menos duas palavras de 3+ letras, ou uma palavra longa
 * (5+) — o suficiente pra ser uma descrição, não um fragmento. Note que
 * o nome já chega aqui limpo pelo `sanitizeProductName` do parser
 * (src/lib/parsePdfCatalog.ts); esta checagem é a segunda linha de
 * defesa, e também cobre catálogo CSV, que não passa pelo parser de PDF.
 */
export function isUsableSearchTerm(name: string | undefined | null): boolean {
  if (!name?.trim()) return false;
  const words = normalize(name).filter((token) => token.length >= 3);
  return words.length >= 2 || words.some((word) => word.length >= 5);
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
