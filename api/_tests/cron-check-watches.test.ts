import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ApiRequest, ApiResponse } from "../_lib/httpTypes.js";

/**
 * Elegibilidade e teto do cron de checagem automática. O portão de segredo
 * está em auth-gates.test.ts.
 */
const state = vi.hoisted(() => ({
  plan: "free" as string,
  autoCheck: true,
  watches: [] as { uid: string; lastCheckedAt: number; provider: string }[],
}));
const quota = vi.hoisted(() => ({ consumeSearchQuota: vi.fn() }));
const check = vi.hoisted(() => ({ checkAndPersistWatch: vi.fn() }));

vi.mock("../_lib/firestoreAdmin.js", () => ({
  getAdminDb: () => ({
    collectionGroup: () => ({
      where: () => ({
        get: async () => ({
          docs: state.watches.map((w, i) => ({
            ref: { path: `users/${w.uid}/watches/w${i}`, parent: { parent: { id: w.uid } } },
            data: () => ({ active: true, lastCheckedAt: w.lastCheckedAt, provider: w.provider }),
          })),
        }),
      }),
    }),
    collection: () => ({
      doc: () => ({
        get: async () => ({ data: () => ({ plan: state.plan }) }),
        collection: () => ({ doc: () => ({ get: async () => ({ data: () => ({ autoCheckWatches: state.autoCheck }) }) }) }),
      }),
    }),
  }),
}));
vi.mock("../_lib/searchQuota.js", async () => {
  const actual = await vi.importActual<typeof import("../_lib/searchQuota.js")>("../_lib/searchQuota.js");
  return { ...actual, consumeSearchQuota: quota.consumeSearchQuota };
});
vi.mock("../_lib/watchCheck.js", () => ({ checkAndPersistWatch: check.checkAndPersistWatch }));

import handler from "../cron-check-watches.js";
import { QuotaExceededError, QuotaUnavailableError } from "../_lib/searchQuota.js";

function makeRes() {
  const out = { status: 0, body: undefined as unknown };
  const res: ApiResponse = {
    status(code) {
      out.status = code;
      return res;
    },
    json(body) {
      out.body = body;
    },
    setHeader() {
      return res;
    },
    send() {},
  };
  return { res, out };
}

const REQUEST: ApiRequest = { method: "GET", headers: { authorization: "Bearer segredo" }, body: undefined };
const ORIGINAL = { secret: process.env.CRON_SECRET, billing: process.env.BILLING_ENABLED };
const OLD = 1_000; // checado há muito tempo → já pode ser checado de novo

beforeEach(() => {
  vi.clearAllMocks();
  process.env.CRON_SECRET = "segredo";
  delete process.env.BILLING_ENABLED;
  state.plan = "free";
  state.autoCheck = true;
  state.watches = [];
  quota.consumeSearchQuota.mockResolvedValue({ used: 1, limit: 100 });
  check.checkAndPersistWatch.mockResolvedValue({ alertId: null });
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
  return () => {
    for (const [key, value] of [
      ["CRON_SECRET", ORIGINAL.secret],
      ["BILLING_ENABLED", ORIGINAL.billing],
    ] as const) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  };
});

const watchesOf = (uid: string, n: number) =>
  Array.from({ length: n }, (_, i) => ({ uid, lastCheckedAt: OLD + i, provider: "serpapi" }));

describe("cron-check-watches", () => {
  it("modo gratuito: conta no plano 'free' também é checada (todos têm a checagem automática)", async () => {
    state.watches = watchesOf("u1", 3);
    const { res, out } = makeRes();
    await handler(REQUEST, res);

    expect(out.body).toMatchObject({ candidates: 3, checked: 3 });
  });

  it("cobrança ligada: volta ao original — plano 'free' NÃO é checado, 'pro' é", async () => {
    process.env.BILLING_ENABLED = "true";
    state.watches = watchesOf("u1", 2);

    state.plan = "free";
    const first = makeRes();
    await handler(REQUEST, first.res);
    expect(first.out.body).toMatchObject({ candidates: 0, checked: 0 });

    state.plan = "pro";
    const second = makeRes();
    await handler(REQUEST, second.res);
    expect(second.out.body).toMatchObject({ candidates: 2, checked: 2 });
  });

  it("só quem ligou 'Checar automaticamente todo dia' é checado", async () => {
    state.autoCheck = false;
    state.watches = watchesOf("u1", 2);
    const { res, out } = makeRes();
    await handler(REQUEST, res);

    expect(out.body).toMatchObject({ candidates: 0 });
    expect(check.checkAndPersistWatch).not.toHaveBeenCalled();
  });

  it("teto de 200 watches por usuário — quem gravou milhares direto no banco não faz o cron varrer tudo", async () => {
    state.watches = watchesOf("u1", 450);
    const { res, out } = makeRes();
    await handler(REQUEST, res);

    expect(out.body).toMatchObject({ candidates: 200, checked: 200 });
    expect(check.checkAndPersistWatch).toHaveBeenCalledTimes(200);
  });

  it("dentro do teto, vão os de checagem mais antiga", async () => {
    state.watches = [
      { uid: "u1", lastCheckedAt: 5_000, provider: "serpapi" },
      ...watchesOf("u1", 200), // 1.000…1.199: todos mais antigos que o de 5.000
    ];
    const { res } = makeRes();
    await handler(REQUEST, res);

    const checkedTimes = check.checkAndPersistWatch.mock.calls.map((c) => (c[3] as { lastCheckedAt: number }).lastCheckedAt);
    expect(checkedTimes).toHaveLength(200);
    expect(checkedTimes).not.toContain(5_000);
  });

  it("não rechecou o que foi checado há pouco (menos de 20h)", async () => {
    state.watches = [{ uid: "u1", lastCheckedAt: Date.now() - 60_000, provider: "serpapi" }];
    const { res, out } = makeRes();
    await handler(REQUEST, res);

    expect(out.body).toMatchObject({ candidates: 0 });
  });

  it("limite diário estourado: para de checar daquele usuário, sem erro", async () => {
    state.watches = watchesOf("u1", 5);
    quota.consumeSearchQuota
      .mockResolvedValueOnce({ used: 99, limit: 100 })
      .mockRejectedValue(new QuotaExceededError("limite", 100, 100));
    const { res, out } = makeRes();
    await handler(REQUEST, res);

    expect(out.status).toBe(200);
    expect(out.body).toMatchObject({ checked: 1, quotaBlockedUsers: 1 });
  });

  it("contador fora do ar (modo gratuito): não checa nada — falha fechada", async () => {
    state.watches = watchesOf("u1", 3);
    quota.consumeSearchQuota.mockRejectedValue(new QuotaUnavailableError());
    const { res, out } = makeRes();
    await handler(REQUEST, res);

    expect(out.body).toMatchObject({ checked: 0 });
    expect(check.checkAndPersistWatch).not.toHaveBeenCalled();
  });
});
