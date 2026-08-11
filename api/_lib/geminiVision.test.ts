import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GeminiVisionError, compareProductImages, describeProductImage } from "./geminiVision";

/**
 * Mocka `fetch` global — o módulo usa o mesmo `fetch` tanto pra baixar as
 * imagens (`fetchImageAsBase64`) quanto pra chamar a API do Gemini
 * (`callGemini`), então cada teste enfileira as respostas na ORDEM em que
 * as chamadas acontecem (imagem(ns) primeiro, Gemini por último) — ver
 * comentário de cada teste com mais de uma chamada.
 */
function mockImageResponse(contentType = "image/jpeg"): Response {
  return {
    ok: true,
    status: 200,
    headers: { get: (h: string) => (h.toLowerCase() === "content-type" ? contentType : null) },
    arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer,
  } as unknown as Response;
}

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

describe("describeProductImage", () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("baixa a foto e devolve a descrição do Gemini já sem aspas nem pontuação sobrando", () => {
    fetchMock
      .mockResolvedValueOnce(mockImageResponse())
      .mockResolvedValueOnce(mockGeminiResponse('"fone de ouvido bluetooth preto over-ear."'));

    return describeProductImage("https://catalogo/foto.jpg", "fake-key").then((query) => {
      expect(query).toBe("fone de ouvido bluetooth preto over-ear");
    });
  });

  it("propaga GeminiVisionError quando o download da foto falha (não é problema do Gemini)", async () => {
    fetchMock.mockResolvedValueOnce({ ok: false, status: 404 } as Response);

    await expect(describeProductImage("https://catalogo/quebrada.jpg", "fake-key")).rejects.toThrow(
      GeminiVisionError
    );
  });

  it("traduz RESOURCE_EXHAUSTED numa mensagem acionável sobre cota, não um erro genérico de HTTP", async () => {
    fetchMock.mockResolvedValueOnce(mockImageResponse()).mockResolvedValueOnce(mockGeminiErrorResponse(429, "RESOURCE_EXHAUSTED"));

    await expect(describeProductImage("https://catalogo/foto.jpg", "fake-key")).rejects.toThrow(/cota/i);
  });
});

describe("compareProductImages", () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("baixa as duas fotos e devolve a nota de similaridade como número", async () => {
    fetchMock
      .mockResolvedValueOnce(mockImageResponse())
      .mockResolvedValueOnce(mockImageResponse())
      .mockResolvedValueOnce(mockGeminiResponse("0.85"));

    const score = await compareProductImages("https://catalogo/a.jpg", "https://loja/b.jpg", "fake-key");
    expect(score).toBe(0.85);
  });

  it("satura a nota em 0..1 mesmo se o Gemini devolver fora da faixa pedida no prompt", async () => {
    fetchMock
      .mockResolvedValueOnce(mockImageResponse())
      .mockResolvedValueOnce(mockImageResponse())
      .mockResolvedValueOnce(mockGeminiResponse("1.5"));

    const score = await compareProductImages("https://catalogo/a.jpg", "https://loja/b.jpg", "fake-key");
    expect(score).toBe(1);
  });

  it("recusa resposta não numérica em vez de silenciosamente virar NaN/0 (falha visível > match errado silencioso)", async () => {
    fetchMock
      .mockResolvedValueOnce(mockImageResponse())
      .mockResolvedValueOnce(mockImageResponse())
      .mockResolvedValueOnce(mockGeminiResponse("não sei dizer"));

    await expect(
      compareProductImages("https://catalogo/a.jpg", "https://loja/b.jpg", "fake-key")
    ).rejects.toThrow(GeminiVisionError);
  });
});
