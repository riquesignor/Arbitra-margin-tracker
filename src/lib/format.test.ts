import { describe, expect, it } from "vitest";
import { brl, displayProductName, formatMs, marginTone, pct } from "./format";

describe("brl", () => {
  it("usa vírgula decimal e ponto de milhar", () => {
    expect(brl(310.86)).toBe("R$ 310,86");
    expect(brl(1234.5)).toBe("R$ 1.234,50");
  });
});

describe("pct", () => {
  it("formata fração em porcentagem pt-BR", () => {
    expect(pct(-0.205)).toBe("-20,5%");
    expect(pct(0.25, 0)).toBe("25%");
  });
});

describe("formatMs", () => {
  it("mostra ms abaixo de 1s e segundos acima", () => {
    expect(formatMs(840)).toBe("840 ms");
    expect(formatMs(12048)).toBe("12,0 s");
  });
});

describe("displayProductName", () => {
  it("normaliza nome todo em caixa alta", () => {
    expect(displayProductName("POTE DE VIDRO HERMETICO QUADRADO 320ML C/ TRAVA")).toBe(
      "Pote de Vidro Hermetico Quadrado 320ML c/ Trava"
    );
  });

  it("não mexe em nome com caixa mista", () => {
    expect(displayProductName("Lanterna Led P70")).toBe("Lanterna Led P70");
  });

  it("não mexe em código curto", () => {
    expect(displayProductName("BM-A16")).toBe("BM-A16");
  });
});

describe("marginTone", () => {
  it("classifica pela meta", () => {
    expect(marginTone(0.3, 0.25)).toBe("good");
    expect(marginTone(0.1, 0.25)).toBe("warn");
    expect(marginTone(-0.2, 0.25)).toBe("bad");
  });
});
