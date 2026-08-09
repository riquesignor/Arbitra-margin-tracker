import type { PricingRules } from "../types";
import { DEFAULT_PRICING_RULES } from "./marginCalculator";
import { firebaseConfigured, getFirebaseDb } from "./firebase";

const STORAGE_KEY = "arbitra:pricing_rules";
// Subcoleção de `users/{userId}` (ver ADR-0003) — doc único
// `users/{userId}/pricing_rules/config`. Antes era uma coleção de nível
// superior `pricing_rules/{userId}` (1:1); só o path muda.
const SUBCOLLECTION = "pricing_rules";
const DOC_ID = "config";

/**
 * `{ ...DEFAULT, ...saved }` é merge RASO — `marketplaceFees` é array,
 * então "saved" (se existir) substitui o array padrão inteiro, não
 * mescla item a item. Sem isso, uma taxa nova adicionada em
 * `DEFAULT_PRICING_RULES` (ex: "ads") nunca apareceria pra quem já tem
 * regras salvas de antes — só pra conta nova. Aqui completa por `id`:
 * mantém 100% da customização do usuário nas taxas que ele já tinha, só
 * acrescenta as que faltam.
 */
function mergeMissingFees(saved: PricingRules["marketplaceFees"] | undefined): PricingRules["marketplaceFees"] {
  const base = saved ?? [];
  const existingIds = new Set(base.map((f) => f.id));
  const missing = DEFAULT_PRICING_RULES.marketplaceFees.filter((f) => !existingIds.has(f.id));
  return missing.length > 0 ? [...base, ...missing] : base;
}

function loadFromLocalStorage(): PricingRules {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return DEFAULT_PRICING_RULES;
    const saved = JSON.parse(raw) as Partial<PricingRules>;
    return {
      ...DEFAULT_PRICING_RULES,
      ...saved,
      marketplaceFees: mergeMissingFees(saved.marketplaceFees),
    };
  } catch {
    return DEFAULT_PRICING_RULES;
  }
}

/**
 * userId + Firebase configurado → Firestore
 * (`users/{userId}/pricing_rules/config`, ver firestore.rules e
 * ADR-0003). Caso contrário, ou se o Firestore falhar (rede, regra de
 * segurança, banco não provisionado), cai pro localStorage — o usuário
 * nunca fica travado sem conseguir configurar preços.
 */
export async function loadPricingRules(userId: string | null): Promise<PricingRules> {
  if (userId && firebaseConfigured) {
    try {
      const db = await getFirebaseDb();
      const { doc, getDoc } = await import("firebase/firestore");
      const snap = await getDoc(doc(db, "users", userId, SUBCOLLECTION, DOC_ID));
      if (snap.exists()) {
        const saved = snap.data() as Partial<PricingRules>;
        return {
          ...DEFAULT_PRICING_RULES,
          ...saved,
          marketplaceFees: mergeMissingFees(saved.marketplaceFees),
        };
      }
      return DEFAULT_PRICING_RULES;
    } catch (err) {
      console.warn("Firestore indisponível, usando localStorage:", err);
    }
  }

  return loadFromLocalStorage();
}

export async function savePricingRules(userId: string | null, rules: PricingRules): Promise<void> {
  if (userId && firebaseConfigured) {
    try {
      const db = await getFirebaseDb();
      const { doc, setDoc } = await import("firebase/firestore");
      await setDoc(doc(db, "users", userId, SUBCOLLECTION, DOC_ID), rules);
      return;
    } catch (err) {
      console.warn("Firestore indisponível, salvando em localStorage:", err);
    }
  }

  localStorage.setItem(STORAGE_KEY, JSON.stringify(rules));
}
