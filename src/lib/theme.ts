import type { AccentPalette, FontSizePreset, ThemeMode } from "./userPreferences";

/** Valor efetivamente pintado — "system" (ver ThemeMode em userPreferences.ts) nunca chega até aqui, já vem resolvido. */
export type Theme = "dark" | "light";

const STORAGE_KEY = "arbitra:theme";

/**
 * Preferência salva > preferência do SO > dark (default do produto).
 * Kept como "quick paint" antes do Firestore/userPreferences responder —
 * `App.tsx` chama isto só pro primeiro render, depois passa a seguir
 * `loadUserPreferences` + `resolveThemeMode`.
 */
export function getInitialTheme(): Theme {
  if (typeof window === "undefined") return "dark";

  const stored = window.localStorage.getItem(STORAGE_KEY);
  if (stored === "light" || stored === "dark") return stored;

  const prefersLight = window.matchMedia?.("(prefers-color-scheme: light)").matches;
  return prefersLight ? "light" : "dark";
}

/** Aplica no <html data-theme="..."> — tokens.css reage a esse atributo. */
export function applyTheme(theme: Theme): void {
  document.documentElement.dataset.theme = theme;
  window.localStorage.setItem(STORAGE_KEY, theme);
}

/**
 * Resolve o preset "Sistema" (Configurações → Aparência) pro valor real
 * de acordo com o SO no momento da chamada — "light"/"dark" explícitos
 * passam direto. Quem chama deve re-resolver quando
 * `matchMedia("(prefers-color-scheme: light)")` mudar em tempo real (ver
 * listener montado em App.tsx) pra "Sistema" acompanhar o SO sem precisar
 * de reload.
 */
export function resolveThemeMode(mode: ThemeMode): Theme {
  if (mode === "light" || mode === "dark") return mode;
  if (typeof window === "undefined") return "dark";
  const prefersLight = window.matchMedia?.("(prefers-color-scheme: light)").matches;
  return prefersLight ? "light" : "dark";
}

/** Aplica a paleta de acento no <html data-accent="...">. "aco" (padrão) não precisa do atributo, mas setar não faz mal — tokens.css já cobre os dois casos. */
export function applyAccent(accent: AccentPalette): void {
  document.documentElement.dataset.accent = accent;
}

/** Aplica o preset de tamanho de texto no <html data-font-size="...">. */
export function applyFontSize(fontSize: FontSizePreset): void {
  document.documentElement.dataset.fontSize = fontSize;
}
