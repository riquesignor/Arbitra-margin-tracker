import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fetchAmazonPaApiCandidatesForQuery } from "./amazonPaApi.js";

const ORIGINAL_ENV = {
  AMAZON_PAAPI_ACCESS_KEY: process.env.AMAZON_PAAPI_ACCESS_KEY,
  AMAZON_PAAPI_SECRET_KEY: process.env.AMAZON_PAAPI_SECRET_KEY,
  AMAZON_PAAPI_PARTNER_TAG: process.env.AMAZON_PAAPI_PARTNER_TAG,
};

function setCredentials() {
  process.env.AMAZON_PAAPI_ACCESS_KEY = "AKIAFAKEEXAMPLE";
  process.env.AMAZON_PAAPI_SECRET_KEY = "segredoFalsoDeTeste1234567890";
  process.env.AMAZON_PAAPI_PARTNER_TAG = "arbitra-20";
}

function restoreEnv() {
  for (const [key, value] of Object.entries(ORIGINAL_ENV)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

const fetchMock = vi.fn();

beforeEach(() => {
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.stubGlobal("fetch", fetchMock);
  fetchMock.mockReset();
  restoreEnv();
});

afterEach(() => {
  restoreEnv();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("fetchAmazonPaApiCandidatesForQuery", () => {
  it("sem as 3 credenciais configuradas: devolve [] sem nem tentar chamar a API", async () => {
    // Nenhuma env var setada (restoreEnv já deixou como estava antes, e o
    // ambiente de teste não tem AMAZON_PAAPI_* configurado).
    const result = await fetchAmazonPaApiCandidatesForQuery("furadeira de impacto");
    expect(result).toEqual([]);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("com credenciais: assina a requisição no formato AWS SigV4 esperado e manda os headers certos", async () => {
    setCredentials();
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({ SearchResult: { Items: [] } }),
    });

    await fetchAmazonPaApiCandidatesForQuery("furadeira de impacto");

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://webservices.amazon.com.br/paapi5/searchitems");
    expect(init.method).toBe("POST");

    const headers = init.headers as Record<string, string>;
    expect(headers["x-amz-target"]).toBe("com.amazon.paapi5.v1.ProductAdvertisingAPIv1.SearchItems");
    expect(headers["content-type"]).toBe("application/json; charset=utf-8");
    // Formato ISO8601 "básico" exigido pelo SigV4 — sem "-"/":" e sem ms.
    expect(headers["x-amz-date"]).toMatch(/^\d{8}T\d{6}Z$/);
    // Authorization: "AWS4-HMAC-SHA256 Credential=<access>/<escopo>, SignedHeaders=..., Signature=<64 hex>"
    expect(headers.authorization).toMatch(
      /^AWS4-HMAC-SHA256 Credential=AKIAFAKEEXAMPLE\/\d{8}\/us-east-1\/ProductAdvertisingAPI\/aws4_request, SignedHeaders=content-encoding;content-type;host;x-amz-date;x-amz-target, Signature=[0-9a-f]{64}$/
    );

    const body = JSON.parse(init.body as string);
    expect(body).toMatchObject({
      Keywords: "furadeira de impacto",
      SearchIndex: "All",
      PartnerTag: "arbitra-20",
      PartnerType: "Associates",
      Marketplace: "www.amazon.com.br",
    });
  });

  it("mapeia Items da resposta pro formato ScrapedOffer-compatível (título, preço, link, foto)", async () => {
    setCredentials();
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({
        SearchResult: {
          Items: [
            {
              ASIN: "B0EXAMPLE1",
              DetailPageURL: "https://www.amazon.com.br/dp/B0EXAMPLE1",
              ItemInfo: { Title: { DisplayValue: "Furadeira de Impacto 750W" } },
              Images: { Primary: { Medium: { URL: "https://img.amazon/x.jpg" } } },
              Offers: { Listings: [{ Price: { Amount: 349.9, DisplayAmount: "R$ 349,90" } }] },
            },
            // Sem preço — deve ser descartado (mesmo critério das outras fontes).
            {
              ASIN: "B0EXAMPLE2",
              ItemInfo: { Title: { DisplayValue: "Sem oferta ativa" } },
            },
          ],
        },
      }),
    });

    const result = await fetchAmazonPaApiCandidatesForQuery("furadeira de impacto");

    expect(result).toEqual([
      {
        title: "Furadeira de Impacto 750W",
        price: 349.9,
        link: "https://www.amazon.com.br/dp/B0EXAMPLE1",
        thumbnail: "https://img.amazon/x.jpg",
      },
    ]);
  });

  it("HTTP não-ok: devolve [] (fonte opcional, não lança)", async () => {
    setCredentials();
    fetchMock.mockResolvedValue({ ok: false, status: 429, text: async () => "TooManyRequests" });

    const result = await fetchAmazonPaApiCandidatesForQuery("furadeira de impacto");
    expect(result).toEqual([]);
  });

  it("payload com Errors (ex.: PartnerTag inválido): devolve [] em vez de lançar", async () => {
    setCredentials();
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({ Errors: [{ Code: "InvalidParameterValue", Message: "PartnerTag inválido" }] }),
    });

    const result = await fetchAmazonPaApiCandidatesForQuery("furadeira de impacto");
    expect(result).toEqual([]);
  });

  it("timeout (AbortError): devolve [] em vez de propagar", async () => {
    setCredentials();
    // Simula o fetch já tendo sido abortado (mesmo efeito do
    // AbortController disparando em PAAPI_TIMEOUT_MS) sem depender de
    // esperar o timeout real de 8s no teste.
    fetchMock.mockImplementation(async () => {
      const err = new Error("This operation was aborted");
      err.name = "AbortError";
      throw err;
    });

    const result = await fetchAmazonPaApiCandidatesForQuery("furadeira de impacto");
    expect(result).toEqual([]);
  });
});
