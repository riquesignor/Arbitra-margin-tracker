import { firebaseConfigured, getFirebaseDb } from "./firebase";

const COLLECTION = "catalog_images";
// 30 dias — estendido a partir das 2h originais (mesmo TTL do cache de
// preço, market_prices) pra a foto continuar aparecendo na coluna de
// produto da tela de Resultados mesmo quando o usuário reabre um
// catálogo antigo do histórico, não só na busca recém-feita. Decisão
// consciente de trade-off: mais documentos base64 acumulados no
// Firestore (ver nota de limpeza abaixo), em troca de foto visível por
// muito mais tempo no histórico.
const TTL_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * Hospedagem TEMPORÁRIA de foto de produto — existe só pra dar uma URL
 * pública ao Google Lens (SerpApi), que exige `url` alcançável pela
 * internet, não aceita upload direto (ver comentário no topo de
 * googleLensProvider.ts). Guardada em Firestore (`catalog_images`), não
 * Firebase Storage: desde fev/2026 o Storage saiu do plano Spark de
 * vez, exigindo cartão vinculado (plano Blaze) mesmo dentro do limite
 * grátis — decisão explícita da fase de teste foi evitar isso.
 *
 * Trade-off documentado: sem Storage, ficamos limitados ao teto de 1MB
 * por doc do Firestore — por isso a compressão agressiva antes de
 * salvar (ver compressForUpload). Também não existe limpeza automática
 * dos docs expirados ainda (TTL é só verificado na leitura, em
 * catalog-image.ts, igual ao cache de preço) — pra um catálogo grande
 * processado várias vezes, isso acumula documentos "mortos" no
 * Firestore. Solução real de produção: configurar uma TTL policy nativa
 * do Firestore no campo `expiresAt` desta coleção (console ou
 * `gcloud firestore fields ttls update`), que apaga sozinho depois de
 * expirado — não precisa de Cloud Function nem de código aqui.
 */
export class CatalogImageError extends Error {}

/**
 * Redimensiona e comprime uma imagem (crop de linha do PDF, já um
 * `HTMLCanvasElement`) pra um JPEG pequeno o bastante pra caber num doc
 * Firestore com folga. 480px de largura já é mais que suficiente pro
 * Google Lens reconhecer o produto — não precisamos de resolução alta.
 */
async function compressForUpload(source: HTMLCanvasElement, maxWidth = 480): Promise<Blob> {
  const scale = Math.min(1, maxWidth / source.width);
  const targetWidth = Math.max(1, Math.round(source.width * scale));
  const targetHeight = Math.max(1, Math.round(source.height * scale));

  let canvas: HTMLCanvasElement = source;
  if (scale < 1) {
    const resized = document.createElement("canvas");
    resized.width = targetWidth;
    resized.height = targetHeight;
    const ctx = resized.getContext("2d");
    if (!ctx) throw new CatalogImageError("Não consegui redimensionar a imagem (canvas 2d indisponível).");
    ctx.drawImage(source, 0, 0, targetWidth, targetHeight);
    canvas = resized;
  }

  return new Promise<Blob>((resolve, reject) => {
    canvas.toBlob(
      (blob) => (blob ? resolve(blob) : reject(new CatalogImageError("Falha ao gerar JPEG da imagem."))),
      "image/jpeg",
      0.72
    );
  });
}

function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = reader.result as string; // "data:image/jpeg;base64,AAAA..."
      const base64 = result.split(",")[1] ?? "";
      resolve(base64);
    };
    reader.onerror = () => reject(new CatalogImageError("Falha ao ler a imagem como base64."));
    reader.readAsDataURL(blob);
  });
}

// Hosts que NUNCA são alcançáveis de fora da própria máquina — o
// crawler da SerpApi roda em servidor deles, na internet, então uma URL
// `http://localhost:5173/...` ou `http://127.0.0.1:.../...` é inútil
// pra ele (timeout/erro na hora de baixar a imagem), mesmo rodando
// `vercel dev` local. Isso é DIFERENTE da exigência de servidor que já
// existe pra busca por TEXTO (essa só precisa que O NOSSO servidor
// alcance a serpapi.com, uma chamada de saída — funciona até de
// localhost). Busca por IMAGEM é o inverso: a SerpApi precisa alcançar
// A GENTE, uma chamada de ENTRADA — só funciona com deploy público de
// verdade (`https://seu-projeto.vercel.app` ou domínio próprio) ou um
// túnel (ngrok etc.), nunca localhost.
const UNREACHABLE_HOSTS = ["localhost", "127.0.0.1", "[::1]"];

/** Exportado pra falhar cedo, uma vez só, antes de tentar subir 20 fotos que vão todas falhar pelo mesmo motivo — ver parsePdfCatalog.ts. */
export function assertPubliclyReachable(): void {
  const hostname = window.location.hostname;
  if (UNREACHABLE_HOSTS.includes(hostname)) {
    throw new CatalogImageError(
      `Modo imagem não funciona em "${hostname}" — a SerpApi (Google Lens) precisa BAIXAR a foto ` +
        "de uma URL pública, e localhost não é alcançável de fora da sua máquina (isso é diferente " +
        "da busca por texto, que só faz chamada de SAÍDA e funciona local). Rode num deploy público " +
        "de verdade (ex: seu-projeto.vercel.app) ou use SerpApi/RapidAPI por texto pra testar local."
    );
  }
}

/**
 * Sobe uma imagem (canvas) pro Firestore e devolve a URL pública
 * (`/api/catalog-image?id=...`) que o provider Google Lens vai usar.
 */
export async function uploadCatalogImage(
  userId: string,
  sku: string,
  canvas: HTMLCanvasElement
): Promise<string> {
  if (!firebaseConfigured) {
    throw new CatalogImageError("Firebase não configurado — modo imagem exige login.");
  }
  assertPubliclyReachable();

  const blob = await compressForUpload(canvas);
  const base64 = await blobToBase64(blob);

  const db = await getFirebaseDb();
  const { collection, addDoc } = await import("firebase/firestore");
  const docRef = await addDoc(collection(db, COLLECTION), {
    userId,
    sku,
    contentType: "image/jpeg",
    base64,
    createdAt: Date.now(),
    expiresAt: Date.now() + TTL_MS,
  });

  return `${window.location.origin}/api/catalog-image?id=${docRef.id}`;
}
