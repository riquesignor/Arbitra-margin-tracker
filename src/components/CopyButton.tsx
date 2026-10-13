import { useEffect, useRef, useState } from "react";
import { Check, Copy } from "lucide-react";
import styles from "./CopyButton.module.css";

interface Props {
  text: string;
  label?: string;
}

const FEEDBACK_MS = 1500;

export default function CopyButton({ text, label = "Copiar" }: Props) {
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout>>();

  useEffect(() => () => clearTimeout(timer.current), []);

  async function handleCopy() {
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      return;
    }
    setCopied(true);
    clearTimeout(timer.current);
    timer.current = setTimeout(() => setCopied(false), FEEDBACK_MS);
  }

  return (
    <button
      type="button"
      className={copied ? styles.buttonCopied : styles.button}
      onClick={handleCopy}
      aria-label={copied ? "Copiado" : `${label} ${text}`}
      title={copied ? "Copiado" : label}
    >
      {copied ? <Check size={12} /> : <Copy size={12} />}
    </button>
  );
}
