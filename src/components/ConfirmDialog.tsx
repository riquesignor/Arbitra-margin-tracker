import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { ConfirmContext, type ConfirmOptions } from "../lib/confirm";
import styles from "./ConfirmDialog.module.css";

interface Pending extends ConfirmOptions {
  resolve: (ok: boolean) => void;
}

/**
 * Confirmação em modal (ver src/lib/confirm.ts). Usa o `<dialog>` nativo
 * com `showModal()`: o navegador já cuida de prender o foco dentro, fechar
 * no Esc e deixar o resto da página inerte. O foco começa em "Cancelar" —
 * apertar Enter por reflexo nunca confirma uma ação destrutiva.
 */
export default function ConfirmProvider({ children }: { children: ReactNode }) {
  const [pending, setPending] = useState<Pending | null>(null);
  const dialogRef = useRef<HTMLDialogElement>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);

  const confirm = useCallback(
    (options: ConfirmOptions) =>
      new Promise<boolean>((resolve) => {
        // Pedido novo com outro ainda aberto: o anterior conta como "cancelar"
        // (resolver uma Promise duas vezes é inofensivo, então o StrictMode não atrapalha).
        setPending((prev) => {
          prev?.resolve(false);
          return { ...options, resolve };
        });
      }),
    []
  );

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog || !pending) return;
    if (!dialog.open) dialog.showModal();
    cancelRef.current?.focus();
  }, [pending]);

  function close(ok: boolean) {
    pending?.resolve(ok);
    dialogRef.current?.close();
    setPending(null);
  }

  return (
    <ConfirmContext.Provider value={confirm}>
      {children}
      <dialog
        ref={dialogRef}
        className={styles.dialog}
        aria-labelledby="confirm-dialog-title"
        aria-describedby={pending?.message ? "confirm-dialog-message" : undefined}
        onCancel={(e) => {
          e.preventDefault();
          close(false);
        }}
        onClick={(e) => {
          // Clique no fundo escurecido (fora da caixa) = cancelar.
          if (e.target === dialogRef.current) close(false);
        }}
      >
        {pending && (
          <div className={styles.box}>
            <h2 id="confirm-dialog-title" className={styles.title}>
              {pending.title}
            </h2>
            {pending.message && (
              <p id="confirm-dialog-message" className={styles.message}>
                {pending.message}
              </p>
            )}
            <div className={styles.actions}>
              <button ref={cancelRef} type="button" className={styles.cancel} onClick={() => close(false)}>
                {pending.cancelLabel ?? "Cancelar"}
              </button>
              <button
                type="button"
                className={pending.tone === "danger" ? styles.confirmDanger : styles.confirm}
                onClick={() => close(true)}
              >
                {pending.confirmLabel ?? "Confirmar"}
              </button>
            </div>
          </div>
        )}
      </dialog>
    </ConfirmContext.Provider>
  );
}
