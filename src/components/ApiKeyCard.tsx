import { useState, type FormEvent, type ReactNode } from "react";
import { Check, Eye, EyeOff, KeyRound, Trash2 } from "lucide-react";
import { deleteUserApiKey, saveUserApiKey, type ApiKeyField } from "../lib/userSecrets";
import styles from "./Account.module.css";

export interface ApiKeyCardConfig {
  field: ApiKeyField;
  title: string;
  intro: ReactNode;
  placeholder: string;
  savedMessage: string;
  removedMessage: string;
  beta?: boolean;
}

interface Props {
  userId: string;
  config: ApiKeyCardConfig;
  /** Se já existe chave salva — vem do Account, que também usa a informação fora do card. */
  saved: boolean;
  onSavedChange: (saved: boolean) => void;
}

// Input com "olhinho" pra revelar o que foi digitado/colado antes de salvar.
// NÃO reexibe a chave já salva: a tela só sabe se ela existe, nunca o valor.
function KeyInput({
  value,
  onChange,
  placeholder,
  disabled,
}: {
  value: string;
  onChange: (value: string) => void;
  placeholder: string;
  disabled?: boolean;
}) {
  const [visible, setVisible] = useState(false);
  return (
    <div className={styles.keyInputWrap}>
      <input
        className={styles.input}
        type={visible ? "text" : "password"}
        placeholder={placeholder}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        autoComplete="off"
      />
      <button
        type="button"
        className={styles.keyInputToggle}
        onClick={() => setVisible((v) => !v)}
        disabled={disabled}
        tabIndex={-1}
        title={visible ? "Ocultar chave" : "Mostrar chave"}
        aria-label={visible ? "Ocultar chave" : "Mostrar chave"}
      >
        {visible ? <EyeOff size={14} /> : <Eye size={14} />}
      </button>
    </div>
  );
}

/**
 * Card de uma chave BYOK (salvar, trocar, remover). Chave já salva fica
 * recolhida (só status + "Trocar chave"); o formulário completo só abre pra
 * quem ainda não tem chave ou pediu pra trocar.
 */
export default function ApiKeyCard({ userId, config, saved, onSavedChange }: Props) {
  const [editing, setEditing] = useState(false);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function persist(save: boolean) {
    setBusy(true);
    setError(null);
    setMessage(null);
    try {
      if (save) {
        await saveUserApiKey(userId, config.field, input);
        setEditing(false);
        setInput("");
      } else {
        await deleteUserApiKey(userId, config.field);
      }
      onSavedChange(save);
      setMessage(save ? config.savedMessage : config.removedMessage);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  function handleSubmit(e: FormEvent) {
    e.preventDefault();
    if (!input.trim()) return;
    void persist(true);
  }

  const showForm = !saved || editing;

  return (
    <section className={styles.card}>
      <div className={styles.cardHeader}>
        <span className={styles.cardHeaderIcon}>
          <KeyRound size={14} />
        </span>
        <h2 className={styles.cardHeaderTitle}>{config.title}</h2>
        {config.beta && <span className={styles.betaBadge}>Beta</span>}
        <span className={saved ? styles.statusPillOk : styles.statusPillWarning}>
          {saved ? <Check size={11} strokeWidth={3} /> : null} {saved ? "configurada" : "não configurada"}
        </span>
      </div>

      <form className={styles.compactKeyForm} onSubmit={handleSubmit}>
        {showForm && <p className={styles.cardIntro}>{config.intro}</p>}

        <div className={styles.compactKeyRow}>
          {showForm ? (
            <>
              <KeyInput
                value={input}
                onChange={setInput}
                placeholder={saved ? "Substituir a chave atual…" : config.placeholder}
                disabled={busy}
              />
              <button className={styles.primaryButton} type="submit" disabled={busy || !input.trim()}>
                {busy ? "Salvando…" : "Salvar"}
              </button>
              {saved && (
                <button type="button" className={styles.linkButton} onClick={() => setEditing(false)}>
                  Cancelar
                </button>
              )}
            </>
          ) : (
            <>
              <span className={styles.keyStoredHint}>Chave salva — por segurança o valor não aparece aqui.</span>
              <button type="button" className={styles.secondaryKeyButton} onClick={() => setEditing(true)}>
                Trocar chave
              </button>
            </>
          )}
          {saved && (
            <button
              type="button"
              className={styles.iconButton}
              title="Remover chave"
              onClick={() => void persist(false)}
              disabled={busy}
            >
              <Trash2 size={13} />
            </button>
          )}
        </div>

        {message && <p className={styles.successText}>{message}</p>}
        {error && <p className={styles.errorText}>{error}</p>}
      </form>
    </section>
  );
}
