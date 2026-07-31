/**
 * Roda no máximo `limit` chamadas de `fn` em paralelo, preservando a
 * ordem dos resultados. Usado por todo provider que faz N requisições
 * HTTP (uma por item do catálogo) pra não estourar rate limit de APIs
 * de terceiro. Extraído aqui porque agora tem 2+ providers repetindo a
 * mesma lógica (ver src/lib/concurrency.ts pro espelho client-side).
 */
export async function mapWithConcurrency<T, R>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<R>
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let cursor = 0;

  async function worker() {
    while (cursor < items.length) {
      const i = cursor++;
      results[i] = await fn(items[i]);
    }
  }

  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}
