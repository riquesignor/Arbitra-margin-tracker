import { useState } from "react";
import { motion } from "framer-motion";
import { MailCheck, LogOut } from "lucide-react";
import { resendVerificationEmail, refreshEmailVerified, signOutUser, type AuthUser } from "../lib/auth";
import styles from "./VerifyEmailGate.module.css";

interface Props {
  user: AuthUser;
  onUserUpdate: (user: AuthUser) => void;
}

const RESEND_COOLDOWN_SECONDS = 30;

/**
 * Tela cheia que substitui o app inteiro enquanto a conta (login por
 * email/senha) não confirma o email — ver App.tsx. Contas Google nunca
 * chegam aqui (Google já garante emailVerified: true). Existe pra evitar
 * "contas fantasmas": cadastro sem confirmar não consegue usar nada, mas
 * também não é apagado — só fica preso aqui até confirmar ou sair.
 */
export default function VerifyEmailGate({ user, onUserUpdate }: Props) {
  const [resending, setResending] = useState(false);
  const [resent, setResent] = useState(false);
  const [cooldown, setCooldown] = useState(0);
  const [checking, setChecking] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleResend() {
    setError(null);
    setResending(true);
    try {
      await resendVerificationEmail();
      setResent(true);
      setCooldown(RESEND_COOLDOWN_SECONDS);
      const timer = setInterval(() => {
        setCooldown((prev) => {
          if (prev <= 1) {
            clearInterval(timer);
            return 0;
          }
          return prev - 1;
        });
      }, 1000);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setResending(false);
    }
  }

  async function handleCheck() {
    setError(null);
    setChecking(true);
    try {
      const updated = await refreshEmailVerified();
      if (updated) onUserUpdate(updated);
      if (updated && !updated.emailVerified) {
        setError("Ainda não confirmado — clique no link do email antes de tentar de novo.");
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setChecking(false);
    }
  }

  return (
    <div className={styles.container}>
      <motion.div
        className={styles.card}
        initial={{ opacity: 0, y: 8 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.2 }}
      >
        <span className={styles.avatar}>
          <MailCheck size={20} />
        </span>
        <h1 className={styles.title}>Confirme seu email</h1>
        <p className={styles.hint}>
          Enviamos um link de confirmação para <strong>{user.email}</strong>. Clique nele e depois
          volte aqui — sem isso, a conta fica sem acesso à busca de preço e ao resto do app.
        </p>

        <div className={styles.actions}>
          <button
            className={styles.primaryButton}
            type="button"
            onClick={() => void handleCheck()}
            disabled={checking}
          >
            {checking ? "Verificando…" : "Já confirmei, atualizar"}
          </button>
          <button
            className={styles.secondaryButton}
            type="button"
            onClick={() => void handleResend()}
            disabled={resending || cooldown > 0}
          >
            {cooldown > 0 ? `Reenviar (${cooldown}s)` : resending ? "Enviando…" : "Reenviar email"}
          </button>
        </div>

        {resent && cooldown > 0 && <p className={styles.successText}>Email reenviado.</p>}
        {error && <p className={styles.errorText}>{error}</p>}

        <button className={styles.linkButton} type="button" onClick={() => void signOutUser()}>
          <LogOut size={13} />
          Sair e usar outra conta
        </button>
      </motion.div>
    </div>
  );
}
