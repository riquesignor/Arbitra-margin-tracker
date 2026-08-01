import { getAdminDb } from "./firestoreAdmin.js";

const REFRESH_BUFFER_MS = 60_000;

interface MlTokenDoc {
  accessToken: string;
  accessTokenExpiresAt: number;
  refreshToken: string;
  updatedAt: number;
}

/**
 * Mantém o access_token do Mercado Livre válido, renovando via
 * refresh_token quando necessário.
 *
 * Por que Firestore e não variável de ambiente: o refresh_token do ML é
 * de uso único — cada renovação (`grant_type=refresh_token`) invalida o
 * anterior e devolve um novo. Uma env var é estática (não dá pra
 * sobrescrever em runtime) e memória de função serverless não sobrevive
 * entre invocações/cold starts — qualquer uma das duas quebraria na
 * segunda renovação. Firestore é o único estado realmente persistente
 * disponível aqui.
 *
 * ⚠️ Limitação conhecida: não há lock contra renovação concorrente. Se
 * duas invocações colidirem exatamente no mesmo milissegundo de
 * expiração, uma pode invalidar o refresh_token que a outra acabou de
 * usar. Baixa probabilidade no volume atual; se virar problema real, a
 * solução é uma transação Firestore (`runTransaction`) neste ponto.
 *
 * Setup inicial: `node scripts/ml-oauth-setup.mjs` (ver README) — gera o
 * primeiro par access/refresh token via OAuth e grava aqui.
 */
export async function getMlAccessToken(): Promise<string> {
  const db = getAdminDb();
  const ref = db.collection("ml_oauth").doc("tokens");
  const snap = await ref.get();

  if (!snap.exists) {
    throw new Error(
      "Mercado Livre OAuth não configurado. Rode `node scripts/ml-oauth-setup.mjs` (ver README) " +
        "pra autorizar o app e gravar o token inicial no Firestore."
    );
  }

  const data = snap.data() as MlTokenDoc;
  const now = Date.now();

  if (data.accessTokenExpiresAt > now + REFRESH_BUFFER_MS) {
    return data.accessToken;
  }

  const clientId = process.env.ML_CLIENT_ID;
  const clientSecret = process.env.ML_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    throw new Error("ML_CLIENT_ID / ML_CLIENT_SECRET ausentes no ambiente do servidor.");
  }

  const resp = await fetch("https://api.mercadolibre.com/oauth/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      client_id: clientId,
      client_secret: clientSecret,
      refresh_token: data.refreshToken,
    }),
  });

  if (!resp.ok) {
    const body = await resp.text();
    throw new Error(`Falha ao renovar token Mercado Livre (${resp.status}): ${body}`);
  }

  const json = (await resp.json()) as {
    access_token: string;
    refresh_token: string;
    expires_in: number;
  };

  const updated: MlTokenDoc = {
    accessToken: json.access_token,
    accessTokenExpiresAt: now + json.expires_in * 1000,
    refreshToken: json.refresh_token,
    updatedAt: now,
  };

  await ref.set(updated);
  return updated.accessToken;
}
