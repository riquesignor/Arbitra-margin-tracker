import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  GroqQuotaExhaustedError,
  GroqVisionError,
  compareProductImages,
  compareProductImagesBatch,
  describeProductImage,
} from "./groqVision";

/**
 * Mocka `fetch` global — mesmo padrão de geminiVision.test.ts: o módulo
 * usa o mesmo `fetch` tanto pra baixar as imagens (`fetchImageAsDataUri`)
 * quanto pra chamar a API da Groq (`callGroq`), então cada teste
 * enfileira as respostas na ORDEM em que as chamadas acontecem
 * (imagem(ns) primeiro, Groq por último).
 */
function mockImageResponse(contentType = "image/jpeg"): Response {
  return {
    ok: true,
    status: 200,
    headers: { get: (h: string) => (h.toLowerCase() === "content-type" ? contentType : null) },
    arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer,
  } as unknown as Response;
}

function mockGroqResponse(text: string): Response {
  return {
    ok: true,
    status: 200,
    headers: { get: () => null },
    json: async () => ({ choices: [{ message: { content: text } }] }),
  } as unknown as Response;
}

function mockGroqQuotaResponse(retryAfterSeconds: number | null = null): Response {
  return {
    ok: false,
    status: 429,
    headers: { get: (h: string) => (h.toLowerCase() === "retry-after" ? retryAfterSeconds?.toString() ?? null : null) },
    json: async () => ({ error: { message: "rate limit" } }),
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

  it("baixa a foto e devolve a descrição da Groq já sem aspas nem pontuação sobrando", async () => {
    fetchMock
      .mockResolvedValueOnce(mockImageResponse())
      .mockResolvedValueOnce(mockGroqResponse('"fone de ouvido bluetooth preto over-ear."'));

    const query = await describeProductImage("https://catalogo/foto.jpg", "fake-key");
    expect(query).toBe("fone de ouvido bluetooth preto over-ear");
  });

  it("propaga GroqVisionError quando o download da foto falha (não é problema da Groq)", async () => {
    fetchMock.mockResolvedValueOnce({ ok: false, status: 404 } as Response);

    await expect(describeProductImage("https://catalogo/quebrada.jpg", "fake-key")).rejects.toThrow(
      GroqVisionError
    );
  });

  it("traduz HTTP 429 numa GroqQuotaExhaustedError com retry-after, e recupera na 2ª tentativa", async () => {
    vi.useFakeTimers();
    try {
      fetchMock
        .mockResolvedValueOnce(mockImageResponse())
        .mockResolvedValueOnce(mockGroqQuotaResponse(5)) // retry-after: 5s
        .mockResolvedValueOnce(mockGroqResponse("fone bluetooth preto"));

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
        .mockResolvedValueOnce(mockGroqQuotaResponse(null)) // sem header — usa MAX_RETRY_DELAY_MS
        .mockResolvedValueOnce(mockGroqQuotaResponse(null));

      const promise = describeProductImage("https://catalogo/foto.jpg", "fake-key");
      const assertion = expect(promise).rejects.toThrow(GroqQuotaExhaustedError);
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
      .mockResolvedValueOnce(mockGroqResponse("0.85"));

    const score = await compareProductImages("https://catalogo/a.jpg", "https://loja/b.jpg", "fake-key");
    expect(score).toBe(0.85);
  });

  it("satura a nota em 0..1 mesmo se a Groq devolver fora da faixa pedida no prompt", async () => {
    fetchMock
      .mockResolvedValueOnce(mockImageResponse())
      .mockResolvedValueOnce(mockImageResponse())
      .mockResolvedValueOnce(mockGroqResponse("1.5"));

    const score = await compareProductImages("https://catalogo/a.jpg", "https://loja/b.jpg", "fake-key");
    expect(score).toBe(1);
  });

  it("recusa resposta não numérica em vez de silenciosamente virar NaN/0", async () => {
    fetchMock
      .mockResolvedValueOnce(mockImageResponse())
      .mockResolvedValueOnce(mockImageResponse())
      .mockResolvedValueOnce(mockGroqResponse("não sei dizer"));

    await expect(
      compareProductImages("https://catalogo/a.jpg", "https://loja/b.jpg", "fake-key")
    ).rejects.toThrow(GroqVisionError);
  });
});

describe(
  "compareProductImagesBatch — fix do estouro real de TPM (Groq zerando resultado, ver comentário " +
    "grande no topo de groqVision.ts): manda a foto do catálogo UMA VEZ + N candidatos na MESMA " +
    "chamada, em vez de reenviar o catálogo a cada comparação",
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
      "baixa o catálogo UMA VEZ + N candidatos e faz UMA chamada só à Groq, devolvendo as notas na " +
        "MESMA ORDEM dos candidatos (regressão: antes eram N chamadas separadas, cada uma reenviando " +
        "o catálogo — o gasto redundante de token que estourava o TPM do tier gratuito)",
      async () => {
        fetchMock
          .mockResolvedValueOnce(mockImageResponse()) // catálogo
          .mockResolvedValueOnce(mockImageResponse()) // candidato 1
          .mockResolvedValueOnce(mockImageResponse()) // candidato 2
          .mockResolvedValueOnce(mockImageResponse()) // candidato 3
          .mockResolvedValueOnce(mockGroqResponse("0.9, 0.2, 0.05")); // 1 ÚNICA chamada à Groq

        const scores = await compareProductImagesBatch(
          "https://catalogo/a.jpg",
          ["https://loja/c1.jpg", "https://loja/c2.jpg", "https://loja/c3.jpg"],
          "fake-key"
        );

        expect(scores).toEqual([0.9, 0.2, 0.05]);
        // 4 downloads de imagem (catálogo + 3 candidatos) + 1 chamada à Groq = 5 fetches totais.
        expect(fetchMock).toHaveBeenCalledTimes(5);
      }
    );

    it(
      "chunka em grupos de até 4 candidatos (teto de imagens/requisição do modelo, catálogo + 4) — " +
        "defensivo, caso CANDIDATES_PER_STORE cresça no futuro além do que cabe numa chamada só. O " +
        "catálogo é baixado UMA VEZ só (antes do laço de chunks), não a cada chunk — menos uma " +
        "redundância além da que o batching em si já corta",
      async () => {
        const candidateUrls = Array.from({ length: 5 }, (_, i) => `https://loja/c${i + 1}.jpg`);

        fetchMock
          .mockResolvedValueOnce(mockImageResponse()) // catálogo (baixado 1x, reaproveitado nos dois chunks)
          // Chunk 1 (4 candidatos): 4 downloads + 1 chamada Groq.
          .mockResolvedValueOnce(mockImageResponse())
          .mockResolvedValueOnce(mockImageResponse())
          .mockResolvedValueOnce(mockImageResponse())
          .mockResolvedValueOnce(mockImageResponse())
          .mockResolvedValueOnce(mockGroqResponse("0.9, 0.8, 0.1, 0.0"))
          // Chunk 2 (1 candidato restante): 1 download + 1 chamada Groq.
          .mockResolvedValueOnce(mockImageResponse())
          .mockResolvedValueOnce(mockGroqResponse("0.5"));

        const scores = await compareProductImagesBatch("https://catalogo/a.jpg", candidateUrls, "fake-key");

        expect(scores).toEqual([0.9, 0.8, 0.1, 0.0, 0.5]);
        // 1 catálogo + 5 candidatos + 2 chamadas Groq (uma por chunk) = 8 fetches totais.
        expect(fetchMock).toHaveBeenCalledTimes(8);
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
          .mockResolvedValueOnce(mockGroqResponse("0.9")); // só 1 número pra 2 candidatos

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

    it("propaga GroqQuotaExhaustedError quando a chamada em lote esgota a cota", async () => {
      fetchMock
        .mockResolvedValueOnce(mockImageResponse())
        .mockResolvedValueOnce(mockImageResponse())
        .mockResolvedValueOnce(mockGroqQuotaResponse(1))
        .mockResolvedValueOnce(mockGroqQuotaResponse(1)); // retry também esgota

      vi.useFakeTimers();
      try {
        const promise = compareProductImagesBatch(
          "https://catalogo/a.jpg",
          ["https://loja/c1.jpg"],
          "fake-key"
        );
        const assertion = expect(promise).rejects.toThrow(GroqQuotaExhaustedError);
        await vi.advanceTimersByTimeAsync(1000);
        await assertion;
      } finally {
        vi.useRealTimers();
      }
    });
  }
);
