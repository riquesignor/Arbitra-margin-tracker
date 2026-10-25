import { createContext, useContext } from "react";

/**
 * Aviso passageiro no canto da tela (out/2026). Pensado pro padrão
 * "fez, avisa, deixa desfazer": a ação acontece na hora pra quem olha, e
 * o efeito definitivo (ex.: apagar no Firestore) roda em `onExpire`,
 * quando o aviso some sem o usuário clicar em "Desfazer".
 */
export interface ToastOptions {
  message: string;
  tone?: "default" | "error";
  /** Botão no aviso (ex.: "Desfazer"). Clicar NÃO dispara `onExpire`. */
  action?: { label: string; onClick: () => void };
  /** Roda quando o aviso some sozinho ou é fechado no X — nunca depois de `action`. */
  onExpire?: () => void;
  durationMs?: number;
}

export interface ToastApi {
  show: (options: ToastOptions) => string;
  dismiss: (id: string) => void;
}

const noop: ToastApi = {
  show: () => "",
  dismiss: () => {},
};

export const ToastContext = createContext<ToastApi>(noop);

export function useToast(): ToastApi {
  return useContext(ToastContext);
}
