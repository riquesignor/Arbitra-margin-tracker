import { textSimilarity } from "./textSimilarity.js";

/**
 * Escolhe o melhor candidato entre resultados de busca (SerpApi, RapidAPI
 * Amazon, Mercado Livre etc.) — critério pedido explicitamente: entre
 * anúncios que já parecem ser o produto certo, priorizar o "mais famoso"
 * (mais avaliações/vendas), não só o primeiro nem só o de título mais
 * parecido.
 *
 * Antes (todo provider repetia o mesmo loop manualmente): escolhia sempre
 * o candidato de MAIOR similaridade de texto com o nome do catálogo,
 * ignorando rating/reviews/vendas por completo — um anúncio com 2
 * avaliações e um com 20 mil ficavam empatados se o título fosse
 * igualmente parecido, e o primeiro da lista vencia por acaso.
 *
 * Agora: dois passos.
 *   1) Filtra pra só os candidatos com similaridade "próxima o bastante"
 *      do melhor match (`SIMILARITY_TOLERANCE`) — ainda é o produto
 *      certo que decide quem entra na disputa, popularidade nunca vence
 *      um match ruim.
 *   2) Entre os sobreviventes, ordena por popularidade (`getPopularity`)
 *      — no empate de popularidade (ou quando nenhum candidato tem dado
 *      de popularidade, `getPopularity` volta 0 pra todos), desempata
 *      por similaridade, preservando o comportamento antigo como
 *      fallback.
 *
 * A confiança (`confidenceFromSimilarity`) continua calculada em cima da
 * similaridade do candidato ESCOLHIDO, não do maior valor encontrado —
 * se o escolhido por popularidade tiver similaridade um pouco mais baixa
 * que o melhor match bruto (ainda dentro da tolerância), a confiança
 * exibida reflete isso.
 */
const SIMILARITY_TOLERANCE = 0.15;

export interface RankedCandidate<T> {
  candidate: T;
  similarity: number;
}

export function pickBestCandidate<T>(
  catalogName: string,
  candidates: T[],
  getTitle: (candidate: T) => string,
  getPopularity: (candidate: T) => number
): RankedCandidate<T> | null {
  if (candidates.length === 0) return null;

  const scored = candidates.map((candidate) => ({
    candidate,
    similarity: textSimilarity(catalogName, getTitle(candidate)),
  }));

  const maxSimilarity = Math.max(...scored.map((s) => s.similarity));
  const contenders = scored.filter((s) => s.similarity >= maxSimilarity - SIMILARITY_TOLERANCE);

  let best = contenders[0];
  let bestPopularity = getPopularity(best.candidate);
  for (const contender of contenders.slice(1)) {
    const popularity = getPopularity(contender.candidate);
    if (
      popularity > bestPopularity ||
      (popularity === bestPopularity && contender.similarity > best.similarity)
    ) {
      best = contender;
      bestPopularity = popularity;
    }
  }

  return best;
}

/**
 * Mesma lógica de filtro/ordenação de `pickBestCandidate`, mas devolve
 * até `k` candidatos em vez de só o melhor — usado pela re-ranqueação
 * visual (ver visionInternalSearchProvider.ts): a IA de visão precisa de
 * um PUNHADO de candidatos pra comparar a foto contra, não só o vencedor
 * da similaridade de texto (que pode não ser o certo — é só o melhor
 * TEXTO, a foto ainda não entrou na decisão nesse ponto).
 */
export function getTopCandidates<T>(
  catalogName: string,
  candidates: T[],
  getTitle: (candidate: T) => string,
  getPopularity: (candidate: T) => number,
  k: number
): RankedCandidate<T>[] {
  if (candidates.length === 0) return [];

  const scored = candidates.map((candidate) => ({
    candidate,
    similarity: textSimilarity(catalogName, getTitle(candidate)),
  }));

  const maxSimilarity = Math.max(...scored.map((s) => s.similarity));
  const contenders = scored.filter((s) => s.similarity >= maxSimilarity - SIMILARITY_TOLERANCE);

  return contenders
    .sort((a, b) => {
      const popDiff = getPopularity(b.candidate) - getPopularity(a.candidate);
      return popDiff !== 0 ? popDiff : b.similarity - a.similarity;
    })
    .slice(0, k);
}

/**
 * Score de popularidade combinando contagem de avaliações/vendas (escala
 * log — a diferença entre 10 e 100 avaliações importa mais que entre
 * 10.000 e 10.090) com a nota média como desempate leve. `count` cobre
 * tanto "reviews"/"total_ratings" (SerpApi, Unwrangle) quanto
 * "sold_quantity" (Mercado Livre) — o nome do campo já deixa claro pra
 * cada provider qual sinal de "fama" ele tem disponível.
 */
export function popularityScore(count: number | null | undefined, rating: number | null | undefined): number {
  const safeCount = count && count > 0 ? count : 0;
  const safeRating = rating && rating > 0 ? rating : 0;
  return Math.log10(safeCount + 1) * 10 + safeRating;
}
