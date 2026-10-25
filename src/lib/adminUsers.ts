/** Todas as chaves BYOK possíveis (ver API_KEY_FIELDS em userSecrets.ts) — mostra o que falta, não só o que tem. */
export const ALL_KEY_PROVIDERS = ["SerpApi", "RapidAPI", "SearchApi.io", "ScraperAPI", "Unwrangle", "Gemini", "Mistral", "NVIDIA"];

/** Iniciais pro avatar da conta (parte do email antes do @). */
export function initials(email: string | null): string {
  const name = (email ?? "?").split("@")[0].replace(/[^a-zA-Z0-9]/g, " ").trim();
  const parts = name.split(/\s+/).filter(Boolean);
  return ((parts[0]?.[0] ?? "?") + (parts[1]?.[0] ?? "")).toUpperCase();
}
