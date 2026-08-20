import { describe, expect, it } from "vitest";
import { buildSearchQuery } from "./searchQuery";

describe("buildSearchQuery", () => {
  it("remove rótulo de referência/código + valor", () => {
    expect(buildSearchQuery("Maozinha latex azul ref 790862")).toBe("Maozinha latex azul");
    expect(buildSearchQuery("Caneta Azul BIC cód. 12345")).toBe("Caneta Azul BIC");
    expect(buildSearchQuery("Caixa Organizadora CÓDIGO:99881")).toBe("Caixa Organizadora");
  });

  it("remove dimensão de embalagem (NxNcm)", () => {
    expect(buildSearchQuery("Maozinha latex azul 9x10cm")).toBe("Maozinha latex azul");
    expect(buildSearchQuery("Caixa organizadora 10 x 15 x 20cm plástico")).toBe(
      "Caixa organizadora plástico"
    );
  });

  it("remove código numérico longo solto (5+ dígitos sem letra)", () => {
    expect(buildSearchQuery("Balão látex liso 100 unidades 790862")).toBe(
      "Balão látex liso 100 unidades"
    );
  });

  it("preserva código alfanumérico (tem letra, não é ruído de referência interna)", () => {
    expect(buildSearchQuery("Placa de vídeo RTX4090 24gb")).toBe("Placa de vídeo RTX4090 24gb");
  });

  it("combina os três tipos de ruído no mesmo nome", () => {
    expect(buildSearchQuery("Maozinha latex azul 9x10cm ref 790862")).toBe("Maozinha latex azul");
  });

  it("corta a cauda além do teto de palavras", () => {
    const longo = Array.from({ length: 20 }, (_, i) => `palavra${i}`).join(" ");
    const result = buildSearchQuery(longo);
    expect(result.split(" ")).toHaveLength(12);
  });

  it("nome já limpo (sem ruído) passa inalterado, exceto por espaço extra", () => {
    expect(buildSearchQuery("Fone de Ouvido Bluetooth JBL Tune 510BT Preto")).toBe(
      "Fone de Ouvido Bluetooth JBL Tune 510BT Preto"
    );
  });

  it("rede de segurança: se a limpeza deixar a query curta/genérica demais, volta o nome original", () => {
    // Só código + medida — depois de limpar não sobra nada útil pra buscar.
    expect(buildSearchQuery("REF 790862 9x10cm")).toBe("REF 790862 9x10cm");
  });

  it("lida com entrada vazia/nula sem lançar exceção", () => {
    expect(buildSearchQuery("")).toBe("");
    expect(buildSearchQuery("   ")).toBe("");
  });
});
