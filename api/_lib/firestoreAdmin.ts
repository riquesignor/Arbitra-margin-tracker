import { cert, getApps, initializeApp, type App } from "firebase-admin/app";
import { getFirestore, type Firestore } from "firebase-admin/firestore";

let app: App | null = null;

/**
 * Singleton — Edge/Serverless Functions podem reusar a mesma instância
 * entre invocações "quentes" (mesmo container). `getApps()` evita
 * "app already exists" em hot reload/dev.
 */
export function getAdminApp(): App {
  if (app) return app;

  const existing = getApps();
  if (existing.length > 0) {
    app = existing[0];
    return app;
  }

  const projectId = process.env.FIREBASE_PROJECT_ID;
  const clientEmail = process.env.FIREBASE_CLIENT_EMAIL;
  // .env guarda quebras de linha como "\n" literal — precisa converter de volta.
  const privateKey = process.env.FIREBASE_PRIVATE_KEY?.replace(/\\n/g, "\n");

  if (!projectId || !clientEmail || !privateKey) {
    throw new Error(
      "Credenciais Firebase Admin ausentes (FIREBASE_PROJECT_ID / FIREBASE_CLIENT_EMAIL / FIREBASE_PRIVATE_KEY)"
    );
  }

  app = initializeApp({ credential: cert({ projectId, clientEmail, privateKey }) });
  return app;
}

let db: Firestore | null = null;

/**
 * `db.settings({ ignoreUndefinedProperties: true })` — mesmo motivo do
 * lado client (ver src/lib/firebase.ts): sem isso, `writeCachedPrices`
 * (cache.ts) falha em silêncio sempre que um `MarketplacePriceResult`
 * tem `link`/`matchedTitle`/`imageUrl` valendo `undefined` (comum — nem
 * todo item encontrado tem os três). `settings()` só pode ser chamado
 * UMA VEZ por instância, antes de qualquer leitura/escrita — por isso o
 * singleton `db` aqui (sem ele, cada chamada a `getFirestore()` devolve
 * a mesma instância cacheada pelo SDK, e a segunda chamada a `settings()`
 * nela lançaria "Firestore has already been initialized").
 */
export function getAdminDb(): Firestore {
  if (!db) {
    db = getFirestore(getAdminApp());
    db.settings({ ignoreUndefinedProperties: true });
  }
  return db;
}
