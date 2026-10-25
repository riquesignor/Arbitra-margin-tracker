import { useEffect, useMemo, useRef, useState, type ClipboardEvent, type DragEvent } from "react";
import {
  Camera,
  ExternalLink,
  ImagePlus,
  Loader2,
  MessageSquare,
  Plus,
  RefreshCw,
  Search,
  Send,
  Sparkles,
  Trash2,
  X,
} from "lucide-react";
import type { PlanId, SearchProviderId } from "../types";
import { getPlan } from "../config/plans";
import { brl } from "../lib/format";
import { safeExternalUrl } from "../lib/safeExternalUrl";
import {
  ASSISTANT_PROVIDERS,
  askProductAssistant,
  shrinkPhoto,
  type AssistantContext,
  type ChatTurn,
} from "../lib/productAssistant";
import {
  deleteAssistantChat,
  listAssistantChats,
  saveAssistantChat,
  type AssistantChatRecord,
} from "../lib/assistantChats";
import { useToast } from "../lib/toast";
import CopyButton from "./CopyButton";
import styles from "./ProductAssistant.module.css";

interface Props {
  userId: string | null;
  planId: PlanId | null | undefined;
  onOpenAccount: () => void;
}

const DEFAULT_QUESTION = "Por quanto eu deveria vender esse produto?";

/** Perguntas prontas da primeira análise — clicar só preenche a caixa, não envia. */
const STARTER_QUESTIONS = [
  DEFAULT_QUESTION,
  "Vale a pena comprar pelo custo que informei?",
  "Em qual marketplace compensa mais vender?",
  "Quanta concorrência tem esse produto?",
];

/** Sugestões de continuação — já com contexto, não gastam busca. */
const FOLLOW_UP_QUESTIONS = [
  "Qual preço pra vender mais rápido?",
  "Quanto sobra depois das taxas do marketplace?",
  "Os anúncios encontrados são mesmo esse produto?",
  "Vale a pena comprar?",
];

/**
 * "Assistente" (out/2026, plano Pro): foto de UM produto → preço de
 * mercado atual + preço sugerido, com conversa de acompanhamento. Caso de
 * uso diferente da Nova busca (catálogo em lote): decisão rápida sobre
 * um item avulso — "vi isso no atacado, vale comprar?". Só a primeira
 * mensagem busca preço (gasta cota); as seguintes só conversam sobre o
 * contexto já achado — ver api/product-assistant.ts.
 *
 * Layout (out/2026, padrão "Mail" do shadcn): conversas salvas sempre à
 * vista numa coluna à esquerda, conversa aberta à direita. A última
 * conversa aberta volta sozinha quando o usuário sai e entra na tela.
 */
/** Teto do servidor é 30 mensagens (api/product-assistant.ts); conversa reaberta pode ser mais longa. */
const MAX_TURNS_SENT = 29;

const LAST_CHAT_KEY = "arbitra.assistant.lastChat";

function readLastChat(userId: string | null): string | null {
  if (!userId) return null;
  try {
    return localStorage.getItem(`${LAST_CHAT_KEY}.${userId}`);
  } catch {
    return null;
  }
}

function writeLastChat(userId: string | null, chatId: string | null) {
  if (!userId) return;
  try {
    if (chatId) localStorage.setItem(`${LAST_CHAT_KEY}.${userId}`, chatId);
    else localStorage.removeItem(`${LAST_CHAT_KEY}.${userId}`);
  } catch {
    // Sem storage — só não reabre sozinho na próxima visita.
  }
}

export default function ProductAssistant({ userId, planId, onOpenAccount }: Props) {
  const plan = getPlan(planId);
  const toast = useToast();
  const [photo, setPhoto] = useState<{
    base64: string;
    mimeType: string;
    previewUrl: string;
    thumbUrl: string;
  } | null>(null);
  /** Imagem mostrada no topo da conversa — a foto recém-escolhida ou a miniatura de uma conversa reaberta. */
  const [threadImage, setThreadImage] = useState<string | null>(null);
  const [chatId, setChatId] = useState<string | null>(null);
  const [chats, setChats] = useState<AssistantChatRecord[]>([]);
  const [chatsLoaded, setChatsLoaded] = useState(false);
  const [chatSearch, setChatSearch] = useState("");
  const [saveWarning, setSaveWarning] = useState<string | null>(null);
  const [provider, setProvider] = useState<SearchProviderId>("serpapi");
  const [costInput, setCostInput] = useState("");
  const [draft, setDraft] = useState(DEFAULT_QUESTION);
  const [turns, setTurns] = useState<ChatTurn[]>([]);
  const [context, setContext] = useState<AssistantContext | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const draftRef = useRef<HTMLTextAreaElement>(null);
  const threadEndRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    threadEndRef.current?.scrollIntoView({ behavior: "smooth", block: "nearest" });
  }, [turns, loading]);

  useEffect(() => {
    let cancelled = false;
    void listAssistantChats(userId).then((list) => {
      if (cancelled) return;
      setChats(list);
      setChatsLoaded(true);
      // Volta pra conversa que estava aberta quando o usuário saiu da tela.
      const last = readLastChat(userId);
      const chat = last ? list.find((c) => c.id === last) : undefined;
      if (chat) openChat(chat);
    });
    return () => {
      cancelled = true;
    };
    // openChat só mexe em estado local; rodar de novo só quando troca o usuário.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [userId]);

  // Caixa de texto cresce com o conteúdo (até o teto do CSS).
  useEffect(() => {
    const el = draftRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${el.scrollHeight}px`;
  }, [draft]);

  const visibleChats = useMemo(() => {
    const term = chatSearch.trim().toLowerCase();
    return term ? chats.filter((c) => c.title.toLowerCase().includes(term)) : chats;
  }, [chats, chatSearch]);

  if (!plan.features.productAssistant) {
    return (
      <div className={styles.container}>
        <Header />
        <div className={styles.upsell}>
          <Sparkles size={18} aria-hidden="true" />
          <div>
            <p className={styles.upsellTitle}>Disponível no plano Pro</p>
            <p className={styles.upsellText}>
              Mande a foto de um produto e receba na hora o preço que ele está sendo vendido no
              mercado, um preço de venda sugerido e uma conversa pra tirar dúvidas sobre ele. Fale
              com o administrador da sua conta pra mudar de plano.
            </p>
          </div>
        </div>
      </div>
    );
  }

  async function handlePickFile(file: File | undefined) {
    if (!file) return;
    if (!/^image\/(jpeg|png|webp)$/.test(file.type)) {
      setError("Use uma foto JPG, PNG ou WebP.");
      return;
    }
    setError(null);
    try {
      const shrunk = await shrinkPhoto(file);
      setPhoto(shrunk);
      setThreadImage(shrunk.previewUrl);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Não consegui ler essa imagem.");
    }
  }

  function handleDrop(e: DragEvent<HTMLElement>) {
    e.preventDefault();
    setDragging(false);
    void handlePickFile(e.dataTransfer.files?.[0]);
  }

  /** Colar (Ctrl+V) um print ou foto copiada em qualquer lugar da análise nova. */
  function handlePaste(e: ClipboardEvent<HTMLElement>) {
    if (started) return;
    const file = Array.from(e.clipboardData.files).find((f) => f.type.startsWith("image/"));
    if (!file) return;
    e.preventDefault();
    void handlePickFile(file);
  }

  async function send() {
    const text = draft.trim();
    if (!text || loading) return;
    if (!context && !photo) {
      setError("Escolha a foto do produto primeiro.");
      return;
    }
    const cost = Number(costInput.replace(/\./g, "").replace(",", "."));
    const nextTurns: ChatTurn[] = [...turns, { role: "user", text }];
    setTurns(nextTurns);
    setDraft("");
    setError(null);
    setLoading(true);
    try {
      const result = await askProductAssistant({
        messages: nextTurns.slice(-MAX_TURNS_SENT),
        context,
        ...(context
          ? {}
          : {
              imageBase64: photo!.base64,
              imageMimeType: photo!.mimeType,
              provider,
              supplierPrice: Number.isFinite(cost) && cost > 0 ? cost : undefined,
            }),
      });
      const finalTurns: ChatTurn[] = [...nextTurns, { role: "model", text: result.reply }];
      setContext(result.context);
      setTurns(finalTurns);
      void persist(result.context, finalTurns);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setTurns(turns);
      setDraft(text);
    } finally {
      setLoading(false);
    }
  }

  /** Grava depois de cada resposta. Falha aqui não apaga a resposta da tela — só avisa que não ficou salva. */
  async function persist(ctx: AssistantContext, finalTurns: ChatTurn[]) {
    if (!userId) return;
    const now = Date.now();
    const existing = chats.find((c) => c.id === chatId);
    const thumbnail = photo?.thumbUrl ?? existing?.thumbnail;
    const data = {
      title: ctx.query,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
      context: ctx,
      turns: finalTurns,
      ...(thumbnail ? { thumbnail } : {}),
    };
    try {
      const id = await saveAssistantChat(userId, chatId, data);
      setChatId(id);
      writeLastChat(userId, id);
      setSaveWarning(null);
      // Atualiza a lista na hora (sem reler o Firestore) — conversa sobe pro topo.
      setChats((prev) => [{ id, ...data }, ...prev.filter((c) => c.id !== id)]);
    } catch (err) {
      console.warn("Não consegui salvar a conversa do Assistente:", err);
      setSaveWarning("Essa conversa não foi salva no histórico (falha de conexão). A resposta acima continua valendo.");
    }
  }

  function openChat(chat: AssistantChatRecord) {
    setPhoto(null);
    setThreadImage(chat.thumbnail ?? null);
    setChatId(chat.id);
    setContext(chat.context);
    setTurns(chat.turns);
    setDraft("");
    setError(null);
    setSaveWarning(null);
    writeLastChat(userId, chat.id);
  }

  /** Some da lista na hora; apaga de vez quando o aviso de "Desfazer" expira. */
  function removeChat(chat: AssistantChatRecord) {
    if (!userId) return;
    const wasOpen = chat.id === chatId;
    setChats((prev) => prev.filter((c) => c.id !== chat.id));
    if (wasOpen) reset();
    const putBack = () => {
      setChats((prev) => [...prev, chat].sort((a, b) => b.updatedAt - a.updatedAt));
      if (wasOpen) openChat(chat);
    };
    toast.show({
      message: `Conversa "${chat.title}" excluída.`,
      action: { label: "Desfazer", onClick: putBack },
      onExpire: () => {
        deleteAssistantChat(userId, chat.id).catch((err: unknown) => {
          putBack();
          toast.show({
            tone: "error",
            message: `Não consegui excluir a conversa: ${err instanceof Error ? err.message : String(err)}`,
          });
        });
      },
    });
  }

  function reset() {
    setPhoto(null);
    setThreadImage(null);
    setChatId(null);
    setTurns([]);
    setContext(null);
    setDraft(DEFAULT_QUESTION);
    setCostInput("");
    setError(null);
    setSaveWarning(null);
    writeLastChat(userId, null);
  }

  function pickQuestion(text: string) {
    setDraft(text);
    draftRef.current?.focus();
  }

  const started = turns.length > 0;
  const suggestions = started ? FOLLOW_UP_QUESTIONS : STARTER_QUESTIONS;

  return (
    <div className={styles.container}>
      <Header />

      <div className={styles.layout}>
        {/* ─── conversas salvas ─── */}
        <aside className={styles.sidebar} aria-label="Conversas salvas">
          <button type="button" className={styles.newButton} onClick={reset} disabled={loading}>
            <Plus size={15} aria-hidden="true" /> Nova análise
          </button>
          {chats.length > 0 && (
            <label className={styles.chatSearch}>
              <Search size={14} aria-hidden="true" />
              <input
                placeholder="Buscar conversa"
                aria-label="Buscar conversa"
                value={chatSearch}
                onChange={(e) => setChatSearch(e.target.value)}
              />
              {chatSearch && (
                <button type="button" onClick={() => setChatSearch("")} aria-label="Limpar busca">
                  <X size={13} aria-hidden="true" />
                </button>
              )}
            </label>
          )}
          <div className={styles.sidebarHead}>
            <span>Histórico</span>
            {chats.length > 0 && <span className={styles.sidebarCount}>{chats.length}</span>}
          </div>
          {!chatsLoaded ? (
            <p className={styles.sidebarEmpty}>Carregando conversas…</p>
          ) : chats.length === 0 ? (
            <p className={styles.sidebarEmpty}>
              Cada produto que você analisar fica salvo aqui — dá pra reabrir e continuar a conversa
              depois, sem gastar busca de novo.
            </p>
          ) : visibleChats.length === 0 ? (
            <p className={styles.sidebarEmpty}>Nenhuma conversa com “{chatSearch.trim()}”.</p>
          ) : (
            <ul className={styles.chatList}>
              {visibleChats.map((c) => (
                <ChatListItem
                  key={c.id}
                  chat={c}
                  active={c.id === chatId}
                  disabled={loading}
                  onOpen={() => openChat(c)}
                  onDelete={() => removeChat(c)}
                />
              ))}
            </ul>
          )}
        </aside>

        {/* ─── área de trabalho ─── */}
        <section className={styles.main} onPaste={handlePaste} aria-live="polite">
          {!started ? (
            <div className={styles.setup}>
              <div className={styles.setupGrid}>
                <button
                  type="button"
                  className={dragging ? styles.dropzoneActive : styles.dropzone}
                  onClick={() => fileInputRef.current?.click()}
                  onDragOver={(e) => {
                    e.preventDefault();
                    setDragging(true);
                  }}
                  onDragLeave={() => setDragging(false)}
                  onDrop={handleDrop}
                >
                  {photo ? (
                    <>
                      <img src={photo.previewUrl} alt="Foto do produto escolhida" className={styles.photoPreview} />
                      <span className={styles.dropzoneSwap}>
                        <RefreshCw size={12} aria-hidden="true" /> Trocar foto
                      </span>
                    </>
                  ) : (
                    <>
                      <span className={styles.dropzoneIcon}>
                        <ImagePlus size={22} aria-hidden="true" />
                      </span>
                      <span className={styles.dropzoneTitle}>Arraste a foto do produto</span>
                      <span className={styles.dropzoneHint}>
                        ou clique pra escolher · Ctrl+V cola um print
                        <br />
                        JPG, PNG ou WebP
                      </span>
                    </>
                  )}
                </button>
                <input
                  ref={fileInputRef}
                  type="file"
                  accept="image/jpeg,image/png,image/webp"
                  hidden
                  onChange={(e) => {
                    void handlePickFile(e.target.files?.[0]);
                    e.target.value = "";
                  }}
                />

                <div className={styles.fields}>
                  <label className={styles.field}>
                    <span className={styles.fieldLabel}>Onde buscar o preço</span>
                    <select
                      className={styles.input}
                      value={provider}
                      onChange={(e) => setProvider(e.target.value as SearchProviderId)}
                    >
                      {ASSISTANT_PROVIDERS.map((p) => (
                        <option key={p.id} value={p.id}>
                          {p.label}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label className={styles.field}>
                    <span className={styles.fieldLabel}>
                      Quanto custa pra você <span className={styles.optional}>opcional</span>
                    </span>
                    <span className={styles.money}>
                      <span aria-hidden="true">R$</span>
                      <input
                        className={styles.moneyInput}
                        inputMode="decimal"
                        placeholder="35,90"
                        value={costInput}
                        onChange={(e) => setCostInput(e.target.value)}
                      />
                    </span>
                    <span className={styles.fieldHint}>Com o custo, o assistente fala de margem e se vale comprar.</span>
                  </label>
                  <p className={styles.fieldHint}>
                    Usa as chaves cadastradas em{" "}
                    <button type="button" className={styles.linkButton} onClick={onOpenAccount}>
                      Conta
                    </button>{" "}
                    (Gemini pra reconhecer a foto + a do mecanismo escolhido). Cada análise nova gasta 1
                    busca por marketplace; as perguntas seguintes não gastam.
                  </p>
                </div>
              </div>

              <ol className={styles.steps}>
                <li>
                  <span className={styles.stepNumber}>1</span>
                  <span>
                    <b>Reconhece a foto</b>
                    <span className={styles.stepText}>O Gemini identifica marca, modelo e tamanho do produto.</span>
                  </span>
                </li>
                <li>
                  <span className={styles.stepNumber}>2</span>
                  <span>
                    <b>Busca o preço agora</b>
                    <span className={styles.stepText}>Amazon e Mercado Livre, com quantos vendedores disputam.</span>
                  </span>
                </li>
                <li>
                  <span className={styles.stepNumber}>3</span>
                  <span>
                    <b>Sugere e conversa</b>
                    <span className={styles.stepText}>Preço de venda sugerido e espaço pra tirar dúvidas.</span>
                  </span>
                </li>
              </ol>
            </div>
          ) : (
            <div className={styles.thread}>
              <ProductSummary context={context} image={threadImage} />
              <ol className={styles.messages}>
                {turns.map((t, i) => (
                  <li key={i} className={t.role === "user" ? styles.userMessage : styles.modelMessage}>
                    {t.role === "model" && (
                      <span className={styles.avatar} aria-hidden="true">
                        <Sparkles size={13} />
                      </span>
                    )}
                    <div className={styles.messageBody}>
                      <span className={styles.srOnly}>{t.role === "user" ? "Você:" : "Assistente:"}</span>
                      {t.text.trim()}
                      {t.role === "model" && (
                        <span className={styles.messageActions}>
                          <CopyButton text={t.text} label="Copiar resposta" />
                        </span>
                      )}
                    </div>
                  </li>
                ))}
                {loading && (
                  <li className={styles.modelMessage}>
                    <span className={styles.avatar} aria-hidden="true">
                      <Sparkles size={13} />
                    </span>
                    <div className={`${styles.messageBody} ${styles.thinking}`}>
                      <Loader2 size={14} className="spin" aria-hidden="true" />
                      {context ? "Pensando…" : "Reconhecendo o produto e buscando preço…"}
                    </div>
                  </li>
                )}
              </ol>
              <div ref={threadEndRef} />
            </div>
          )}

          {error && (
            <p className={styles.error} role="alert">
              {error}
            </p>
          )}
          {saveWarning && <p className={styles.warning}>{saveWarning}</p>}

          {/* ─── caixa de mensagem ─── */}
          <div className={styles.composerWrap}>
            {!loading && (
              <div className={styles.suggestions} aria-label="Perguntas sugeridas">
                {suggestions.map((q) => (
                  <button key={q} type="button" className={styles.chip} onClick={() => pickQuestion(q)}>
                    {q}
                  </button>
                ))}
              </div>
            )}
            <form
              className={styles.composer}
              onSubmit={(e) => {
                e.preventDefault();
                void send();
              }}
            >
              {!started && (
                <span className={photo ? styles.composerPhoto : styles.composerPhotoEmpty} aria-hidden="true">
                  {photo ? <img src={photo.thumbUrl} alt="" /> : <Camera size={15} />}
                </span>
              )}
              <textarea
                ref={draftRef}
                className={styles.textarea}
                rows={1}
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
                    e.preventDefault();
                    void send();
                  }
                }}
                placeholder={started ? "Pergunte mais sobre esse produto…" : DEFAULT_QUESTION}
                aria-label={started ? "Sua pergunta" : "Pergunta da análise"}
                maxLength={2000}
                disabled={loading}
              />
              <button
                type="submit"
                className={styles.sendButton}
                disabled={loading || !draft.trim() || (!started && !photo)}
                title={!started && !photo ? "Escolha a foto do produto primeiro" : undefined}
              >
                {loading ? <Loader2 size={15} className="spin" aria-hidden="true" /> : <Send size={15} aria-hidden="true" />}
                {started ? "Enviar" : "Analisar"}
              </button>
            </form>
            <p className={styles.composerHint}>Enter envia · Shift+Enter quebra linha</p>
          </div>
        </section>
      </div>
    </div>
  );
}

function Header() {
  return (
    <header className={styles.header}>
      <h1 className={styles.title}>
        Assistente de produto <span className={styles.proTag}>Pro</span>
      </h1>
      <p className={styles.lead}>
        Mande a foto de um produto avulso e descubra por quanto ele está sendo vendido agora, com um
        preço de venda sugerido — sem montar catálogo.
      </p>
    </header>
  );
}

function relativeWhen(ts: number): string {
  const d = new Date(ts);
  const now = new Date();
  const sameDay = d.toDateString() === now.toDateString();
  if (sameDay) return d.toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" });
  const yesterday = new Date(now);
  yesterday.setDate(now.getDate() - 1);
  if (d.toDateString() === yesterday.toDateString()) return "ontem";
  return d.toLocaleDateString("pt-BR", { day: "2-digit", month: "2-digit" });
}

function lowestPrice(context: AssistantContext): number | null {
  return context.offers.length > 0 ? Math.min(...context.offers.map((o) => o.price)) : null;
}

function ChatListItem({
  chat,
  active,
  disabled,
  onOpen,
  onDelete,
}: {
  chat: AssistantChatRecord;
  active: boolean;
  disabled: boolean;
  onOpen: () => void;
  onDelete: () => void;
}) {
  const lastReply = [...chat.turns].reverse().find((t) => t.role === "model")?.text ?? "";
  const price = lowestPrice(chat.context);
  const questions = chat.turns.filter((t) => t.role === "user").length;
  return (
    <li className={active ? styles.chatItemActive : styles.chatItem}>
      <button
        type="button"
        className={styles.chatOpen}
        onClick={onOpen}
        disabled={disabled}
        aria-current={active ? "true" : undefined}
      >
        {chat.thumbnail ? (
          <img src={chat.thumbnail} alt="" className={styles.chatThumb} />
        ) : (
          <span className={styles.chatThumbEmpty} aria-hidden="true">
            <MessageSquare size={14} />
          </span>
        )}
        <span className={styles.chatText}>
          <span className={styles.chatTop}>
            <span className={styles.chatTitle}>{chat.title}</span>
            <span className={styles.chatWhen}>{relativeWhen(chat.updatedAt)}</span>
          </span>
          <span className={styles.chatSnippet}>{lastReply}</span>
          <span className={styles.chatMeta}>
            {price != null && <span className={styles.chatPrice}>a partir de {brl(price)}</span>}
            <span>
              {questions} {questions === 1 ? "pergunta" : "perguntas"}
            </span>
          </span>
        </span>
      </button>
      <button
        type="button"
        className={styles.chatDelete}
        onClick={onDelete}
        disabled={disabled}
        aria-label={`Excluir conversa ${chat.title}`}
        title="Excluir conversa"
      >
        <Trash2 size={14} aria-hidden="true" />
      </button>
    </li>
  );
}

const MARKET_NAME: Record<string, string> = { amazon: "Amazon", mercadolivre: "Mercado Livre" };

/** Topo da conversa: o produto identificado e as ofertas encontradas, em formato de livro-razão. */
function ProductSummary({ context, image }: { context: AssistantContext | null; image: string | null }) {
  if (!context) {
    return (
      <div className={styles.summary}>
        {image && <img src={image} alt="Produto analisado" className={styles.summaryPhoto} />}
        <div className={styles.summaryText}>
          <span className={styles.summaryLabel}>Analisando</span>
          <span className={styles.summaryTitle}>Reconhecendo o produto…</span>
        </div>
      </div>
    );
  }
  const prices = context.offers.map((o) => o.price);
  return (
    <div className={styles.summaryBlock}>
      <div className={styles.summary}>
        {image ? (
          <img src={image} alt="Produto analisado" className={styles.summaryPhoto} />
        ) : (
          <span className={styles.summaryPhotoEmpty} aria-hidden="true">
            <Camera size={18} />
          </span>
        )}
        <div className={styles.summaryText}>
          <span className={styles.summaryLabel}>Identificado como</span>
          <h2 className={styles.summaryTitle}>{context.query}</h2>
          <span className={styles.summaryMeta}>
            {prices.length > 0 && (
              <>
                {prices.length > 1 && Math.min(...prices) !== Math.max(...prices)
                  ? `${brl(Math.min(...prices))} a ${brl(Math.max(...prices))}`
                  : brl(prices[0])}{" "}
                no mercado
              </>
            )}
            {context.supplierPrice != null && <> · seu custo {brl(context.supplierPrice)}</>}
          </span>
        </div>
      </div>
      {context.offers.length === 0 ? (
        <p className={styles.noOffers}>Nenhuma oferta encontrada nesta busca.</p>
      ) : (
        <table className={styles.offers}>
          <thead>
            <tr>
              <th scope="col">Onde</th>
              <th scope="col" className={styles.num}>
                Preço
              </th>
              <th scope="col" className={styles.num}>
                Vendedores
              </th>
              <th scope="col">
                <span className={styles.srOnly}>Anúncio</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {context.offers.map((o) => {
              const link = safeExternalUrl(o.link);
              return (
                <tr key={o.marketplace}>
                  <td>
                    {MARKET_NAME[o.marketplace] ?? o.marketplace}
                    {o.approximate && (
                      <span
                        className={styles.approx}
                        title="Correspondência aproximada — pode não ser exatamente esse produto. Abra o anúncio antes de confiar no preço."
                      >
                        aproximado
                      </span>
                    )}
                    {o.title && <span className={styles.offerTitle}>{o.title}</span>}
                  </td>
                  <td className={styles.num}>{brl(o.price)}</td>
                  <td className={styles.num}>{o.competitorCount}</td>
                  <td className={styles.linkCell}>
                    {link && (
                      <a href={link} target="_blank" rel="noopener noreferrer" className={styles.offerLink}>
                        <ExternalLink size={12} aria-hidden="true" /> <span className={styles.offerLinkText}>Ver anúncio</span>
                      </a>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
    </div>
  );
}
