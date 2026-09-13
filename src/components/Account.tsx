import { useEffect, useState, type FormEvent } from "react";
import { motion } from "framer-motion";
import {
  ShieldAlert,
  UserRound,
  LogOut,
  KeyRound,
  Check,
  Trash2,
  Search,
  Calculator,
  Library,
  Gauge,
  SlidersHorizontal,
  Eye,
  EyeOff,
} from "lucide-react";
import { firebaseConfigured } from "../lib/firebase";
import { signIn, signOutUser, signUp, type AuthUser } from "../lib/auth";
import {
  deleteUserSerpApiKey,
  deleteUserRapidApiKey,
  deleteUserSearchApiKey,
  deleteUserUnwrangleApiKey,
  deleteUserGeminiApiKey,
  deleteUserMistralApiKey,
  deleteUserNvidiaApiKey,
  deleteUserScraperApiKey,
  getUserSerpApiKey,
  getUserRapidApiKey,
  getUserSearchApiKey,
  getUserUnwrangleApiKey,
  getUserGeminiApiKey,
  getUserMistralApiKey,
  getUserNvidiaApiKey,
  getUserScraperApiKey,
  saveUserSerpApiKey,
  saveUserRapidApiKey,
  saveUserSearchApiKey,
  saveUserUnwrangleApiKey,
  saveUserGeminiApiKey,
  saveUserMistralApiKey,
  saveUserNvidiaApiKey,
  saveUserScraperApiKey,
} from "../lib/userSecrets";
import { getTodayUsage } from "../lib/usageQuota";
import { getPlan } from "../config/plans";
import type { UserProfile } from "../lib/userProfile";
import type { UserPreferences } from "../lib/userPreferences";
import styles from "./Account.module.css";

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

// 13 dias ilustrativos — `usage_daily` (ver usageQuota.ts) só guarda o
// contador do dia atual, sem histórico por dia no back-end ainda. Só a
// última barra (hoje) é dado real; o resto é só pra dar forma ao
// gráfico (ver aviso abaixo do gráfico, igual ao mockup).
const ILLUSTRATIVE_USAGE_SHAPE = [4, 12, 2, 8, 18, 14, 6, 2, 15, 20, 9, 7, 11];

// Input de chave BYOK com "olhinho" pra revelar o que foi digitado/colado
// antes de salvar — NÃO reexibe a chave já salva (o servidor só devolve
// "tem chave configurada?" via has*ApiKey, nunca o valor em si, ver
// userSecrets.ts). Visibilidade é estado local do próprio campo (não do
// componente Account) pra não precisar de mais um useState por chave.
function KeyInput({
  value,
  onChange,
  placeholder,
  disabled,
}: {
  value: string;
  onChange: (value: string) => void;
  placeholder: string;
  disabled?: boolean;
}) {
  const [visible, setVisible] = useState(false);
  return (
    <div className={styles.keyInputWrap}>
      <input
        className={styles.input}
        type={visible ? "text" : "password"}
        placeholder={placeholder}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        autoComplete="off"
      />
      <button
        type="button"
        className={styles.keyInputToggle}
        onClick={() => setVisible((v) => !v)}
        disabled={disabled}
        tabIndex={-1}
        title={visible ? "Ocultar chave" : "Mostrar chave"}
        aria-label={visible ? "Ocultar chave" : "Mostrar chave"}
      >
        {visible ? <EyeOff size={14} /> : <Eye size={14} />}
      </button>
    </div>
  );
}

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

  // BYOK — chave SerpApi própria (ver userSecrets.ts). Só carrega/mostra
  // quando logado; nunca reexibe a chave em texto puro depois de salva,
  // só indica que existe uma configurada.
  const [hasSerpKey, setHasSerpKey] = useState(false);
  const [serpKeyInput, setSerpKeyInput] = useState("");
  const [savingSerpKey, setSavingSerpKey] = useState(false);
  const [serpKeyMsg, setSerpKeyMsg] = useState<string | null>(null);
  const [serpKeyError, setSerpKeyError] = useState<string | null>(null);

  // BYOK — chave RapidAPI própria (provider "Amazon direto"). Mesmo
  // padrão de estado da chave SerpApi acima.
  const [hasRapidKey, setHasRapidKey] = useState(false);
  const [rapidKeyInput, setRapidKeyInput] = useState("");
  const [savingRapidKey, setSavingRapidKey] = useState(false);
  const [rapidKeyMsg, setRapidKeyMsg] = useState<string | null>(null);
  const [rapidKeyError, setRapidKeyError] = useState<string | null>(null);

  // BYOK — chave SearchApi.io própria (2ª fonte de busca por foto).
  // Mesmo padrão de estado das chaves acima.
  const [hasSearchApiKey, setHasSearchApiKey] = useState(false);
  const [searchApiKeyInput, setSearchApiKeyInput] = useState("");
  const [savingSearchApiKey, setSavingSearchApiKey] = useState(false);
  const [searchApiKeyMsg, setSearchApiKeyMsg] = useState<string | null>(null);
  const [searchApiKeyError, setSearchApiKeyError] = useState<string | null>(null);

  // BYOK — chave Unwrangle própria (alternativa paga ao Mercado Livre
  // público, usada só no fallback de erro — ver Dashboard.tsx).
  const [hasUnwrangleKey, setHasUnwrangleKey] = useState(false);
  const [unwrangleKeyInput, setUnwrangleKeyInput] = useState("");
  const [savingUnwrangleKey, setSavingUnwrangleKey] = useState(false);
  const [unwrangleKeyMsg, setUnwrangleKeyMsg] = useState<string | null>(null);
  const [unwrangleKeyError, setUnwrangleKeyError] = useState<string | null>(null);

  // BYOK — chave Gemini própria (motor interno + IA, provider
  // "vision_internal"). Mesmo padrão de estado das chaves acima.
  const [hasGeminiKey, setHasGeminiKey] = useState(false);
  const [geminiKeyInput, setGeminiKeyInput] = useState("");
  const [savingGeminiKey, setSavingGeminiKey] = useState(false);
  const [geminiKeyMsg, setGeminiKeyMsg] = useState<string | null>(null);
  const [geminiKeyError, setGeminiKeyError] = useState<string | null>(null);

  // BYOK — chave Mistral própria (motor interno + IA, provider
  // "vision_mistral", ver MISTRAL_INTRO acima). Mesmo padrão de estado
  // das chaves acima.
  const [hasMistralKey, setHasMistralKey] = useState(false);
  const [mistralKeyInput, setMistralKeyInput] = useState("");
  const [savingMistralKey, setSavingMistralKey] = useState(false);
  const [mistralKeyMsg, setMistralKeyMsg] = useState<string | null>(null);
  const [mistralKeyError, setMistralKeyError] = useState<string | null>(null);

  // BYOK — chave NVIDIA própria (BETA, motor interno + IA, provider
  // "vision_nvidia", ver NVIDIA_INTRO acima). Mesmo padrão de estado das
  // chaves acima.
  const [hasNvidiaKey, setHasNvidiaKey] = useState(false);
  const [nvidiaKeyInput, setNvidiaKeyInput] = useState("");
  const [savingNvidiaKey, setSavingNvidiaKey] = useState(false);
  const [nvidiaKeyMsg, setNvidiaKeyMsg] = useState<string | null>(null);
  const [nvidiaKeyError, setNvidiaKeyError] = useState<string | null>(null);

  // BYOK — chave ScraperAPI própria (set/2026, virou BYOK — antes era
  // secret de servidor da plataforma, ver src/lib/userSecrets.ts). Usada
  // pelo mecanismo "ScraperAPI" em si E como fallback/proxy de outros
  // (motor interno + IA quando a raspagem bloqueia, retry de imagem
  // bloqueada) — mesmo padrão de estado das chaves acima.
  const [hasScraperApiKey, setHasScraperApiKey] = useState(false);
  const [scraperApiKeyInput, setScraperApiKeyInput] = useState("");
  const [savingScraperApiKey, setSavingScraperApiKey] = useState(false);
  const [scraperApiKeyMsg, setScraperApiKeyMsg] = useState<string | null>(null);
  const [scraperApiKeyError, setScraperApiKeyError] = useState<string | null>(null);

  // Uso diário (contador real, ver usageQuota.ts) — mesma fonte que o
  // Dashboard usa pro aviso "N busca(s) hoje".
  const [todayUsage, setTodayUsage] = useState<number | null>(null);

  useEffect(() => {
    if (!user) return;
    getUserSerpApiKey(user.uid).then((key) => setHasSerpKey(Boolean(key)));
    getUserRapidApiKey(user.uid).then((key) => setHasRapidKey(Boolean(key)));
    getUserSearchApiKey(user.uid).then((key) => setHasSearchApiKey(Boolean(key)));
    getUserUnwrangleApiKey(user.uid).then((key) => setHasUnwrangleKey(Boolean(key)));
    getUserGeminiApiKey(user.uid).then((key) => setHasGeminiKey(Boolean(key)));
    getUserMistralApiKey(user.uid).then((key) => setHasMistralKey(Boolean(key)));
    getUserNvidiaApiKey(user.uid).then((key) => setHasNvidiaKey(Boolean(key)));
    getUserScraperApiKey(user.uid).then((key) => setHasScraperApiKey(Boolean(key)));
    getTodayUsage(user.uid).then(setTodayUsage);
  }, [user]);

  async function handleSaveRapidKey(e: FormEvent) {
    e.preventDefault();
    if (!user || !rapidKeyInput.trim()) return;
    setSavingRapidKey(true);
    setRapidKeyError(null);
    setRapidKeyMsg(null);
    try {
      await saveUserRapidApiKey(user.uid, rapidKeyInput);
      setHasRapidKey(true);
      setRapidKeyInput("");
      setRapidKeyMsg("Chave salva — o provider \"Amazon direto\" no Dashboard já pode usar.");
    } catch (err) {
      setRapidKeyError(err instanceof Error ? err.message : String(err));
    } finally {
      setSavingRapidKey(false);
    }
  }

  async function handleRemoveRapidKey() {
    if (!user) return;
    setSavingRapidKey(true);
    setRapidKeyError(null);
    setRapidKeyMsg(null);
    try {
      await deleteUserRapidApiKey(user.uid);
      setHasRapidKey(false);
      setRapidKeyMsg("Chave removida — o provider \"Amazon direto\" fica indisponível até cadastrar outra.");
    } catch (err) {
      setRapidKeyError(err instanceof Error ? err.message : String(err));
    } finally {
      setSavingRapidKey(false);
    }
  }

  async function handleSaveSearchApiKey(e: FormEvent) {
    e.preventDefault();
    if (!user || !searchApiKeyInput.trim()) return;
    setSavingSearchApiKey(true);
    setSearchApiKeyError(null);
    setSearchApiKeyMsg(null);
    try {
      await saveUserSearchApiKey(user.uid, searchApiKeyInput);
      setHasSearchApiKey(true);
      setSearchApiKeyInput("");
      setSearchApiKeyMsg("Chave salva — já pode escolher \"SearchApi.io\" como API de busca por imagem.");
    } catch (err) {
      setSearchApiKeyError(err instanceof Error ? err.message : String(err));
    } finally {
      setSavingSearchApiKey(false);
    }
  }

  async function handleRemoveSearchApiKey() {
    if (!user) return;
    setSavingSearchApiKey(true);
    setSearchApiKeyError(null);
    setSearchApiKeyMsg(null);
    try {
      await deleteUserSearchApiKey(user.uid);
      setHasSearchApiKey(false);
      setSearchApiKeyMsg("Chave removida.");
    } catch (err) {
      setSearchApiKeyError(err instanceof Error ? err.message : String(err));
    } finally {
      setSavingSearchApiKey(false);
    }
  }

  async function handleSaveUnwrangleKey(e: FormEvent) {
    e.preventDefault();
    if (!user || !unwrangleKeyInput.trim()) return;
    setSavingUnwrangleKey(true);
    setUnwrangleKeyError(null);
    setUnwrangleKeyMsg(null);
    try {
      await saveUserUnwrangleApiKey(user.uid, unwrangleKeyInput);
      setHasUnwrangleKey(true);
      setUnwrangleKeyInput("");
      setUnwrangleKeyMsg(
        "Chave salva — se a busca pública do Mercado Livre falhar, você poderá tentar de novo com ela."
      );
    } catch (err) {
      setUnwrangleKeyError(err instanceof Error ? err.message : String(err));
    } finally {
      setSavingUnwrangleKey(false);
    }
  }

  async function handleRemoveUnwrangleKey() {
    if (!user) return;
    setSavingUnwrangleKey(true);
    setUnwrangleKeyError(null);
    setUnwrangleKeyMsg(null);
    try {
      await deleteUserUnwrangleApiKey(user.uid);
      setHasUnwrangleKey(false);
      setUnwrangleKeyMsg("Chave removida.");
    } catch (err) {
      setUnwrangleKeyError(err instanceof Error ? err.message : String(err));
    } finally {
      setSavingUnwrangleKey(false);
    }
  }

  async function handleSaveGeminiKey(e: FormEvent) {
    e.preventDefault();
    if (!user || !geminiKeyInput.trim()) return;
    setSavingGeminiKey(true);
    setGeminiKeyError(null);
    setGeminiKeyMsg(null);
    try {
      await saveUserGeminiApiKey(user.uid, geminiKeyInput);
      setHasGeminiKey(true);
      setGeminiKeyInput("");
      setGeminiKeyMsg("Chave salva — já pode escolher \"Motor interno + IA\" como API de busca por imagem.");
    } catch (err) {
      setGeminiKeyError(err instanceof Error ? err.message : String(err));
    } finally {
      setSavingGeminiKey(false);
    }
  }

  async function handleRemoveGeminiKey() {
    if (!user) return;
    setSavingGeminiKey(true);
    setGeminiKeyError(null);
    setGeminiKeyMsg(null);
    try {
      await deleteUserGeminiApiKey(user.uid);
      setHasGeminiKey(false);
      setGeminiKeyMsg("Chave removida.");
    } catch (err) {
      setGeminiKeyError(err instanceof Error ? err.message : String(err));
    } finally {
      setSavingGeminiKey(false);
    }
  }

  async function handleSaveMistralKey(e: FormEvent) {
    e.preventDefault();
    if (!user || !mistralKeyInput.trim()) return;
    setSavingMistralKey(true);
    setMistralKeyError(null);
    setMistralKeyMsg(null);
    try {
      await saveUserMistralApiKey(user.uid, mistralKeyInput);
      setHasMistralKey(true);
      setMistralKeyInput("");
      setMistralKeyMsg("Chave salva — já pode escolher \"Motor interno + IA (Mistral)\" como API de busca por imagem.");
    } catch (err) {
      setMistralKeyError(err instanceof Error ? err.message : String(err));
    } finally {
      setSavingMistralKey(false);
    }
  }

  async function handleRemoveMistralKey() {
    if (!user) return;
    setSavingMistralKey(true);
    setMistralKeyError(null);
    setMistralKeyMsg(null);
    try {
      await deleteUserMistralApiKey(user.uid);
      setHasMistralKey(false);
      setMistralKeyMsg("Chave removida.");
    } catch (err) {
      setMistralKeyError(err instanceof Error ? err.message : String(err));
    } finally {
      setSavingMistralKey(false);
    }
  }

  async function handleSaveNvidiaKey(e: FormEvent) {
    e.preventDefault();
    if (!user || !nvidiaKeyInput.trim()) return;
    setSavingNvidiaKey(true);
    setNvidiaKeyError(null);
    setNvidiaKeyMsg(null);
    try {
      await saveUserNvidiaApiKey(user.uid, nvidiaKeyInput);
      setHasNvidiaKey(true);
      setNvidiaKeyInput("");
      setNvidiaKeyMsg("Chave salva — já pode escolher \"Motor interno + IA (NVIDIA, beta)\" como API de busca por imagem.");
    } catch (err) {
      setNvidiaKeyError(err instanceof Error ? err.message : String(err));
    } finally {
      setSavingNvidiaKey(false);
    }
  }

  async function handleRemoveNvidiaKey() {
    if (!user) return;
    setSavingNvidiaKey(true);
    setNvidiaKeyError(null);
    setNvidiaKeyMsg(null);
    try {
      await deleteUserNvidiaApiKey(user.uid);
      setHasNvidiaKey(false);
      setNvidiaKeyMsg("Chave removida.");
    } catch (err) {
      setNvidiaKeyError(err instanceof Error ? err.message : String(err));
    } finally {
      setSavingNvidiaKey(false);
    }
  }

  async function handleSaveScraperApiKey(e: FormEvent) {
    e.preventDefault();
    if (!user || !scraperApiKeyInput.trim()) return;
    setSavingScraperApiKey(true);
    setScraperApiKeyError(null);
    setScraperApiKeyMsg(null);
    try {
      await saveUserScraperApiKey(user.uid, scraperApiKeyInput);
      setHasScraperApiKey(true);
      setScraperApiKeyInput("");
      setScraperApiKeyMsg(
        "Chave salva — o mecanismo \"ScraperAPI\" e o fallback anti-bloqueio do motor interno + IA já podem usar."
      );
    } catch (err) {
      setScraperApiKeyError(err instanceof Error ? err.message : String(err));
    } finally {
      setSavingScraperApiKey(false);
    }
  }

  async function handleRemoveScraperApiKey() {
    if (!user) return;
    setSavingScraperApiKey(true);
    setScraperApiKeyError(null);
    setScraperApiKeyMsg(null);
    try {
      await deleteUserScraperApiKey(user.uid);
      setHasScraperApiKey(false);
      setScraperApiKeyMsg("Chave removida — o mecanismo \"ScraperAPI\" fica indisponível até cadastrar outra.");
    } catch (err) {
      setScraperApiKeyError(err instanceof Error ? err.message : String(err));
    } finally {
      setSavingScraperApiKey(false);
    }
  }

  async function handleSaveSerpKey(e: FormEvent) {
    e.preventDefault();
    if (!user || !serpKeyInput.trim()) return;
    setSavingSerpKey(true);
    setSerpKeyError(null);
    setSerpKeyMsg(null);
    try {
      await saveUserSerpApiKey(user.uid, serpKeyInput);
      setHasSerpKey(true);
      setSerpKeyInput("");
      setSerpKeyMsg("Chave salva — suas próximas buscas usam sua cota, não a compartilhada.");
    } catch (err) {
      setSerpKeyError(err instanceof Error ? err.message : String(err));
    } finally {
      setSavingSerpKey(false);
    }
  }

  async function handleRemoveSerpKey() {
    if (!user) return;
    setSavingSerpKey(true);
    setSerpKeyError(null);
    setSerpKeyMsg(null);
    try {
      await deleteUserSerpApiKey(user.uid);
      setHasSerpKey(false);
      setSerpKeyMsg("Chave removida — voltando a usar a cota compartilhada do app.");
    } catch (err) {
      setSerpKeyError(err instanceof Error ? err.message : String(err));
    } finally {
      setSavingSerpKey(false);
    }
  }

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

          <form className={styles.authCard} onSubmit={handleSubmit}>
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
  const usageDays = Array.from({ length: 14 }, (_, i) => {
    const d = new Date();
    d.setDate(d.getDate() - (13 - i));
    const isToday = i === 13;
    return {
      key: `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`,
      label: String(d.getDate()).padStart(2, "0"),
      value: isToday ? todayUsage ?? 0 : ILLUSTRATIVE_USAGE_SHAPE[i],
      isToday,
    };
  });
  const maxUsage = Math.max(1, ...usageDays.map((d) => d.value));

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
          <section className={styles.card}>
            <div className={styles.cardHeader}>
              <span className={styles.cardHeaderIcon}>
                <KeyRound size={14} />
              </span>
              <h2 className={styles.cardHeaderTitle}>SerpApi</h2>
              <span className={hasSerpKey ? styles.statusPillOk : styles.statusPillWarning}>
                {hasSerpKey ? <Check size={11} strokeWidth={3} /> : null} {hasSerpKey ? "configurada" : "não configurada"}
              </span>
            </div>

            <form className={styles.compactKeyForm} onSubmit={handleSaveSerpKey}>
              <p className={styles.cardIntro}>{SERPAPI_INTRO}</p>

              <div className={styles.compactKeyRow}>
                <KeyInput
                  value={serpKeyInput}
                  onChange={setSerpKeyInput}
                  placeholder={hasSerpKey ? "Substituir a chave atual…" : "Cole sua chave SerpApi"}
                  disabled={savingSerpKey}
                />
                <button
                  className={styles.primaryButton}
                  type="submit"
                  disabled={savingSerpKey || !serpKeyInput.trim()}
                >
                  {savingSerpKey ? "Salvando…" : "Salvar"}
                </button>
                {hasSerpKey && (
                  <button
                    type="button"
                    className={styles.iconButton}
                    title="Remover chave"
                    onClick={() => void handleRemoveSerpKey()}
                    disabled={savingSerpKey}
                  >
                    <Trash2 size={13} />
                  </button>
                )}
              </div>

              {serpKeyMsg && <p className={styles.successText}>{serpKeyMsg}</p>}
              {serpKeyError && <p className={styles.errorText}>{serpKeyError}</p>}
            </form>
          </section>

          <section className={styles.card}>
            <div className={styles.cardHeader}>
              <span className={styles.cardHeaderIcon}>
                <KeyRound size={14} />
              </span>
              <h2 className={styles.cardHeaderTitle}>RapidAPI (Amazon)</h2>
              <span className={hasRapidKey ? styles.statusPillOk : styles.statusPillWarning}>
                {hasRapidKey ? <Check size={11} strokeWidth={3} /> : null}{" "}
                {hasRapidKey ? "configurada" : "não configurada"}
              </span>
            </div>

            <form className={styles.compactKeyForm} onSubmit={handleSaveRapidKey}>
              <p className={styles.cardIntro}>{RAPIDAPI_INTRO}</p>

              <div className={styles.compactKeyRow}>
                <KeyInput
                  value={rapidKeyInput}
                  onChange={setRapidKeyInput}
                  placeholder={hasRapidKey ? "Substituir a chave atual…" : "Cole sua X-RapidAPI-Key"}
                  disabled={savingRapidKey}
                />
                <button
                  className={styles.primaryButton}
                  type="submit"
                  disabled={savingRapidKey || !rapidKeyInput.trim()}
                >
                  {savingRapidKey ? "Salvando…" : "Salvar"}
                </button>
                {hasRapidKey && (
                  <button
                    type="button"
                    className={styles.iconButton}
                    title="Remover chave"
                    onClick={() => void handleRemoveRapidKey()}
                    disabled={savingRapidKey}
                  >
                    <Trash2 size={13} />
                  </button>
                )}
              </div>

              {rapidKeyMsg && <p className={styles.successText}>{rapidKeyMsg}</p>}
              {rapidKeyError && <p className={styles.errorText}>{rapidKeyError}</p>}
            </form>
          </section>

          <section className={styles.card}>
            <div className={styles.cardHeader}>
              <span className={styles.cardHeaderIcon}>
                <KeyRound size={14} />
              </span>
              <h2 className={styles.cardHeaderTitle}>SearchApi.io</h2>
              <span className={hasSearchApiKey ? styles.statusPillOk : styles.statusPillWarning}>
                {hasSearchApiKey ? <Check size={11} strokeWidth={3} /> : null}{" "}
                {hasSearchApiKey ? "configurada" : "não configurada"}
              </span>
            </div>

            <form className={styles.compactKeyForm} onSubmit={handleSaveSearchApiKey}>
              <p className={styles.cardIntro}>{SEARCHAPI_INTRO}</p>

              <div className={styles.compactKeyRow}>
                <KeyInput
                  value={searchApiKeyInput}
                  onChange={setSearchApiKeyInput}
                  placeholder={hasSearchApiKey ? "Substituir a chave atual…" : "Cole sua chave SearchApi.io"}
                  disabled={savingSearchApiKey}
                />
                <button
                  className={styles.primaryButton}
                  type="submit"
                  disabled={savingSearchApiKey || !searchApiKeyInput.trim()}
                >
                  {savingSearchApiKey ? "Salvando…" : "Salvar"}
                </button>
                {hasSearchApiKey && (
                  <button
                    type="button"
                    className={styles.iconButton}
                    title="Remover chave"
                    onClick={() => void handleRemoveSearchApiKey()}
                    disabled={savingSearchApiKey}
                  >
                    <Trash2 size={13} />
                  </button>
                )}
              </div>

              {searchApiKeyMsg && <p className={styles.successText}>{searchApiKeyMsg}</p>}
              {searchApiKeyError && <p className={styles.errorText}>{searchApiKeyError}</p>}
            </form>
          </section>

          <section className={styles.card}>
            <div className={styles.cardHeader}>
              <span className={styles.cardHeaderIcon}>
                <KeyRound size={14} />
              </span>
              <h2 className={styles.cardHeaderTitle}>Gemini (motor interno + IA)</h2>
              <span className={hasGeminiKey ? styles.statusPillOk : styles.statusPillWarning}>
                {hasGeminiKey ? <Check size={11} strokeWidth={3} /> : null}{" "}
                {hasGeminiKey ? "configurada" : "não configurada"}
              </span>
            </div>

            <form className={styles.compactKeyForm} onSubmit={handleSaveGeminiKey}>
              <p className={styles.cardIntro}>{GEMINI_INTRO}</p>

              <div className={styles.compactKeyRow}>
                <KeyInput
                  value={geminiKeyInput}
                  onChange={setGeminiKeyInput}
                  placeholder={hasGeminiKey ? "Substituir a chave atual…" : "Cole sua chave Gemini"}
                  disabled={savingGeminiKey}
                />
                <button
                  className={styles.primaryButton}
                  type="submit"
                  disabled={savingGeminiKey || !geminiKeyInput.trim()}
                >
                  {savingGeminiKey ? "Salvando…" : "Salvar"}
                </button>
                {hasGeminiKey && (
                  <button
                    type="button"
                    className={styles.iconButton}
                    title="Remover chave"
                    onClick={() => void handleRemoveGeminiKey()}
                    disabled={savingGeminiKey}
                  >
                    <Trash2 size={13} />
                  </button>
                )}
              </div>

              {geminiKeyMsg && <p className={styles.successText}>{geminiKeyMsg}</p>}
              {geminiKeyError && <p className={styles.errorText}>{geminiKeyError}</p>}
            </form>
          </section>

          <section className={styles.card}>
            <div className={styles.cardHeader}>
              <span className={styles.cardHeaderIcon}>
                <KeyRound size={14} />
              </span>
              <h2 className={styles.cardHeaderTitle}>Mistral (motor interno + IA)</h2>
              <span className={hasMistralKey ? styles.statusPillOk : styles.statusPillWarning}>
                {hasMistralKey ? <Check size={11} strokeWidth={3} /> : null}{" "}
                {hasMistralKey ? "configurada" : "não configurada"}
              </span>
            </div>

            <form className={styles.compactKeyForm} onSubmit={handleSaveMistralKey}>
              <p className={styles.cardIntro}>{MISTRAL_INTRO}</p>

              <div className={styles.compactKeyRow}>
                <KeyInput
                  value={mistralKeyInput}
                  onChange={setMistralKeyInput}
                  placeholder={hasMistralKey ? "Substituir a chave atual…" : "Cole sua chave Mistral"}
                  disabled={savingMistralKey}
                />
                <button
                  className={styles.primaryButton}
                  type="submit"
                  disabled={savingMistralKey || !mistralKeyInput.trim()}
                >
                  {savingMistralKey ? "Salvando…" : "Salvar"}
                </button>
                {hasMistralKey && (
                  <button
                    type="button"
                    className={styles.iconButton}
                    title="Remover chave"
                    onClick={() => void handleRemoveMistralKey()}
                    disabled={savingMistralKey}
                  >
                    <Trash2 size={13} />
                  </button>
                )}
              </div>

              {mistralKeyMsg && <p className={styles.successText}>{mistralKeyMsg}</p>}
              {mistralKeyError && <p className={styles.errorText}>{mistralKeyError}</p>}
            </form>
          </section>

          <section className={styles.card}>
            <div className={styles.cardHeader}>
              <span className={styles.cardHeaderIcon}>
                <KeyRound size={14} />
              </span>
              <h2 className={styles.cardHeaderTitle}>NVIDIA (motor interno + IA)</h2>
              <span className={styles.betaBadge}>Beta</span>
              <span className={hasNvidiaKey ? styles.statusPillOk : styles.statusPillWarning}>
                {hasNvidiaKey ? <Check size={11} strokeWidth={3} /> : null}{" "}
                {hasNvidiaKey ? "configurada" : "não configurada"}
              </span>
            </div>

            <form className={styles.compactKeyForm} onSubmit={handleSaveNvidiaKey}>
              <p className={styles.cardIntro}>{NVIDIA_INTRO}</p>

              <div className={styles.compactKeyRow}>
                <KeyInput
                  value={nvidiaKeyInput}
                  onChange={setNvidiaKeyInput}
                  placeholder={hasNvidiaKey ? "Substituir a chave atual…" : "Cole sua chave NVIDIA"}
                  disabled={savingNvidiaKey}
                />
                <button
                  className={styles.primaryButton}
                  type="submit"
                  disabled={savingNvidiaKey || !nvidiaKeyInput.trim()}
                >
                  {savingNvidiaKey ? "Salvando…" : "Salvar"}
                </button>
                {hasNvidiaKey && (
                  <button
                    type="button"
                    className={styles.iconButton}
                    title="Remover chave"
                    onClick={() => void handleRemoveNvidiaKey()}
                    disabled={savingNvidiaKey}
                  >
                    <Trash2 size={13} />
                  </button>
                )}
              </div>

              {nvidiaKeyMsg && <p className={styles.successText}>{nvidiaKeyMsg}</p>}
              {nvidiaKeyError && <p className={styles.errorText}>{nvidiaKeyError}</p>}
            </form>
          </section>

          <section className={styles.card}>
            <div className={styles.cardHeader}>
              <span className={styles.cardHeaderIcon}>
                <KeyRound size={14} />
              </span>
              <h2 className={styles.cardHeaderTitle}>ScraperAPI</h2>
              <span className={hasScraperApiKey ? styles.statusPillOk : styles.statusPillWarning}>
                {hasScraperApiKey ? <Check size={11} strokeWidth={3} /> : null}{" "}
                {hasScraperApiKey ? "configurada" : "não configurada"}
              </span>
            </div>

            <form className={styles.compactKeyForm} onSubmit={handleSaveScraperApiKey}>
              <p className={styles.cardIntro}>{SCRAPERAPI_INTRO}</p>

              <div className={styles.compactKeyRow}>
                <KeyInput
                  value={scraperApiKeyInput}
                  onChange={setScraperApiKeyInput}
                  placeholder={hasScraperApiKey ? "Substituir a chave atual…" : "Cole sua ScraperAPI key"}
                  disabled={savingScraperApiKey}
                />
                <button
                  className={styles.primaryButton}
                  type="submit"
                  disabled={savingScraperApiKey || !scraperApiKeyInput.trim()}
                >
                  {savingScraperApiKey ? "Salvando…" : "Salvar"}
                </button>
                {hasScraperApiKey && (
                  <button
                    type="button"
                    className={styles.iconButton}
                    title="Remover chave"
                    onClick={() => void handleRemoveScraperApiKey()}
                    disabled={savingScraperApiKey}
                  >
                    <Trash2 size={13} />
                  </button>
                )}
              </div>

              {scraperApiKeyMsg && <p className={styles.successText}>{scraperApiKeyMsg}</p>}
              {scraperApiKeyError && <p className={styles.errorText}>{scraperApiKeyError}</p>}
            </form>
          </section>

          <section className={styles.card}>
            <div className={styles.cardHeader}>
              <span className={styles.cardHeaderIcon}>
                <KeyRound size={14} />
              </span>
              <h2 className={styles.cardHeaderTitle}>Unwrangle (Mercado Livre alt.)</h2>
              <span className={hasUnwrangleKey ? styles.statusPillOk : styles.statusPillWarning}>
                {hasUnwrangleKey ? <Check size={11} strokeWidth={3} /> : null}{" "}
                {hasUnwrangleKey ? "configurada" : "não configurada"}
              </span>
            </div>

            <form className={styles.compactKeyForm} onSubmit={handleSaveUnwrangleKey}>
              <p className={styles.cardIntro}>{UNWRANGLE_INTRO}</p>

              <div className={styles.compactKeyRow}>
                <KeyInput
                  value={unwrangleKeyInput}
                  onChange={setUnwrangleKeyInput}
                  placeholder={hasUnwrangleKey ? "Substituir a chave atual…" : "Cole sua chave Unwrangle"}
                  disabled={savingUnwrangleKey}
                />
                <button
                  className={styles.primaryButton}
                  type="submit"
                  disabled={savingUnwrangleKey || !unwrangleKeyInput.trim()}
                >
                  {savingUnwrangleKey ? "Salvando…" : "Salvar"}
                </button>
                {hasUnwrangleKey && (
                  <button
                    type="button"
                    className={styles.iconButton}
                    title="Remover chave"
                    onClick={() => void handleRemoveUnwrangleKey()}
                    disabled={savingUnwrangleKey}
                  >
                    <Trash2 size={13} />
                  </button>
                )}
              </div>

              {unwrangleKeyMsg && <p className={styles.successText}>{unwrangleKeyMsg}</p>}
              {unwrangleKeyError && <p className={styles.errorText}>{unwrangleKeyError}</p>}
            </form>
          </section>

          <section className={styles.card}>
            <div className={styles.cardHeader}>
              <span className={styles.cardHeaderIcon}>
                <Gauge size={14} />
              </span>
              <h2 className={styles.cardHeaderTitle}>Uso diário de busca</h2>
              <span className={styles.cardHeaderMeta}>últimos 14 dias</span>
            </div>
            <div className={styles.cardBody}>
              <div className={styles.usageBig}>
                <span className={styles.usageBigNumber}>{todayUsage ?? 0}</span>
                <span className={styles.usageBigLabel}>
                  busca(s) hoje{hasSerpKey ? " com a sua chave" : ""}
                </span>
              </div>
              <div className={styles.usageChart}>
                {usageDays.map((d) => (
                  <div key={d.key} className={styles.usageBarCol}>
                    <span className={d.isToday ? styles.usageBarTrackToday : styles.usageBarTrack}>
                      <span
                        className={d.isToday ? styles.usageBarFillToday : styles.usageBarFill}
                        style={{ height: `${Math.max(4, Math.round((d.value / maxUsage) * 100))}%` }}
                      />
                    </span>
                    <span className={d.isToday ? styles.usageBarLabelToday : styles.usageBarLabel}>
                      {d.label}
                    </span>
                  </div>
                ))}
              </div>
              <p className={styles.usageCaption}>
                a barra destacada é o dia de hoje (dado real). O histórico dos dias anteriores é
                ilustrativo — ainda não é gravado por dia no back-end.
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
                    onToggle={() => onUpdatePreferences({ [p.key]: !preferences[p.key] })}
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
                <span className={styles.infoRowLabel}>uid</span>
                <span className={styles.infoRowValueMono}>{user.uid}</span>
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
