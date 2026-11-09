import { useEffect, useRef, useState } from "react";
import { Check, Copy, HeartHandshake } from "lucide-react";
import { PIX_COPIA_COLA, PIX_QR_IMAGE_PATH } from "../config/donation";
import styles from "./DonationCard.module.css";

const FEEDBACK_MS = 4000;

/** Copia pelo Clipboard API; sem ele (http, navegador antigo), tenta o método legado. `false` se nada funcionou. */
async function copyToClipboard(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    // cai no método legado abaixo
  }
  try {
    const area = document.createElement("textarea");
    area.value = text;
    area.setAttribute("readonly", "");
    area.style.position = "fixed";
    area.style.opacity = "0";
    document.body.appendChild(area);
    area.select();
    const ok = document.execCommand("copy");
    document.body.removeChild(area);
    return ok;
  } catch {
    return false;
  }
}

/**
 * "Apoie o projeto" (nov/2026): contribuição VOLUNTÁRIA por PIX — QR Code
 * (public/pix-doacao.png) e botão "Copiar chave PIX" (VITE_DONATE_PIX_COPIA_COLA).
 * Não libera função nenhuma. Faltando a imagem, ela some sem quebrar nada;
 * faltando a variável, o botão não é renderizado.
 */
export default function DonationCard() {
  const [imageFailed, setImageFailed] = useState(false);
  const [feedback, setFeedback] = useState<"copied" | "failed" | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout>>();
  const manualRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => () => clearTimeout(timer.current), []);

  useEffect(() => {
    if (feedback === "failed") manualRef.current?.select();
  }, [feedback]);

  async function handleCopy() {
    if (!PIX_COPIA_COLA) return;
    const ok = await copyToClipboard(PIX_COPIA_COLA);
    setFeedback(ok ? "copied" : "failed");
    clearTimeout(timer.current);
    if (ok) timer.current = setTimeout(() => setFeedback(null), FEEDBACK_MS);
  }

  const hasQr = !imageFailed;
  const configured = hasQr || PIX_COPIA_COLA !== null;

  return (
    <section className={styles.card} aria-labelledby="donation-title">
      <div className={styles.text}>
        <h3 id="donation-title" className={styles.title}>
          <HeartHandshake size={16} aria-hidden="true" /> Contribua por PIX
        </h3>
        <p className={styles.description}>
          O Arbitra é um projeto gratuito e sem fins lucrativos. Se ele te ajudou, dá pra contribuir por PIX — o valor
          é livre.
        </p>
        <p className={styles.note}>Contribuição voluntária. Não libera funções.</p>

        {PIX_COPIA_COLA && (
          <div className={styles.copyRow}>
            <button type="button" className={styles.copyButton} onClick={() => void handleCopy()}>
              {feedback === "copied" ? <Check size={15} aria-hidden="true" /> : <Copy size={15} aria-hidden="true" />}
              Copiar chave PIX
            </button>
          </div>
        )}

        {/* Região viva: leitor de tela anuncia o resultado da cópia sem mover o foco. */}
        <p className={styles.live} role="status" aria-live="polite">
          {feedback === "copied" && "Chave PIX copiada."}
          {feedback === "failed" && "Não consegui copiar sozinho. O código está selecionado abaixo — copie com Ctrl+C."}
        </p>
        {feedback === "failed" && PIX_COPIA_COLA && (
          <textarea
            ref={manualRef}
            className={styles.manual}
            readOnly
            rows={3}
            value={PIX_COPIA_COLA}
            aria-label="Chave PIX (copia e cola)"
          />
        )}

        {!configured && (
          <p className={styles.note}>Esta instância ainda não configurou uma forma de contribuição.</p>
        )}
      </div>

      {hasQr && (
        <img
          className={styles.qr}
          src={PIX_QR_IMAGE_PATH}
          alt="QR Code PIX para contribuir voluntariamente com o projeto"
          width={168}
          height={168}
          onError={() => setImageFailed(true)}
        />
      )}
    </section>
  );
}
