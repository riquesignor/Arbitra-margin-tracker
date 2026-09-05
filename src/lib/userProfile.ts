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
  /**
   * Flag denormalizada — NUNCA a chave em si. `user_secrets/{uid}` não
   * tem (nem deve ter) override de admin na security rule, então não dá
   * pra saber "esse usuário tem chave?" lendo aquela coleção como admin.
   * `saveUserSerpApiKey`/`deleteUserSerpApiKey` (userSecrets.ts) mantêm
   * este campo em sincronia via writeBatch atômico sempre que a chave
   * muda. Ver ADR-0002, Action Item 1.
   */
  hasSerpApiKey?: boolean;
  /** Mesmo padrão de `hasSerpApiKey` acima, pra chave RapidAPI (Amazon direto). */
  hasRapidApiKey?: boolean;
  /**
   * Campos de billing (Mercado Pago, ver api/billing-create-subscription.ts
   * e api/billing-webhook.ts) — SÓ LEITURA no client. Quem escreve é
   * sempre o servidor via Admin SDK (ignora firestore.rules); a regra do
   * dono (`allow update`) nem lista esses campos no `hasOnly`, então uma
   * tentativa de setDoc client-side aqui seria recusada de qualquer jeito.
   */
  mpPreapprovalId?: string;
  mpSubscriptionStatus?: string;
  mpSubscriptionUpdatedAt?: number;
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
        hasSerpApiKey: data.hasSerpApiKey ?? false,
        hasRapidApiKey: data.hasRapidApiKey ?? false,
        mpPreapprovalId: data.mpPreapprovalId,
        mpSubscriptionStatus: data.mpSubscriptionStatus,
        mpSubscriptionUpdatedAt: data.mpSubscriptionUpdatedAt,
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
          hasSerpApiKey: data.hasSerpApiKey ?? false,
          hasRapidApiKey: data.hasRapidApiKey ?? false,
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
