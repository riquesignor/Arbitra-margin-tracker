import { describe, expect, it, vi } from "vitest";
import { fetchWithRetry } from "./fetchWithRetry.js";

const noSleep = () => Promise.resolve();

function res(status: number): Response {
  return new Response(status === 200 ? "{}" : "erro", { status });
}

describe("fetchWithRetry", () => {
  it("devolve de primeira quando dá 200, sem reenviar", async () => {
    const doFetch = vi.fn().mockResolvedValue(res(200));
    const out = await fetchWithRetry(doFetch, { sleep: noSleep });
    expect(out.status).toBe(200);
    expect(doFetch).toHaveBeenCalledTimes(1);
  });

  it("reenvia uma vez em 503 e devolve o sucesso", async () => {
    const doFetch = vi.fn().mockResolvedValueOnce(res(503)).mockResolvedValueOnce(res(200));
    const sleep = vi.fn().mockResolvedValue(undefined);
    const out = await fetchWithRetry(doFetch, { sleep });
    expect(out.status).toBe(200);
    expect(doFetch).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledTimes(1);
  });

  it("devolve o 5xx quando a nova tentativa também falha (não insiste mais)", async () => {
    const doFetch = vi.fn().mockResolvedValue(res(502));
    const out = await fetchWithRetry(doFetch, { sleep: noSleep });
    expect(out.status).toBe(502);
    expect(doFetch).toHaveBeenCalledTimes(2);
  });

  it.each([400, 401, 403, 404, 429])("NÃO reenvia em HTTP %i", async (status) => {
    const doFetch = vi.fn().mockResolvedValue(res(status));
    const out = await fetchWithRetry(doFetch, { sleep: noSleep });
    expect(out.status).toBe(status);
    expect(doFetch).toHaveBeenCalledTimes(1);
  });

  it("reenvia quando o fetch lança (erro de rede)", async () => {
    const doFetch = vi.fn().mockRejectedValueOnce(new Error("ECONNRESET")).mockResolvedValueOnce(res(200));
    const out = await fetchWithRetry(doFetch, { sleep: noSleep });
    expect(out.status).toBe(200);
    expect(doFetch).toHaveBeenCalledTimes(2);
  });

  it("propaga o erro quando as duas tentativas lançam", async () => {
    const doFetch = vi.fn().mockRejectedValue(new Error("ECONNRESET"));
    await expect(fetchWithRetry(doFetch, { sleep: noSleep })).rejects.toThrow("ECONNRESET");
    expect(doFetch).toHaveBeenCalledTimes(2);
  });

  it("com retryOnThrow:false não reenvia erro lançado (ex.: timeout), mas ainda reenvia 5xx", async () => {
    const throwing = vi.fn().mockRejectedValue(new Error("timeout"));
    await expect(fetchWithRetry(throwing, { sleep: noSleep, retryOnThrow: false })).rejects.toThrow("timeout");
    expect(throwing).toHaveBeenCalledTimes(1);

    const flaky = vi.fn().mockResolvedValueOnce(res(500)).mockResolvedValueOnce(res(200));
    const out = await fetchWithRetry(flaky, { sleep: noSleep, retryOnThrow: false });
    expect(out.status).toBe(200);
    expect(flaky).toHaveBeenCalledTimes(2);
  });

  it("respeita retries:0", async () => {
    const doFetch = vi.fn().mockResolvedValue(res(503));
    const out = await fetchWithRetry(doFetch, { retries: 0, sleep: noSleep });
    expect(out.status).toBe(503);
    expect(doFetch).toHaveBeenCalledTimes(1);
  });
});
