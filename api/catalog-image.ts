import type { ApiRequest, ApiResponse } from "./_lib/httpTypes.js";
import { getAdminDb } from "./_lib/firestoreAdmin.js";

const COLLECTION = "catalog_images";

/**
 * GET /api/catalog-image?id=xxx
 * Serve, com o Content-Type certo, uma imagem previamente salva em
 * `catalog_images/{id}` (ver src/lib/catalogImages.ts) — existe só
 * porque o Google Lens (SerpApi) exige uma URL pública de imagem, não
 * aceita upload direto (ver googleLensProvider.ts). Não tem
 * autenticação de propósito: o Google Lens crawler não manda
 * Authorization header nenhum. O "segredo" é o id ser um doc id do
 * Firestore (não sequencial, não adivinhável por força bruta) e o TTL
 * (2h, verificado abaixo) — não é um mecanismo de controle de acesso
 * forte, só o suficiente pro risco real (foto de produto de catálogo,
 * não é dado sensível).
 */
export default async function handler(req: ApiRequest, res: ApiResponse): Promise<void> {
  if (req.method !== "GET") {
    res.status(405).json({ error: "Método não permitido" });
    return;
  }

  const idParam = req.query?.id;
  const id = Array.isArray(idParam) ? idParam[0] : idParam;
  if (!id) {
    res.status(400).json({ error: "Parâmetro id ausente" });
    return;
  }

  try {
    const db = getAdminDb();
    const snap = await db.collection(COLLECTION).doc(id).get();
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
