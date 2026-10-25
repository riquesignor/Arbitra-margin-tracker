import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { X } from "lucide-react";
import { ToastContext, type ToastApi, type ToastOptions } from "../lib/toast";
import styles from "./Toaster.module.css";

interface ActiveToast extends ToastOptions {
  id: string;
}

const DEFAULT_DURATION_MS = 5000;
const MAX_VISIBLE = 3;

/**
 * Provedor dos avisos (ver src/lib/toast.ts). Fica na raiz (main.tsx), então
 * um aviso sobrevive à troca de tela — importante pro "Desfazer": o
 * `onExpire` (efeito definitivo) roda mesmo se a tela que o criou já saiu.
 */
export default function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<ActiveToast[]>([]);
  // Espelho síncrono da lista: os efeitos (`onExpire`) rodam FORA do
  // setState — no StrictMode o updater roda duas vezes, e um "apagar do
  // Firestore" ali dentro rodaria duas vezes também.
  const toastsRef = useRef<ActiveToast[]>([]);
  const counter = useRef(0);

  const commit = useCallback((next: ActiveToast[]) => {
    toastsRef.current = next;
    setToasts(next);
  }, []);

  const remove = useCallback(
    (id: string, runExpire: boolean) => {
      const target = toastsRef.current.find((t) => t.id === id);
      if (!target) return;
      commit(toastsRef.current.filter((t) => t.id !== id));
      if (runExpire) target.onExpire?.();
    },
    [commit]
  );

  const api = useMemo<ToastApi>(
    () => ({
      show: (options) => {
        counter.current += 1;
        const id = `toast-${counter.current}`;
        const next = [...toastsRef.current, { ...options, id }];
        // Excesso: o mais antigo sai como se tivesse expirado (efeito definitivo roda).
        const overflow = next.length > MAX_VISIBLE ? next.splice(0, next.length - MAX_VISIBLE) : [];
        commit(next);
        overflow.forEach((t) => t.onExpire?.());
        return id;
      },
      dismiss: (id) => remove(id, true),
    }),
    [commit, remove]
  );

  return (
    <ToastContext.Provider value={api}>
      {children}
      <div className={styles.region} role="region" aria-label="Avisos">
        {toasts.map((t) => (
          <ToastItem key={t.id} toast={t} onRemove={remove} />
        ))}
      </div>
    </ToastContext.Provider>
  );
}

function ToastItem({ toast, onRemove }: { toast: ActiveToast; onRemove: (id: string, runExpire: boolean) => void }) {
  const [paused, setPaused] = useState(false);
  const remaining = useRef(toast.durationMs ?? DEFAULT_DURATION_MS);
  const startedAt = useRef(Date.now());

  // Pausa enquanto o mouse está em cima ou o foco está dentro (dá tempo de ler/clicar).
  useEffect(() => {
    if (paused) return;
    startedAt.current = Date.now();
    const timer = setTimeout(() => onRemove(toast.id, true), remaining.current);
    return () => {
      clearTimeout(timer);
      remaining.current -= Date.now() - startedAt.current;
    };
  }, [paused, toast.id, onRemove]);

  return (
    <div
      className={toast.tone === "error" ? styles.toastError : styles.toast}
      role={toast.tone === "error" ? "alert" : "status"}
      onMouseEnter={() => setPaused(true)}
      onMouseLeave={() => setPaused(false)}
      onFocus={() => setPaused(true)}
      onBlur={() => setPaused(false)}
    >
      <span className={styles.message}>{toast.message}</span>
      {toast.action && (
        <button
          type="button"
          className={styles.action}
          onClick={() => {
            toast.action!.onClick();
            onRemove(toast.id, false);
          }}
        >
          {toast.action.label}
        </button>
      )}
      <button type="button" className={styles.close} aria-label="Fechar aviso" onClick={() => onRemove(toast.id, true)}>
        <X size={14} aria-hidden="true" />
      </button>
    </div>
  );
}
