import { getAuth } from "firebase-admin/auth";
import type { ApiRequest, ApiResponse } from "./_lib/httpTypes.js";
import { requireAuth, UnauthorizedError } from "./_lib/verifyAuth.js";
import { getAdminApp, getAdminDb } from "./_lib/firestoreAdmin.js";
import { createPreapproval } from "./_lib/mercadoPago.js";

/**
 * Cria (ou recria) a assinatura recorrente do usuário logado no Mercado
 * Pago e devolve a URL de checkout hospedada (`initPoint`) — o front-end
 * (Settings.tsx > PagamentoSection) só faz
 * `window.location.href = initPoint`. Nenhum dado de cartão passa pelo
 * Arbitra (ver mercadoPago.ts).
 *
 * MVP: sempre cria um preapproval NOVO. Se o usuário já tinha um pendente
 * de checkout anterior abandonado, fica órfão no Mercado Pago (não é
 * cobrado — preapproval "pending" nunca vira cobrança sozinho) — aceitável
 * pro MVP, mas se virar ruído vale registrar `mpPreapprovalId` anterior e
 * cancelar antes de criar o novo (endpoint `PUT /preapproval/{id}` com
 * `status: "cancelled"`).
 */
export default async function handler(req: ApiRequest, res: ApiResponse): Promise<void> {
  if (req.method !== "POST") {
    res.status(405).json({ error: "Método não permitido" });
    return;
  }

  let uid: string;
  try {
    uid = await requireAuth(req);
  } catch (err) {
    if (err instanceof UnauthorizedError) {
      res.status(401).json({ error: err.message });
      return;
    }
    throw err;
  }

  try {
    const authUser = await getAuth(getAdminApp()).getUser(uid);
    const payerEmail = authUser.email ?? undefined;

    const preapproval = await createPreapproval({ uid, payerEmail });

    // Admin SDK ignora firestore.rules — pode escrever campos que o
    // client não teria permissão de escrever direto (ver firestore.rules,
    // `match /users/{userId} > allow update`, hasOnly das flags has*ApiKey).
    await getAdminDb()
      .collection("users")
      .doc(uid)
      .set(
        {
          mpPreapprovalId: preapproval.id,
          mpSubscriptionStatus: preapproval.status,
          mpSubscriptionUpdatedAt: Date.now(),
        },
        { merge: true }
      );

    res.status(200).json({ initPoint: preapproval.initPoint, preapprovalId: preapproval.id });
  } catch (err) {
    res.status(502).json({
      error: "Não consegui criar a assinatura no Mercado Pago",
      detail: err instanceof Error ? err.message : String(err),
    });
  }
}
