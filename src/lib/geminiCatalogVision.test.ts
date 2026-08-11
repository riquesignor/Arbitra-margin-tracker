import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  GeminiCatalogVisionError,
  extractCatalogPageWithGemini,
  normalizeSkuForMatch,
  parseCatalogPageResponse,
} from "./geminiCatalogVision";

const FAKE_PAGE_DATA_URL = "data:image/jpeg;base64,QQ=="; // "A" em base64 — conteúdo não importa, só o formato

function mockGeminiResponse(text: string, opts: { ok?: boolean; status?: number } = {}): Response {
  return {
    ok: opts.ok ?? true,
    status: opts.status ?? 200,
    json: async () => ({ candidates: [{ content: { parts: [{ text }] } }] }),
  } as unknown as Response;
}

function mockGeminiErrorResponse(status: number, errorStatus: string): Response {
  return {
    ok: false,
    status,
    json: async () => ({ error: { status: errorStatus, message: "boom" } }),
  } as unknown as Response;
}

describe("parseCatalogPageResponse", () => {
  it("parseia um array JSON limpo de produtos", () => {
    const products = parseCatalogPageResponse(
      '[{"sku":"BM-F1324","inStock":true,"price":17.00},{"sku":"BM-F1323","inStock":false,"price":null}]'
    );

    expect(products).toEqual([
      { sku: "BM-F1324", inStock: true, price: 17 },
      { sku: "BM-F1323", inStock: false, price: null },
    ]);
  });

  it("tolera cerca de código (```json ... ```) que o modelo às vezes devolve mesmo pedindo pra não", () => {
    const products = parseCatalogPageResponse('```json\n[{"sku":"A1","inStock":true,"price":10}]\n```');

    expect(products).toEqual([{ sku: "A1", inStock: true, price: 10 }]);
  });

  it("pula entradas malformadas isoladas em vez de derrubar a página inteira", () => {
    const products = parseCatalogPageResponse(
      '[{"sku":"A1","inStock":true,"price":10}, {"semSku": true}, null, {"sku":"","inStock":true,"price":5}]'
    );

    expect(products).toEqual([{ sku: "A1", inStock: true, price: 10 }]);
  });

  it("trata preço inválido (negativo, zero, não-número) como null em vez de propagar lixo", () => {
    const products = parseCatalogPageResponse(
      '[{"sku":"A1","inStock":true,"price":-5},{"sku":"A2","inStock":true,"price":"12,00"}]'
    );

    expect(products).toEqual([
      { sku: "A1", inStock: true, price: null },
      { sku: "A2", inStock: true, price: null },
    ]);
  });

  it("lança GeminiCatalogVisionError quando a resposta não é JSON válido", () => {
    expect(() => parseCatalogPageResponse("não é json nenhum")).toThrow(GeminiCatalogVisionError);
  });

  it("lança GeminiCatalogVisionError quando a resposta é um objeto, não um array", () => {
    expect(() => parseCatalogPageResponse('{"sku":"A1"}')).toThrow(GeminiCatalogVisionError);
  });
});

describe("normalizeSkuForMatch", () => {
  it("ignora caixa e espaço na comparação (OCR e Gemini podem variar formatação)", () => {
    expect(normalizeSkuForMatch("bm-f1324")).toBe(normalizeSkuForMatch("BM-F1324"));
    expect(normalizeSkuForMatch(" BM F1324 ")).toBe(normalizeSkuForMatch("BMF1324"));
  });
});

describe("extractCatalogPageWithGemini", () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("manda a página inteira numa ÚNICA chamada e devolve os produtos parseados", async () => {
    fetchMock.mockResolvedValueOnce(
      mockGeminiResponse('[{"sku":"BM-F1324","inStock":true,"price":17.00}]')
    );

    const products = await extractCatalogPageWithGemini(FAKE_PAGE_DATA_URL, "fake-key");

    expect(fetchMock).toHaveBeenCalledTimes(1); // uma chamada por página, não por produto
    expect(products).toEqual([{ sku: "BM-F1324", inStock: true, price: 17 }]);
  });

  it("rejeita data URL fora do formato esperado sem chamar a rede", async () => {
    await expect(extractCatalogPageWithGemini("not-a-data-url", "fake-key")).rejects.toThrow(
      GeminiCatalogVisionError
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("traduz RESOURCE_EXHAUSTED numa mensagem acionável sobre cota", async () => {
    fetchMock.mockResolvedValueOnce(mockGeminiErrorResponse(429, "RESOURCE_EXHAUSTED"));

    await expect(extractCatalogPageWithGemini(FAKE_PAGE_DATA_URL, "fake-key")).rejects.toThrow(/cota/i);
  });
});
