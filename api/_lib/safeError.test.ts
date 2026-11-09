import { describe, expect, it } from "vitest";
import { publicErrorDetail, redactSecrets } from "./safeError.js";

describe("redactSecrets", () => {
  it("esconde chave de API na query string de uma URL", () => {
    const text = "fetch falhou: https://serpapi.com/search.json?engine=google&api_key=abcd1234SECRETvalue&q=tenis";
    const clean = redactSecrets(text);
    expect(clean).not.toContain("abcd1234SECRETvalue");
    expect(clean).toContain("api_key=[oculto]");
    expect(clean).toContain("q=tenis"); // o resto da URL continua legível
  });

  it("esconde ?key= (Gemini) e token= em qualquer posição", () => {
    expect(redactSecrets("POST https://x/y?key=AIzaSyA-1234567890abcdefghijklmnop")).not.toMatch(/AIza/);
    expect(redactSecrets("a=1&token=meu-token-secreto&b=2")).toBe("a=1&token=[oculto]&b=2");
  });

  it("esconde token Bearer", () => {
    expect(redactSecrets("Authorization: Bearer eyJhbGciOiJSUzI1NiJ9.payload.assinatura")).toBe(
      "Authorization: Bearer [oculto]"
    );
  });

  it("esconde formatos de chave conhecidos soltos no texto", () => {
    expect(redactSecrets("token APP_USR-1234567890123456-abcdef-ghijkl recusado")).not.toContain("APP_USR-1234");
    expect(redactSecrets("chave sk-abcdefghijklmnopqrstuvwx inválida")).toBe("chave [oculto] inválida");
    expect(redactSecrets("AIzaSyA1234567890abcdefghijklmnopqrstu")).toBe("[oculto]");
  });

  it("troca NOME de variável de ambiente por [config]", () => {
    expect(redactSecrets("MERCADOPAGO_ACCESS_TOKEN ausente — configure a credencial")).toBe(
      "[config] ausente — configure a credencial"
    );
    expect(
      redactSecrets("Credenciais Firebase Admin ausentes (FIREBASE_PROJECT_ID / FIREBASE_CLIENT_EMAIL / FIREBASE_PRIVATE_KEY)")
    ).toBe("Credenciais Firebase Admin ausentes ([config] / [config] / [config])");
  });

  it("não mexe em mensagem comum que o usuário precisa ler", () => {
    for (const text of [
      "Sua chave SerpApi parece inválida — confira em Conta.",
      "HTTP 429: limite de requisições atingido pelo provedor",
      "Gemini sem cota disponível agora",
      "Nenhuma oferta encontrada pra “Garrafa térmica 1L”.",
    ]) {
      expect(redactSecrets(text)).toBe(text);
    }
  });
});

describe("publicErrorDetail", () => {
  it("lê a mensagem de um Error e passa pelo filtro", () => {
    const err = new Error("falha em https://api.exemplo.com/v1?api_key=SEGREDO123 (MERCADOPAGO_ACCESS_TOKEN)");
    const detail = publicErrorDetail(err);
    expect(detail).not.toMatch(/SEGREDO123|MERCADOPAGO_ACCESS_TOKEN/);
  });

  it("aceita qualquer valor lançado, não só Error", () => {
    expect(publicErrorDetail("texto solto")).toBe("texto solto");
    expect(publicErrorDetail({ toString: () => "objeto" })).toBe("objeto");
  });

  it("colapsa quebras de linha (stack/corpo bruto não vira parede de texto) e corta no limite", () => {
    expect(publicErrorDetail(new Error("linha 1\n   linha 2\n\tlinha 3"))).toBe("linha 1 linha 2 linha 3");
    const long = publicErrorDetail(new Error("x".repeat(5000)));
    expect(long.length).toBeLessThanOrEqual(300);
    expect(long.endsWith("…")).toBe(true);
    expect(publicErrorDetail(new Error("y".repeat(50)), 10)).toHaveLength(10);
  });
});
