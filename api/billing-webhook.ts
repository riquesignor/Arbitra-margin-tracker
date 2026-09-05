import type { ApiRequest, ApiResponse } from "./_lib/httpTypes.js";
import { getAdminDb } from "./_lib/firestoreAdmin.js";
import { getPreapproval, isActiveSubscriptionStatus, verifyWebhookSignature } from "./_lib/mercadoPago.js";

/** Plano atribuído automaticamente enquanto a assinatura estiver ativa — sobrescrevível sem deploy. */
function getPaidPlanId(): string {
  return process.env.MERCADOPAGO_PAID_PLAN_ID ?? "pro";
}

interface WebhookBody {
  type?: string;
  action?: string;
  data?: { id?: string };
}

function firstHeader(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

/**
 * Notificação webhook do Mercado Pago (configurar em: painel MP > Sua
 * integração > Webhooks, evento "Assinaturas" apontando pra
 * `<APP_BASE_URL>/api/billing-webhook`). NÃO exige `requireAuth` — quem
 * chama é o Mercado Pago, não um usuário logado — a autenticidade vem da
 * assinatura HMAC (`verifyWebhookSignature`), não de um Firebase ID Token.
 *
 * ⚠️ Sem verificação/teste em ambiente real nesta sessão (sem acesso a
 * build/sandbox) — o formato de `x-signature` segue a documentação
 * pública do Mercado Pago; confirme no Simulador de Webhooks deles antes
 * de expor em produção.
 */
export default async function handler(req: ApiRequest, res: ApiResponse): Promise<void> {
  if (req.method !== "POST") {
    res.status(405).json({ error: "Método não permitido" });
    return;
  }

  const body = (req.body ?? {}) as WebhookBody;
  const dataId = body.data?.id;

  // Mercado Pago manda eventos de teste/outros tipos (ex.: "payment") no
  // mesmo endpoint se configurado amplo demais — ignoramos silenciosamente
  // o que não for assinatura, mas sempre com 200 (retry desnecessário do
  // lado deles se responder erro pra evento que não nos interessa).
  if (body.type !== "subscription_preapproval" || !dataId) {
    res.status(200).json({ ignored: true });
    return;
  }

  const signatureHeader = firstHeader(req.headers?.["x-signature"]);
  const requestId = firstHeader(req.headers?.["x-request-id"]);
  const validSignature = verifyWebhookSignature({ signatureHeader, requestId, dataId });
  if (!validSignature) {
    res.status(401).json({ error: "Assinatura do webhook inválida" });
    return;
  }

  try {
    // Não confiamos em nenhum campo do BODY além do id — o status
    // "de verdade" vem de uma consulta autenticada à API do Mercado Pago,
    // nunca do que a notificação alega ter acontecido.
    const details = await getPreapproval(dataId);
    const uid = details.externalReference;
    if (!uid) {
      res.status(200).json({ warning: "preapproval sem external_reference — não sei a qual usuário associar" });
      return;
    }

    const plan = isActiveSubscriptionStatus(details.status) ? getPaidPlanId() : "free";

    await getAdminDb()
      .collection("users")
      .doc(uid)
      .set(
        {
          plan,
          mpPreapprovalId: details.id,
          mpSubscriptionStatus: details.status,
          mpSubscriptionUpdatedAt: Date.now(),
        },
        { merge: true }
      );

    res.status(200).json({ ok: true, uid, plan, status: details.status });
  } catch (err) {
    // 502, não 200: queremos que o Mercado Pago RETENTE se a nossa
    // consulta/gravação falhar por instabilidade transitória.
    res.status(502).json({
      error: "Falha ao processar notificação de assinatura",
      detail: err instanceof Error ? err.message : String(err),
    });
  }
}
