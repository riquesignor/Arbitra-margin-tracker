import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ApiRequest, ApiResponse } from "../_lib/httpTypes.js";

/**
 * Validação de entrada e vazamento de erro em POST /api/fetch-prices.
 */
const core = vi.hoisted(() => ({ fetchPricesCore: vi.fn() }));
const quota = vi.hoisted(() => ({ consumeSearchQuota: vi.fn() }));
const auth = vi.hoisted(() => ({ requireVerifiedAuth: vi.fn() }));

vi.mock("../_lib/verifyAuth.js", async () => {
  const actual = await vi.importActual<typeof import("../_lib/verifyAuth.js")>("../_lib/verifyAuth.js");
  return { ...actual, requireVerifiedAuth: auth.requireVerifiedAuth };
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
import { EmailNotVerifiedError, UnauthorizedError } from "../_lib/verifyAuth.js";

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

const request = (body: unknown, method = "POST"): ApiRequest => ({
  method,
  headers: { authorization: "Bearer x", host: "app.exemplo.com" },
  body,
});
const valid = { marketplaces: ["amazon"], provider: "serpapi", items: [{ sku: "A", name: "Produto" }] };

beforeEach(() => {
  vi.clearAllMocks();
  auth.requireVerifiedAuth.mockResolvedValue("uid-1");
  quota.consumeSearchQuota.mockResolvedValue({ used: 1, limit: 100 });
  core.fetchPricesCore.mockResolvedValue({ byMarketplace: {}, warning: undefined, reasons: {} });
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});

describe("POST /api/fetch-prices — autenticação", () => {
  it("sem login: 401, sem cota e sem busca", async () => {
    auth.requireVerifiedAuth.mockRejectedValue(new UnauthorizedError("Sessão inválida ou expirada. Entre de novo."));
    const { res, out } = makeRes();
    await handler(request(valid), res);

    expect(out.status).toBe(401);
    expect(quota.consumeSearchQuota).not.toHaveBeenCalled();
    expect(core.fetchPricesCore).not.toHaveBeenCalled();
  });

  it("e-mail não confirmado: 403", async () => {
    auth.requireVerifiedAuth.mockRejectedValue(new EmailNotVerifiedError("Confirme seu email"));
    const { res, out } = makeRes();
    await handler(request(valid), res);

    expect(out.status).toBe(403);
    expect(core.fetchPricesCore).not.toHaveBeenCalled();
  });

  it("só aceita POST", async () => {
    const { res, out } = makeRes();
    await handler(request(valid, "GET"), res);
    expect(out.status).toBe(405);
  });
});

describe("POST /api/fetch-prices — limites dos campos", () => {
  it.each([
    ["sku gigante", { sku: "S".repeat(301), name: "ok" }],
    ["nome gigante", { sku: "A", name: "N".repeat(2001) }],
    ["imageUrl gigante", { sku: "A", name: "ok", imageUrl: "https://x/" + "a".repeat(3000) }],
    ["supplierPrice não numérico", { sku: "A", name: "ok", supplierPrice: "caro" }],
    ["supplierPrice infinito", { sku: "A", name: "ok", supplierPrice: Number.MAX_VALUE * 10 }],
    ["sku que não é texto", { sku: 123, name: "ok" }],
  ])("recusa com 400 antes da cota: %s", async (_label, item) => {
    const { res, out } = makeRes();
    await handler(request({ ...valid, items: [item] }), res);

    expect(out.status).toBe(400);
    expect(quota.consumeSearchQuota).not.toHaveBeenCalled();
  });

  it("aceita item completo e nos limites exatos", async () => {
    const { res, out } = makeRes();
    await handler(
      request({ ...valid, items: [{ sku: "S".repeat(300), name: "N".repeat(2000), supplierPrice: 12.5 }] }),
      res
    );
    expect(out.status).toBe(200);
  });

  it("supplierPrice nulo ou ausente continua válido (catálogo sem custo)", async () => {
    const { res, out } = makeRes();
    await handler(request({ ...valid, items: [{ sku: "A", name: "ok", supplierPrice: null }, { sku: "B", name: "ok" }] }), res);
    expect(out.status).toBe(200);
  });

  it("máximo de 50 produtos por requisição", async () => {
    const items = Array.from({ length: 51 }, (_, i) => ({ sku: `S${i}`, name: "ok" }));
    const { res, out } = makeRes();
    await handler(request({ ...valid, items }), res);
    expect(out.status).toBe(400);
  });

  it("recusa marketplace/provider fora da lista", async () => {
    for (const body of [{ ...valid, marketplaces: ["ebay"] }, { ...valid, provider: "inventado" }, { ...valid, items: [] }]) {
      const { res, out } = makeRes();
      await handler(request(body), res);
      expect(out.status).toBe(400);
    }
  });
});

describe("POST /api/fetch-prices — erro do provedor", () => {
  it("o detail continua existindo (explica o problema), mas sem chave nem nome de variável", async () => {
    core.fetchPricesCore.mockRejectedValue(
      new Error(
        "SerpApi recusou: https://serpapi.com/search?api_key=MINHA-CHAVE-SECRETA&q=x — veja FIREBASE_PRIVATE_KEY"
      )
    );
    const { res, out } = makeRes();
    await handler(request(valid), res);

    expect(out.status).toBe(502);
    const body = out.body as { error: string; detail: string };
    expect(body.error).toBe("Busca de preço indisponível");
    expect(body.detail).toContain("SerpApi recusou");
    expect(body.detail).not.toMatch(/MINHA-CHAVE-SECRETA|FIREBASE_PRIVATE_KEY/);
  });
});
