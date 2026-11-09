/**
 * Contribuição voluntária por PIX (nov/2026) — o Arbitra é um projeto
 * gratuito e beneficente, e doar NÃO libera função nenhuma.
 *
 * - QR Code: arquivo `public/pix-doacao.png` (colocado à mão por quem opera
 *   a instância). Se faltar, o cartão simplesmente não mostra a imagem.
 * - "Copia e cola": `VITE_DONATE_PIX_COPIA_COLA`, lida NO BUILD (variável
 *   `VITE_*`). Sem ela, o botão "Copiar chave PIX" não é renderizado.
 *
 * Nenhum dado de pagamento passa pelo Arbitra: é só um texto a ser copiado
 * e uma imagem estática.
 */
export const PIX_QR_IMAGE_PATH = "/pix-doacao.png";

/** Texto do "copia e cola" sem espaços nas pontas; vazio/ausente = `null` (botão não aparece). */
export function normalizePixCopiaCola(value: string | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

export const PIX_COPIA_COLA = normalizePixCopiaCola(import.meta.env.VITE_DONATE_PIX_COPIA_COLA as string | undefined);
