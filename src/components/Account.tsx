import { useEffect, useState, type FormEvent } from "react";
import { motion } from "framer-motion";
<<<<<<< HEAD
=======
<<<<<<< HEAD
>>>>>>> 876d06fbe516a280c102d8517ac760291de86799
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
} from "lucide-react";
import { firebaseConfigured } from "../lib/firebase";
import { signIn, signOutUser, signUp, type AuthUser } from "../lib/auth";
<<<<<<< HEAD
import {
  deleteUserSerpApiKey,
  deleteUserRapidApiKey,
  getUserSerpApiKey,
  getUserRapidApiKey,
  saveUserSerpApiKey,
  saveUserRapidApiKey,
} from "../lib/userSecrets";
import { getTodayUsage } from "../lib/usageQuota";
import { getPlan } from "../config/plans";
import type { UserProfile } from "../lib/userProfile";
=======
import { deleteUserSerpApiKey, getUserSerpApiKey, saveUserSerpApiKey } from "../lib/userSecrets";
import { getTodayUsage } from "../lib/usageQuota";
import { getPlan } from "../config/plans";
import type { UserProfile } from "../lib/userProfile";
=======
import { ShieldAlert, UserRound, LogOut, KeyRound, Check, Trash2 } from "lucide-react";
import { firebaseConfigured } from "../lib/firebase";
import { signIn, signOutUser, signUp, type AuthUser } from "../lib/auth";
import { deleteUserSerpApiKey, getUserSerpApiKey, saveUserSerpApiKey } from "../lib/userSecrets";
>>>>>>> 7c481fb27bc9373aac5d889f1743cdf12b977510
>>>>>>> 876d06fbe516a280c102d8517ac760291de86799
import styles from "./Account.module.css";

interface Props {
  user: AuthUser | null;
<<<<<<< HEAD
  profile: UserProfile | null;
=======
<<<<<<< HEAD
  profile: UserProfile | null;
=======
>>>>>>> 7c481fb27bc9373aac5d889f1743cdf12b977510
>>>>>>> 876d06fbe516a280c102d8517ac760291de86799
}

const cardMotion = {
  initial: { opacity: 0, y: 8 },
  animate: { opacity: 1, y: 0 },
  transition: { duration: 0.3, ease: [0.16, 1, 0.3, 1] as const },
};

<<<<<<< HEAD
=======
<<<<<<< HEAD
>>>>>>> 876d06fbe516a280c102d8517ac760291de86799
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

const SERPAPI_STEPS = [
  {
    n: "1",
    title: "Crie a conta grátis na SerpApi",
    text: "só email, sem cartão de crédito — cerca de 250 buscas por mês no plano grátis",
  },
  {
    n: "2",
    title: "Copie sua API key",
    text: "ela fica no painel da SerpApi, em Your Account → API Key",
  },
  {
    n: "3",
    title: "Cole aqui e salve",
    text: "a busca já usa sua chave na próxima tentativa — sem mexer em .env, sem reiniciar nada",
  },
];

<<<<<<< HEAD
// Só usada pelo provider "Amazon direto" no Dashboard (ver
// SEARCH_PROVIDERS em Dashboard.tsx) — SerpApi e Mercado Livre direto
// não precisam dessa chave.
const RAPIDAPI_STEPS = [
  {
    n: "1",
    title: "Crie a conta grátis na RapidAPI",
    text: "só email, sem cartão de crédito",
  },
  {
    n: "2",
    title: 'Assine a API "Real-Time Amazon Data"',
    text: "no plano Basic (free) — até 100 buscas por mês, dá pra testar sem custo",
  },
  {
    n: "3",
    title: "Copie a X-RapidAPI-Key e cole aqui",
    text: "a mesma chave da sua conta RapidAPI funciona pra qualquer API que você assinar lá",
  },
];

=======
>>>>>>> 876d06fbe516a280c102d8517ac760291de86799
// 13 dias ilustrativos — `usage_daily` (ver usageQuota.ts) só guarda o
// contador do dia atual, sem histórico por dia no back-end ainda. Só a
// última barra (hoje) é dado real; o resto é só pra dar forma ao
// gráfico (ver aviso abaixo do gráfico, igual ao mockup).
const ILLUSTRATIVE_USAGE_SHAPE = [4, 12, 2, 8, 18, 14, 6, 2, 15, 20, 9, 7, 11];

export default function Account({ user, profile }: Props) {
<<<<<<< HEAD
=======
=======
export default function Account({ user }: Props) {
>>>>>>> 7c481fb27bc9373aac5d889f1743cdf12b977510
>>>>>>> 876d06fbe516a280c102d8517ac760291de86799
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

<<<<<<< HEAD
  // BYOK — chave RapidAPI própria (provider "Amazon direto"). Mesmo
  // padrão de estado da chave SerpApi acima.
  const [hasRapidKey, setHasRapidKey] = useState(false);
  const [rapidKeyInput, setRapidKeyInput] = useState("");
  const [savingRapidKey, setSavingRapidKey] = useState(false);
  const [rapidKeyMsg, setRapidKeyMsg] = useState<string | null>(null);
  const [rapidKeyError, setRapidKeyError] = useState<string | null>(null);

=======
<<<<<<< HEAD
>>>>>>> 876d06fbe516a280c102d8517ac760291de86799
  // Uso diário (contador real, ver usageQuota.ts) — mesma fonte que o
  // Dashboard usa pro aviso "N busca(s) hoje".
  const [todayUsage, setTodayUsage] = useState<number | null>(null);

  useEffect(() => {
    if (!user) return;
    getUserSerpApiKey(user.uid).then((key) => setHasSerpKey(Boolean(key)));
<<<<<<< HEAD
    getUserRapidApiKey(user.uid).then((key) => setHasRapidKey(Boolean(key)));
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
=======
    getTodayUsage(user.uid).then(setTodayUsage);
=======
  useEffect(() => {
    if (!user) return;
    getUserSerpApiKey(user.uid).then((key) => setHasSerpKey(Boolean(key)));
>>>>>>> 7c481fb27bc9373aac5d889f1743cdf12b977510
  }, [user]);
>>>>>>> 876d06fbe516a280c102d8517ac760291de86799

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
<<<<<<< HEAD
      <div className={styles.deniedContainer}>
        <h1 className={styles.deniedTitle}>Conta</h1>
        <motion.div className={styles.deniedCard} {...cardMotion}>
=======
<<<<<<< HEAD
      <div className={styles.deniedContainer}>
        <h1 className={styles.deniedTitle}>Conta</h1>
        <motion.div className={styles.deniedCard} {...cardMotion}>
=======
      <div className={styles.container}>
        <h1 className={styles.title}>Conta</h1>
        <motion.div className={styles.card} {...cardMotion}>
>>>>>>> 7c481fb27bc9373aac5d889f1743cdf12b977510
>>>>>>> 876d06fbe516a280c102d8517ac760291de86799
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
<<<<<<< HEAD
=======
<<<<<<< HEAD
>>>>>>> 876d06fbe516a280c102d8517ac760291de86799
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
              <h2 className={styles.cardHeaderTitle}>Sua chave SerpApi</h2>
              <span className={hasSerpKey ? styles.statusPillOk : styles.statusPillWarning}>
                {hasSerpKey ? <Check size={11} strokeWidth={3} /> : null} {hasSerpKey ? "configurada" : "não configurada"}
              </span>
            </div>

            {SERPAPI_STEPS.map((s) => (
              <div key={s.n} className={styles.stepRow}>
                <span className={styles.stepNumber}>{s.n}</span>
                <span className={styles.stepText}>
                  <span className={styles.stepTitle}>{s.title}</span>
                  <span className={styles.stepDesc}>{s.text}</span>
                </span>
              </div>
            ))}

            <form className={styles.cardBody} onSubmit={handleSaveSerpKey}>
              <label className={styles.field}>
                <span className={styles.fieldLabel}>
                  {hasSerpKey ? "substituir a chave atual" : "sua chave SerpApi"}
                </span>
                <input
                  className={styles.input}
                  type="password"
                  placeholder={hasSerpKey ? "Cole a nova chave…" : "Cole sua chave SerpApi"}
                  value={serpKeyInput}
                  onChange={(e) => setSerpKeyInput(e.target.value)}
                  autoComplete="off"
                />
              </label>

              <div className={styles.keyActions}>
                <button
                  className={styles.primaryButton}
                  type="submit"
                  disabled={savingSerpKey || !serpKeyInput.trim()}
                >
                  {savingSerpKey ? "Salvando…" : "Salvar chave"}
                </button>
                {hasSerpKey && (
                  <button
                    type="button"
                    className={styles.linkButton}
                    onClick={() => void handleRemoveSerpKey()}
                    disabled={savingSerpKey}
                  >
                    <Trash2 size={13} style={{ verticalAlign: "-2px", marginRight: 4 }} />
                    remover chave
                  </button>
                )}
              </div>

              <p className={styles.smallHint}>a chave fica guardada na sua conta e nunca é exibida de volta em texto puro</p>

              {serpKeyMsg && <p className={styles.successText}>{serpKeyMsg}</p>}
              {serpKeyError && <p className={styles.errorText}>{serpKeyError}</p>}
            </form>
          </section>

          <section className={styles.card}>
            <div className={styles.cardHeader}>
              <span className={styles.cardHeaderIcon}>
<<<<<<< HEAD
                <KeyRound size={14} />
              </span>
              <h2 className={styles.cardHeaderTitle}>Sua chave RapidAPI</h2>
              <span className={hasRapidKey ? styles.statusPillOk : styles.statusPillWarning}>
                {hasRapidKey ? <Check size={11} strokeWidth={3} /> : null}{" "}
                {hasRapidKey ? "configurada" : "não configurada"}
              </span>
            </div>

            <p className={styles.cardIntro}>
              opcional — só necessária se você escolher o provider "Amazon direto" no Dashboard
              (alternativa à SerpApi quando ela estiver sem cota).
            </p>

            {RAPIDAPI_STEPS.map((s) => (
              <div key={s.n} className={styles.stepRow}>
                <span className={styles.stepNumber}>{s.n}</span>
                <span className={styles.stepText}>
                  <span className={styles.stepTitle}>{s.title}</span>
                  <span className={styles.stepDesc}>{s.text}</span>
                </span>
              </div>
            ))}

            <form className={styles.cardBody} onSubmit={handleSaveRapidKey}>
              <label className={styles.field}>
                <span className={styles.fieldLabel}>
                  {hasRapidKey ? "substituir a chave atual" : "sua chave RapidAPI (X-RapidAPI-Key)"}
                </span>
                <input
                  className={styles.input}
                  type="password"
                  placeholder={hasRapidKey ? "Cole a nova chave…" : "Cole sua chave RapidAPI"}
                  value={rapidKeyInput}
                  onChange={(e) => setRapidKeyInput(e.target.value)}
                  autoComplete="off"
                />
              </label>

              <div className={styles.keyActions}>
                <button
                  className={styles.primaryButton}
                  type="submit"
                  disabled={savingRapidKey || !rapidKeyInput.trim()}
                >
                  {savingRapidKey ? "Salvando…" : "Salvar chave"}
                </button>
                {hasRapidKey && (
                  <button
                    type="button"
                    className={styles.linkButton}
                    onClick={() => void handleRemoveRapidKey()}
                    disabled={savingRapidKey}
                  >
                    <Trash2 size={13} style={{ verticalAlign: "-2px", marginRight: 4 }} />
                    remover chave
                  </button>
                )}
              </div>

              <p className={styles.smallHint}>a chave fica guardada na sua conta e nunca é exibida de volta em texto puro</p>

              {rapidKeyMsg && <p className={styles.successText}>{rapidKeyMsg}</p>}
              {rapidKeyError && <p className={styles.errorText}>{rapidKeyError}</p>}
            </form>
          </section>

          <section className={styles.card}>
            <div className={styles.cardHeader}>
              <span className={styles.cardHeaderIcon}>
=======
>>>>>>> 876d06fbe516a280c102d8517ac760291de86799
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
<<<<<<< HEAD
=======
=======
      <div className={styles.container}>
        <h1 className={styles.title}>Conta</h1>
        <motion.form className={styles.card} onSubmit={handleSubmit} {...cardMotion}>
          <span className={styles.avatar}>
            <UserRound size={20} />
          </span>
          <input
            className={styles.input}
            type="email"
            placeholder="Email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            required
          />
          <input
            className={styles.input}
            type="password"
            placeholder="Senha"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            required
          />
          <button className={styles.primaryButton} type="submit" disabled={loading}>
            {loading ? "Aguarde…" : mode === "signIn" ? "Entrar" : "Criar conta"}
          </button>
          <button
            type="button"
            className={styles.linkButton}
            onClick={() => setMode(mode === "signIn" ? "signUp" : "signIn")}
          >
            {mode === "signIn" ? "Não tem conta? Criar uma" : "Já tenho conta"}
          </button>
          {error && <p className={styles.errorText}>{error}</p>}
        </motion.form>
      </div>
    );
  }

  return (
    <div className={styles.container}>
      <h1 className={styles.title}>Conta</h1>
      <motion.div className={styles.card} {...cardMotion}>
        <span className={styles.avatar}>
          <UserRound size={20} />
        </span>
        <div className={styles.emailRow}>{user.email}</div>
        <button className={styles.linkButton} type="button" onClick={() => void signOutUser()}>
          <LogOut size={13} style={{ verticalAlign: "-2px", marginRight: 4 }} />
          Sair
        </button>
      </motion.div>

      <motion.form className={styles.card} onSubmit={handleSaveSerpKey} {...cardMotion}>
        <span className={styles.avatar}>
          <KeyRound size={20} />
        </span>
        <p className={styles.hint}>
          Sua própria chave SerpApi (grátis, cadastro só com email em{" "}
          <a href="https://serpapi.com/" target="_blank" rel="noreferrer">
            serpapi.com
          </a>
          ). Com ela, suas buscas usam a cota da sua conta, não a compartilhada do app — evita o
          limite diário estourar por causa de outros usuários.
        </p>

        {hasSerpKey && (
          <div className={styles.emailRow}>
            <Check size={14} style={{ verticalAlign: "-2px", marginRight: 4 }} />
            Chave própria configurada
          </div>
        )}

        <input
          className={styles.input}
          type="password"
          placeholder={hasSerpKey ? "Substituir chave…" : "Cole sua chave SerpApi"}
          value={serpKeyInput}
          onChange={(e) => setSerpKeyInput(e.target.value)}
          autoComplete="off"
        />

        <button
          className={styles.primaryButton}
          type="submit"
          disabled={savingSerpKey || !serpKeyInput.trim()}
        >
          {savingSerpKey ? "Salvando…" : "Salvar chave"}
        </button>

        {hasSerpKey && (
          <button
            type="button"
            className={styles.linkButton}
            onClick={() => void handleRemoveSerpKey()}
            disabled={savingSerpKey}
          >
            <Trash2 size={13} style={{ verticalAlign: "-2px", marginRight: 4 }} />
            Remover e voltar pra chave compartilhada
          </button>
        )}

        {serpKeyMsg && <p className={styles.hint}>{serpKeyMsg}</p>}
        {serpKeyError && <p className={styles.errorText}>{serpKeyError}</p>}
      </motion.form>
    </div>
>>>>>>> 7c481fb27bc9373aac5d889f1743cdf12b977510
>>>>>>> 876d06fbe516a280c102d8517ac760291de86799
  );
}
