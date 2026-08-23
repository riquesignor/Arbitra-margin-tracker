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

/**
 * Termos genéricos de catálogo/anúncio (embalagem, unidade, qualificador
 * de marketing, preposição) que aparecem em produtos DIFERENTES e por
 * isso NÃO discriminam nada — ao contrário, INFLAM a similaridade entre
 * dois produtos que não têm relação nenhuma, só porque os dois dizem
 * "Kit Profissional" ou têm "de"/"com" no meio do nome (ago/2026,
 * diagnóstico do relato "quase todo produto vem com o marketplace
 * errado" — ver rankCandidates.ts: `MIN_ACCEPTABLE_SIMILARITY` era baixo
 * o bastante pra esse ruído sozinho empurrar candidato errado pra cima
 * do piso de aceite). Mesma lista de src/lib/textSimilarity.ts (cópia
 * client-side pro comparador de fornecedores) — MANTER AS DUAS EM
 * SINCRONIA se editar aqui, são arquivos duplicados de propósito (ver
 * comentário no topo daquele arquivo), não um import compartilhado.
 *
 * Números NÃO entram aqui: "kit 5" vs "kit 10" são produtos diferentes,
 * o dígito é sinal real, só o rótulo "kit" que é ruído.
 */
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
    .replace(DIACRITICS_PATTERN, "") // remove acentos
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter(Boolean)
    .map(stemPortugueseWord);

  if (!filterGeneric) return tokens;

  // Se filtrar deixar a lista vazia (nome era só termos genéricos, ex.
  // "Kit Profissional"), volta pro conjunto sem filtro — melhor comparar
  // por algo do que não ter token nenhum pra comparar.
  const filtered = tokens.filter((t) => !GENERIC_TOKENS.has(t));
  return filtered.length > 0 ? filtered : tokens;
}

/**
 * `ignoreGenericTerms` (default true, ago/2026): descarta termos
 * genéricos (ver GENERIC_TOKENS) antes de comparar — sem quebrar
 * nenhuma chamada existente (parâmetro novo, com default). Quem chama
 * hoje (rankCandidates.ts, todo provider de busca por texto) passa a se
 * beneficiar automaticamente, sem precisar mudar a chamada.
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
 * Sem filtro de termo genérico de propósito: mesmo um nome "só" com
 * termo genérico ainda é um termo de busca válido pro Lens (a imagem
 * carrega o sinal real, isto só decide se vale mandar `q` JUNTO).
 */
export function isUsableSearchTerm(name: string | undefined | null): boolean {
  if (!name?.trim()) return false;
  const words = normalize(name, false).filter((token) => token.length >= 3);
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
