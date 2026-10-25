import { createContext, useContext } from "react";

/** Substituto do `window.confirm` no estilo do app (out/2026) — ver ConfirmDialog.tsx. */
export interface ConfirmOptions {
  title: string;
  message?: string;
  confirmLabel?: string;
  cancelLabel?: string;
  /** "danger" pinta o botão de confirmar de vermelho (excluir, tirar permissão). */
  tone?: "default" | "danger";
}

export type ConfirmFn = (options: ConfirmOptions) => Promise<boolean>;

export const ConfirmContext = createContext<ConfirmFn>((options) =>
  Promise.resolve(window.confirm(options.message ? `${options.title}\n\n${options.message}` : options.title))
);

/** `if (!(await confirm({ title: "Excluir?" }))) return;` */
export function useConfirm(): ConfirmFn {
  return useContext(ConfirmContext);
}
