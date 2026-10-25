import { useState, type FormEvent, type ReactNode } from "react";
import { motion } from "framer-motion";
import {
  Palette,
  SlidersHorizontal,
  CreditCard,
  UserCog,
  Check,
  AlertTriangle,
  Loader2,
  Workflow,
  Home,
  Search,
  BarChart3,
  Package,
  History,
  LogOut,
  X,
} from "lucide-react";
import type { AuthUser } from "../lib/auth";
import { changeEmail, changePassword, deleteAccount, signOutUser } from "../lib/auth";
import { getPlan, PLANS } from "../config/plans";
import type { UserProfile } from "../lib/userProfile";
import { createSubscriptionCheckout } from "../lib/billingApi";
import { brl, pct } from "../lib/format";
import type { Recommendation } from "../types";
import MarginBar from "./MarginBar";
import { BADGE_CLASS, BADGE_LABEL } from "./ResultsTable";
import type {
  AccentPalette,
  FontSizePreset,
  StartScreen,
  TableDensity,
  ThemeMode,
  UserPreferences,
} from "../lib/userPreferences";
import styles from "./Settings.module.css";

interface Props {
  preferences: UserPreferences;
  onUpdatePreferences: (partial: Partial<UserPreferences>) => void;
  user: AuthUser | null;
  profile: UserProfile | null;
  initialSection?: Section;
}

export type Section = "aparencia" | "fluxo" | "personalizacao" | "pagamento" | "conta";

const SECTIONS: { id: Section; label: string; hint: string; icon: typeof Palette; isNew?: boolean }[] = [
  { id: "aparencia", label: "Aparência", hint: "modo, cor e tamanho do texto", icon: Palette },
  { id: "fluxo", label: "Fluxo de trabalho", hint: "onde o app abre e densidade", icon: Workflow, isNew: true },
  { id: "personalizacao", label: "Tabelas e gráficos", hint: "o que aparece em cada tela", icon: SlidersHorizontal },
  { id: "pagamento", label: "Plano e pagamento", hint: "assinatura e limites", icon: CreditCard },
  { id: "conta", label: "Conta", hint: "email, senha e acesso", icon: UserCog },
];

// Valores de design-tokens.md § Temas de cor (paleta "Remaster",
// ago/2026) — contraste medido sobre o papel #EFEEE9, todas AA pra
// texto normal. "aco" é a paleta padrão (mesma do resto do app quando
// nenhuma paleta foi escolhida ainda). Precisa espelhar exatamente os
// valores de src/styles/tokens.css — são dois lugares com a mesma
// paleta (aqui é só o preview visual da tela, tokens.css é quem
// realmente aplica), então uma trocou sem a outra vira inconsistência.
const PALETTES: { id: AccentPalette; label: string; primary: string; hover: string; tint: string; contrast: string }[] = [
  { id: "aco", label: "Aço", primary: "#35577A", hover: "#24405C", tint: "#E7ECF2", contrast: "6,4:1 · AA" },
  { id: "petroleo", label: "Petróleo", primary: "#1F5F5B", hover: "#164744", tint: "#E6F0EF", contrast: "7,2:1 · AA" },
  { id: "indigo", label: "Índigo", primary: "#474C88", hover: "#353A68", tint: "#EDEEF6", contrast: "7,3:1 · AA" },
  { id: "terracota", label: "Terracota", primary: "#8A4A2F", hover: "#6B3823", tint: "#F6EDE8", contrast: "6,5:1 · AA" },
];

const FONT_SIZES: { id: FontSizePreset; label: string; sample: string; body: string }[] = [
  { id: "compact", label: "Compacto", sample: "15px", body: "13px" },
  { id: "standard", label: "Padrão", sample: "18px", body: "14px" },
  { id: "large", label: "Grande", sample: "22px", body: "16px" },
];

const THEME_MODES: { id: ThemeMode; label: string; hint: string }[] = [
  { id: "light", label: "Claro", hint: "papel claro, bom de dia" },
  { id: "dark", label: "Escuro", hint: "cansa menos à noite" },
  { id: "system", label: "Sistema", hint: "segue o computador" },
];

const START_SCREENS: { id: StartScreen; label: string; hint: string; icon: typeof Home }[] = [
  { id: "home", label: "Início", hint: "resumo do catálogo e atalhos", icon: Home },
  { id: "dashboard", label: "Nova busca", hint: "direto pra subir catálogo", icon: Search },
  { id: "results", label: "Resultados", hint: "a última busca aberta", icon: BarChart3 },
  { id: "portfolio", label: "Meus produtos", hint: "tendência e monitorados", icon: Package },
  { id: "last", label: "Onde parei", hint: "a última tela que você usou", icon: History },
];

const DENSITIES: { id: TableDensity; label: string; hint: string }[] = [
  { id: "comfortable", label: "Confortável", hint: "mais respiro entre linhas" },
  { id: "compact", label: "Compacta", hint: "mais produtos por tela" },
];

const PERSONALIZATION_TOGGLES: {
  key: keyof Pick<
    UserPreferences,
    "chartsPricing" | "chartsResults" | "compareEnginesSideBySide" | "groupOffersBySku"
  >;
  title: string;
  text: string;
}[] = [
  {
    key: "chartsPricing",
    title: "Gráficos na tela de Precificação",
    text: "Curva de sensibilidade de preço e histograma de margem, ao lado dos números.",
  },
  {
    key: "chartsResults",
    title: "Aba Análise em Resultados",
    text: "Distribuição de margem, maiores lucros por unidade e custo × margem.",
  },
  {
    key: "compareEnginesSideBySide",
    title: "Comparar marketplaces lado a lado",
    text: "Ao buscar em 2 marketplaces, mostra 2 colunas de preço + diferença em vez de 1 linha por oferta.",
  },
  {
    key: "groupOffersBySku",
    title: "Agrupar ofertas por SKU",
    text: "1 produto por linha, com as ofertas de outros marketplaces recolhidas embaixo.",
  },
];

function Switch({ on, onToggle, label }: { on: boolean; onToggle: () => void; label: string }) {
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

/** Linha de formulário no estilo do shadcn: rótulo + explicação à esquerda, controle à direita. */
function Group({ title, description, children }: { title: string; description?: ReactNode; children: ReactNode }) {
  return (
    <div className={styles.group}>
      <div className={styles.groupText}>
        <h3 className={styles.groupTitle}>{title}</h3>
        {description && <p className={styles.groupDescription}>{description}</p>}
      </div>
      <div className={styles.groupControl}>{children}</div>
    </div>
  );
}

export default function Settings({
  preferences,
  onUpdatePreferences,
  user,
  profile,
  initialSection = "aparencia",
}: Props) {
  const [section, setSection] = useState<Section>(initialSection);
  const plan = getPlan(profile?.plan);
  const current = SECTIONS.find((s) => s.id === section)!;

  return (
    <div className={styles.container}>
      <header className={styles.header}>
        <h1 className={styles.title}>Configurações</h1>
        <p className={styles.lead}>
          Tudo aqui é salvo na hora e vale em qualquer computador em que você entrar com esta conta.
        </p>
      </header>

      <div className={styles.layout}>
        <nav className={styles.nav} aria-label="Seções das configurações">
          {SECTIONS.map((s) => {
            const Icon = s.icon;
            const active = section === s.id;
            return (
              <button
                key={s.id}
                type="button"
                className={active ? styles.navItemActive : styles.navItem}
                aria-current={active ? "page" : undefined}
                onClick={() => setSection(s.id)}
              >
                <Icon size={16} strokeWidth={2} aria-hidden="true" />
                <span className={styles.navText}>
                  <span className={styles.navLabel}>
                    {s.label}
                    {s.isNew && <span className={styles.newTag}>novo</span>}
                  </span>
                  <span className={styles.navHint}>{s.hint}</span>
                </span>
              </button>
            );
          })}
          <div className={styles.navPlan}>
            <span className={styles.navPlanLabel}>Seu plano</span>
            <span className={styles.navPlanName}>{plan.name}</span>
            {section !== "pagamento" && (
              <button type="button" className={styles.inlineLink} onClick={() => setSection("pagamento")}>
                ver detalhes
              </button>
            )}
          </div>
        </nav>

        <motion.div
          key={section}
          className={styles.body}
          initial={{ opacity: 0, y: 6 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.22, ease: [0.16, 1, 0.3, 1] }}
        >
          <div className={styles.sectionHead}>
            <h2 className={styles.sectionTitle}>{current.label}</h2>
          </div>
          {section === "aparencia" && (
            <AparenciaSection preferences={preferences} onUpdatePreferences={onUpdatePreferences} />
          )}
          {section === "fluxo" && <FluxoSection preferences={preferences} onUpdatePreferences={onUpdatePreferences} />}
          {section === "personalizacao" && (
            <PersonalizacaoSection preferences={preferences} onUpdatePreferences={onUpdatePreferences} />
          )}
          {section === "pagamento" && (
            <PagamentoSection planId={plan.id} subscriptionStatus={profile?.mpSubscriptionStatus} />
          )}
          {section === "conta" && <ContaSection user={user} />}
        </motion.div>
      </div>
    </div>
  );
}

const PREVIEW_ROWS: { name: string; price: number; marginPct: number; recommendation: Recommendation }[] = [
  { name: "Cortador de Legumes 6 em 1", price: 62.9, marginPct: 0.483, recommendation: "recomendado" },
  { name: "Fone de Ouvido Gamer", price: 65.69, marginPct: 0.12, recommendation: "revisar" },
  { name: "Luminária de Mesa", price: 75.9, marginPct: -0.2, recommendation: "evitar" },
];
const PREVIEW_TARGET = 0.25;

/**
 * Tema/paleta/tamanho/densidade já se aplicam ao vivo no app inteiro (ver
 * applyAccent/applyTheme/applyFontSize/applyDensity em App.tsx), mas a tela
 * de Configurações não tem nenhum dos componentes mais usados — barra de
 * margem, badge de status, linha de produto. Esta prévia mostra eles com as
 * preferências atuais, sem precisar sair daqui pra conferir.
 */
function ThemePreview() {
  return (
    <aside className={styles.preview} aria-label="Prévia">
      <div className={styles.previewHead}>
        <span>Prévia</span>
        <span className={styles.previewHeadMeta}>como fica nas telas</span>
      </div>
      <div className={styles.previewStat}>
        <span className={styles.previewStatLabel}>Margem mediana</span>
        <span className={styles.previewStatValue}>{pct(0.214)}</span>
      </div>
      <table className={styles.previewTable}>
        <tbody>
          {PREVIEW_ROWS.map((row) => (
            <tr key={row.name}>
              <td>
                <span className={styles.previewName}>{row.name}</span>
                <MarginBar marginPct={row.marginPct} targetMarginPct={PREVIEW_TARGET} recommendation={row.recommendation} />
              </td>
              <td className={styles.previewNum}>
                {brl(row.price)}
                <span className={`${styles.previewBadge} ${BADGE_CLASS[row.recommendation]}`}>
                  {BADGE_LABEL[row.recommendation]}
                </span>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <div className={styles.previewActions}>
        <span className={styles.previewPrimary} aria-hidden="true">
          Nova busca
        </span>
        <span className={styles.previewLink} aria-hidden="true">
          link de destaque
        </span>
      </div>
    </aside>
  );
}

/** Miniatura de tela (estilo "Appearance" do shadcn) pintada com as cores fixas de cada modo. */
function ModeThumb({ mode }: { mode: ThemeMode }) {
  if (mode === "system") {
    return (
      <span className={styles.modeThumbSplit} aria-hidden="true">
        <ModeThumb mode="light" />
        <ModeThumb mode="dark" />
      </span>
    );
  }
  return (
    <span className={mode === "light" ? styles.thumbLight : styles.thumbDark} aria-hidden="true">
      <span className={styles.thumbBar} />
      <span className={styles.thumbLine} style={{ width: "70%" }} />
      <span className={styles.thumbLine} style={{ width: "45%" }} />
      <span className={styles.thumbRow}>
        <span className={styles.thumbDot} />
        <span className={styles.thumbLine} style={{ width: "60%" }} />
      </span>
      <span className={styles.thumbRow}>
        <span className={styles.thumbDot} />
        <span className={styles.thumbLine} style={{ width: "50%" }} />
      </span>
    </span>
  );
}

function AparenciaSection({
  preferences,
  onUpdatePreferences,
}: {
  preferences: UserPreferences;
  onUpdatePreferences: (partial: Partial<UserPreferences>) => void;
}) {
  return (
    <div className={styles.withPreview}>
      <div className={styles.groups}>
        <Group title="Modo" description="Claro, escuro ou acompanhando o sistema do seu computador.">
          <div className={styles.choiceGrid3} role="radiogroup" aria-label="Modo">
            {THEME_MODES.map((m) => {
              const active = preferences.themeMode === m.id;
              return (
                <button
                  key={m.id}
                  type="button"
                  role="radio"
                  aria-checked={active}
                  className={active ? styles.choiceActive : styles.choice}
                  onClick={() => onUpdatePreferences({ themeMode: m.id })}
                >
                  <ModeThumb mode={m.id} />
                  <span className={styles.choiceLabel}>
                    {m.label}
                    {active && <Check size={13} strokeWidth={3} aria-hidden="true" />}
                  </span>
                  <span className={styles.choiceHint}>{m.hint}</span>
                </button>
              );
            })}
          </div>
        </Group>

        <Group
          title="Cor de destaque"
          description="Muda botões, links e seleção. Verde, amarelo e vermelho de status nunca mudam — continuam querendo dizer a mesma coisa."
        >
          <div className={styles.choiceGrid4} role="radiogroup" aria-label="Cor de destaque">
            {PALETTES.map((p) => {
              const active = preferences.accent === p.id;
              return (
                <button
                  key={p.id}
                  type="button"
                  role="radio"
                  aria-checked={active}
                  className={active ? styles.choiceActive : styles.choice}
                  onClick={() => onUpdatePreferences({ accent: p.id })}
                >
                  <span className={styles.swatches} aria-hidden="true">
                    <span style={{ background: p.primary }} />
                    <span style={{ background: p.hover }} />
                    <span style={{ background: p.tint }} />
                  </span>
                  <span className={styles.choiceLabel}>
                    {p.label}
                    {active && <Check size={13} strokeWidth={3} aria-hidden="true" />}
                  </span>
                  <span className={styles.choiceMono}>{p.contrast}</span>
                </button>
              );
            })}
          </div>
        </Group>

        <Group title="Tamanho do texto" description="Vale pro app inteiro, inclusive tabelas e gráficos.">
          <div className={styles.choiceGrid3} role="radiogroup" aria-label="Tamanho do texto">
            {FONT_SIZES.map((f) => {
              const active = preferences.fontSize === f.id;
              return (
                <button
                  key={f.id}
                  type="button"
                  role="radio"
                  aria-checked={active}
                  className={active ? styles.choiceActive : styles.choice}
                  onClick={() => onUpdatePreferences({ fontSize: f.id })}
                >
                  <span className={styles.fontSample} style={{ fontSize: f.sample }} aria-hidden="true">
                    Aa
                  </span>
                  <span className={styles.choiceLabel}>
                    {f.label}
                    {active && <Check size={13} strokeWidth={3} aria-hidden="true" />}
                  </span>
                  <span className={styles.choiceMono}>{f.body} de corpo</span>
                </button>
              );
            })}
          </div>
        </Group>
      </div>
      <ThemePreview />
    </div>
  );
}

function FluxoSection({
  preferences,
  onUpdatePreferences,
}: {
  preferences: UserPreferences;
  onUpdatePreferences: (partial: Partial<UserPreferences>) => void;
}) {
  return (
    <div className={styles.groups}>
      <Group
        title="Abrir o app em"
        description="A tela que aparece quando você entra. Quem trabalha sempre no mesmo lugar economiza um clique toda vez."
      >
        <div className={styles.startGrid} role="radiogroup" aria-label="Abrir o app em">
          {START_SCREENS.map((s) => {
            const Icon = s.icon;
            const active = preferences.startScreen === s.id;
            return (
              <button
                key={s.id}
                type="button"
                role="radio"
                aria-checked={active}
                className={active ? styles.startActive : styles.start}
                onClick={() => onUpdatePreferences({ startScreen: s.id })}
              >
                <span className={styles.startIcon} aria-hidden="true">
                  <Icon size={16} />
                </span>
                <span className={styles.startText}>
                  <span className={styles.choiceLabel}>{s.label}</span>
                  <span className={styles.choiceHint}>{s.hint}</span>
                </span>
                <span className={styles.radioDot} aria-hidden="true" />
              </button>
            );
          })}
        </div>
      </Group>

      <Group
        title="Densidade das tabelas"
        description="Resultados, Meus produtos e Início. A compacta cabe quase o dobro de linhas na tela — bom pra catálogo grande."
      >
        <div className={styles.choiceGrid2} role="radiogroup" aria-label="Densidade das tabelas">
          {DENSITIES.map((d) => {
            const active = preferences.tableDensity === d.id;
            return (
              <button
                key={d.id}
                type="button"
                role="radio"
                aria-checked={active}
                className={active ? styles.choiceActive : styles.choice}
                onClick={() => onUpdatePreferences({ tableDensity: d.id })}
              >
                <span className={d.id === "compact" ? styles.densityThumbCompact : styles.densityThumb} aria-hidden="true">
                  {Array.from({ length: d.id === "compact" ? 6 : 4 }, (_, i) => (
                    <span key={i}>
                      <i />
                      <i />
                      <i />
                    </span>
                  ))}
                </span>
                <span className={styles.choiceLabel}>
                  {d.label}
                  {active && <Check size={13} strokeWidth={3} aria-hidden="true" />}
                </span>
                <span className={styles.choiceHint}>{d.hint}</span>
              </button>
            );
          })}
        </div>
      </Group>
    </div>
  );
}

function PersonalizacaoSection({
  preferences,
  onUpdatePreferences,
}: {
  preferences: UserPreferences;
  onUpdatePreferences: (partial: Partial<UserPreferences>) => void;
}) {
  return (
    <div className={styles.groups}>
      <p className={styles.sectionNote}>
        Desligar um gráfico nunca esconde dado — os números continuam nas tabelas.
      </p>
      <ul className={styles.toggleList}>
        {PERSONALIZATION_TOGGLES.map((t) => (
          <li key={t.key} className={styles.toggleRow}>
            <span className={styles.toggleText}>
              <span className={styles.toggleTitle}>{t.title}</span>
              <span className={styles.toggleSub}>{t.text}</span>
            </span>
            <Switch
              on={preferences[t.key]}
              onToggle={() => onUpdatePreferences({ [t.key]: !preferences[t.key] })}
              label={t.title}
            />
          </li>
        ))}
      </ul>
    </div>
  );
}

const SUBSCRIPTION_STATUS_LABEL: Record<string, string> = {
  authorized: "ativa",
  pending: "aguardando pagamento",
  paused: "pausada",
  cancelled: "cancelada",
};

function PagamentoSection({ planId, subscriptionStatus }: { planId: UserProfile["plan"]; subscriptionStatus?: string }) {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const isActive = subscriptionStatus === "authorized";
  const plan = getPlan(planId);

  async function handleSubscribe() {
    setError(null);
    setLoading(true);
    try {
      const { initPoint } = await createSubscriptionCheckout();
      window.location.href = initPoint;
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setLoading(false);
    }
  }

  const rows: { label: string; value: (p: (typeof PLANS)[number]) => ReactNode }[] = [
    { label: "Buscas por dia (referência)", value: (p) => p.dailySearchLimit.toLocaleString("pt-BR") },
    { label: "Produtos monitorados", value: (p) => p.maxWatches.toLocaleString("pt-BR") },
    { label: "Buscas no histórico", value: (p) => p.features.historyLimit.toLocaleString("pt-BR") },
    { label: "Relatório / PDF", value: (p) => <Yes on={p.features.printableReport} /> },
    { label: "Assistente de produto", value: (p) => <Yes on={p.features.productAssistant} /> },
    { label: "Checagem diária automática", value: (p) => <Yes on={p.features.autoWatchCheck} /> },
  ];

  return (
    <div className={styles.groups}>
      <Group
        title="Assinatura"
        description="Cobrança recorrente pelo Mercado Pago — o checkout é deles, o Arbitra nunca vê dado de cartão. O plano muda sozinho quando o pagamento é aprovado."
      >
        <dl className={styles.ledger}>
          <div>
            <dt>Plano atual</dt>
            <dd>
              {plan.name} · {plan.priceLabel}
            </dd>
          </div>
          <div>
            <dt>Status</dt>
            <dd>
              <span className={isActive ? styles.pillOk : styles.pillWarn}>
                {subscriptionStatus ? SUBSCRIPTION_STATUS_LABEL[subscriptionStatus] ?? subscriptionStatus : "sem assinatura"}
              </span>
            </dd>
          </div>
        </dl>
        <div className={styles.actions}>
          <button type="button" className={styles.primaryButton} onClick={() => void handleSubscribe()} disabled={loading}>
            {loading && <Loader2 size={14} className="spin" aria-hidden="true" />}
            {loading ? "Abrindo checkout…" : isActive ? "Gerenciar assinatura" : "Assinar agora"}
          </button>
        </div>
        {error && <p className={styles.errorText}>{error}</p>}
      </Group>

      <Group title="Comparar planos" description="O que cada plano libera. A coluna marcada é a sua.">
        <div className={styles.planTableWrap}>
          <table className={styles.planTable}>
            <thead>
              <tr>
                <th scope="col">
                  <span className={styles.srOnly}>Recurso</span>
                </th>
                {PLANS.map((p) => (
                  <th key={p.id} scope="col" className={p.id === plan.id ? styles.planCurrent : undefined}>
                    {p.name}
                    {p.id === plan.id && <span className={styles.planYou}>seu plano</span>}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.label}>
                  <th scope="row">{r.label}</th>
                  {PLANS.map((p) => (
                    <td key={p.id} className={p.id === plan.id ? styles.planCurrent : undefined}>
                      {r.value(p)}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Group>
    </div>
  );
}

function Yes({ on }: { on: boolean }) {
  return on ? (
    <Check size={15} strokeWidth={2.5} className={styles.yes} aria-label="incluso" />
  ) : (
    <X size={14} className={styles.no} aria-label="não incluso" />
  );
}

function ContaSection({ user }: { user: AuthUser | null }) {
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [savingPassword, setSavingPassword] = useState(false);
  const [passwordMsg, setPasswordMsg] = useState<string | null>(null);
  const [passwordError, setPasswordError] = useState<string | null>(null);

  const [showEmailForm, setShowEmailForm] = useState(false);
  const [newEmail, setNewEmail] = useState("");
  const [emailPassword, setEmailPassword] = useState("");
  const [savingEmail, setSavingEmail] = useState(false);
  const [emailMsg, setEmailMsg] = useState<string | null>(null);
  const [emailError, setEmailError] = useState<string | null>(null);

  const [showDeleteForm, setShowDeleteForm] = useState(false);
  const [deletePassword, setDeletePassword] = useState("");
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);

  async function handleChangePassword(e: FormEvent) {
    e.preventDefault();
    setPasswordError(null);
    setPasswordMsg(null);
    if (newPassword !== confirmPassword) {
      setPasswordError("A nova senha e a confirmação não são iguais.");
      return;
    }
    if (newPassword.length < 6) {
      setPasswordError("A nova senha precisa de pelo menos 6 caracteres.");
      return;
    }
    setSavingPassword(true);
    try {
      await changePassword(currentPassword, newPassword);
      setPasswordMsg("Senha alterada.");
      setCurrentPassword("");
      setNewPassword("");
      setConfirmPassword("");
    } catch (err) {
      setPasswordError(err instanceof Error ? err.message : String(err));
    } finally {
      setSavingPassword(false);
    }
  }

  async function handleChangeEmail(e: FormEvent) {
    e.preventDefault();
    setEmailError(null);
    setEmailMsg(null);
    setSavingEmail(true);
    try {
      await changeEmail(user?.hasPassword ? emailPassword : undefined, newEmail);
      setEmailMsg(`Link de confirmação enviado pra ${newEmail} — o email só muda depois que você confirmar.`);
      setNewEmail("");
      setEmailPassword("");
      setShowEmailForm(false);
    } catch (err) {
      setEmailError(err instanceof Error ? err.message : String(err));
    } finally {
      setSavingEmail(false);
    }
  }

  async function handleDeleteAccount(e: FormEvent) {
    e.preventDefault();
    setDeleteError(null);
    setDeleting(true);
    try {
      await deleteAccount(user?.hasPassword ? deletePassword : undefined);
    } catch (err) {
      setDeleteError(err instanceof Error ? err.message : String(err));
      setDeleting(false);
    }
  }

  return (
    <div className={styles.groups}>
      <Group title="Email de acesso" description="O email muda só depois que você clicar no link de confirmação enviado pro endereço novo.">
        <dl className={styles.ledger}>
          <div>
            <dt>Email atual</dt>
            <dd>{user?.email ?? "—"}</dd>
          </div>
          <div>
            <dt>Login</dt>
            <dd>{user?.hasPassword ? "email e senha" : "conta Google"}</dd>
          </div>
        </dl>
        {!showEmailForm ? (
          <div className={styles.actions}>
            <button type="button" className={styles.secondaryButton} onClick={() => setShowEmailForm(true)}>
              Alterar email
            </button>
          </div>
        ) : (
          <form className={styles.form} onSubmit={(e) => void handleChangeEmail(e)}>
            <label className={styles.field}>
              <span className={styles.fieldLabel}>Novo email</span>
              <input className={styles.input} type="email" value={newEmail} onChange={(e) => setNewEmail(e.target.value)} required />
            </label>
            {user?.hasPassword ? (
              <label className={styles.field}>
                <span className={styles.fieldLabel}>Senha atual (confirmação)</span>
                <input
                  className={styles.input}
                  type="password"
                  value={emailPassword}
                  onChange={(e) => setEmailPassword(e.target.value)}
                  autoComplete="current-password"
                  required
                />
              </label>
            ) : (
              <p className={styles.note}>Vamos pedir pra você confirmar de novo com o Google antes de trocar.</p>
            )}
            <div className={styles.actions}>
              <button className={styles.primaryButton} type="submit" disabled={savingEmail}>
                {savingEmail ? "Enviando…" : "Enviar confirmação"}
              </button>
              <button type="button" className={styles.secondaryButton} onClick={() => setShowEmailForm(false)} disabled={savingEmail}>
                Cancelar
              </button>
            </div>
          </form>
        )}
        {emailMsg && <p className={styles.successText}>{emailMsg}</p>}
        {emailError && <p className={styles.errorText}>{emailError}</p>}
      </Group>

      <Group title="Senha" description={user?.hasPassword ? "Pelo menos 6 caracteres." : undefined}>
        {user?.hasPassword ? (
          <form className={styles.form} onSubmit={(e) => void handleChangePassword(e)}>
            <label className={styles.field}>
              <span className={styles.fieldLabel}>Senha atual</span>
              <input
                className={styles.input}
                type="password"
                value={currentPassword}
                onChange={(e) => setCurrentPassword(e.target.value)}
                autoComplete="current-password"
                required
              />
            </label>
            <div className={styles.fieldRow}>
              <label className={styles.field}>
                <span className={styles.fieldLabel}>Nova senha</span>
                <input
                  className={styles.input}
                  type="password"
                  value={newPassword}
                  onChange={(e) => setNewPassword(e.target.value)}
                  autoComplete="new-password"
                  required
                />
              </label>
              <label className={styles.field}>
                <span className={styles.fieldLabel}>Repetir nova senha</span>
                <input
                  className={styles.input}
                  type="password"
                  value={confirmPassword}
                  onChange={(e) => setConfirmPassword(e.target.value)}
                  autoComplete="new-password"
                  required
                />
              </label>
            </div>
            <div className={styles.actions}>
              <button className={styles.primaryButton} type="submit" disabled={savingPassword}>
                {savingPassword && <Loader2 size={14} className="spin" aria-hidden="true" />}
                {savingPassword ? "Salvando…" : "Trocar senha"}
              </button>
            </div>
            {passwordMsg && <p className={styles.successText}>{passwordMsg}</p>}
            {passwordError && <p className={styles.errorText}>{passwordError}</p>}
          </form>
        ) : (
          <p className={styles.note}>Sua conta usa login do Google — não há senha cadastrada aqui pra trocar.</p>
        )}
      </Group>

      <Group title="Sessão" description="Sai só deste navegador. Suas buscas e configurações continuam salvas.">
        <div className={styles.actions}>
          <button className={styles.secondaryButton} type="button" onClick={() => void signOutUser()}>
            <LogOut size={14} aria-hidden="true" /> Sair desta conta
          </button>
        </div>
      </Group>

      <div className={styles.danger}>
        <Group
          title="Excluir conta"
          description={
            <>
              <AlertTriangle size={13} className={styles.dangerIcon} aria-hidden="true" />
              Apaga o login e o perfil salvo. Não tem como desfazer.
            </>
          }
        >
          {!showDeleteForm ? (
            <div className={styles.actions}>
              <button type="button" className={styles.dangerButton} onClick={() => setShowDeleteForm(true)}>
                Excluir minha conta
              </button>
            </div>
          ) : (
            <form className={styles.form} onSubmit={(e) => void handleDeleteAccount(e)}>
              {user?.hasPassword ? (
                <label className={styles.field}>
                  <span className={styles.fieldLabel}>Confirme sua senha</span>
                  <input
                    className={styles.input}
                    type="password"
                    value={deletePassword}
                    onChange={(e) => setDeletePassword(e.target.value)}
                    autoComplete="current-password"
                    required
                  />
                </label>
              ) : (
                <p className={styles.note}>Vamos pedir pra você confirmar de novo com o Google antes de excluir.</p>
              )}
              <div className={styles.actions}>
                <button className={styles.dangerButton} type="submit" disabled={deleting}>
                  {deleting ? "Excluindo…" : "Confirmar exclusão"}
                </button>
                <button type="button" className={styles.secondaryButton} onClick={() => setShowDeleteForm(false)} disabled={deleting}>
                  Cancelar
                </button>
              </div>
              {deleteError && <p className={styles.errorText}>{deleteError}</p>}
            </form>
          )}
        </Group>
      </div>
    </div>
  );
}
