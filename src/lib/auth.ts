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

/**
 * Reautentica com email/senha atual — pré-requisito do Firebase Auth
 * pras 3 operações sensíveis abaixo (trocar senha, trocar email, excluir
 * conta): todas exigem login "recente", e como o app só tem login por
 * email/senha (ver signIn/signUp acima), reautenticar é sempre isto.
 */
async function reauthenticate(currentPassword: string): Promise<void> {
  const auth = await getFirebaseAuth();
  const user = auth.currentUser;
  if (!user?.email) throw new Error("Nenhum usuário logado.");
  const { EmailAuthProvider, reauthenticateWithCredential } = await import("firebase/auth");
  const credential = EmailAuthProvider.credential(user.email, currentPassword);
  await reauthenticateWithCredential(user, credential);
}

/** Configurações → Dados da conta: trocar senha (exige a senha atual). */
export async function changePassword(currentPassword: string, newPassword: string): Promise<void> {
  await reauthenticate(currentPassword);
  const auth = await getFirebaseAuth();
  const { updatePassword } = await import("firebase/auth");
  await updatePassword(auth.currentUser!, newPassword);
}

/**
 * Configurações → Dados da conta: trocar email. Usa
 * `verifyBeforeUpdateEmail` (recomendação atual do Firebase) — o email
 * só muda de fato depois que o usuário confirma pelo link enviado pro
 * ENDEREÇO NOVO, não troca na hora. `AuthUser.email` só reflete a troca
 * depois do próximo login.
 */
export async function changeEmail(currentPassword: string, newEmail: string): Promise<void> {
  await reauthenticate(currentPassword);
  const auth = await getFirebaseAuth();
  const { verifyBeforeUpdateEmail } = await import("firebase/auth");
  await verifyBeforeUpdateEmail(auth.currentUser!, newEmail);
}

/**
 * Configurações → Dados da conta: excluir conta. Apaga o doc de perfil
 * (`users/{uid}`) antes de excluir o login — best-effort (a regra
 * permite `isOwner` deletar, ver firestore.rules); subcoleções
 * (secrets/pricing_rules/preferences/etc.) ficam órfãs (Firestore não
 * cascade-deleta), aceitável pro MVP sem Cloud Function de limpeza.
 */
export async function deleteAccount(currentPassword: string): Promise<void> {
  await reauthenticate(currentPassword);
  const auth = await getFirebaseAuth();
  const user = auth.currentUser!;
  try {
    const { getFirebaseDb } = await import("./firebase");
    const db = await getFirebaseDb();
    const { doc, deleteDoc } = await import("firebase/firestore");
    await deleteDoc(doc(db, "users", user.uid));
  } catch (err) {
    console.warn("Não consegui apagar o doc de perfil antes de excluir a conta (seguindo mesmo assim):", err);
  }
  const { deleteUser } = await import("firebase/auth");
  await deleteUser(user);
}
