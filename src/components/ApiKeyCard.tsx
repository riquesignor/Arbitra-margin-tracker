import { useState, type FormEvent, type ReactNode } from "react";
import { Check, Eye, EyeOff, Plus, Trash2 } from "lucide-react";
import { deleteUserApiKey, saveUserApiKey, type ApiKeyField } from "../lib/userSecrets";
import { useConfirm } from "../lib/confirm";
import styles from "./Account.module.css";

export interface ApiKeyCardConfig {
  field: ApiKeyField;
  title: string;
  /** Uma linha curta do que a chave libera — aparece sempre na lista. */
  summary: string;
  /** Explicação completa + link de onde criar — só aparece com o formulário aberto. */
  intro: ReactNode;
  placeholder: string;
  savedMessage: string;
  removedMessage: string;
  beta?: boolean;
  recommended?: boolean;
}

interface Props {
  userId: string;
  config: ApiKeyCardConfig;
  /** Se já existe chave salva — vem do Account, que também usa a informação fora da linha. */
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
        // Só existe depois de um clique explícito em "Adicionar"/"Trocar" — o foco vai pra onde a pessoa vai colar.
        autoFocus
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
 * Uma chave BYOK como linha de lista (out/2026 — antes era um cartão
 * grande por chave, 8 empilhados). Fechada mostra só nome, pra que serve e
 * status; o formulário com a explicação e o link de onde criar a chave só
 * abre na linha que o usuário clicou pra adicionar/trocar.
 */
export default function ApiKeyCard({ userId, config, saved, onSavedChange }: Props) {
  const confirm = useConfirm();
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

  async function handleRemove() {
    const ok = await confirm({
      title: `Remover a chave ${config.title}?`,
      message: "Os mecanismos de busca que dependem dela ficam indisponíveis até você cadastrar outra.",
      confirmLabel: "Remover chave",
      tone: "danger",
    });
    if (ok) void persist(false);
  }

  function handleSubmit(e: FormEvent) {
    e.preventDefault();
    if (!input.trim()) return;
    void persist(true);
  }

  return (
    <li className={editing ? styles.keyRowOpen : styles.keyRow}>
      <div className={styles.keyRowMain}>
        <span className={saved ? styles.keyDotOn : styles.keyDotOff} aria-hidden="true">
          {saved && <Check size={11} strokeWidth={3} />}
        </span>
        <span className={styles.keyText}>
          <span className={styles.keyTitle}>
            {config.title}
            {config.recommended && <span className={styles.recommendedTag}>recomendada</span>}
            {config.beta && <span className={styles.betaBadge}>Beta</span>}
          </span>
          <span className={styles.keySummary}>{config.summary}</span>
        </span>
        <span className={saved ? styles.statusOk : styles.statusOff}>{saved ? "configurada" : "sem chave"}</span>
        <span className={styles.keyActions}>
          {!editing && (
            <button
              type="button"
              className={saved ? styles.secondaryKeyButton : styles.addKeyButton}
              onClick={() => {
                setEditing(true);
                setMessage(null);
                setError(null);
              }}
              disabled={busy}
            >
              {!saved && <Plus size={14} aria-hidden="true" />}
              {saved ? "Trocar" : "Adicionar"}
            </button>
          )}
          {saved && !editing && (
            <button
              type="button"
              className={styles.iconButton}
              title="Remover chave"
              aria-label={`Remover chave ${config.title}`}
              onClick={() => void handleRemove()}
              disabled={busy}
            >
              <Trash2 size={14} />
            </button>
          )}
        </span>
      </div>

      {editing && (
        <form className={styles.keyEditor} onSubmit={handleSubmit}>
          <p className={styles.keyIntro}>{config.intro}</p>
          <div className={styles.keyEditorRow}>
            <KeyInput
              value={input}
              onChange={setInput}
              placeholder={saved ? "Cole a chave nova pra substituir a atual" : config.placeholder}
              disabled={busy}
            />
            <button className={styles.primaryButton} type="submit" disabled={busy || !input.trim()}>
              {busy ? "Salvando…" : "Salvar"}
            </button>
            <button type="button" className={styles.secondaryKeyButton} onClick={() => setEditing(false)} disabled={busy}>
              Cancelar
            </button>
          </div>
          {saved && <p className={styles.keyStoredHint}>Por segurança, a chave atual nunca aparece aqui — só dá pra substituir.</p>}
        </form>
      )}

      {(message || error) && (
        <p className={error ? styles.errorText : styles.successText} role={error ? "alert" : "status"}>
          {error ?? message}
        </p>
      )}
    </li>
  );
}
