import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ApiRequest, ApiResponse } from "./_lib/httpTypes.js";

/**
 * Portões de autenticação de TODAS as rotas de api/ (revisão de segurança,
 * nov/2026). Sem token, cada rota recusa ANTES de tocar o banco ou um
 * provedor externo. Quem trava o cron é o segredo (CRON_SECRET), não um
 * login. Se alguém criar uma rota nova, o lugar de lembrar dela é aqui.
 */
const auth = vi.hoisted(() => ({ verifyIdToken: vi.fn() }));
const db = vi.hoisted(() => ({ touched: 0, isAdmin: false, watches: [] as unknown[] }));

vi.mock("firebase-admin/auth", () => ({ getAuth: () => ({ verifyIdToken: auth.verifyIdToken, getUser: vi.fn() }) }));
vi.mock("./_lib/firestoreAdmin.js", () => ({
  getAdminApp: () => ({}),
  getAdminDb: () => {
    db.touched++;
    return {
      collection: () => ({
        doc: () => ({
          get: async () => ({ exists: true, data: () => ({ isAdmin: db.isAdmin, plan: "free" }) }),
          collection: () => ({ doc: () => ({ get: async () => ({ exists: false, data: () => undefined }) }) }),
        }),
      }),
      collectionGroup: () => ({ where: () => ({ get: async () => ({ docs: db.watches }) }) }),
    };
  },
}));
vi.mock("./_lib/fetchPricesCore.js", () => ({
  fetchPricesCore: vi.fn(),
  FetchPricesValidationError: class FetchPricesValidationError extends Error {},
}));
vi.mock("./_lib/mercadoPago.js", () => ({
  createPreapproval: vi.fn(),
  getPreapproval: vi.fn(),
  verifyWebhookSignature: vi.fn(() => false),
  isActiveSubscriptionStatus: vi.fn(),
}));

import fetchPrices from "./fetch-prices.js";
import checkWatch from "./check-watch.js";
import productAssistant from "./product-assistant.js";
import adminDiagnostics from "./admin-diagnostics.js";
import billingCreate from "./billing-create-subscription.js";
import billingWebhook from "./billing-webhook.js";
import cron from "./cron-check-watches.js";

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

const req = (method: string, headers: ApiRequest["headers"] = {}, body: unknown = {}): ApiRequest => ({ method, headers, body });

const ORIGINAL = { cron: process.env.CRON_SECRET, billing: process.env.BILLING_ENABLED };

beforeEach(() => {
  vi.clearAllMocks();
  db.touched = 0;
  db.isAdmin = false;
  db.watches = [];
  delete process.env.CRON_SECRET;
  process.env.BILLING_ENABLED = "true"; // senão as rotas de cobrança respondem 503 antes de autenticar
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "log").mockImplementation(() => {});
  return () => {
    for (const [key, value] of [
      ["CRON_SECRET", ORIGINAL.cron],
      ["BILLING_ENABLED", ORIGINAL.billing],
    ] as const) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  };
});

describe("rotas de usuário: sem token → 401, sem tocar banco nem provedor", () => {
  const routes: [string, (q: ApiRequest, s: ApiResponse) => Promise<void>, string][] = [
    ["fetch-prices", fetchPrices, "POST"],
    ["check-watch", checkWatch, "POST"],
    ["product-assistant", productAssistant, "POST"],
    ["admin-diagnostics", adminDiagnostics, "GET"],
    ["billing-create-subscription", billingCreate, "POST"],
  ];

  it.each(routes)("%s", async (_name, handler, method) => {
    const { res, out } = makeRes();
    await handler(req(method), res);

    expect(out.status).toBe(401);
    expect(db.touched).toBe(0);
    expect(auth.verifyIdToken).not.toHaveBeenCalled();
  });

  it.each(routes)("%s: token inválido → 401 com mensagem genérica", async (_name, handler, method) => {
    auth.verifyIdToken.mockRejectedValue(new Error("detalhe interno do firebase"));
    const { res, out } = makeRes();
    await handler(req(method, { authorization: "Bearer lixo" }), res);

    expect(out.status).toBe(401);
    expect(JSON.stringify(out.body)).not.toContain("detalhe interno");
  });
});

describe("admin-diagnostics exige admin de verdade", () => {
  it("usuário logado mas sem isAdmin → 403", async () => {
    auth.verifyIdToken.mockResolvedValue({ uid: "u1", email_verified: true });
    db.isAdmin = false;
    const { res, out } = makeRes();
    await adminDiagnostics(req("GET", { authorization: "Bearer ok" }), res);
    expect(out.status).toBe(403);
  });

  it("admin → 200, e o corpo só tem booleanos e nomes, nunca valor de variável", async () => {
    auth.verifyIdToken.mockResolvedValue({ uid: "u1", email_verified: true });
    db.isAdmin = true;
    process.env.ML_CLIENT_ID = "valor-secreto-ml";
    process.env.FIREBASE_PRIVATE_KEY = "valor-secreto-firebase";
    const { res, out } = makeRes();
    await adminDiagnostics(req("GET", { authorization: "Bearer ok" }), res);

    expect(out.status).toBe(200);
    expect(JSON.stringify(out.body)).not.toMatch(/valor-secreto/);
    delete process.env.ML_CLIENT_ID;
    delete process.env.FIREBASE_PRIVATE_KEY;
  });
});

describe("cron-check-watches: trava pelo segredo, não por login", () => {
  it("sem CRON_SECRET configurado: recusa tudo (nunca roda aberto)", async () => {
    const { res, out } = makeRes();
    await cron(req("GET", { authorization: "Bearer qualquer-coisa" }), res);
    expect(out.status).toBe(401);
    expect(db.touched).toBe(0);
  });

  it("com segredo configurado: sem header, header errado e de tamanho diferente → 401", async () => {
    process.env.CRON_SECRET = "segredo-do-cron";
    for (const headers of [{}, { authorization: "Bearer errado" }, { authorization: "segredo-do-cron" }, { authorization: "Bearer segredo-do-cron-a-mais" }]) {
      const { res, out } = makeRes();
      await cron(req("GET", headers), res);
      expect(out.status).toBe(401);
    }
    expect(db.touched).toBe(0);
  });

  it("token de usuário (Firebase) NÃO serve de segredo do cron", async () => {
    process.env.CRON_SECRET = "segredo-do-cron";
    auth.verifyIdToken.mockResolvedValue({ uid: "u1", email_verified: true });
    const { res, out } = makeRes();
    await cron(req("GET", { authorization: "Bearer token-de-usuario" }), res);
    expect(out.status).toBe(401);
  });

  it("segredo correto passa pelo portão", async () => {
    process.env.CRON_SECRET = "segredo-do-cron";
    const { res, out } = makeRes();
    await cron(req("GET", { authorization: "Bearer segredo-do-cron" }), res);
    expect(out.status).toBe(200);
    expect(out.body).toMatchObject({ candidates: 0, checked: 0 });
  });

  it("outros métodos (PUT/DELETE) → 405", async () => {
    process.env.CRON_SECRET = "segredo-do-cron";
    const { res, out } = makeRes();
    await cron(req("DELETE", { authorization: "Bearer segredo-do-cron" }), res);
    expect(out.status).toBe(405);
  });
});

describe("billing-webhook: autenticidade vem da assinatura, não de login", () => {
  it("evento de assinatura com assinatura inválida → 401 e nada é gravado", async () => {
    const { res, out } = makeRes();
    await billingWebhook(req("POST", {}, { type: "subscription_preapproval", data: { id: "x" } }), res);
    expect(out.status).toBe(401);
    expect(db.touched).toBe(0);
  });

  it("evento de outro tipo é ignorado com 200 (sem retry do Mercado Pago)", async () => {
    const { res, out } = makeRes();
    await billingWebhook(req("POST", {}, { type: "payment", data: { id: "x" } }), res);
    expect(out.status).toBe(200);
    expect(db.touched).toBe(0);
  });
});
