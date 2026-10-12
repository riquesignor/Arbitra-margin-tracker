import { firebaseConfigured, getFirebaseDb } from "./firebase";
import type { AssistantContext, ChatTurn } from "./productAssistant";

/**
 * Histórico do Assistente de produto (out/2026) — subcoleção de
 * `users/{userId}` (mesmo padrão de ADR-0003: tudo do usuário fica na
 * pasta dele, sem coleção de chat solta no nível superior). Uma conversa
 * por doc; o cliente grava depois de cada resposta do assistente.
 *
 * A foto vai só como miniatura (~256px, ver `shrinkPhoto`) — o bastante
 * pra reconhecer a conversa na lista e no topo da conversa reaberta, sem
 * chegar perto do limite de 1MB por doc. A foto inteira não é necessária
 * pra continuar: perguntas seguintes usam o `context` salvo (produto
 * identificado + ofertas achadas), não a imagem.
 */
const SUBCOLLECTION = "assistant_chats";

export interface AssistantChatRecord {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  context: AssistantContext;
  turns: ChatTurn[];
  thumbnail?: string;
}

export type AssistantChatData = Omit<AssistantChatRecord, "id">;

const DEFAULT_LIMIT = 30;

export async function listAssistantChats(
  userId: string | null,
  limitCount = DEFAULT_LIMIT
): Promise<AssistantChatRecord[]> {
  if (!userId || !firebaseConfigured) return [];
  try {
    const db = await getFirebaseDb();
    const { collection, query, orderBy, limit, getDocs } = await import("firebase/firestore");
    const snap = await getDocs(
      query(collection(db, "users", userId, SUBCOLLECTION), orderBy("updatedAt", "desc"), limit(limitCount))
    );
    return snap.docs.map((d) => ({ id: d.id, ...(d.data() as AssistantChatData) }));
  } catch (err) {
    console.warn("Não consegui listar conversas do Assistente:", err);
    return [];
  }
}

/**
 * Cria (`chatId` null) ou atualiza a conversa. Devolve o id — o chamador
 * guarda pra próxima mensagem cair no MESMO doc. Lança em caso de erro:
 * quem chama decide se avisa o usuário (a resposta já apareceu na tela,
 * só não ficou salva).
 */
export async function saveAssistantChat(
  userId: string,
  chatId: string | null,
  data: AssistantChatData
): Promise<string> {
  const db = await getFirebaseDb();
  const { collection, doc, addDoc, setDoc } = await import("firebase/firestore");
  if (chatId) {
    await setDoc(doc(db, "users", userId, SUBCOLLECTION, chatId), data);
    return chatId;
  }
  const ref = await addDoc(collection(db, "users", userId, SUBCOLLECTION), data);
  return ref.id;
}

export async function deleteAssistantChat(userId: string, chatId: string): Promise<void> {
  const db = await getFirebaseDb();
  const { doc, deleteDoc } = await import("firebase/firestore");
  await deleteDoc(doc(db, "users", userId, SUBCOLLECTION, chatId));
}
