import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ApiRequest, ApiResponse } from "./_lib/httpTypes.js";

/**
 * Com a cobrança desligada (padrão), as duas rotas de assinatura precisam
 * responder 503 SEM autenticar, SEM falar com o Mercado Pago e SEM mexer no
 * Firestore. O cliente do Mercado Pago e o Admin SDK são mockados só pra
 * poder afirmar que NÃO foram chamados.
 */
const mp = vi.hoisted(() => ({
  createPreapproval: vi.fn(),
  getPreapproval: vi.fn(),
  verifyWebhookSignature: vi.fn(),
  isActiveSubscriptionStatus: vi.fn(),
}));
const admin = vi.hoisted(() => ({ getAdminDb: vi.fn(), getAdminApp: vi.fn() }));

vi.mock("./_lib/mercadoPago.js", () => mp);
vi.mock("./_lib/firestoreAdmin.js", () => admin);

import createSubscription from "./billing-create-subscription.js";
import webhook from "./billing-webhook.js";

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

const ORIGINAL = process.env.BILLING_ENABLED;

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  if (ORIGINAL === undefined) delete process.env.BILLING_ENABLED;
  else process.env.BILLING_ENABLED = ORIGINAL;
});

describe("cobrança desligada (padrão)", () => {
  beforeEach(() => {
    delete process.env.BILLING_ENABLED;
  });

  it("billing-create-subscription responde 503 e não chama o Mercado Pago nem o Firestore", async () => {
    const { res, out } = makeRes();
    await createSubscription({ method: "POST", headers: { authorization: "Bearer qualquer" }, body: {} } as ApiRequest, res);

    expect(out.status).toBe(503);
    expect(out.body).toEqual({ error: "Cobrança indisponível nesta versão." });
    expect(mp.createPreapproval).not.toHaveBeenCalled();
    expect(admin.getAdminDb).not.toHaveBeenCalled();
    expect(admin.getAdminApp).not.toHaveBeenCalled();
  });

  it("billing-webhook responde 503 e não consulta o Mercado Pago nem grava plano", async () => {
    const { res, out } = makeRes();
    await webhook(
      { method: "POST", headers: {}, body: { type: "subscription_preapproval", data: { id: "abc" } } } as ApiRequest,
      res
    );

    expect(out.status).toBe(503);
    expect(out.body).toEqual({ error: "Cobrança indisponível nesta versão." });
    expect(mp.verifyWebhookSignature).not.toHaveBeenCalled();
    expect(mp.getPreapproval).not.toHaveBeenCalled();
    expect(admin.getAdminDb).not.toHaveBeenCalled();
  });

  it("a resposta 503 não vaza nome de variável nem detalhe técnico", async () => {
    const { res, out } = makeRes();
    await createSubscription({ method: "POST", headers: {}, body: {} } as ApiRequest, res);

    expect(JSON.stringify(out.body)).not.toMatch(/MERCADOPAGO|BILLING_ENABLED|token|secret|detail/i);
  });
});

describe("cobrança ligada — o código dormente continua funcionando", () => {
  beforeEach(() => {
    process.env.BILLING_ENABLED = "true";
  });

  it("billing-create-subscription volta a exigir login (401 sem token) em vez de 503", async () => {
    const { res, out } = makeRes();
    await createSubscription({ method: "POST", headers: {}, body: {} } as ApiRequest, res);

    expect(out.status).toBe(401);
  });

  it("billing-webhook volta a validar a assinatura (401 com assinatura inválida)", async () => {
    mp.verifyWebhookSignature.mockReturnValue(false);
    const { res, out } = makeRes();
    await webhook(
      { method: "POST", headers: {}, body: { type: "subscription_preapproval", data: { id: "abc" } } } as ApiRequest,
      res
    );

    expect(out.status).toBe(401);
    expect(mp.getPreapproval).not.toHaveBeenCalled();
  });
});
