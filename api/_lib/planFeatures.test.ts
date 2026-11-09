import { describe, expect, it } from "vitest";
import { featuresForPlan } from "./planFeatures.js";

describe("featuresForPlan — plano efetivo no servidor", () => {
  it("modo gratuito (cobrança desligada): todo mundo tem os recursos do pro, qualquer que seja o plano salvo", () => {
    for (const saved of ["free", "starter", "pro", "iniciante", "", undefined]) {
      expect(featuresForPlan(saved, false)).toEqual({ productAssistant: true, autoWatchCheck: true });
    }
  });

  it("cobrança ligada: volta ao comportamento original por plano", () => {
    expect(featuresForPlan("free", true)).toEqual({ productAssistant: false, autoWatchCheck: false });
    expect(featuresForPlan("starter", true)).toEqual({ productAssistant: false, autoWatchCheck: false });
    expect(featuresForPlan("pro", true)).toEqual({ productAssistant: true, autoWatchCheck: true });
  });

  it("cobrança ligada: plano desconhecido ou ausente cai no mais restritivo (free)", () => {
    expect(featuresForPlan("inexistente", true)).toEqual({ productAssistant: false, autoWatchCheck: false });
    expect(featuresForPlan(undefined, true)).toEqual({ productAssistant: false, autoWatchCheck: false });
  });

  it("sem o 2º argumento, segue BILLING_ENABLED (desligada por padrão)", () => {
    const original = process.env.BILLING_ENABLED;
    try {
      delete process.env.BILLING_ENABLED;
      expect(featuresForPlan("free").productAssistant).toBe(true);
      process.env.BILLING_ENABLED = "true";
      expect(featuresForPlan("free").productAssistant).toBe(false);
    } finally {
      if (original === undefined) delete process.env.BILLING_ENABLED;
      else process.env.BILLING_ENABLED = original;
    }
  });
});
