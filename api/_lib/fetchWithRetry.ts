// 5xx de infraestrutura costumam sumir na segunda tentativa. 429 e demais 4xx
// ficam de fora de propósito: na SerpApi, por exemplo, 429 é cota esgotada
// (não é transitório) e reenviar só gasta throughput.
const TRANSIENT_STATUS = new Set([500, 502, 503, 504]);

export interface RetryOptions {
  /** Tentativas EXTRAS depois da primeira. Default 1 — as APIs de busca são BYOK com cota apertada, então não vale insistir mais. */
  retries?: number;
  baseDelayMs?: number;
  /** Reenviar também quando o `fetch` lança (rede/timeout). Desligue onde um timeout já é lento por si só e reenviar dobraria a espera. */
  retryOnThrow?: boolean;
  sleep?: (ms: number) => Promise<void>;
}

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Executa `doFetch` e tenta de novo só em erro de rede ou HTTP 500/502/503/504,
 * com backoff exponencial e jitter. Recebe a função (e não a URL) pra cada
 * provider manter o próprio `fetch` (headers, timeout, AbortController).
 * Só use com requisições idempotentes (GET de busca).
 */
export async function fetchWithRetry(
  doFetch: () => Promise<Response>,
  options: RetryOptions = {}
): Promise<Response> {
  const { retries = 1, baseDelayMs = 500, retryOnThrow = true, sleep = defaultSleep } = options;

  for (let attempt = 0; ; attempt++) {
    const isLastAttempt = attempt >= retries;
    const delay = baseDelayMs * 2 ** attempt + Math.random() * 250;

    let response: Response;
    try {
      response = await doFetch();
    } catch (err) {
      if (isLastAttempt || !retryOnThrow) throw err;
      await sleep(delay);
      continue;
    }

    if (isLastAttempt || !TRANSIENT_STATUS.has(response.status)) return response;
    await response.body?.cancel().catch(() => undefined);
    await sleep(delay);
  }
}
