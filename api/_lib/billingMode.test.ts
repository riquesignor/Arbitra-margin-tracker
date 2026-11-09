import { describe, expect, it } from "vitest";
import { BILLING_DISABLED_MESSAGE, isBillingEnabled } from "./billingMode.js";

describe("isBillingEnabled", () => {
  it("vem DESLIGADA por padrão (variável ausente ou vazia)", () => {
    expect(isBillingEnabled({})).toBe(false);
    expect(isBillingEnabled({ BILLING_ENABLED: "" })).toBe(false);
    expect(isBillingEnabled({ BILLING_ENABLED: "   " })).toBe(false);
  });

  it("só 'true' ou '1' ligam (sem diferenciar maiúsculas e espaços)", () => {
    expect(isBillingEnabled({ BILLING_ENABLED: "true" })).toBe(true);
    expect(isBillingEnabled({ BILLING_ENABLED: " TRUE " })).toBe(true);
    expect(isBillingEnabled({ BILLING_ENABLED: "1" })).toBe(true);
  });

  it("qualquer outro valor mantém desligada — na dúvida, não cobra", () => {
    for (const value of ["false", "0", "yes", "on", "sim", "talvez"]) {
      expect(isBillingEnabled({ BILLING_ENABLED: value })).toBe(false);
    }
  });
});

describe("BILLING_DISABLED_MESSAGE", () => {
  it("é curta e não entrega nome de variável nem como ligar", () => {
    expect(BILLING_DISABLED_MESSAGE).toBe("Cobrança indisponível nesta versão.");
    expect(BILLING_DISABLED_MESSAGE).not.toMatch(/BILLING|MERCADOPAGO|env|variável/i);
  });
});
