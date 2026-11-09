import { describe, expect, it } from "vitest";
import { dailyLimitMessage, DEFAULT_DAILY_SEARCH_LIMIT, getDailySearchLimit } from "./freeMode.js";

describe("getDailySearchLimit (DAILY_SEARCH_LIMIT)", () => {
  it("o padrão é 100 buscas por dia", () => {
    expect(DEFAULT_DAILY_SEARCH_LIMIT).toBe(100);
    expect(getDailySearchLimit({})).toBe(100);
  });

  it("aceita um override inteiro positivo", () => {
    expect(getDailySearchLimit({ DAILY_SEARCH_LIMIT: "250" })).toBe(250);
    expect(getDailySearchLimit({ DAILY_SEARCH_LIMIT: " 40 " })).toBe(40);
  });

  it("valor inválido NUNCA vira 'sem limite' — cai no padrão", () => {
    for (const value of ["", "abc", "0", "-5", "10.5", "1e9", "Infinity", "NaN", "100000000"]) {
      expect(getDailySearchLimit({ DAILY_SEARCH_LIMIT: value })).toBe(100);
    }
  });
});

describe("dailyLimitMessage", () => {
  it("é a mensagem amigável combinada, com o limite vigente", () => {
    expect(dailyLimitMessage(100)).toBe(
      "Limite diário de 100 buscas atingido. Volta amanhã, a partir da meia-noite no horário de Brasília."
    );
    expect(dailyLimitMessage(250)).toContain("250 buscas");
  });
});
