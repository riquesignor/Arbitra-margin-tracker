import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  MistralQuotaExhaustedError,
  MistralVisionError,
  compareProductImages,
  compareProductImagesBatch,
  describeProductImage,
} from "./mistralVision";

/**
 * Mocka `fetch` global — mesmo padrão de geminiVision.test.ts/
 * groqVision.test.ts: o módulo usa o mesmo `fetch` tanto pra baixar as
 * imagens (`fetchImageAsDataUri`) quanto pra chamar a API da Mistral
 * (`callMistral`), então cada teste enfileira as respostas na ORDEM em
 * que as chamadas acontecem (imagem(ns) primeiro, Mistral por último).
 */
function mockImageResponse(contentType = "image/jpeg"): Response {
  return {
    ok: true,
    status: 200,
    headers: { get: (h: string) => (h.toLowerCase() === "content-type" ? contentType : null) },
    arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer,
  } as unknown as Response;
}

function mockMistralResponse(text: string): Response {
  return {
    ok: true,
    status: 200,
    headers: { get: () => null },
    json: async () => ({ choices: [{ message: { content: text } }] }),
  } as unknown as Response;
}

function mockMistralQuotaResponse(retryAfterSeconds: number | null = null): Response {
  return {
    ok: false,
    status: 429,
    headers: { get: (h: string) => (h.toLowerCase() === "retry-after" ? retryAfterSeconds?.toString() ?? null : null) },
    json: async () => ({ message: "rate limit" }),
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

  it("baixa a foto e devolve a descrição da Mistral já sem aspas nem pontuação sobrando", async () => {
    fetchMock
      .mockResolvedValueOnce(mockImageResponse())
      .mockResolvedValueOnce(mockMistralResponse('"fone de ouvido bluetooth preto over-ear."'));

    const query = await describeProductImage("https://catalogo/foto.jpg", "fake-key");
    expect(query).toBe("fone de ouvido bluetooth preto over-ear");
  });

  it("propaga MistralVisionError quando o download da foto falha (não é problema da Mistral)", async () => {
    fetchMock.mockResolvedValueOnce({ ok: false, status: 404 } as Response);

    await expect(describeProductImage("https://catalogo/quebrada.jpg", "fake-key")).rejects.toThrow(
      MistralVisionError
    );
  });

  it("traduz HTTP 429 numa MistralQuotaExhaustedError com retry-after, e recupera na 2ª tentativa", async () => {
    vi.useFakeTimers();
    try {
      fetchMock
        .mockResolvedValueOnce(mockImageResponse())
        .mockResolvedValueOnce(mockMistralQuotaResponse(5)) // retry-after: 5s
        .mockResolvedValueOnce(mockMistralResponse("fone bluetooth preto"));

      const promise = describeProductImage("https://catalogo/foto.jpg", "fake-key");
      const assertion = expect(promise).resolves.toBe("fone bluetooth preto");
      await vi.advanceTimersByTimeAsync(5000);
      await assertion;
    } finally {
      vi.useRealTimers();
    }
  });

  it("propaga erro de cota se a 2ª tentativa também esgotar", async () => {
    vi.useFakeTimers();
    try {
      fetchMock
        .mockResolvedValueOnce(mockImageResponse())
        .mockResolvedValueOnce(mockMistralQuotaResponse(null)) // sem header — usa MAX_RETRY_DELAY_MS
        .mockResolvedValueOnce(mockMistralQuotaResponse(null));

      const promise = describeProductImage("https://catalogo/foto.jpg", "fake-key");
      const assertion = expect(promise).rejects.toThrow(MistralQuotaExhaustedError);
      await vi.advanceTimersByTimeAsync(20000);
      await assertion;
    } finally {
      vi.useRealTimers();
    }
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
      .mockResolvedValueOnce(mockMistralResponse("0.85"));

    const score = await compareProductImages("https://catalogo/a.jpg", "https://loja/b.jpg", "fake-key");
    expect(score).toBe(0.85);
  });

  it("satura a nota em 0..1 mesmo se a Mistral devolver fora da faixa pedida no prompt", async () => {
    fetchMock
      .mockResolvedValueOnce(mockImageResponse())
      .mockResolvedValueOnce(mockImageResponse())
      .mockResolvedValueOnce(mockMistralResponse("1.5"));

    const score = await compareProductImages("https://catalogo/a.jpg", "https://loja/b.jpg", "fake-key");
    expect(score).toBe(1);
  });

  it("recusa resposta não numérica em vez de silenciosamente virar NaN/0 (falha visível > match errado silencioso)", async () => {
    fetchMock
      .mockResolvedValueOnce(mockImageResponse())
      .mockResolvedValueOnce(mockImageResponse())
      .mockResolvedValueOnce(mockMistralResponse("não sei dizer"));

    await expect(
      compareProductImages("https://catalogo/a.jpg", "https://loja/b.jpg", "fake-key")
    ).rejects.toThrow(MistralVisionError);
  });
});

describe(
  "compareProductImagesBatch — manda a foto do catálogo UMA VEZ + N candidatos na MESMA chamada, em vez " +
    "de reenviar o catálogo a cada comparação (mesma técnica implementada primeiro pro Groq, ver comentário " +
    "grande no topo de mistralVision.ts)",
  () => {
    let fetchMock: ReturnType<typeof vi.fn>;

    beforeEach(() => {
      fetchMock = vi.fn();
      vi.stubGlobal("fetch", fetchMock);
    });

    afterEach(() => {
      vi.unstubAllGlobals();
    });

    it("devolve [] sem chamar a rede quando a lista de candidatos vem vazia", async () => {
      const scores = await compareProductImagesBatch("https://catalogo/a.jpg", [], "fake-key");
      expect(scores).toEqual([]);
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it(
      "baixa o catálogo UMA VEZ + N candidatos e faz UMA chamada só à Mistral, devolvendo as notas na " +
        "MESMA ORDEM dos candidatos",
      async () => {
        fetchMock
          .mockResolvedValueOnce(mockImageResponse()) // catálogo
          .mockResolvedValueOnce(mockImageResponse()) // candidato 1
          .mockResolvedValueOnce(mockImageResponse()) // candidato 2
          .mockResolvedValueOnce(mockImageResponse()) // candidato 3
          .mockResolvedValueOnce(mockMistralResponse("0.9, 0.2, 0.05")); // 1 ÚNICA chamada à Mistral

        const scores = await compareProductImagesBatch(
          "https://catalogo/a.jpg",
          ["https://loja/c1.jpg", "https://loja/c2.jpg", "https://loja/c3.jpg"],
          "fake-key"
        );

        expect(scores).toEqual([0.9, 0.2, 0.05]);
        // 4 downloads de imagem (catálogo + 3 candidatos) + 1 chamada à Mistral = 5 fetches totais.
        expect(fetchMock).toHaveBeenCalledTimes(5);
      }
    );

    it(
      "chunka em grupos de até 7 candidatos (teto de imagens/requisição da Mistral, 8, menos 1 pra foto do " +
        "catálogo) — defensivo, caso CANDIDATES_PER_STORE cresça no futuro além do que cabe numa chamada só. " +
        "O catálogo é baixado UMA VEZ só (antes do laço de chunks), não a cada chunk",
      async () => {
        const candidateUrls = Array.from({ length: 8 }, (_, i) => `https://loja/c${i + 1}.jpg`);
        const chunk1Scores = "0.9, 0.8, 0.1, 0.0, 0.5, 0.6, 0.7";

        fetchMock
          .mockResolvedValueOnce(mockImageResponse()) // catálogo (baixado 1x, reaproveitado nos dois chunks)
          // Chunk 1 (7 candidatos): 7 downloads + 1 chamada Mistral.
          .mockResolvedValueOnce(mockImageResponse())
          .mockResolvedValueOnce(mockImageResponse())
          .mockResolvedValueOnce(mockImageResponse())
          .mockResolvedValueOnce(mockImageResponse())
          .mockResolvedValueOnce(mockImageResponse())
          .mockResolvedValueOnce(mockImageResponse())
          .mockResolvedValueOnce(mockImageResponse())
          .mockResolvedValueOnce(mockMistralResponse(chunk1Scores))
          // Chunk 2 (1 candidato restante): 1 download + 1 chamada Mistral.
          .mockResolvedValueOnce(mockImageResponse())
          .mockResolvedValueOnce(mockMistralResponse("0.3"));

        const scores = await compareProductImagesBatch("https://catalogo/a.jpg", candidateUrls, "fake-key");

        expect(scores).toEqual([0.9, 0.8, 0.1, 0.0, 0.5, 0.6, 0.7, 0.3]);
        // 1 catálogo + 8 candidatos + 2 chamadas Mistral (uma por chunk) = 11 fetches totais.
        expect(fetchMock).toHaveBeenCalledTimes(11);
      }
    );

    it(
      "descarta o CHUNK inteiro (nota null em cada posição) quando a contagem de números devolvida " +
        "não bate com a quantidade de candidatos — mais seguro que arriscar atribuir nota errada",
      async () => {
        const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
        fetchMock
          .mockResolvedValueOnce(mockImageResponse())
          .mockResolvedValueOnce(mockImageResponse())
          .mockResolvedValueOnce(mockImageResponse())
          .mockResolvedValueOnce(mockMistralResponse("0.9")); // só 1 número pra 2 candidatos

        const scores = await compareProductImagesBatch(
          "https://catalogo/a.jpg",
          ["https://loja/c1.jpg", "https://loja/c2.jpg"],
          "fake-key"
        );

        expect(scores).toEqual([null, null]);
        expect(warnSpy).toHaveBeenCalledWith(expect.stringMatching(/1 nota\(s\) pra 2 candidato/i));
        warnSpy.mockRestore();
      }
    );

    it("propaga MistralQuotaExhaustedError quando a chamada em lote esgota a cota", async () => {
      fetchMock
        .mockResolvedValueOnce(mockImageResponse())
        .mockResolvedValueOnce(mockImageResponse())
        .mockResolvedValueOnce(mockMistralQuotaResponse(1))
        .mockResolvedValueOnce(mockMistralQuotaResponse(1)); // retry também esgota

      vi.useFakeTimers();
      try {
        const promise = compareProductImagesBatch(
          "https://catalogo/a.jpg",
          ["https://loja/c1.jpg"],
          "fake-key"
        );
        const assertion = expect(promise).rejects.toThrow(MistralQuotaExhaustedError);
        await vi.advanceTimersByTimeAsync(1000);
        await assertion;
      } finally {
        vi.useRealTimers();
      }
    });
  }
);
