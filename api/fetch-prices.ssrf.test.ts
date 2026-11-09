import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ApiRequest, ApiResponse } from "./_lib/httpTypes.js";

/**
 * `imageUrl` é o único campo do corpo que o servidor transforma em
 * `fetch()`. A fronteira de confiança fica na rota: só vale a foto que o
 * PRÓPRIO app hospedou, no host da própria requisição.
 */
const core = vi.hoisted(() => ({ fetchPricesCore: vi.fn() }));
const quota = vi.hoisted(() => ({ consumeSearchQuota: vi.fn() }));

vi.mock("./_lib/verifyAuth.js", async () => {
  const actual = await vi.importActual<typeof import("./_lib/verifyAuth.js")>("./_lib/verifyAuth.js");
  return { ...actual, requireVerifiedAuth: vi.fn(async () => "uid-1") };
});
vi.mock("./_lib/searchQuota.js", async () => {
  const actual = await vi.importActual<typeof import("./_lib/searchQuota.js")>("./_lib/searchQuota.js");
  return { ...actual, consumeSearchQuota: quota.consumeSearchQuota };
});
vi.mock("./_lib/fetchPricesCore.js", () => ({
  fetchPricesCore: core.fetchPricesCore,
  FetchPricesValidationError: class FetchPricesValidationError extends Error {},
}));

import handler from "./fetch-prices.js";

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

const request = (imageUrl: string | undefined, host = "app-arbitra.vercel.app"): ApiRequest => ({
  method: "POST",
  headers: { authorization: "Bearer x", host },
  body: {
    marketplaces: ["amazon"],
    provider: "vision_internal",
    items: [{ sku: "A", name: "Produto", ...(imageUrl !== undefined ? { imageUrl } : {}) }],
  },
});

const ORIGINAL_VERCEL_ENV = process.env.VERCEL_ENV;

beforeEach(() => {
  vi.clearAllMocks();
  process.env.VERCEL_ENV = "production"; // modo estrito de deploy
  quota.consumeSearchQuota.mockResolvedValue({ used: 1, limit: 100 });
  core.fetchPricesCore.mockResolvedValue({ byMarketplace: {}, warning: undefined, reasons: {} });
  vi.spyOn(console, "log").mockImplementation(() => {});
  return () => {
    if (ORIGINAL_VERCEL_ENV === undefined) delete process.env.VERCEL_ENV;
    else process.env.VERCEL_ENV = ORIGINAL_VERCEL_ENV;
  };
});

describe("POST /api/fetch-prices — foto do catálogo (SSRF)", () => {
  it("aceita a foto hospedada no próprio app (mesmo host da requisição)", async () => {
    const { res, out } = makeRes();
    await handler(request("https://app-arbitra.vercel.app/api/catalog-image?id=abc"), res);

    expect(out.status).toBe(200);
    expect(core.fetchPricesCore).toHaveBeenCalledTimes(1);
  });

  it("item sem foto continua válido (busca por texto)", async () => {
    const { res, out } = makeRes();
    await handler(request(undefined), res);

    expect(out.status).toBe(200);
  });

  it.each([
    ["host público qualquer, com a rota certa", "https://evil.example.com/api/catalog-image?id=abc"],
    ["metadata da nuvem", "http://169.254.169.254/latest/meta-data/"],
    ["loopback com a rota certa", "https://127.0.0.1/api/catalog-image?id=abc"],
    ["IPv6 embutido", "https://[::ffff:127.0.0.1]/api/catalog-image?id=abc"],
    ["rota errada no host do app", "https://app-arbitra.vercel.app/api/admin-diagnostics"],
    ["host que só COMEÇA igual", "https://app-arbitra.vercel.app.evil.com/api/catalog-image?id=abc"],
    ["usuário@host", "https://evil.com@app-arbitra.vercel.app/api/catalog-image?id=abc"],
    ["esquema file:", "file:///etc/passwd"],
  ])("recusa com 400 e nem chega na cota nem na busca: %s", async (_label, imageUrl) => {
    const { res, out } = makeRes();
    await handler(request(imageUrl), res);

    expect(out.status).toBe(400);
    expect(quota.consumeSearchQuota).not.toHaveBeenCalled();
    expect(core.fetchPricesCore).not.toHaveBeenCalled();
  });

  it("a foto do app só vale no host de quem fez a requisição (outro domínio do app não serve)", async () => {
    const { res, out } = makeRes();
    await handler(request("https://app-arbitra.vercel.app/api/catalog-image?id=abc", "outro-dominio.com"), res);

    expect(out.status).toBe(400);
    expect(core.fetchPricesCore).not.toHaveBeenCalled();
  });
});
