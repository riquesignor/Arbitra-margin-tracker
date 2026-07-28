import type { User } from "firebase/auth";
import { firebaseConfigured, getFirebaseAuth } from "./firebase";

export interface AuthUser {
  uid: string;
  email: string | null;
}

function toAuthUser(user: User): AuthUser {
  return { uid: user.uid, email: user.email };
}

/**
 * Sem Firebase configurado: chama callback(null) uma vez e retorna
 * unsubscribe no-op. Com Firebase: escuta onAuthStateChanged de verdade.
 */
export function subscribeToAuth(callback: (user: AuthUser | null) => void): () => void {
  if (!firebaseConfigured) {
    callback(null);
    return () => {};
  }

  let unsubscribe = () => {};
  let cancelled = false;

  getFirebaseAuth()
    .then(async (auth) => {
      if (cancelled) return;
      const { onAuthStateChanged } = await import("firebase/auth");
      unsubscribe = onAuthStateChanged(auth, (user) => callback(user ? toAuthUser(user) : null));
    })
    .catch(() => callback(null));

  return () => {
    cancelled = true;
    unsubscribe();
  };
}

export async function signUp(email: string, password: string): Promise<void> {
  const auth = await getFirebaseAuth();
  const { createUserWithEmailAndPassword } = await import("firebase/auth");
  await createUserWithEmailAndPassword(auth, email, password);
}

export async function signIn(email: string, password: string): Promise<void> {
  const auth = await getFirebaseAuth();
  const { signInWithEmailAndPassword } = await import("firebase/auth");
  await signInWithEmailAndPassword(auth, email, password);
}

export async function signOutUser(): Promise<void> {
  const auth = await getFirebaseAuth();
  const { signOut } = await import("firebase/auth");
  await signOut(auth);
}

/**
 * ID Token do usuário logado, pra autenticar chamadas a `/api/*` (ver
 * verifyAuth.ts no servidor). `null` sem Firebase configurado ou sem
 * usuário logado — quem chama decide o que fazer (hoje, priceApi.ts
 * simplesmente omite o header e deixa o servidor responder 401).
 */
export async function getCurrentIdToken(): Promise<string | null> {
  if (!firebaseConfigured) return null;
  try {
    const auth = await getFirebaseAuth();
    return (await auth.currentUser?.getIdToken()) ?? null;
  } catch (err) {
    console.warn("Não consegui obter o ID Token do usuário:", err);
    return null;
  }
}
