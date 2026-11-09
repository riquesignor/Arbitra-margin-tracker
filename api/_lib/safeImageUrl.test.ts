import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  appHostsFromRequest,
  assertFetchableImageUrl,
  fetchImageWithLimit,
  isCatalogImageFromThisApp,
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


describe("assertFetchableImageUrl — formas de esconder um host interno", () => {
  const blocked = [
    // IPv4 em outras notações (o `URL` normaliza tudo pra forma pontuada)
    "https://2130706433/foto.jpg", // 127.0.0.1 em decimal
    "https://0x7f.1/foto.jpg",
    "https://017700000001/foto.jpg", // octal
    "https://127.1/foto.jpg",
    // faixas que a lista antiga não cobria
    "https://100.64.0.1/foto.jpg", // CGNAT
    "https://100.127.255.254/foto.jpg",
    "https://198.18.0.1/foto.jpg", // benchmarking
    "https://192.0.0.8/foto.jpg",
    "https://192.0.2.10/foto.jpg", // TEST-NET-1
    "https://224.0.0.1/foto.jpg", // multicast
    "https://255.255.255.255/foto.jpg",
    "https://0.0.0.0/foto.jpg",
    // IPv6
    "https://[::1]/foto.jpg",
    "https://[0:0:0:0:0:0:0:1]/foto.jpg",
    "https://[::]/foto.jpg",
    "https://[::ffff:127.0.0.1]/foto.jpg", // IPv4 embutido
    "https://[::ffff:169.254.169.254]/foto.jpg",
    "https://[64:ff9b::7f00:1]/foto.jpg", // NAT64
    "https://[fe80::1]/foto.jpg",
    "https://[fec0::1]/foto.jpg",
    "https://[fc00::1]/foto.jpg",
    "https://[ff02::1]/foto.jpg",
    // nomes que apontam pra dentro
    "https://localhost./foto.jpg", // ponto final = mesmo host
    "https://a.localhost/foto.jpg",
    "https://impressora.lan/foto.jpg",
    "https://wiki.intranet/foto.jpg",
    "https://roteador.home.arpa/foto.jpg",
  ];

  it.each(blocked)("recusa %s", (url) => {
    expect(() => assertFetchableImageUrl(url)).toThrow(UnsafeImageUrlError);
  });

  it("não recusa IP público nem faixa vizinha das privadas (sem falso positivo)", () => {
    for (const url of [
      "https://8.8.8.8/foto.jpg",
      "https://172.15.0.1/foto.jpg", // logo antes de 172.16/12
      "https://172.32.0.1/foto.jpg", // logo depois
      "https://100.63.255.255/foto.jpg", // logo antes do CGNAT
      "https://100.128.0.1/foto.jpg", // logo depois
      "https://198.20.0.1/foto.jpg",
      "https://192.169.0.1/foto.jpg",
      "https://223.255.255.254/foto.jpg",
    ]) {
      expect(() => assertFetchableImageUrl(url)).not.toThrow();
    }
  });
});

describe("fetchImageWithLimit — redirecionamento é validado A CADA SALTO, antes de requisitar", () => {
  function redirect(status: number, location: string | null): Response {
    return {
      ok: false,
      status,
      url: "",
      headers: { get: (h: string) => (h.toLowerCase() === "location" ? location : null) },
      body: null,
    } as unknown as Response;
  }
  function image(): Response {
    return {
      ok: true,
      status: 200,
      url: "",
      headers: { get: (h: string) => (h.toLowerCase() === "content-type" ? "image/jpeg" : null) },
      arrayBuffer: async () => new Uint8Array([1, 2, 3, 4]).buffer,
      body: null,
    } as unknown as Response;
  }

  it("pede ao fetch pra NÃO seguir sozinho (redirect: manual)", async () => {
    const fetchMock = vi.fn().mockResolvedValue(image());
    vi.stubGlobal("fetch", fetchMock);

    await fetchImageWithLimit("https://http2.mlstatic.com/foto.jpg", new AbortController().signal);

    expect(fetchMock.mock.calls[0][1]).toMatchObject({ redirect: "manual" });
  });

  it("redirecionamento pra metadata da nuvem é recusado SEM nunca requisitar o destino", async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(redirect(302, "http://169.254.169.254/latest/meta-data/"));
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      fetchImageWithLimit("https://encurtador.exemplo/abc", new AbortController().signal)
    ).rejects.toThrow(UnsafeImageUrlError);
    // Só a 1ª requisição (ao host público) saiu; o destino interno nunca foi tocado.
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("segue um redirecionamento legítimo (inclusive Location relativo) até a imagem", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(redirect(301, "https://cdn.exemplo.com/foto.jpg"))
      .mockResolvedValueOnce(redirect(302, "/final.jpg"))
      .mockResolvedValueOnce(image());
    vi.stubGlobal("fetch", fetchMock);

    const { buffer } = await fetchImageWithLimit("https://exemplo.com/foto", new AbortController().signal);

    expect(buffer.byteLength).toBe(4);
    expect(String(fetchMock.mock.calls[1][0])).toBe("https://cdn.exemplo.com/foto.jpg");
    expect(String(fetchMock.mock.calls[2][0])).toBe("https://cdn.exemplo.com/final.jpg");
  });

  it("redirecionamento de https pra http puro é recusado num deploy", async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(redirect(302, "http://exemplo.com/foto.jpg"));
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      fetchImageWithLimit("https://exemplo.com/foto", new AbortController().signal)
    ).rejects.toThrow(UnsafeImageUrlError);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("laço de redirecionamentos para depois do limite, sem baixar nada", async () => {
    const fetchMock = vi.fn().mockResolvedValue(redirect(302, "https://exemplo.com/de-novo"));
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      fetchImageWithLimit("https://exemplo.com/inicio", new AbortController().signal)
    ).rejects.toThrow(UnsafeImageUrlError);
    expect(fetchMock.mock.calls.length).toBeLessThanOrEqual(4);
  });

  it("redirecionamento sem Location é erro genérico", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce(redirect(302, null)));

    await expect(
      fetchImageWithLimit("https://exemplo.com/foto", new AbortController().signal)
    ).rejects.toThrow(/^Não consegui baixar a imagem\.$/);
  });
});

describe("isCatalogImageFromThisApp — a foto do catálogo tem que estar hospedada no PRÓPRIO app", () => {
  const hosts = appHostsFromRequest({ host: "app-arbitra.vercel.app" }, {});

  it("aceita a URL que o app gera, no host da própria requisição", () => {
    expect(isCatalogImageFromThisApp("https://app-arbitra.vercel.app/api/catalog-image?id=abc", hosts)).toBe(true);
    expect(isCatalogImageFromThisApp("https://APP-ARBITRA.vercel.app/api/catalog-image?id=abc", hosts)).toBe(true);
  });

  it("recusa a rota certa em OUTRO host público — era o SSRF que o teste só do caminho deixava passar", () => {
    expect(isCatalogImageFromThisApp("https://evil.example.com/api/catalog-image?id=abc", hosts)).toBe(false);
    expect(isCatalogImageFromThisApp("https://app-arbitra.vercel.app.evil.com/api/catalog-image?id=abc", hosts)).toBe(false);
    // usuário/senha na URL é truque pra um host parecer outro — recusado de cara
    expect(isCatalogImageFromThisApp("https://evil.com@app-arbitra.vercel.app/api/catalog-image", hosts)).toBe(false);
  });

  it("a porta faz parte do host", () => {
    expect(isCatalogImageFromThisApp("https://app-arbitra.vercel.app:8443/api/catalog-image?id=a", hosts)).toBe(false);
  });

  it("sem nenhum host conhecido, recusa (não dá pra decidir)", () => {
    expect(isCatalogImageFromThisApp("https://app-arbitra.vercel.app/api/catalog-image?id=a", new Set())).toBe(false);
  });

  it("continua exigindo a rota e as demais guardas", () => {
    expect(isCatalogImageFromThisApp("https://app-arbitra.vercel.app/outra-rota", hosts)).toBe(false);
    expect(isCatalogImageFromThisApp(undefined, hosts)).toBe(false);
    expect(isCatalogImageFromThisApp(42, hosts)).toBe(false);
  });
});

describe("appHostsFromRequest", () => {
  it("junta o Host da requisição, o repassado pelo proxy e os domínios declarados em variáveis de ambiente", () => {
    const hosts = appHostsFromRequest(
      { host: "App.Exemplo.com.br", "x-forwarded-host": "outro.exemplo.com, intermediario.com" },
      {
        VERCEL_URL: "projeto-abc123.vercel.app",
        VERCEL_PROJECT_PRODUCTION_URL: "app-arbitra.vercel.app",
        APP_BASE_URL: "https://arbitra.exemplo.com.br/",
      }
    );

    expect([...hosts].sort()).toEqual(
      [
        "app.exemplo.com.br",
        "outro.exemplo.com",
        "projeto-abc123.vercel.app",
        "app-arbitra.vercel.app",
        "arbitra.exemplo.com.br",
      ].sort()
    );
  });

  it("aceita cabeçalho como array e APP_BASE_URL malformada sem lançar", () => {
    const hosts = appHostsFromRequest({ host: ["a.com", "b.com"] }, { APP_BASE_URL: "isso não é url" });
    expect([...hosts]).toEqual(["a.com"]);
  });

  it("sem cabeçalhos nem variáveis, devolve vazio", () => {
    expect(appHostsFromRequest(undefined, {}).size).toBe(0);
  });
});
