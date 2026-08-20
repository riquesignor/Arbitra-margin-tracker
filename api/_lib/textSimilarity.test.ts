import { describe, expect, it } from "vitest";
import { confidenceFromSimilarity, textSimilarity } from "./textSimilarity";

describe("textSimilarity", () => {
  it("retorna 1 pra textos idênticos", () => {
    expect(textSimilarity("Caneta Azul BIC", "Caneta Azul BIC")).toBe(1);
  });

  it("ignora a ordem das palavras (Jaccard sobre conjunto de tokens)", () => {
    expect(textSimilarity("Caneta Azul BIC", "BIC Azul Caneta")).toBe(1);
  });

  it("ignora acentuação e caixa", () => {
    expect(textSimilarity("Válvula de Pressão", "valvula de pressao")).toBe(1);
  });

  it("retorna 0 quando não há token em comum", () => {
    expect(textSimilarity("Caneta Azul", "Parafuso Sextavado")).toBe(0);
  });

  it("retorna 0 se algum dos textos normaliza pra vazio", () => {
    expect(textSimilarity("!!!", "Caneta Azul")).toBe(0);
    expect(textSimilarity("", "")).toBe(0);
  });

  it("retorna similaridade parcial proporcional à sobreposição de tokens", () => {
    // interseção {caneta,azul} = 2; união {caneta,azul,bic,pilot} = 4
    expect(textSimilarity("caneta azul bic", "caneta azul pilot")).toBeCloseTo(0.5, 4);
  });

  it("trata plural/singular como o mesmo token (stemming leve PT-BR) — regressão do 'achei 3 de 40'", () => {
    expect(textSimilarity("Balão Bexiga Látex", "Balões Bexigas Látex")).toBe(1);
    expect(textSimilarity("Caneta Azul", "Canetas Azuis")).toBeGreaterThan(
      textSimilarity("Caneta Azul", "Parafuso Sextavado")
    );
  });

  it("normaliza plural irregular comum (-ões→-ao, -ais→-al, -eis→-el)", () => {
    expect(textSimilarity("Botão de Pressão", "Botões de Pressão")).toBe(1);
    expect(textSimilarity("Kit Artesanal", "Kit Artesanais")).toBe(1);
    expect(textSimilarity("Anel de Prata", "Anéis de Prata")).toBe(1);
  });

  it("não mexe em número/código (stemming só se aplica a palavra, não a dígito)", () => {
    expect(textSimilarity("Produto 12345", "Produto 12345")).toBe(1);
  });
});

describe("confidenceFromSimilarity", () => {
  it("mapeia similaridade 0 pra confiança mínima (0.3)", () => {
    expect(confidenceFromSimilarity(0)).toBe(0.3);
  });

  it("mapeia similaridade 1 pra confiança máxima (0.9)", () => {
    expect(confidenceFromSimilarity(1)).toBe(0.9);
  });

  it("mapeia linearmente entre os extremos", () => {
    expect(confidenceFromSimilarity(0.5)).toBeCloseTo(0.6, 4);
  });

  it("nunca sai do intervalo [0.3, 0.9] mesmo com entrada fora de [0,1]", () => {
    expect(confidenceFromSimilarity(-1)).toBe(0.3);
    expect(confidenceFromSimilarity(2)).toBe(0.9);
  });
});
