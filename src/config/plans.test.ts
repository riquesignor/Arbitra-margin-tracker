import { describe, expect, it } from "vitest";
import { getEffectivePlan, getPlan, PLANS } from "./plans";
import { DEFAULT_DAILY_SEARCH_LIMIT, parseDailySearchLimit } from "./limits";

describe("getEffectivePlan — modo gratuito (cobrança desligada)", () => {
  it("todo mundo ganha os recursos e os tetos do plano pro, qualquer que seja o plano salvo", () => {
    const pro = getPlan("pro");
    for (const saved of ["free", "starter", "pro", null, undefined] as const) {
      const plan = getEffectivePlan(saved, false);
      expect(plan.features).toEqual(pro.features);
      expect(plan.features.productAssistant).toBe(true);
      expect(plan.features.autoWatchCheck).toBe(true);
      expect(plan.features.printableReport).toBe(true);
      expect(plan.maxWatches).toBe(pro.maxWatches);
      expect(plan.features.historyLimit).toBe(pro.features.historyLimit);
    }
  });

  it("nada fica ilimitado: os tetos são números finitos", () => {
    const plan = getEffectivePlan("free", false);
    for (const value of [plan.maxWatches, plan.features.historyLimit, plan.dailySearchLimit]) {
      expect(Number.isFinite(value)).toBe(true);
      expect(value).toBeGreaterThan(0);
    }
  });

  it("o limite diário é UM só e igual pra todos (100 por padrão)", () => {
    expect(DEFAULT_DAILY_SEARCH_LIMIT).toBe(100);
    for (const saved of ["free", "starter", "pro"] as const) {
      expect(getEffectivePlan(saved, false).dailySearchLimit).toBe(100);
    }
    expect(getEffectivePlan("free", false, 40).dailySearchLimit).toBe(40);
  });

  it("mantém o id salvo (a biblioteca de catálogos continua liberada por ele) e se apresenta como gratuito", () => {
    const plan = getEffectivePlan("starter", false);
    expect(plan.id).toBe("starter");
    expect(plan.name).toBe("Gratuito");
    expect(plan.priceLabel).toBe("Grátis");
  });

  it("não altera as definições dos planos (nada é gravado nem mutado)", () => {
    const before = JSON.stringify(PLANS);
    getEffectivePlan("free", false);
    getEffectivePlan("starter", false, 7);
    expect(JSON.stringify(PLANS)).toBe(before);
  });
});

describe("getEffectivePlan — cobrança ligada volta ao comportamento original", () => {
  it("devolve exatamente o plano salvo", () => {
    for (const id of ["free", "starter", "pro"] as const) {
      expect(getEffectivePlan(id, true)).toBe(getPlan(id));
    }
    expect(getEffectivePlan("free", true).dailySearchLimit).toBe(50);
    expect(getEffectivePlan("free", true).features.productAssistant).toBe(false);
    expect(getEffectivePlan("free", true).maxWatches).toBe(10);
  });

  it("plano ausente ou desconhecido cai no free, como sempre", () => {
    expect(getEffectivePlan(undefined, true)).toBe(getPlan("free"));
    expect(getEffectivePlan(null, true)).toBe(getPlan("free"));
  });
});

describe("parseDailySearchLimit (VITE_DAILY_SEARCH_LIMIT)", () => {
  it("segue as mesmas regras do servidor: inteiro positivo ou o padrão, nunca 'sem limite'", () => {
    expect(parseDailySearchLimit(undefined)).toBe(100);
    expect(parseDailySearchLimit("250")).toBe(250);
    for (const bad of ["", "abc", "0", "-1", "1.5", "1e9", "999999999"]) {
      expect(parseDailySearchLimit(bad)).toBe(100);
    }
  });
});
