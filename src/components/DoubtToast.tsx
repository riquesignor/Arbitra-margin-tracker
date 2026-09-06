import { useEffect, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { X, HelpCircle } from "lucide-react";
import styles from "./DoubtToast.module.css";

interface Props {
  onOpenFaq: () => void;
}

// Some sozinho depois desse tempo (pedido: "5-10 segundos") — 8s dá tempo
// de ler as duas linhas sem segurar a tela ocupada por tanto tempo quanto
// o teto pedido. Aparece com um atraso pequeno (não instantâneo no load)
// pra não competir com a animação de entrada da própria tela.
const SHOW_DELAY_MS = 1200;
const AUTO_DISMISS_MS = 8000;

/**
 * Aviso "tem dúvida?" no canto superior direito — aparece uma vez por
 * carregamento de sessão (sem persistência em localStorage/Firestore de
 * propósito: é só um empurrão pontual pra quem acabou de abrir o app,
 * não precisa lembrar entre sessões se o usuário já fechou antes). Leva
 * pra Faq.tsx (ver App.tsx > screen "faq").
 */
export default function DoubtToast({ onOpenFaq }: Props) {
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    const showTimer = setTimeout(() => setVisible(true), SHOW_DELAY_MS);
    return () => clearTimeout(showTimer);
  }, []);

  useEffect(() => {
    if (!visible) return;
    const hideTimer = setTimeout(() => setVisible(false), AUTO_DISMISS_MS);
    return () => clearTimeout(hideTimer);
  }, [visible]);

  return (
    <AnimatePresence>
      {visible && (
        <motion.div
          className={styles.toast}
          role="status"
          initial={{ opacity: 0, y: -10, x: 8 }}
          animate={{ opacity: 1, y: 0, x: 0 }}
          exit={{ opacity: 0, y: -10 }}
          transition={{ duration: 0.25, ease: [0.16, 1, 0.3, 1] }}
        >
          <button
            type="button"
            className={styles.closeButton}
            onClick={() => setVisible(false)}
            aria-label="Fechar aviso"
          >
            <X size={13} />
          </button>
          <span className={styles.icon}>
            <HelpCircle size={16} />
          </span>
          <div className={styles.text}>
            <p className={styles.question}>Está em dúvida sobre o funcionamento?</p>
            <button
              type="button"
              className={styles.link}
              onClick={() => {
                setVisible(false);
                onOpenFaq();
              }}
            >
              Clique aqui para entender
            </button>
          </div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
