import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ApiRequest, ApiResponse } from "../_lib/httpTypes.js";

/**
 * O limite diário tem que valer NO SERVIDOR: a rota recusa ANTES de buscar
 * qualquer preço (nenhuma API externa é chamada) e devolve a mensagem
 * amigável. Aqui só se verifica o contrato HTTP — a lógica do contador está
 * em api/_lib/searchQuota.freeMode.test.ts.
 */
const core = vi.hoisted(() => ({ fetchPricesCore: vi.fn() }));
const quota = vi.hoisted(() => ({ consumeSearchQuota: vi.fn() }));

vi.mock("../_lib/verifyAuth.js", async () => {
  const actual = await vi.importActual<typeof import("../_lib/verifyAuth.js")>("../_lib/verifyAuth.js");
  return { ...actual, requireVerifiedAuth: vi.fn(async () => "uid-1") };
});
vi.mock("../_lib/searchQuota.js", async () => {
  const actual = await vi.importActual<typeof import("../_lib/searchQuota.js")>("../_lib/searchQuota.js");
  return { ...actual, consumeSearchQuota: quota.consumeSearchQuota };
});
vi.mock("../_lib/fetchPricesCore.js", () => ({
  fetchPricesCore: core.fetchPricesCore,
  FetchPricesValidationError: class FetchPricesValidationError extends Error {},
}));

import handler from "../fetch-prices.js";
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

const request = (items = 2): ApiRequest => ({
  method: "POST",
  headers: { authorization: "Bearer x" },
  body: {
    marketplaces: ["amazon", "mercadolivre"],
    provider: "serpapi",
    items: Array.from({ length: items }, (_, i) => ({ sku: `SKU-${i}`, name: `Produto ${i}` })),
  },
});

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});

describe("POST /api/fetch-prices — limite diário", () => {
  it("reserva produtos × marketplaces na cota ANTES de buscar", async () => {
    quota.consumeSearchQuota.mockResolvedValue({ used: 4, limit: 100 });
    core.fetchPricesCore.mockResolvedValue({ byMarketplace: {}, warning: undefined, reasons: {} });

    const { res, out } = makeRes();
    await handler(request(2), res);

    expect(quota.consumeSearchQuota).toHaveBeenCalledWith("uid-1", "serpapi", 4);
    expect(out.status).toBe(200);
    expect(out.body).toMatchObject({ _usage: { used: 4, limit: 100 } });
  });

  it("estourou o limite: 429 com a mensagem amigável e SEM buscar preço nenhum", async () => {
    const message =
      "Limite diário de 100 buscas atingido. Volta amanhã, a partir da meia-noite no horário de Brasília.";
    quota.consumeSearchQuota.mockRejectedValue(new QuotaExceededError(message, 100, 100));

    const { res, out } = makeRes();
    await handler(request(), res);

    expect(out.status).toBe(429);
    expect(out.body).toEqual({ error: message, used: 100, limit: 100 });
    expect(core.fetchPricesCore).not.toHaveBeenCalled();
  });

  it("contador indisponível: 503 e SEM buscar (falha fechada no modo gratuito)", async () => {
    quota.consumeSearchQuota.mockRejectedValue(new QuotaUnavailableError());

    const { res, out } = makeRes();
    await handler(request(), res);

    expect(out.status).toBe(503);
    expect(core.fetchPricesCore).not.toHaveBeenCalled();
  });

  it("erro cru do contador (cobrança ligada): segue sem bloquear, como sempre foi", async () => {
    quota.consumeSearchQuota.mockRejectedValue(new Error("firestore indisponível"));
    core.fetchPricesCore.mockResolvedValue({ byMarketplace: {}, warning: undefined, reasons: {} });

    const { res, out } = makeRes();
    await handler(request(), res);

    expect(out.status).toBe(200);
    expect(core.fetchPricesCore).toHaveBeenCalledTimes(1);
  });
});
