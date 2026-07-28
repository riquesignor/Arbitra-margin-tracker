import type { FirebaseApp } from "firebase/app";
import type { Auth } from "firebase/auth";
import type { Firestore } from "firebase/firestore";

const firebaseConfig = {
  apiKey: import.meta.env.VITE_FIREBASE_API_KEY,
  authDomain: import.meta.env.VITE_FIREBASE_AUTH_DOMAIN,
  projectId: import.meta.env.VITE_FIREBASE_PROJECT_ID,
};

export const firebaseConfigured = Boolean(firebaseConfig.apiKey);

/**
 * Import dinâmico de "firebase/*": só baixa o SDK (client) quando alguém
 * de fato loga ou acessa Firestore — quem nunca usa Conta não paga esse
 * peso no bundle inicial. `firebaseConfigured` é o único gate: se não
 * houver env vars, nenhuma dessas funções é chamada (ver auth.ts /
 * pricingRulesStore.ts).
 */
let appPromise: Promise<FirebaseApp> | null = null;
function getApp(): Promise<FirebaseApp> {
  if (!appPromise) {
    appPromise = import("firebase/app").then(({ initializeApp, getApps }) =>
      getApps().length > 0 ? getApps()[0] : initializeApp(firebaseConfig)
    );
  }
  return appPromise;
}

let authPromise: Promise<Auth> | null = null;
export function getFirebaseAuth(): Promise<Auth> {
  if (!firebaseConfigured) {
    return Promise.reject(new Error("Firebase não configurado (VITE_FIREBASE_* ausente)"));
  }
  if (!authPromise) {
    authPromise = Promise.all([getApp(), import("firebase/auth")]).then(([app, { getAuth }]) =>
      getAuth(app)
    );
  }
  return authPromise;
}

let dbPromise: Promise<Firestore> | null = null;
export function getFirebaseDb(): Promise<Firestore> {
  if (!firebaseConfigured) {
    return Promise.reject(new Error("Firebase não configurado (VITE_FIREBASE_* ausente)"));
  }
  if (!dbPromise) {
    dbPromise = Promise.all([getApp(), import("firebase/firestore")]).then(
      ([app, { getFirestore }]) => getFirestore(app)
    );
  }
  return dbPromise;
}
