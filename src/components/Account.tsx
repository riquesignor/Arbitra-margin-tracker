import { useEffect, useState, type FormEvent } from "react";
import { motion } from "framer-motion";
import {
  ShieldAlert,
  UserRound,
  LogOut,
  Search,
  Calculator,
  Library,
  Gauge,
  SlidersHorizontal,
} from "lucide-react";
import { firebaseConfigured } from "../lib/firebase";
import { signIn, signInWithGoogle, signOutUser, signUp, type AuthUser } from "../lib/auth";
import { API_KEY_FIELDS, getUserApiKeys, type ApiKeyField } from "../lib/userSecrets";
import ApiKeyCard, { type ApiKeyCardConfig } from "./ApiKeyCard";
import { getTodayUsage } from "../lib/usageQuota";
import { getPlan } from "../config/plans";
import type { UserProfile } from "../lib/userProfile";
import type { UserPreferences } from "../lib/userPreferences";
import styles from "./Account.module.css";

/** Logo oficial do Google (4 cores), padrão pra botão "Continuar com Google". */
function GoogleIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 18 18" aria-hidden="true">
      <path
        fill="#4285F4"
        d="M17.64 9.2c0-.64-.06-1.25-.16-1.84H9v3.48h4.84c-.21 1.13-.84 2.09-1.8 2.73v2.27h2.92c1.7-1.57 2.68-3.88 2.68-6.64z"
      />
      <path
        fill="#34A853"
        d="M9 18c2.43 0 4.47-.8 5.96-2.18l-2.92-2.27c-.81.54-1.84.86-3.04.86-2.34 0-4.32-1.58-5.03-3.7H.96v2.34C2.44 15.98 5.48 18 9 18z"
      />
      <path
        fill="#FBBC05"
        d="M3.97 10.71c-.18-.54-.28-1.11-.28-1.71s.1-1.17.28-1.71V4.95H.96A8.997 8.997 0 000 9c0 1.45.35 2.83.96 4.05l3.01-2.34z"
      />
      <path
        fill="#EA4335"
        d="M9 3.58c1.32 0 2.51.45 3.44 1.35l2.58-2.58C13.46.89 11.43 0 9 0 5.48 0 2.44 2.02.96 4.95l3.01 2.34C4.68 5.16 6.66 3.58 9 3.58z"
      />
    </svg>
  );
}

interface Props {
  user: AuthUser | null;
  profile: UserProfile | null;
  preferences: UserPreferences;
  onUpdatePreferences: (partial: Partial<UserPreferences>) => void;
}

// "Preferências opcionais" — cada uma tem efeito num ponto específico do
// app (ver comentário de cada campo em userPreferences.ts). Fica na tela
// Conta (não em Configurações) porque são ajustes de COMPORTAMENTO de
// busca/histórico da própria conta, não de aparência/gráfico.
const OPTIONAL_PREFERENCES: {
  key: keyof Pick<
    UserPreferences,
    "onlyOwnKey" | "warnAt80PercentQuota" | "reuseRecentResult" | "notifyOnSearchComplete" | "retainHistory90Days"
  >;
  title: string;
  text: string;
}[] = [
  {
    key: "onlyOwnKey",
    title: "Usar somente a minha chave",
    text: "nunca cair pro provider sem chave (Mercado Livre público) mesmo se a busca falhar.",
  },
  {
    key: "warnAt80PercentQuota",
    title: "Avisar quando eu chegar a 80% da cota",
    text: "mostra o aviso \"!\" na barra de busca diária da Nova busca.",
  },
  {
    key: "reuseRecentResult",
    title: "Reaproveitar resultado recente",
    text: "carrega do histórico em vez de reprocessar um catálogo já buscado.",
  },
  {
    key: "notifyOnSearchComplete",
    title: "Me avisar quando a busca terminar",
    text: "notificação do navegador ao concluir uma busca longa (catálogo grande).",
  },
  {
    key: "retainHistory90Days",
    title: "Guardar histórico por 90 dias",
    text: "catálogos processados somem da lista depois de 90 dias (menos linha pra rolar).",
  },
];

const cardMotion = {
  initial: { opacity: 0, y: 8 },
  animate: { opacity: 1, y: 0 },
  transition: { duration: 0.3, ease: [0.16, 1, 0.3, 1] as const },
};

const BENEFITS = [
  {
    icon: Search,
    title: "Busca de preço real",
    text: "compara seu catálogo com Mercado Livre e Amazon usando sua própria chave SerpApi",
  },
  {
    icon: Calculator,
    title: "Margem calculada",
    text: "suas regras de custo, frete e taxa aplicadas em cada produto do catálogo",
  },
  {
    icon: Library,
    title: "Histórico e biblioteca",
    text: "catálogos já processados voltam sem gastar busca, e o plano libera catálogos prontos",
  },
];

// Instrução compacta (1 linha) em vez do passo-a-passo numerado antigo —
// o link já leva direto pra onde pegar a chave, sem precisar de 3 blocos
// de texto por card. Usada tanto pra busca por texto (Amazon + Mercado
// Livre) quanto pra busca por foto (Google Lens) — é a MESMA chave.
const SERPAPI_INTRO = (
  <>
    Busca por texto (Amazon + Mercado Livre) e por foto (Google Lens), pra catálogo sem texto real —{" "}
    <a href="https://serpapi.com/manage-api-key" target="_blank" rel="noreferrer">
      crie grátis em serpapi.com
    </a>{" "}
    (só email, ~250 buscas/mês) e cole a API key abaixo.
  </>
);

// Só usada pelo provider "Amazon direto" no Dashboard (ver
// SEARCH_PROVIDERS em Dashboard.tsx) — SerpApi e Mercado Livre direto
// não precisam dessa chave. Reservada pra catálogo com texto real e
// legível (ver gate de OCR em Dashboard.tsx > finishWithRows) — PDF que
// só funciona por foto continua exigindo a SerpApi acima.
const RAPIDAPI_INTRO = (
  <>
    Opcional — busca por NOME só na Amazon, mais barata que a SerpApi; use em catálogo com texto
    legível (sem OCR).{" "}
    <a href="https://rapidapi.com/letscrape-6bRBa3QguO5/api/real-time-amazon-data/pricing" target="_blank" rel="noreferrer">
      assine grátis "Real-Time Amazon Data" na RapidAPI
    </a>{" "}
    (até 100 buscas/mês) e cole a X-RapidAPI-Key abaixo.
  </>
);

// Segunda fonte de busca por FOTO (provider "searchapi_lens", ver
// Dashboard.tsx) — vendor diferente da SerpApi, só pra redundância
// (cota/downtime de um não afeta o outro). Opcional: sem essa chave, a
// busca por imagem continua funcionando normalmente via SerpApi.
const SEARCHAPI_INTRO = (
  <>
    Opcional — segunda fonte de busca por foto (redundância à SerpApi acima), mesmo tipo de
    resultado (Google Lens), vendor diferente.{" "}
    <a href="https://www.searchapi.io/users/sign_up" target="_blank" rel="noreferrer">
      crie grátis em searchapi.io
    </a>{" "}
    (100 buscas/mês, sem cartão) e cole a API key abaixo.
  </>
);

// Alternativa PAGA ao endpoint público do Mercado Livre — não aparece
// como opção normal no seletor de API do Dashboard; só é oferecida
// quando a busca pública falhar (HTTP 403), como "tentar de novo com
// sua chave". Sem tier grátis (a partir de $99/mês na Unwrangle) — só
// vale cadastrar se a instabilidade do endpoint público estiver
// atrapalhando de verdade.
const UNWRANGLE_INTRO = (
  <>
    Opcional — alternativa paga ao Mercado Livre público, usada só quando ele falhar (sem tier
    grátis, a partir de $99/mês).{" "}
    <a href="https://console.unwrangle.com/signup" target="_blank" rel="noreferrer">
      criar conta na unwrangle.com
    </a>{" "}
    e cole a API key abaixo.
  </>
);

// Motor de busca por foto SEM SerpApi/SearchApi.io (provider
// "vision_internal", ver Dashboard.tsx): uma IA de visão (Gemini) descreve
// a foto do catálogo e confirma o candidato achado comparando as fotos —
// ver visionInternalSearchProvider.ts. BYOK: tem tier gratuito permanente
// sem cartão, mas com limite de RATE (não de dinheiro) — por isso continua
// sendo uma chave própria, não uma cota compartilhada da Arbitra.
const GEMINI_INTRO = (
  <>
    Opcional — motor de busca por foto sem SerpApi/SearchApi.io: uma IA descreve a foto do
    catálogo e confirma o produto certo comparando as imagens.{" "}
    <a href="https://aistudio.google.com/apikey" target="_blank" rel="noreferrer">
      crie grátis no Google AI Studio
    </a>{" "}
    (sem cartão, cota diária generosa) e cole a API key abaixo.
  </>
);

// 2ª opção de backend pro motor interno + IA (ago/2026, ver GEMINI_INTRO
// acima e VisionBackend em visionInternalSearchProvider.ts) — mesmo tipo
// de busca (foto → descrição → confirmação visual), fornecedor diferente,
// pra comparar qualidade/velocidade lado a lado no mesmo catálogo. Chave
// SEPARADA da Gemini de propósito — contas diferentes, o usuário pode
// cadastrar as duas e alternar no seletor sem recadastrar nada.
//
// SUBSTITUIU o card Groq (removido no mesmo mês, ago/2026 — relato real
// "não traz nenhum resultado sequer": free tier de 8.000 tokens/minuto
// zerava a cota mesmo com comparação em lote implementada). Mistral tem
// free tier de 500.000 tokens/minuto (ver mistralVision.ts) — folga bem
// maior pro mesmo padrão de uso.
const MISTRAL_INTRO = (
  <>
    Opcional — mesma ideia do card Gemini acima (motor de busca por foto sem SerpApi/SearchApi.io),
    fornecedor de IA diferente pra comparar qualidade/velocidade.{" "}
    <a href="https://console.mistral.ai" target="_blank" rel="noreferrer">
      crie grátis em console.mistral.ai
    </a>{" "}
    (sem cartão, precisa confirmar telefone) e cole a API key abaixo.
  </>
);

// 3ª opção de backend pro motor interno + IA (BETA, set/2026) — mesma
// ideia dos cards Gemini/Mistral acima (busca por foto → descrição →
// confirmação visual), servida via NVIDIA NIM (build.nvidia.com), catálogo
// de 100+ modelos com free tier sem cartão. Entra marcada como Beta (ver
// badge no header do card) até ter validação real de acurácia/latência
// num catálogo — é uma 3ª opção pra comparar, não substitui as de cima.
// Criar a chave NÃO exige login/OAuth na hora de USAR o Arbitra: é o
// mesmo passo de criar conta na plataforma de origem (uma vez, fora do
// app) que Gemini/Mistral já pedem hoje.
const NVIDIA_INTRO = (
  <>
    Opcional, em teste (beta) — mesma ideia dos cards Gemini/Mistral acima (motor de busca por foto
    sem SerpApi/SearchApi.io), via catálogo de modelos da NVIDIA.{" "}
    <a href="https://build.nvidia.com" target="_blank" rel="noreferrer">
      crie grátis em build.nvidia.com
    </a>{" "}
    (só email, sem cartão) e cole a API key abaixo. Resultado pode variar mais que Gemini/Mistral
    enquanto está em teste — seu feedback ajuda a decidir se ela vira opção definitiva.
  </>
);

// Sua própria chave (set/2026, BYOK — antes era secret da plataforma,
// paga por TODO mundo; virou por usuário pra escalar pra "qualquer
// pessoa comercializar" sem empurrar custo de infra pro operador). Três
// usos diferentes: mecanismo "ScraperAPI" (Structured Data Endpoints —
// busca de verdade, não só transporte), fallback do motor interno + IA
// quando a raspagem direta da loja é bloqueada (fetchCandidateOffers,
// visionInternalSearchProvider.ts), e retry de download de foto de
// anúncio bloqueada (safeImageUrl.ts).
const SCRAPERAPI_INTRO = (
  <>
    Opcional — usada pelo mecanismo "ScraperAPI" e como reforço anti-bloqueio de outros mecanismos
    (motor interno, download de foto de anúncio).{" "}
    <a href="https://www.scraperapi.com/" target="_blank" rel="noreferrer">
      crie em scraperapi.com
    </a>{" "}
    (trial grátis com 5.000 créditos; pago depois disso) e cole a API key abaixo.
  </>
);

// Ordem = ordem de exibição na tela.
const API_KEY_CARDS: ApiKeyCardConfig[] = [
  {
    field: "serpApiKey",
    title: "SerpApi",
    intro: SERPAPI_INTRO,
    placeholder: "Cole sua chave SerpApi",
    savedMessage: "Chave salva — suas próximas buscas usam sua cota, não a compartilhada.",
    removedMessage: "Chave removida — voltando a usar a cota compartilhada do app.",
  },
  {
    field: "rapidApiKey",
    title: "RapidAPI (Amazon)",
    intro: RAPIDAPI_INTRO,
    placeholder: "Cole sua X-RapidAPI-Key",
    savedMessage: 'Chave salva — o provider "Amazon direto" no Dashboard já pode usar.',
    removedMessage: 'Chave removida — o provider "Amazon direto" fica indisponível até cadastrar outra.',
  },
  {
    field: "searchApiKey",
    title: "SearchApi.io",
    intro: SEARCHAPI_INTRO,
    placeholder: "Cole sua chave SearchApi.io",
    savedMessage: 'Chave salva — já pode escolher "SearchApi.io" como API de busca por imagem.',
    removedMessage: "Chave removida.",
  },
  {
    field: "geminiApiKey",
    title: "Gemini (motor interno + IA)",
    intro: GEMINI_INTRO,
    placeholder: "Cole sua chave Gemini",
    savedMessage: 'Chave salva — já pode escolher "Motor interno + IA" como API de busca por imagem.',
    removedMessage: "Chave removida.",
  },
  {
    field: "mistralApiKey",
    title: "Mistral (motor interno + IA)",
    intro: MISTRAL_INTRO,
    placeholder: "Cole sua chave Mistral",
    savedMessage: 'Chave salva — já pode escolher "Motor interno + IA (Mistral)" como API de busca por imagem.',
    removedMessage: "Chave removida.",
  },
  {
    field: "nvidiaApiKey",
    title: "NVIDIA (motor interno + IA)",
    intro: NVIDIA_INTRO,
    placeholder: "Cole sua chave NVIDIA",
    savedMessage: 'Chave salva — já pode escolher "Motor interno + IA (NVIDIA, beta)" como API de busca por imagem.',
    removedMessage: "Chave removida.",
    beta: true,
  },
  {
    field: "scraperApiKey",
    title: "ScraperAPI",
    intro: SCRAPERAPI_INTRO,
    placeholder: "Cole sua ScraperAPI key",
    savedMessage:
      'Chave salva — o mecanismo "ScraperAPI" e o fallback anti-bloqueio do motor interno + IA já podem usar.',
    removedMessage: 'Chave removida — o mecanismo "ScraperAPI" fica indisponível até cadastrar outra.',
  },
  {
    field: "unwrangleApiKey",
    title: "Unwrangle (Mercado Livre alt.)",
    intro: UNWRANGLE_INTRO,
    placeholder: "Cole sua chave Unwrangle",
    savedMessage: "Chave salva — se a busca pública do Mercado Livre falhar, você poderá tentar de novo com ela.",
    removedMessage: "Chave removida.",
  },
];

function PrefSwitch({ on, onToggle, label }: { on: boolean; onToggle: () => void; label: string }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      aria-label={label}
      className={on ? styles.switchOn : styles.switch}
      onClick={onToggle}
    >
      <span className={styles.switchThumb} />
    </button>
  );
}

export default function Account({ user, profile, preferences, onUpdatePreferences }: Props) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [mode, setMode] = useState<"signIn" | "signUp">("signIn");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  // Quais chaves BYOK já estão salvas (nunca o valor). Cada ApiKeyCard cuida
  // do próprio formulário; o status fica aqui porque o card de uso também usa.
  const [savedKeys, setSavedKeys] = useState<Partial<Record<ApiKeyField, boolean>>>({});

  // Uso diário (contador real, ver usageQuota.ts) — mesma fonte que o
  // Dashboard usa pro aviso "N busca(s) hoje".
  const [todayUsage, setTodayUsage] = useState<number | null>(null);

  useEffect(() => {
    if (!user) return;
    void getUserApiKeys(user.uid).then((keys) =>
      setSavedKeys(Object.fromEntries(API_KEY_FIELDS.map((field) => [field, Boolean(keys[field])])))
    );
    void getTodayUsage(user.uid).then(setTodayUsage);
  }, [user]);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setLoading(true);
    try {
      if (mode === "signIn") await signIn(email, password);
      else await signUp(email, password);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }

  async function handleGoogleSignIn() {
    setError(null);
    setLoading(true);
    try {
      await signInWithGoogle();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }

  if (!firebaseConfigured) {
    return (
      <div className={styles.deniedContainer}>
        <h1 className={styles.deniedTitle}>Conta</h1>
        <motion.div className={styles.deniedCard} {...cardMotion}>
          <span className={styles.avatar}>
            <ShieldAlert size={20} />
          </span>
          <p className={styles.hint}>
            Login e sincronização entre dispositivos exigem Firebase configurado. Sem isso, as
            regras de precificação ficam salvas só neste navegador (localStorage).
          </p>
          <code className={styles.code}>
            VITE_FIREBASE_API_KEY
            <br />
            VITE_FIREBASE_AUTH_DOMAIN
            <br />
            VITE_FIREBASE_PROJECT_ID
          </code>
        </motion.div>
      </div>
    );
  }

  if (!user) {
    return (
      <motion.div className={styles.container} {...cardMotion}>
        <div className={styles.loggedOutLayout}>
          <div className={styles.pitch}>
            <span className={styles.eyebrow}>Bem-vindo de volta</span>
            <h1 className={styles.pitchTitle}>
              Entre pra precificar
              <br />
              seu catálogo.
            </h1>
            <p className={styles.pitchSubtitle}>
              A conta guarda suas regras de margem, o histórico de catálogos processados e a sua
              chave de busca — tudo volta do jeito que você deixou.
            </p>
            <div className={styles.benefits}>
              {BENEFITS.map((b) => (
                <div key={b.title} className={styles.benefitRow}>
                  <span className={styles.benefitIcon}>
                    <b.icon size={14} />
                  </span>
                  <span>
                    <span className={styles.benefitTitle}>{b.title}</span>
                    <span className={styles.benefitText}>{b.text}</span>
                  </span>
                </div>
              ))}
            </div>
          </div>

          <form className={styles.authCard} onSubmit={(e) => void handleSubmit(e)}>
            <div className={styles.tabRow}>
              <button
                type="button"
                className={mode === "signIn" ? styles.tabActive : styles.tab}
                onClick={() => setMode("signIn")}
              >
                Entrar
              </button>
              <button
                type="button"
                className={mode === "signUp" ? styles.tabActive : styles.tab}
                onClick={() => setMode("signUp")}
              >
                Criar conta
              </button>
            </div>

            <label className={styles.field}>
              <span className={styles.fieldLabel}>email</span>
              <input
                className={styles.input}
                type="email"
                placeholder="voce@empresa.com.br"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                required
              />
            </label>

            <label className={styles.field}>
              <span className={styles.fieldLabel}>senha</span>
              <input
                className={styles.input}
                type="password"
                placeholder="••••••••"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                required
              />
            </label>

            <button className={styles.primaryButton} type="submit" disabled={loading}>
              {loading ? "Aguarde…" : mode === "signIn" ? "Entrar" : "Criar conta"}
            </button>

            <div className={styles.orDivider}>
              <span>ou</span>
            </div>

            <button
              type="button"
              className={styles.googleButton}
              onClick={() => void handleGoogleSignIn()}
              disabled={loading}
            >
              <GoogleIcon />
              Continuar com Google
            </button>

            <p className={styles.authHint}>
              {mode === "signIn"
                ? "Primeira vez aqui? Criar conta leva 10 segundos — só email e senha."
                : "Já tem conta? Troque pra \"Entrar\" ali em cima."}
            </p>

            {error && <p className={styles.errorText}>{error}</p>}
          </form>
        </div>
      </motion.div>
    );
  }

  const plan = getPlan(profile?.plan);
  // `usage_daily` (ver usageQuota.ts) só guarda o contador do DIA ATUAL —
  // sem histórico por dia no back-end, então aqui só aparece dado real:
  // uso de hoje contra o teto do plano (antes eram 13 barras inventadas).
  const usageToday = todayUsage ?? 0;
  const usagePct = Math.min(1, usageToday / Math.max(1, plan.dailySearchLimit));

  return (
    <motion.div className={styles.container} {...cardMotion}>
      <div className={styles.header}>
        <div className={styles.headerMain}>
          <span className={styles.eyebrow}>Sua conta</span>
          <h1 className={styles.title}>Conta e chave de busca</h1>
          <p className={styles.subtitle}>
            Sua chave SerpApi é o que libera a busca de preço. Cadastre uma vez — as buscas passam
            a usar a cota da sua própria conta.
          </p>
        </div>
        <div className={styles.headerCard}>
          <span className={styles.headerCardIcon}>
            <UserRound size={15} />
          </span>
          <span className={styles.headerCardText}>
            <span className={styles.headerCardLabel}>conectado como</span>
            <span className={styles.headerCardValue}>{user.email}</span>
          </span>
          <button
            className={styles.headerCardLogout}
            type="button"
            title="Sair desta conta"
            onClick={() => void signOutUser()}
          >
            <LogOut size={14} />
          </button>
        </div>
      </div>

      <div className={styles.layout}>
        <div className={styles.main}>
          {API_KEY_CARDS.map((card) => (
            <ApiKeyCard
              key={card.field}
              userId={user.uid}
              config={card}
              saved={Boolean(savedKeys[card.field])}
              onSavedChange={(saved) => setSavedKeys((prev) => ({ ...prev, [card.field]: saved }))}
            />
          ))}

          <section className={styles.card}>
            <div className={styles.cardHeader}>
              <span className={styles.cardHeaderIcon}>
                <Gauge size={14} />
              </span>
              <h2 className={styles.cardHeaderTitle}>Uso diário de busca</h2>
              <span className={styles.cardHeaderMeta}>hoje</span>
            </div>
            <div className={styles.cardBody}>
              <div className={styles.usageBig}>
                <span className={styles.usageBigNumber}>{usageToday}</span>
                <span className={styles.usageBigLabel}>
                  busca(s) hoje{savedKeys.serpApiKey ? " com a sua chave" : ""}
                </span>
              </div>
              <div
                className={styles.usageMeter}
                role="meter"
                aria-valuemin={0}
                aria-valuemax={plan.dailySearchLimit}
                aria-valuenow={usageToday}
                aria-label="Uso de busca hoje"
              >
                <span
                  className={usagePct >= 0.8 ? styles.usageMeterFillWarning : styles.usageMeterFill}
                  style={{ width: `${Math.round(usagePct * 100)}%` }}
                />
              </div>
              <p className={styles.usageCaption}>
                {usageToday} de {plan.dailySearchLimit} buscas do plano {plan.name} hoje — o contador
                zera todo dia. Com chave própria, o teto real é o da sua conta no provedor. O
                histórico por dia ainda não é gravado, por isso não tem gráfico de dias anteriores.
              </p>
            </div>
          </section>

          <section className={styles.card}>
            <div className={styles.cardHeader}>
              <span className={styles.cardHeaderIcon}>
                <SlidersHorizontal size={14} />
              </span>
              <h2 className={styles.cardHeaderTitle}>Preferências opcionais</h2>
            </div>
            <div className={styles.toggleList}>
              {OPTIONAL_PREFERENCES.map((p) => (
                <div key={p.key} className={styles.toggleRow}>
                  <span className={styles.toggleText}>
                    <span className={styles.toggleTitle}>{p.title}</span>
                    <span className={styles.toggleSub}>{p.text}</span>
                  </span>
                  <PrefSwitch
                    on={preferences[p.key]}
                    onToggle={() => {
                      const next = !preferences[p.key];
                      // Permissão de notificação só pode ser pedida a partir de
                      // um clique do usuário — este é o momento natural.
                      if (p.key === "notifyOnSearchComplete" && next && "Notification" in window && Notification.permission === "default") {
                        void Notification.requestPermission();
                      }
                      onUpdatePreferences({ [p.key]: next });
                    }}
                    label={p.title}
                  />
                </div>
              ))}
            </div>
          </section>
        </div>

        <aside className={styles.aside}>
          <section className={styles.card}>
            <div className={styles.cardHeader}>
              <h2 className={styles.cardHeaderTitle}>Seu plano</h2>
            </div>
            <div className={styles.planHeaderBlock}>
              <span className={styles.planName}>{plan.name}</span>
              <span className={styles.planPrice}>{plan.priceLabel}</span>
              <span className={styles.planDesc}>{plan.description}</span>
            </div>
            <div className={styles.infoRows}>
              <div className={styles.infoRow}>
                <span className={styles.infoRowLabel}>cota de busca</span>
                <span className={styles.infoRowValue}>sua conta SerpApi</span>
              </div>
              <div className={styles.infoRow}>
                <span className={styles.infoRowLabel}>troca de plano</span>
                <span className={styles.infoRowValue}>pelo admin</span>
              </div>
            </div>
          </section>

          <section className={styles.card}>
            <div className={styles.cardHeader}>
              <h2 className={styles.cardHeaderTitle}>Dados da conta</h2>
            </div>
            <div className={styles.infoRowsFlush}>
              <div className={styles.infoRow}>
                <span className={styles.infoRowLabel}>email</span>
                <span className={styles.infoRowValue}>{user.email}</span>
              </div>
              <div className={styles.infoRow}>
                <span className={styles.infoRowLabel}>id de suporte</span>
                <span className={styles.infoRowValueMono} title={user.uid}>
                  {user.uid.slice(0, 8)}…
                </span>
              </div>
              <div className={styles.infoRow}>
                <span className={styles.infoRowLabel}>permissão</span>
                <span className={styles.infoRowValue}>
                  {profile?.isAdmin ? "administrador" : "usuário"}
                </span>
              </div>
            </div>
            <div className={styles.signOutRow}>
              <button className={styles.linkButton} type="button" onClick={() => void signOutUser()}>
                sair desta conta
              </button>
            </div>
          </section>
        </aside>
      </div>
    </motion.div>
  );
}
