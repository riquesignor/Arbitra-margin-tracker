#!/usr/bin/env node
/**
 * Setup único do OAuth do Mercado Livre. Roda localmente (nunca em
 * produção): faz o fluxo Authorization Code uma vez com a sua conta de
 * vendedor ML e grava o access_token/refresh_token direto no Firestore
 * (`ml_oauth/tokens`), de onde `api/_lib/mlAuth.ts` os lê e renova
 * automaticamente depois.
 *
 * Pré-requisitos (ver README):
 *   1. Criar um app em https://developers.mercadolivre.com.br/devcenter
 *      (gratuito) e anotar Client ID / Secret Key.
 *   2. Definir uma Redirect URI no app (qualquer URL https válida — não
 *      precisa responder nada, você só vai copiar o "code" da barra de
 *      endereço depois do redirect).
 *   3. Preencher no .env: ML_CLIENT_ID, ML_CLIENT_SECRET, ML_REDIRECT_URI
 *      (além das credenciais Firebase Admin que já devem estar lá).
 *
 * Uso:
 *   node --env-file=.env scripts/ml-oauth-setup.mjs
 *   (Node 20.6+ tem --env-file nativo; sem isso, exporte as vars manualmente)
 */

import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { cert, initializeApp } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";

const CLIENT_ID = process.env.ML_CLIENT_ID;
const CLIENT_SECRET = process.env.ML_CLIENT_SECRET;
const REDIRECT_URI = process.env.ML_REDIRECT_URI;

const FIREBASE_PROJECT_ID = process.env.FIREBASE_PROJECT_ID;
const FIREBASE_CLIENT_EMAIL = process.env.FIREBASE_CLIENT_EMAIL;
const FIREBASE_PRIVATE_KEY = process.env.FIREBASE_PRIVATE_KEY?.replace(/\\n/g, "\n");

function requireEnv(name, value) {
  if (!value) {
    console.error(`Faltando ${name} no ambiente. Preencha o .env e rode de novo.`);
    process.exit(1);
  }
}

requireEnv("ML_CLIENT_ID", CLIENT_ID);
requireEnv("ML_CLIENT_SECRET", CLIENT_SECRET);
requireEnv("ML_REDIRECT_URI", REDIRECT_URI);
requireEnv("FIREBASE_PROJECT_ID", FIREBASE_PROJECT_ID);
requireEnv("FIREBASE_CLIENT_EMAIL", FIREBASE_CLIENT_EMAIL);
requireEnv("FIREBASE_PRIVATE_KEY", FIREBASE_PRIVATE_KEY);

const authorizeUrl =
  `https://auth.mercadolivre.com.br/authorization?response_type=code` +
  `&client_id=${encodeURIComponent(CLIENT_ID)}` +
  `&redirect_uri=${encodeURIComponent(REDIRECT_URI)}`;

console.log("\n1. Abra esta URL no navegador (logado com a conta de vendedor ML):\n");
console.log(authorizeUrl);
console.log(
  "\n2. Faça login/autorize. Você será redirecionado pra sua Redirect URI com" +
    ' "?code=TG-..." na barra de endereço — não importa se a página carrega ou dá 404,' +
    " só copie o valor do parâmetro code.\n"
);

const rl = createInterface({ input: stdin, output: stdout });
const code = (await rl.question("3. Cole aqui o code: ")).trim();
rl.close();

if (!code) {
  console.error("Nenhum code informado. Abortando.");
  process.exit(1);
}

console.log("\nTrocando code por access_token/refresh_token...");

const tokenResp = await fetch("https://api.mercadolibre.com/oauth/token", {
  method: "POST",
  headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
  body: new URLSearchParams({
    grant_type: "authorization_code",
    client_id: CLIENT_ID,
    client_secret: CLIENT_SECRET,
    code,
    redirect_uri: REDIRECT_URI,
  }),
});

if (!tokenResp.ok) {
  const body = await tokenResp.text();
  console.error(`Falha na troca de token (${tokenResp.status}):\n${body}`);
  process.exit(1);
}

const tokenJson = await tokenResp.json();
const now = Date.now();

console.log("\nToken obtido. Gravando no Firestore (ml_oauth/tokens)...");

const app = initializeApp({
  credential: cert({
    projectId: FIREBASE_PROJECT_ID,
    clientEmail: FIREBASE_CLIENT_EMAIL,
    privateKey: FIREBASE_PRIVATE_KEY,
  }),
});
const db = getFirestore(app);

await db
  .collection("ml_oauth")
  .doc("tokens")
  .set({
    accessToken: tokenJson.access_token,
    accessTokenExpiresAt: now + tokenJson.expires_in * 1000,
    refreshToken: tokenJson.refresh_token,
    updatedAt: now,
  });

console.log(
  "\nPronto. `api/_lib/mlAuth.ts` já vai renovar esse token sozinho a partir de agora " +
    "(rode `vercel dev` ou deploy pra usar). Esse script não precisa rodar de novo, " +
    "a menos que o refresh_token seja revogado manualmente no painel do Mercado Livre."
);
process.exit(0);

