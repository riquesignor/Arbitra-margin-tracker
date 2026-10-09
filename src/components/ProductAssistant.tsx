import { useEffect, useRef, useState } from "react";
import { Camera, ExternalLink, Loader2, RotateCcw, Send, Sparkles } from "lucide-react";
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
import styles from "./ProductAssistant.module.css";

interface Props {
  planId: PlanId | null | undefined;
  onOpenAccount: () => void;
}

const DEFAULT_QUESTION = "Por quanto eu deveria vender esse produto?";

/**
 * "Assistente" (out/2026, plano Pro): foto de UM produto → preço de
 * mercado atual + preço sugerido, com conversa de acompanhamento. Caso de
 * uso diferente da Nova busca (catálogo em lote): decisão rápida sobre
 * um item avulso — "vi isso no atacado, vale comprar?". Só a primeira
 * mensagem busca preço (gasta cota); as seguintes só conversam sobre o
 * contexto já achado — ver api/product-assistant.ts.
 */
export default function ProductAssistant({ planId, onOpenAccount }: Props) {
  const plan = getPlan(planId);
  const [photo, setPhoto] = useState<{ base64: string; mimeType: string; previewUrl: string } | null>(null);
  const [provider, setProvider] = useState<SearchProviderId>("serpapi");
  const [costInput, setCostInput] = useState("");
  const [draft, setDraft] = useState(DEFAULT_QUESTION);
  const [turns, setTurns] = useState<ChatTurn[]>([]);
  const [context, setContext] = useState<AssistantContext | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const threadEndRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    threadEndRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [turns, loading]);

  if (!plan.features.productAssistant) {
    return (
      <div className={styles.container}>
        <Header />
        <div className={styles.upsell}>
          <Sparkles size={18} />
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
    setError(null);
    try {
      setPhoto(await shrinkPhoto(file));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Não consegui ler essa imagem.");
    }
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
        messages: nextTurns,
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
      setContext(result.context);
      setTurns([...nextTurns, { role: "model", text: result.reply }]);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setTurns(turns);
      setDraft(text);
    } finally {
      setLoading(false);
    }
  }

  function reset() {
    setPhoto(null);
    setTurns([]);
    setContext(null);
    setDraft(DEFAULT_QUESTION);
    setCostInput("");
    setError(null);
  }

  const started = turns.length > 0;

  return (
    <div className={styles.container}>
      <Header />

      {!started && (
        <section className={styles.setup}>
          <button
            type="button"
            className={styles.photoPicker}
            onClick={() => fileInputRef.current?.click()}
          >
            {photo ? (
              <img src={photo.previewUrl} alt="Foto do produto escolhida" className={styles.photoPreview} />
            ) : (
              <>
                <Camera size={22} />
                <span>Escolher foto do produto</span>
                <span className={styles.hint}>JPG, PNG ou WebP — foto do próprio produto, de frente</span>
              </>
            )}
          </button>
          <input
            ref={fileInputRef}
            type="file"
            accept="image/jpeg,image/png,image/webp"
            hidden
            onChange={(e) => void handlePickFile(e.target.files?.[0])}
          />

          <div className={styles.fields}>
            <label className={styles.field}>
              <span>Onde buscar o preço</span>
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
              <span>Quanto custa pra você (opcional)</span>
              <input
                className={styles.input}
                inputMode="decimal"
                placeholder="ex.: 35,90"
                value={costInput}
                onChange={(e) => setCostInput(e.target.value)}
              />
            </label>
            <p className={styles.hint}>
              Usa as chaves que você cadastrou em{" "}
              <button type="button" className={styles.linkButton} onClick={onOpenAccount}>
                Conta
              </button>{" "}
              (Gemini pra reconhecer a foto + a do mecanismo escolhido). Cada análise nova gasta 1
              busca por marketplace; as perguntas seguintes não gastam.
            </p>
          </div>
        </section>
      )}

      {started && (
        <section className={styles.thread}>
          {photo && <img src={photo.previewUrl} alt="Produto analisado" className={styles.threadPhoto} />}
          {context && <OffersCard context={context} />}
          {turns.map((t, i) => (
            <div key={i} className={t.role === "user" ? styles.userBubble : styles.modelBubble}>
              {t.text}
            </div>
          ))}
          {loading && (
            <div className={styles.modelBubble}>
              <Loader2 size={14} className="spin" /> {context ? "Pensando…" : "Reconhecendo o produto e buscando preço…"}
            </div>
          )}
          <div ref={threadEndRef} />
        </section>
      )}

      {error && <p className={styles.error}>{error}</p>}

      <form
        className={styles.composer}
        onSubmit={(e) => {
          e.preventDefault();
          void send();
        }}
      >
        <input
          className={styles.input}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          placeholder={started ? "Pergunte mais sobre esse produto…" : DEFAULT_QUESTION}
          maxLength={2000}
          disabled={loading}
        />
        <button type="submit" className={styles.primaryButton} disabled={loading || !draft.trim()}>
          {loading ? <Loader2 size={14} className="spin" /> : <Send size={14} />}
          {started ? "Enviar" : "Analisar"}
        </button>
        {started && (
          <button type="button" className={styles.secondaryButton} onClick={reset} disabled={loading}>
            <RotateCcw size={14} /> Novo produto
          </button>
        )}
      </form>
    </div>
  );
}

function Header() {
  return (
    <div className={styles.header}>
      <span className={styles.eyebrow}>Pro · Assistente</span>
      <h1 className={styles.title}>Assistente de produto</h1>
      <p className={styles.subtitle}>
        Mande a foto de um produto avulso e descubra por quanto ele está sendo vendido agora, com um
        preço de venda sugerido — sem montar catálogo.
      </p>
    </div>
  );
}

function OffersCard({ context }: { context: AssistantContext }) {
  return (
    <div className={styles.offers}>
      <p className={styles.offersTitle}>
        Identificado como: <strong>{context.query}</strong>
      </p>
      {context.offers.length === 0 ? (
        <p className={styles.hint}>Nenhuma oferta encontrada nesta busca.</p>
      ) : (
        <ul className={styles.offerList}>
          {context.offers.map((o) => {
            const link = safeExternalUrl(o.link);
            return (
              <li key={o.marketplace} className={styles.offerRow}>
                <span className={styles.offerMarket}>{o.marketplace === "amazon" ? "Amazon" : "Mercado Livre"}</span>
                <span className={styles.offerPrice}>{brl(o.price)}</span>
                {o.approximate && <span className={styles.approx}>aproximado</span>}
                <span className={styles.hint}>{o.competitorCount} vendedor(es)</span>
                {link && (
                  <a href={link} target="_blank" rel="noopener noreferrer" className={styles.offerLink}>
                    <ExternalLink size={11} /> ver anúncio
                  </a>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
