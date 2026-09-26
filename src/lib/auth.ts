import type { User } from "firebase/auth";
import { firebaseConfigured, getFirebaseAuth } from "./firebase";

export interface AuthUser {
  uid: string;
  email: string | null;
  /**
   * Login por email/senha só conta como confirmado depois que o usuário
   * clica no link enviado por `sendEmailVerification` (ver signUp). Contas
   * Google chegam aqui sempre `true` — o Google já garante a posse do
   * email, não faz sentido pedir confirmação de novo.
   */
  emailVerified: boolean;
  /**
   * `false` pra contas que só logaram via Google (sem senha cadastrada no
   * Firebase Auth). Usado pra esconder "trocar senha" e pra reautenticar
   * pelo provider certo em changeEmail/deleteAccount (ver reauthenticate).
   */
  hasPassword: boolean;
}

function toAuthUser(user: User): AuthUser {
  return {
    uid: user.uid,
    email: user.email,
    emailVerified: user.emailVerified,
    hasPassword: user.providerData.some((p) => p.providerId === "password"),
  };
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

/**
 * Cria a conta e já dispara o email de confirmação (link, não código —
 * `sendEmailVerification` é o recurso nativo do Firebase; não existe
 * equivalente de código numérico pronto). Falha ao ENVIAR o email não
 * derruba o cadastro (a conta já foi criada no passo anterior) — só loga
 * um warning; o usuário ainda pode pedir reenvio depois (ver
 * resendVerificationEmail) na tela de "confirme seu email".
 */
export async function signUp(email: string, password: string): Promise<void> {
  const auth = await getFirebaseAuth();
  const { createUserWithEmailAndPassword, sendEmailVerification } = await import("firebase/auth");
  const credential = await createUserWithEmailAndPassword(auth, email, password);
  try {
    await sendEmailVerification(credential.user);
  } catch (err) {
    console.warn("Conta criada, mas falhou o envio do email de confirmação:", err);
  }
}

export async function signIn(email: string, password: string): Promise<void> {
  const auth = await getFirebaseAuth();
  const { signInWithEmailAndPassword } = await import("firebase/auth");
  await signInWithEmailAndPassword(auth, email, password);
}

/**
 * Login com Google (popup). Conta é criada automaticamente no primeiro
 * login (mesmo fluxo do Firebase pra email/senha) — `ensureUserProfile`
 * (chamado em App.tsx) cria o doc de perfil igual. Google já garante que o
 * email pertence a quem está logando, então essas contas nascem com
 * `emailVerified: true` — não passam pelo gate de confirmação.
 */
export async function signInWithGoogle(): Promise<void> {
  const auth = await getFirebaseAuth();
  const { GoogleAuthProvider, signInWithPopup } = await import("firebase/auth");
  await signInWithPopup(auth, new GoogleAuthProvider());
}

/** Reenvia o email de confirmação (tela de "confirme seu email"). */
export async function resendVerificationEmail(): Promise<void> {
  const auth = await getFirebaseAuth();
  const user = auth.currentUser;
  if (!user) throw new Error("Nenhum usuário logado.");
  const { sendEmailVerification } = await import("firebase/auth");
  await sendEmailVerification(user);
}

/**
 * `onAuthStateChanged` não dispara de novo só porque o usuário confirmou o
 * email numa outra aba/link — o objeto `User` em memória fica desatualizado
 * até alguém chamar `reload()`. Usado pelo botão "já confirmei" da tela de
 * gate: recarrega o usuário do servidor e devolve o `AuthUser` atualizado
 * pra quem chamou atualizar o state (ver App.tsx).
 */
export async function refreshEmailVerified(): Promise<AuthUser | null> {
  const auth = await getFirebaseAuth();
  const user = auth.currentUser;
  if (!user) return null;
  const { reload } = await import("firebase/auth");
  await reload(user);
  return toAuthUser(user);
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
 * Reautentica — pré-requisito do Firebase Auth pras 3 operações sensíveis
 * abaixo (trocar senha, trocar email, excluir conta): todas exigem login
 * "recente". Desde que login com Google existe (ver signInWithGoogle),
 * nem toda conta tem senha — `currentPassword` só é usado (e obrigatório)
 * pra contas com provider `password`; contas Google reautenticam com um
 * novo popup do Google, e `currentPassword` é ignorado.
 */
async function reauthenticate(currentPassword?: string): Promise<void> {
  const auth = await getFirebaseAuth();
  const user = auth.currentUser;
  if (!user) throw new Error("Nenhum usuário logado.");
  const hasPasswordProvider = user.providerData.some((p) => p.providerId === "password");
  if (hasPasswordProvider) {
    if (!user.email || !currentPassword) throw new Error("Informe a senha atual.");
    const { EmailAuthProvider, reauthenticateWithCredential } = await import("firebase/auth");
    const credential = EmailAuthProvider.credential(user.email, currentPassword);
    await reauthenticateWithCredential(user, credential);
    return;
  }
  const { GoogleAuthProvider, reauthenticateWithPopup } = await import("firebase/auth");
  await reauthenticateWithPopup(user, new GoogleAuthProvider());
}

/**
 * Configurações → Dados da conta: trocar senha (exige a senha atual).
 * Só se aplica a contas com provider `password` — a UI (Settings.tsx)
 * esconde essa opção pra contas só-Google, que não têm senha nenhuma.
 */
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
 * depois do próximo login. `currentPassword` fica de fora pra contas
 * Google (reauthenticate reautentica por popup nesse caso).
 */
export async function changeEmail(currentPassword: string | undefined, newEmail: string): Promise<void> {
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
export async function deleteAccount(currentPassword?: string): Promise<void> {
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
