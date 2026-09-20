import { firebaseConfigured, getFirebaseDb } from "./firebase";

/**
 * Preferências de UI por usuário — Configurações → Aparência/
 * Personalização e as "Preferências opcionais" da tela Conta. Mesmo
 * padrão de persistência de `pricingRulesStore.ts`: Firestore
 * (`users/{userId}/preferences/config`) quando logado, com fallback pra
 * localStorage (usuário deslogado, Firebase indisponível, ou erro de
 * rede) — nunca trava a UI sem conseguir aplicar um tema.
 *
 * "system" em `themeMode` é resolvido pra light/dark em tempo real por
 * `resolveThemeMode` (ver theme.ts) — não é persistido como light/dark
 * escolhido, o preset "Sistema" continua acompanhando o SO.
 */

export type ThemeMode = "light" | "dark" | "system";
export type AccentPalette = "aco" | "petroleo" | "indigo" | "terracota";
export type FontSizePreset = "compact" | "standard" | "large";

export interface UserPreferences {
  // --- Aparência ---
  themeMode: ThemeMode;
  accent: AccentPalette;
  fontSize: FontSizePreset;

  // --- Personalização (gráficos opcionais por tela, ver design-tokens.md
  // § Regras de tela adicionadas — "a leitura numérica nunca depende só
  // do gráfico", então desligar aqui nunca esconde dado, só o gráfico) ---
  chartsPricing: boolean;
  chartsResults: boolean;
  /** Ao comparar 2+ marketplaces: colunas lado a lado (com diferença) em vez de 1 linha por oferta. */
  compareEnginesSideBySide: boolean;
  /** Agrupa ofertas do mesmo SKU numa linha só, com as ofertas individuais recolhidas embaixo. */
  groupOffersBySku: boolean;

  // --- Preferências opcionais (tela Conta) ---
  onlyOwnKey: boolean;
  warnAt80PercentQuota: boolean;
  reuseRecentResult: boolean;
  notifyOnSearchComplete: boolean;
  retainHistory90Days: boolean;
}

export const DEFAULT_PREFERENCES: UserPreferences = {
  themeMode: "dark",
  accent: "aco",
  fontSize: "standard",

  chartsPricing: true,
  chartsResults: true,
  compareEnginesSideBySide: false,
  // Default true (set/2026, pedido explícito do usuário: "deixa igual
  // antes" — mesmo produto em 2 lojas aparecia numa linha só, com o
  // mini-expandir pra ver a segunda oferta). Antes vinha desligado por
  // padrão — usuário só via isso se soubesse que a opção existia em
  // Conta → Configurações.
  groupOffersBySku: true,

  onlyOwnKey: false,
  warnAt80PercentQuota: true,
  reuseRecentResult: true,
  notifyOnSearchComplete: false,
  retainHistory90Days: true,
};

const STORAGE_KEY = "arbitra:preferences";
const SUBCOLLECTION = "preferences";
const DOC_ID = "config";

function loadFromLocalStorage(): UserPreferences {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return DEFAULT_PREFERENCES;
    return { ...DEFAULT_PREFERENCES, ...JSON.parse(raw) } as UserPreferences;
  } catch {
    return DEFAULT_PREFERENCES;
  }
}

export async function loadUserPreferences(userId: string | null): Promise<UserPreferences> {
  if (userId && firebaseConfigured) {
    try {
      const db = await getFirebaseDb();
      const { doc, getDoc } = await import("firebase/firestore");
      const snap = await getDoc(doc(db, "users", userId, SUBCOLLECTION, DOC_ID));
      if (snap.exists()) {
        return { ...DEFAULT_PREFERENCES, ...(snap.data() as Partial<UserPreferences>) };
      }
      return DEFAULT_PREFERENCES;
    } catch (err) {
      console.warn("Firestore indisponível, usando preferências do localStorage:", err);
    }
  }

  return loadFromLocalStorage();
}

/**
 * Salva o conjunto inteiro de preferências (merge parcial — quem chama
 * já resolveu o objeto completo, ver `updatePreferences` nos componentes
 * de Configurações). Grava sempre em localStorage também, mesmo com
 * usuário logado: garante aplicação instantânea no próximo load antes do
 * Firestore responder (evita "flash" de tema errado).
 */
export async function saveUserPreferences(
  userId: string | null,
  prefs: UserPreferences
): Promise<void> {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(prefs));

  if (userId && firebaseConfigured) {
    try {
      const db = await getFirebaseDb();
      const { doc, setDoc } = await import("firebase/firestore");
      await setDoc(doc(db, "users", userId, SUBCOLLECTION, DOC_ID), prefs);
    } catch (err) {
      console.warn("Firestore indisponível, preferências ficaram só no localStorage:", err);
    }
  }
}
