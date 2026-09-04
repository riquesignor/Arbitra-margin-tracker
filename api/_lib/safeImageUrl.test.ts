import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  assertFetchableImageUrl,
  fetchImageWithLimit,
  isSafeCatalogImageUrl,
  MAX_IMAGE_BYTES,
  UnsafeImageUrlError,
} from "./safeImageUrl";

/**
 * `VERCEL_ENV` presente = "estamos num deploy" (ver isLocalDevelopment em
 * safeImageUrl.ts): é o modo estrito, que é o que importa testar. Sem essa
 * variável o módulo afrouxa de propósito pra `vercel dev` em localhost
 * funcionar — comportamento coberto pelo último bloco.
 */
const ORIGINAL_VERCEL_ENV = process.env.VERCEL_ENV;

beforeEach(() => {
  process.env.VERCEL_ENV = "production";
});

afterEach(() => {
  if (ORIGINAL_VERCEL_ENV === undefined) delete process.env.VERCEL_ENV;
  else process.env.VERCEL_ENV = ORIGINAL_VERCEL_ENV;
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("isSafeCatalogImageUrl — foto do catálogo (URL vinda do CLIENTE)", () => {
  it("aceita a URL que o próprio app gera (uploadCatalogImage)", () => {
    expect(isSafeCatalogImageUrl("https://arbitra.vercel.app/api/catalog-image?uid=abc&id=xyz")).toBe(true);
    expect(isSafeCatalogImageUrl("https://dominio-proprio.com.br/api/catalog-image?uid=abc&id=xyz")).toBe(true);
  });

  it("recusa metadata da nuvem — o alvo clássico de SSRF (169.254.169.254)", () => {
    expect(isSafeCatalogImageUrl("http://169.254.169.254/latest/meta-data/")).toBe(false);
    // Mesmo imitando a rota certa e usando https, o host continua barrado.
    expect(isSafeCatalogImageUrl("https://169.254.169.254/api/catalog-image")).toBe(false);
  });

  it("recusa rede interna e loopback em qualquer forma", () => {
    for (const url of [
      "https://localhost/api/catalog-image",
      "https://127.0.0.1/api/catalog-image",
      "https://10.0.0.5/api/catalog-image",
      "https://192.168.1.10/api/catalog-image",
      "https://172.16.0.9/api/catalog-image",
      "https://redis.internal/api/catalog-image",
      "https://metadata.google.internal/api/catalog-image",
    ]) {
      expect(isSafeCatalogImageUrl(url)).toBe(false);
    }
  });

  it("recusa host externo qualquer, mesmo público e em https — a foto tem que vir da NOSSA rota", () => {
    expect(isSafeCatalogImageUrl("https://exemplo.com/foto.jpg")).toBe(false);
    expect(isSafeCatalogImageUrl("https://exemplo.com/api/catalog-image/../admin")).toBe(false);
  });

  it("recusa esquema não-http (file:, data:, gopher:) e entrada que nem é URL", () => {
    expect(isSafeCatalogImageUrl("file:///etc/passwd")).toBe(false);
    expect(isSafeCatalogImageUrl("data:image/png;base64,AAAA")).toBe(false);
    expect(isSafeCatalogImageUrl("gopher://interno:70/_")).toBe(false);
    expect(isSafeCatalogImageUrl("não é url")).toBe(false);
    expect(isSafeCatalogImageUrl("")).toBe(false);
    expect(isSafeCatalogImageUrl(undefined)).toBe(false);
    expect(isSafeCatalogImageUrl(42)).toBe(false);
  });
});

describe("assertFetchableImageUrl — thumbnail de anúncio (URL vinda do PROVIDER)", () => {
  it("aceita host externo público em https (é de onde vem a foto do anúncio)", () => {
    expect(() => assertFetchableImageUrl("https://http2.mlstatic.com/D_NQ_NP_123.jpg")).not.toThrow();
    expect(() => assertFetchableImageUrl("https://m.media-amazon.com/images/I/abc.jpg")).not.toThrow();
  });

  it("continua recusando rede interna e http puro num deploy", () => {
    expect(() => assertFetchableImageUrl("https://10.1.2.3/foto.jpg")).toThrow(UnsafeImageUrlError);
    expect(() => assertFetchableImageUrl("http://exemplo.com/foto.jpg")).toThrow(UnsafeImageUrlError);
  });
});

describe("fetchImageWithLimit", () => {
  function mockResponse(overrides: Partial<Record<string, unknown>> = {}): Response {
    return {
      ok: true,
      status: 200,
      url: "",
      headers: { get: (h: string) => (h.toLowerCase() === "content-type" ? "image/jpeg" : null) },
      arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer,
      body: null,
      ...overrides,
    } as unknown as Response;
  }

  it("baixa normalmente e devolve buffer + mimeType", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(mockResponse()));

    const { buffer, mimeType } = await fetchImageWithLimit(
      "https://http2.mlstatic.com/foto.jpg",
      new AbortController().signal
    );

    expect(mimeType).toBe("image/jpeg");
    expect(buffer.byteLength).toBe(3);
  });

  it("nem chega a chamar fetch quando a URL já é insegura", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      fetchImageWithLimit("http://169.254.169.254/latest/meta-data/", new AbortController().signal)
    ).rejects.toThrow(UnsafeImageUrlError);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("recusa redirecionamento que termina em rede interna (checagem pós-redirect)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(mockResponse({ url: "http://192.168.0.2/interno.jpg" }))
    );

    await expect(
      fetchImageWithLimit("https://encurtador.exemplo/abc", new AbortController().signal)
    ).rejects.toThrow(UnsafeImageUrlError);
  });

  it("recusa imagem acima do teto pelo content-length, sem baixar o corpo", async () => {
    const arrayBuffer = vi.fn();
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        mockResponse({
          headers: {
            get: (h: string) =>
              h.toLowerCase() === "content-length" ? String(MAX_IMAGE_BYTES + 1) : "image/jpeg",
          },
          arrayBuffer,
        })
      )
    );

    await expect(
      fetchImageWithLimit("https://exemplo.com/gigante.jpg", new AbortController().signal)
    ).rejects.toThrow(UnsafeImageUrlError);
    expect(arrayBuffer).not.toHaveBeenCalled();
  });

  it("corta o stream quando o corpo passa do teto mesmo sem content-length (host mentindo)", async () => {
    const chunk = new Uint8Array(1024 * 1024); // 1MB por leitura
    const cancel = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        mockResponse({
          body: {
            getReader: () => ({
              // Nunca termina — é exatamente o caso que o teto protege.
              read: async () => ({ done: false, value: chunk }),
              cancel,
            }),
          },
        })
      )
    );

    await expect(
      fetchImageWithLimit("https://exemplo.com/infinita.jpg", new AbortController().signal)
    ).rejects.toThrow(UnsafeImageUrlError);
    expect(cancel).toHaveBeenCalled();
  });

  it("erro de download NÃO ecoa a URL nem o status recebido (senão vira oráculo de varredura)", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(mockResponse({ ok: false, status: 403 })));

    await expect(
      fetchImageWithLimit("https://exemplo.com/proibida.jpg", new AbortController().signal)
    ).rejects.toThrow(/^Não consegui baixar a imagem\.$/);
  });
});

/**
 * Vetor de bloqueio que ficava invisível (set/2026): a loja recusava a
 * FOTO (não a página), o candidato ficava sem comparação visual e o
 * sintoma chegava ao usuário como "a IA não confirmou nada".
 */
describe("fetchImageWithLimit — 2ª tentativa via ScraperAPI quando a loja bloqueia", () => {
  function okResponse(): Response {
    return {
      ok: true,
      status: 200,
      url: "",
      headers: { get: (h: string) => (h.toLowerCase() === "content-type" ? "image/jpeg" : null) },
      arrayBuffer: async () => new Uint8Array([9, 9]).buffer,
      body: null,
    } as unknown as Response;
  }

  function blockedResponse(status: number): Response {
    return {
      ok: false,
      status,
      url: "",
      headers: { get: () => null },
      body: null,
    } as unknown as Response;
  }

  it("repete pela ScraperAPI em 403 e devolve a imagem que o proxy trouxe", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(blockedResponse(403))
      .mockResolvedValueOnce(okResponse());
    vi.stubGlobal("fetch", fetchMock);

    const { buffer } = await fetchImageWithLimit(
      "https://m.media-amazon.com/images/I/abc.jpg",
      new AbortController().signal,
      "chave-de-teste"
    );

    expect(buffer.byteLength).toBe(2);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const segundaUrl = String(fetchMock.mock.calls[1][0]);
    expect(segundaUrl).toContain("api.scraperapi.com");
    // A URL original viaja como parâmetro, não é descartada.
    expect(decodeURIComponent(segundaUrl)).toContain("m.media-amazon.com/images/I/abc.jpg");
  });

  it("não gasta crédito quando a imagem simplesmente não existe (404 não é bloqueio)", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const fetchMock = vi.fn().mockResolvedValue(blockedResponse(404));
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      fetchImageWithLimit("https://http2.mlstatic.com/sumiu.jpg", new AbortController().signal, "chave-de-teste")
    ).rejects.toThrow(UnsafeImageUrlError);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("não tenta proxy pra foto do próprio app (/api/catalog-image)", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const fetchMock = vi.fn().mockResolvedValue(blockedResponse(403));
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      fetchImageWithLimit(
        "https://arbitra.vercel.app/api/catalog-image?id=x",
        new AbortController().signal,
        "chave-de-teste"
      )
    ).rejects.toThrow(UnsafeImageUrlError);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("sem chave ScraperAPI, falha igual ao comportamento antigo (sem 2ª tentativa)", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const fetchMock = vi.fn().mockResolvedValue(blockedResponse(429));
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      fetchImageWithLimit("https://http2.mlstatic.com/foto.jpg", new AbortController().signal)
    ).rejects.toThrow(/^Não consegui baixar a imagem\.$/);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("proxy também bloqueado: propaga erro genérico, sem 3ª tentativa", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const fetchMock = vi.fn().mockResolvedValue(blockedResponse(403));
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      fetchImageWithLimit(
        "https://m.media-amazon.com/images/I/abc.jpg",
        new AbortController().signal,
        "chave-de-teste"
      )
    ).rejects.toThrow(/^Não consegui baixar a imagem\.$/);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});

describe("modo desenvolvimento local (sem VERCEL_ENV)", () => {
  it("libera http://localhost — `vercel dev` precisa disso, deploy nunca cai aqui", () => {
    delete process.env.VERCEL_ENV;

    expect(isSafeCatalogImageUrl("http://localhost:3000/api/catalog-image?uid=a&id=b")).toBe(true);
    // A rota continua obrigatória mesmo em dev.
    expect(isSafeCatalogImageUrl("http://localhost:3000/qualquer-outra")).toBe(false);
  });
});
