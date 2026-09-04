import { describe, expect, it } from "vitest";
import { detectPackQuantity, unitPriceFromPack } from "./packQuantity";

describe("detectPackQuantity — reconhece lote quando está escrito no título", () => {
  it("pega os formatos comuns de anúncio de atacado", () => {
    const cases: [string, number][] = [
      ["Fone de Ouvido Bluetooth Kit com 12 unidades", 12],
      ["Caneca de Porcelana Kit c/ 6", 6],
      ["Organizador de Gaveta - Conjunto com 4", 4],
      ["Escova de Dentes Atacado 50 peças", 50],
      ["Pilha AA Alcalina 24 unidades", 24],
      ["Copo Descartável Caixa com 100 un", 100],
      ["Suporte Veicular Combo 3", 3],
      ["Pano de Prato Pacote 10 pçs", 10],
      ["Meia Esportiva 5 pares", 5],
    ];

    for (const [title, expected] of cases) {
      expect(detectPackQuantity(title)?.quantity, title).toBe(expected);
    }
  });

  it("devolve o trecho que motivou a detecção (a UI precisa explicar o número)", () => {
    expect(detectPackQuantity("Caneca Kit com 6")?.matchedText).toMatch(/kit com 6/i);
  });

  it("NÃO confunde MEDIDA do produto com quantidade — o erro mais caro possível aqui", () => {
    for (const title of [
      "Caneca Térmica 300ml",
      "Cabo USB-C 2m Reforçado",
      "Lâmpada LED 2700k Branco Quente",
      "Fonte ATX 1200w 80 Plus",
      "SSD NVMe 512gb",
      "Power Bank 20000mah",
      "Mochila 25 L Impermeável",
    ]) {
      expect(detectPackQuantity(title), title).toBeNull();
    }
  });

  it('NÃO trata "kit" sem número como lote — kit de peças diferentes é UM produto, não N iguais', () => {
    expect(detectPackQuantity("Kit Organizador de Cozinha")).toBeNull();
    expect(detectPackQuantity("Kit Ferramentas Profissional")).toBeNull();
  });

  it("ignora quantidade implausível (código de modelo, potência, ano disfarçado de lote)", () => {
    expect(detectPackQuantity("Parafuso Caixa com 5000")).toBeNull();
    expect(detectPackQuantity("Item kit 1")).toBeNull(); // 1 não é lote
  });

  it("é no-op em título vazio/ausente", () => {
    expect(detectPackQuantity("")).toBeNull();
    expect(detectPackQuantity(undefined)).toBeNull();
    expect(detectPackQuantity(null)).toBeNull();
  });
});

describe("unitPriceFromPack", () => {
  it("divide o preço do lote pela quantidade — é o número comparável com o custo do catálogo", () => {
    expect(unitPriceFromPack(120, { quantity: 12, matchedText: "kit com 12" })).toBe(10);
    expect(unitPriceFromPack(89.9, { quantity: 6, matchedText: "kit c/ 6" })).toBe(14.98);
  });

  it("devolve null quando não há lote (preço cheio já é unitário)", () => {
    expect(unitPriceFromPack(120, null)).toBeNull();
  });

  it("devolve null pra preço inválido — não inventa número a partir de dado ruim", () => {
    expect(unitPriceFromPack(0, { quantity: 12, matchedText: "kit com 12" })).toBeNull();
    expect(unitPriceFromPack(Number.NaN, { quantity: 12, matchedText: "kit com 12" })).toBeNull();
  });
});
