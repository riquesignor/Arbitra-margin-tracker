import { beforeEach, describe, expect, it, vi } from "vitest";
// `vi.mock` é içado pra cima dos imports pelo vitest, então o import
// estático abaixo já pega o módulo mockado — sem precisar de `await
// import(...)` no topo (que o tsconfig.api.json, em CommonJS, recusa).
import { consumeSearchQuota, QuotaExceededError, todayKeyBrazil } from "./searchQuota.js";

/**
 * `getAdminDb` é mockado porque a cota é a única lógica aqui — Firestore
 * em si não é o que precisa de teste. O fake replica só o que
 * `consumeSearchQuota` usa: `collection().doc()` encadeado, `.get()` do
 * perfil (pro plano) e `runTransaction` com `tx.get`/`tx.set`.
 */
const state = {
  plan: "free" as string | undefined,
  currentCount: 0 as number | undefined,
  written: null as { searchCount: number } | null,
};

function makeDocRef(path: string) {
  const ref: Record<string, unknown> = {
    path,
    get: async () => ({
      // Doc do perfil (users/{uid}) devolve o plano; o de uso devolve o contador.
      data: () => (path.includes("usage_daily") ? { searchCount: state.currentCount } : { plan: state.plan }),
    }),
  };
  ref.collection = (name: string) => ({ doc: (id: string) => makeDocRef(`${path}/${name}/${id}`) });
  return ref as { path: string; get: () => Promise<{ data: () => unknown }>; collection: (n: string) => { doc: (i: string) => unknown } };
}

vi.mock("./firestoreAdmin.js", () => ({
  getAdminDb: () => ({
    collection: (name: string) => ({ doc: (id: string) => makeDocRef(`${name}/${id}`) }),
    runTransaction: async (fn: (tx: unknown) => Promise<unknown>) =>
      fn({
        get: async (ref: { get: () => Promise<{ data: () => unknown }> }) => ref.get(),
        set: (_ref: unknown, data: { searchCount: number }) => {
          state.written = data;
        },
      }),
  }),
}));

beforeEach(() => {
  state.plan = "free";
  state.currentCount = 0;
  state.written = null;
});

describe("consumeSearchQuota", () => {
  it("reserva e devolve o novo total quando cabe no teto do plano", async () => {
    const result = await consumeSearchQuota("uid-1", "scraperapi", 10);

    expect(result).toEqual({ used: 10, limit: 50 });
    expect(state.written).toEqual({ searchCount: 10, updatedAt: expect.any(Number) });
  });

  it("soma em cima do que já foi gasto hoje (não sobrescreve)", async () => {
    state.currentCount = 30;

    const result = await consumeSearchQuota("uid-1", "scraperapi", 15);

    expect(result.used).toBe(45);
    expect(state.written?.searchCount).toBe(45);
  });

  it(
    "BLOQUEIA antes de gastar API quando a reserva estouraria o teto — é o ponto todo da correção " +
      "(a cota antiga era client-side e o próprio usuário zerava o contador)",
    async () => {
      state.currentCount = 45;

      await expect(consumeSearchQuota("uid-1", "scraperapi", 10)).rejects.toThrow(QuotaExceededError);
      // Nada escrito: a reserva falhou inteira, não pela metade.
      expect(state.written).toBeNull();
    }
  );

  it("o erro carrega used/limit pra virar 429 com número na mensagem", async () => {
    state.currentCount = 50;

    await expect(consumeSearchQuota("uid-1", "scraperapi", 1)).rejects.toMatchObject({
      used: 50,
      limit: 50,
    });
  });

  it("teto acompanha o plano do usuário (starter 200, pro 500)", async () => {
    state.plan = "starter";
    await expect(consumeSearchQuota("uid-1", "scraperapi", 1)).resolves.toMatchObject({ limit: 200 });

    state.plan = "pro";
    await expect(consumeSearchQuota("uid-1", "scraperapi", 1)).resolves.toMatchObject({ limit: 500 });
  });

  it("plano desconhecido/ausente cai no teto mais restritivo — falha fechada, não aberta", async () => {
    state.plan = undefined;
    await expect(consumeSearchQuota("uid-1", "scraperapi", 1)).resolves.toMatchObject({ limit: 50 });

    state.plan = "plano-que-não-existe";
    await expect(consumeSearchQuota("uid-1", "scraperapi", 1)).resolves.toMatchObject({ limit: 50 });
  });

  it(
    "motor interno + IA também conta como custo da plataforma (a raspagem passa pelo proxy ScraperAPI, " +
      "mesmo com a IA sendo BYOK)",
    async () => {
      await expect(consumeSearchQuota("uid-1", "vision_internal", 1)).resolves.toMatchObject({ limit: 50 });
      await expect(consumeSearchQuota("uid-1", "vision_mistral", 1)).resolves.toMatchObject({ limit: 50 });
    }
  );

  it("provider BYOK (usuário paga a própria busca) usa teto alto, só como freio de abuso", async () => {
    for (const provider of ["serpapi", "searchapi_lens", "google_lens_products", "rapidapi_amazon"] as const) {
      const result = await consumeSearchQuota("uid-1", provider, 1);
      expect(result.limit).toBe(25000);
    }
  });
});

describe("todayKeyBrazil", () => {
  it("usa o fuso de São Paulo, não UTC — senão a cota virava às 21h pro usuário", () => {
    // 2026-09-04T02:00:00Z ainda é dia 3 em São Paulo (UTC-3).
    expect(todayKeyBrazil(new Date("2026-09-04T02:00:00Z"))).toBe("20260903");
    expect(todayKeyBrazil(new Date("2026-09-04T12:00:00Z"))).toBe("20260904");
  });

  it("formato bate com o do cliente (yyyymmdd) — os dois leem o MESMO doc", () => {
    expect(todayKeyBrazil(new Date("2026-01-05T15:00:00Z"))).toBe("20260105");
  });
});
