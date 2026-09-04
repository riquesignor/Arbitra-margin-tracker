import type { ApiRequest, ApiResponse } from "./_lib/httpTypes.js";
import { getAdminDb } from "./_lib/firestoreAdmin.js";

const SUBCOLLECTION = "catalog_images";
/** Ver IMAGE_INDEX_COLLECTION em src/lib/catalogImages.ts — `imageId -> { uid, expiresAt }`. */
const IMAGE_INDEX_COLLECTION = "catalog_image_index";

/**
 * GET /api/catalog-image?uid=xxx&id=yyy
 * Serve, com o Content-Type certo, uma imagem previamente salva em
 * `users/{uid}/catalog_images/{id}` (ver src/lib/catalogImages.ts e
 * ADR-0003 — subcoleção por usuário, não mais coleção de nível
 * superior). Existe só porque o Google Lens (SerpApi) exige uma URL
 * pública de imagem, não aceita upload direto (ver
 * googleLensProvider.ts). Não tem autenticação de propósito: o Google
 * Lens crawler não manda Authorization header nenhum. O "segredo"
 * continua sendo o `id` (doc id do Firestore, não sequencial, não
 * adivinhável por força bruta) e o TTL (30 dias, verificado abaixo — ver
 * src/lib/catalogImages.ts); o `uid` só existe aqui porque o Admin SDK
 * precisa do path completo pra buscar um doc de subcoleção — não reduz
 * nem reforça a segurança do endpoint.
 */
export default async function handler(req: ApiRequest, res: ApiResponse): Promise<void> {
  if (req.method !== "GET") {
    res.status(405).json({ error: "Método não permitido" });
    return;
  }

  const idParam = req.query?.id;
  const id = Array.isArray(idParam) ? idParam[0] : idParam;
  const uidParam = req.query?.uid;
  const legacyUid = Array.isArray(uidParam) ? uidParam[0] : uidParam;
  if (!id) {
    res.status(400).json({ error: "Parâmetro id ausente" });
    return;
  }

  try {
    const db = getAdminDb();

    // `?uid=` só existe pra URL ANTIGA (set/2026 — ver
    // docs/auditoria-2026-09.md > P1-6): a URL nova manda só o `id`, e o
    // dono é resolvido pelo índice `catalog_image_index/{id}`, pra não
    // entregar o identificador do usuário à SerpApi/SearchApi.io junto
    // com a foto. URLs antigas seguem funcionando até expirarem (30 dias).
    let uid = legacyUid;
    if (!uid) {
      const indexSnap = await db.collection(IMAGE_INDEX_COLLECTION).doc(id).get();
      const indexData = indexSnap.data();
      if (!indexData || typeof indexData.expiresAt !== "number" || indexData.expiresAt <= Date.now()) {
        res.status(404).json({ error: "Imagem não encontrada ou expirada" });
        return;
      }
      uid = indexData.uid as string;
    }

    const snap = await db.collection("users").doc(uid).collection(SUBCOLLECTION).doc(id).get();
    const data = snap.data();

    if (!data || typeof data.expiresAt !== "number" || data.expiresAt <= Date.now()) {
      res.status(404).json({ error: "Imagem não encontrada ou expirada" });
      return;
    }

    const buffer = Buffer.from(data.base64 as string, "base64");
    res.setHeader("Content-Type", (data.contentType as string) || "image/jpeg");
    res.setHeader("Cache-Control", "public, max-age=3600");
    res.send(buffer);
  } catch (err) {
    res.status(502).json({
      error: "Falha ao servir imagem",
      detail: err instanceof Error ? err.message : String(err),
    });
  }
}
