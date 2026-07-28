import type { PlanId } from "../types";
import { DEFAULT_PLAN_ID } from "../config/plans";
import { firebaseConfigured, getFirebaseDb } from "./firebase";

const COLLECTION = "users";

export interface UserProfile {
  uid: string;
  email: string | null;
  plan: PlanId;
  isAdmin: boolean;
  createdAt: number;
}

function fallbackProfile(uid: string, email: string | null): UserProfile {
  return { uid, email, plan: DEFAULT_PLAN_ID, isAdmin: false, createdAt: Date.now() };
}

/**
 * Busca o perfil (`users/{uid}`) e cria com o plano padrão no primeiro
 * login/cadastro — inclusive pra contas que já existiam antes desse
 * recurso existir (login antigo sem doc em `users`). Sem Firebase
 * configurado ou em caso de erro: perfil "fallback" em memória, plano
 * Iniciante, nunca admin — nunca trava o app, só perde a persistência.
 */
export async function ensureUserProfile(uid: string, email: string | null): Promise<UserProfile> {
  if (!firebaseConfigured) return fallbackProfile(uid, email);

  try {
    const db = await getFirebaseDb();
    const { doc, getDoc, setDoc } = await import("firebase/firestore");
    const ref = doc(db, COLLECTION, uid);
    const snap = await getDoc(ref);

    if (snap.exists()) {
      const data = snap.data() as Partial<UserProfile>;
      return {
        uid,
        email,
        plan: data.plan ?? DEFAULT_PLAN_ID,
        isAdmin: data.isAdmin ?? false,
        createdAt: data.createdAt ?? Date.now(),
      };
    }

    const created = fallbackProfile(uid, email);
    await setDoc(ref, {
      email: created.email,
      plan: created.plan,
      isAdmin: created.isAdmin,
      createdAt: created.createdAt,
    });
    return created;
  } catch (err) {
    console.warn("Não consegui carregar/criar perfil do usuário (seguindo com plano padrão):", err);
    return fallbackProfile(uid, email);
  }
}

/**
 * Lista todos os usuários — só funciona pra quem é admin (ver
 * firestore.rules: `users` permite `read` de todos os docs quando
 * `request.auth.uid` corresponde a um doc com `isAdmin == true`).
 */
export async function listAllUsers(): Promise<UserProfile[]> {
  if (!firebaseConfigured) return [];

  try {
    const db = await getFirebaseDb();
    const { collection, getDocs } = await import("firebase/firestore");
    const snap = await getDocs(collection(db, COLLECTION));

    return snap.docs
      .map((d) => {
        const data = d.data() as Partial<UserProfile>;
        return {
          uid: d.id,
          email: data.email ?? null,
          plan: data.plan ?? DEFAULT_PLAN_ID,
          isAdmin: data.isAdmin ?? false,
          createdAt: data.createdAt ?? 0,
        };
      })
      .sort((a, b) => (a.email ?? "").localeCompare(b.email ?? ""));
  } catch (err) {
    console.warn("Não consegui listar usuários (precisa ser admin):", err);
    return [];
  }
}

export async function updateUserPlan(uid: string, plan: PlanId): Promise<void> {
  const db = await getFirebaseDb();
  const { doc, setDoc } = await import("firebase/firestore");
  await setDoc(doc(db, COLLECTION, uid), { plan }, { merge: true });
}

export async function updateUserAdmin(uid: string, isAdmin: boolean): Promise<void> {
  const db = await getFirebaseDb();
  const { doc, setDoc } = await import("firebase/firestore");
  await setDoc(doc(db, COLLECTION, uid), { isAdmin }, { merge: true });
}
