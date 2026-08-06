import type { PricingRules } from "../types";
import { DEFAULT_PRICING_RULES } from "./marginCalculator";
import { firebaseConfigured, getFirebaseDb } from "./firebase";

const STORAGE_KEY = "arbitra:pricing_rules";
// Subcoleção de `users/{userId}` (ver ADR-0003) — doc único
// `users/{userId}/pricing_rules/config`. Antes era uma coleção de nível
// superior `pricing_rules/{userId}` (1:1); só o path muda.
const SUBCOLLECTION = "pricing_rules";
const DOC_ID = "config";

function loadFromLocalStorage(): PricingRules {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return DEFAULT_PRICING_RULES;
    return { ...DEFAULT_PRICING_RULES, ...JSON.parse(raw) } as PricingRules;
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
        return { ...DEFAULT_PRICING_RULES, ...(snap.data() as Partial<PricingRules>) };
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
