import { describe, expect, it } from "vitest";
import { normalizePixCopiaCola, PIX_QR_IMAGE_PATH } from "./donation";

describe("normalizePixCopiaCola (VITE_DONATE_PIX_COPIA_COLA)", () => {
  it("sem a variável (ou vazia) devolve null — o botão 'Copiar chave PIX' não é renderizado", () => {
    expect(normalizePixCopiaCola(undefined)).toBeNull();
    expect(normalizePixCopiaCola("")).toBeNull();
    expect(normalizePixCopiaCola("   \n ")).toBeNull();
  });

  it("devolve o código sem espaços nas pontas, sem alterar o miolo", () => {
    const code = "00020126580014br.gov.bcb.pix0136chave-exemplo5204000053039865802BR5909Fulano6009SAO PAULO62070503***6304ABCD";
    expect(normalizePixCopiaCola(`  ${code}\n`)).toBe(code);
  });
});

describe("PIX_QR_IMAGE_PATH", () => {
  it("é o arquivo que o dono coloca em public/", () => {
    expect(PIX_QR_IMAGE_PATH).toBe("/pix-doacao.png");
  });
});
