import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { consumeSearchQuota, QuotaExceededError, QuotaUnavailableError } from "./searchQuota.js";

/**
 * Modo gratuito (cobrança desligada = padrão): um limite diário único,
 * aplicado SEMPRE no servidor, em transaction, com o dia no fuso de Brasília.
 *
 * O fake do Firestore guarda um contador por caminho de documento (assim a
 * virada de dia vira um doc novo, como no Firestore de verdade) e SERIALIZA
 * as transactions — o que o Firestore garante e o que a lógica de
 * ler-somar-gravar precisa pra não deixar duas requisições simultâneas
 * passarem pelo mesmo "99/100".
 */
const db = vi.hoisted(() => ({
  counters: new Map<string, number>(),
  profileReads: 0,
  failTransactions: false,
  queue: Promise.resolve() as Promise<unknown>,
}));

function docRef(path: string) {
  return {
    path,
    get: async () => {
      if (!path.includes("usage_daily")) db.profileReads++;
      return { data: () => (path.includes("usage_daily") ? { searchCount: db.counters.get(path) } : { plan: "free" }) };
    },
    collection: (name: string) => ({ doc: (id: string) => docRef(`${path}/${name}/${id}`) }),
  };
}

vi.mock("./firestoreAdmin.js", () => ({
  getAdminDb: () => ({
    collection: (name: string) => ({ doc: (id: string) => docRef(`${name}/${id}`) }),
    runTransaction: (fn: (tx: unknown) => Promise<unknown>) => {
      const run = db.queue.then(async () => {
        if (db.failTransactions) throw new Error("firestore indisponível");
        return fn({
          get: async (ref: { get: () => Promise<{ data: () => unknown }> }) => ref.get(),
          set: (ref: { path: string }, data: { searchCount: number }) => {
            db.counters.set(ref.path, data.searchCount);
          },
        });
      });
      db.queue = run.catch(() => undefined);
      return run;
    },
  }),
}));

const ORIGINAL = { billing: process.env.BILLING_ENABLED, limit: process.env.DAILY_SEARCH_LIMIT };

beforeEach(() => {
  delete process.env.BILLING_ENABLED;
  delete process.env.DAILY_SEARCH_LIMIT;
  db.counters.clear();
  db.profileReads = 0;
  db.failTransactions = false;
  db.queue = Promise.resolve();
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-11-10T15:00:00Z")); // meio-dia em Brasília
});

afterEach(() => {
  vi.useRealTimers();
  for (const [key, value] of [
    ["BILLING_ENABLED", ORIGINAL.billing],
    ["DAILY_SEARCH_LIMIT", ORIGINAL.limit],
  ] as const) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

const TODAY = "users/uid-1/usage_daily/20261110";

describe("limite diário de 100 buscas (modo gratuito)", () => {
  it("o teto é 100 pra qualquer mecanismo e NÃO consulta o plano salvo", async () => {
    for (const provider of ["serpapi", "scraperapi", "vision_internal", "rapidapi_amazon"] as const) {
      db.counters.clear();
      const result = await consumeSearchQuota("uid-1", provider, 1);
      expect(result).toEqual({ used: 1, limit: 100 });
    }
    expect(db.profileReads).toBe(0);
  });

  it("DAILY_SEARCH_LIMIT sobrescreve o padrão", async () => {
    process.env.DAILY_SEARCH_LIMIT = "30";
    expect((await consumeSearchQuota("uid-1", "serpapi", 1)).limit).toBe(30);
  });

  it("usa a mesma unidade de sempre: itens × marketplaces numa reserva só", async () => {
    // 20 produtos × 2 marketplaces = 40 (o lote do cliente)
    await consumeSearchQuota("uid-1", "serpapi", 20 * 2);
    expect(db.counters.get(TODAY)).toBe(40);
  });

  it("permite chegar EXATAMENTE em 100 e bloqueia a partir da 101ª", async () => {
    db.counters.set(TODAY, 99);
    expect(await consumeSearchQuota("uid-1", "serpapi", 1)).toEqual({ used: 100, limit: 100 });
    await expect(consumeSearchQuota("uid-1", "serpapi", 1)).rejects.toThrow(QuotaExceededError);
    expect(db.counters.get(TODAY)).toBe(100);
  });

  it("a reserva que estouraria é recusada INTEIRA — nada é gravado pela metade", async () => {
    db.counters.set(TODAY, 90);
    await expect(consumeSearchQuota("uid-1", "serpapi", 40)).rejects.toMatchObject({ used: 90, limit: 100 });
    expect(db.counters.get(TODAY)).toBe(90);
  });

  it("a mensagem do bloqueio é a combinada, com o aviso do que ainda resta", async () => {
    db.counters.set(TODAY, 100);
    await expect(consumeSearchQuota("uid-1", "serpapi", 1)).rejects.toThrow(
      "Limite diário de 100 buscas atingido. Volta amanhã, a partir da meia-noite no horário de Brasília."
    );

    db.counters.set(TODAY, 90);
    await expect(consumeSearchQuota("uid-1", "serpapi", 40)).rejects.toThrow(
      "Restam 10 hoje; esta busca precisa de 40."
    );
  });

  it("requisições SIMULTÂNEAS não furam o limite (ler-somar-gravar em transaction)", async () => {
    const results = await Promise.allSettled(
      Array.from({ length: 6 }, () => consumeSearchQuota("uid-1", "serpapi", 30))
    );

    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(3); // 3 × 30 = 90 ≤ 100
    expect(results.filter((r) => r.status === "rejected")).toHaveLength(3);
    expect(db.counters.get(TODAY)).toBe(90);
  });

  it("cada usuário tem o próprio contador", async () => {
    db.counters.set(TODAY, 100);
    await expect(consumeSearchQuota("uid-1", "serpapi", 1)).rejects.toThrow(QuotaExceededError);
    expect(await consumeSearchQuota("uid-2", "serpapi", 1)).toEqual({ used: 1, limit: 100 });
  });
});

describe("virada de dia no fuso de Brasília", () => {
  it("às 23h59 de Brasília ainda é o mesmo dia; à meia-noite o contador recomeça do zero", async () => {
    // 2026-11-11T02:59:00Z = 23:59 do dia 10 em Brasília (UTC-3).
    vi.setSystemTime(new Date("2026-11-11T02:59:00Z"));
    db.counters.set("users/uid-1/usage_daily/20261110", 100);
    await expect(consumeSearchQuota("uid-1", "serpapi", 1)).rejects.toThrow(QuotaExceededError);

    // 2026-11-11T03:00:00Z = 00:00 do dia 11 em Brasília.
    vi.setSystemTime(new Date("2026-11-11T03:00:00Z"));
    expect(await consumeSearchQuota("uid-1", "serpapi", 1)).toEqual({ used: 1, limit: 100 });
    expect(db.counters.get("users/uid-1/usage_daily/20261111")).toBe(1);
    // o dia anterior não é tocado
    expect(db.counters.get("users/uid-1/usage_daily/20261110")).toBe(100);
  });

  it("não vira às 21h de Brasília (que seria a meia-noite em UTC)", async () => {
    vi.setSystemTime(new Date("2026-11-11T00:30:00Z")); // 21:30 do dia 10 em Brasília
    db.counters.set("users/uid-1/usage_daily/20261110", 100);
    await expect(consumeSearchQuota("uid-1", "serpapi", 1)).rejects.toThrow(QuotaExceededError);
  });
});

describe("falha na infraestrutura do contador", () => {
  it("modo gratuito: falha FECHADA — não deixa a busca seguir sem reservar", async () => {
    db.failTransactions = true;
    vi.spyOn(console, "error").mockImplementation(() => {});
    await expect(consumeSearchQuota("uid-1", "serpapi", 1)).rejects.toThrow(QuotaUnavailableError);
  });

  it("cobrança ligada: o erro cru sobe (os chamadores seguem sem bloquear, como sempre)", async () => {
    process.env.BILLING_ENABLED = "true";
    db.failTransactions = true;
    const error = await consumeSearchQuota("uid-1", "serpapi", 1).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(Error);
    expect(error).not.toBeInstanceOf(QuotaUnavailableError);
    expect((error as Error).message).toBe("firestore indisponível");
  });
});
