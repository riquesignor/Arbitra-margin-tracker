export type Theme = "dark" | "light";

const STORAGE_KEY = "arbitra:theme";

/** Preferência salva > preferência do SO > dark (default do produto). */
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
