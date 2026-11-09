import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Trava de regressão: os cabeçalhos de segurança do vercel.json (revisão de
 * nov/2026). Se alguém mexer no arquivo e derrubar um deles, o teste avisa.
 */
const config = JSON.parse(readFileSync(join(process.cwd(), "vercel.json"), "utf8")) as {
  headers: { source: string; headers: { key: string; value: string }[] }[];
};
const global = config.headers.find((h) => h.source === "/(.*)");
const header = (name: string) => global?.headers.find((h) => h.key.toLowerCase() === name.toLowerCase())?.value;

describe("vercel.json — cabeçalhos de segurança em todas as rotas", () => {
  it("vale pra tudo, inclusive /api", () => {
    expect(global).toBeDefined();
  });

  it("X-Content-Type-Options: nosniff", () => {
    expect(header("X-Content-Type-Options")).toBe("nosniff");
  });

  it("Referrer-Policy: strict-origin-when-cross-origin", () => {
    expect(header("Referrer-Policy")).toBe("strict-origin-when-cross-origin");
  });

  it("X-Frame-Options: DENY", () => {
    expect(header("X-Frame-Options")).toBe("DENY");
  });

  it("Permissions-Policy restritiva (câmera, microfone, localização e pagamento desligados)", () => {
    const policy = header("Permissions-Policy") ?? "";
    for (const feature of ["camera", "microphone", "geolocation", "payment"]) {
      expect(policy).toContain(`${feature}=()`);
    }
  });

  it("Strict-Transport-Security com validade longa", () => {
    const hsts = header("Strict-Transport-Security") ?? "";
    expect(Number(/max-age=(\d+)/.exec(hsts)?.[1])).toBeGreaterThanOrEqual(31_536_000);
  });

  it("tem Content-Security-Policy que bloqueia plugin, iframe de terceiro e base-uri externo", () => {
    const csp = header("Content-Security-Policy") ?? "";
    expect(csp).toContain("default-src 'self'");
    expect(csp).toContain("object-src 'none'");
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).toContain("base-uri 'self'");
  });

  it("o cron diário continua agendado", () => {
    expect((config as unknown as { crons: { path: string }[] }).crons.map((c) => c.path)).toContain("/api/cron-check-watches");
  });
});
