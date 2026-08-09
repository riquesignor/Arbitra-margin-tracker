import { useState, type FormEvent } from "react";
import { motion } from "framer-motion";
import {
  Palette,
  SlidersHorizontal,
  CreditCard,
  UserCog,
  Check,
  AlertTriangle,
  Loader2,
} from "lucide-react";
import type { AuthUser } from "../lib/auth";
import { changeEmail, changePassword, deleteAccount, signOutUser } from "../lib/auth";
import { getPlan } from "../config/plans";
import type { UserProfile } from "../lib/userProfile";
import type {
  AccentPalette,
  FontSizePreset,
  ThemeMode,
  UserPreferences,
} from "../lib/userPreferences";
import styles from "./Settings.module.css";

interface Props {
  preferences: UserPreferences;
  onUpdatePreferences: (partial: Partial<UserPreferences>) => void;
  user: AuthUser | null;
  profile: UserProfile | null;
}

type Section = "aparencia" | "personalizacao" | "pagamento" | "conta";

const SECTIONS: { id: Section; label: string; icon: typeof Palette }[] = [
  { id: "aparencia", label: "Aparência", icon: Palette },
  { id: "personalizacao", label: "Personalização", icon: SlidersHorizontal },
  { id: "pagamento", label: "Pagamento", icon: CreditCard },
  { id: "conta", label: "Dados da conta", icon: UserCog },
];

// Valores de design-tokens.md § Temas de cor — contraste medido sobre
// #FFFFFF, todas AA pra texto normal. "aco" é a paleta padrão (mesma do
// resto do app quando nenhuma paleta foi escolhida ainda).
const PALETTES: { id: AccentPalette; label: string; primary: string; hover: string; tint: string; contrast: string }[] = [
  { id: "aco", label: "Aço", primary: "#3F5F80", hover: "#2C4460", tint: "#EEF2F7", contrast: "6,7:1 · AA" },
  { id: "petroleo", label: "Petróleo", primary: "#1F5F5B", hover: "#164744", tint: "#E9F2F1", contrast: "7,5:1 · AA" },
  { id: "indigo", label: "Índigo", primary: "#4A4F8C", hover: "#383C6E", tint: "#EEEFF7", contrast: "7,5:1 · AA" },
  { id: "terracota", label: "Terracota", primary: "#8A4A2F", hover: "#6B3823", tint: "#F8EFEA", contrast: "6,8:1 · AA" },
];

const FONT_SIZES: { id: FontSizePreset; label: string; sample: string; body: string }[] = [
  { id: "compact", label: "Compacto", sample: "0.86rem", body: "13px" },
  { id: "standard", label: "Padrão", sample: "1rem", body: "14px" },
  { id: "large", label: "Grande", sample: "1.16rem", body: "16px" },
];

const THEME_MODES: { id: ThemeMode; label: string }[] = [
  { id: "light", label: "Claro" },
  { id: "dark", label: "Escuro" },
  { id: "system", label: "Sistema" },
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
    text: "curva de sensibilidade de preço e histograma de margem, ao lado dos números.",
  },
  {
    key: "chartsResults",
    title: "Gráficos na tela de Resultados",
    text: "barra de margem por linha e faixa de distribuição no topo da tabela.",
  },
  {
    key: "compareEnginesSideBySide",
    title: "Comparar mecanismos lado a lado",
    text: "ao buscar em 2 marketplaces, mostra 2 colunas de preço + diferença em vez de 1 linha por oferta.",
  },
  {
    key: "groupOffersBySku",
    title: "Agrupar ofertas por SKU",
    text: "1 produto por linha, com as ofertas individuais recolhidas embaixo.",
  },
];

const cardMotion = {
  initial: { opacity: 0, y: 8 },
  animate: { opacity: 1, y: 0 },
  transition: { duration: 0.3, ease: [0.16, 1, 0.3, 1] as const },
};

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

export default function Settings({ preferences, onUpdatePreferences, user, profile }: Props) {
  const [section, setSection] = useState<Section>("aparencia");
  const plan = getPlan(profile?.plan);

  return (
    <motion.div className={styles.container} {...cardMotion}>
      <div className={styles.header}>
        <span className={styles.eyebrow}>Preferências</span>
        <h1 className={styles.title}>Configurações</h1>
        <p className={styles.subtitle}>
          Cada seção é independente — mexer numa não afeta as outras.
        </p>
      </div>

      <div className={styles.layout}>
        <nav className={styles.sectionNav}>
          {SECTIONS.map((s) => {
            const Icon = s.icon;
            const active = section === s.id;
            return (
              <button
                key={s.id}
                type="button"
                className={active ? styles.sectionItemActive : styles.sectionItem}
                onClick={() => setSection(s.id)}
              >
                <Icon size={15} strokeWidth={2} />
                {s.label}
              </button>
            );
          })}
        </nav>

        <div className={styles.sectionBody}>
          {section === "aparencia" && (
            <AparenciaSection preferences={preferences} onUpdatePreferences={onUpdatePreferences} />
          )}
          {section === "personalizacao" && (
            <PersonalizacaoSection preferences={preferences} onUpdatePreferences={onUpdatePreferences} />
          )}
          {section === "pagamento" && <PagamentoSection planName={plan.name} priceLabel={plan.priceLabel} />}
          {section === "conta" && <ContaSection user={user} />}
        </div>
      </div>
    </motion.div>
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
    <>
      <section className={styles.card}>
        <div className={styles.cardHeader}>
          <h2 className={styles.cardHeaderTitle}>Paleta</h2>
          <span className={styles.cardHeaderMeta}>acento — neutros e status não mudam</span>
        </div>
        <div className={styles.cardBody}>
          <div className={styles.paletteGrid}>
            {PALETTES.map((p) => {
              const active = preferences.accent === p.id;
              return (
                <button
                  key={p.id}
                  type="button"
                  className={active ? styles.paletteCardActive : styles.paletteCard}
                  onClick={() => onUpdatePreferences({ accent: p.id })}
                >
                  <span className={styles.paletteSwatches}>
                    <span className={styles.swatch} style={{ background: p.primary }} />
                    <span className={styles.swatch} style={{ background: p.hover }} />
                    <span className={styles.swatch} style={{ background: p.tint, border: "1px solid var(--color-border)" }} />
                  </span>
                  <span className={styles.paletteLabel}>{p.label}</span>
                  <span className={styles.paletteContrast}>{p.contrast}</span>
                  {active && (
                    <span className={styles.paletteCheck}>
                      <Check size={11} strokeWidth={3} />
                    </span>
                  )}
                </button>
              );
            })}
          </div>
        </div>
      </section>

      <section className={styles.card}>
        <div className={styles.cardHeader}>
          <h2 className={styles.cardHeaderTitle}>Tamanho do texto</h2>
        </div>
        <div className={styles.cardBody}>
          <div className={styles.fontSizeGrid}>
            {FONT_SIZES.map((f) => {
              const active = preferences.fontSize === f.id;
              return (
                <button
                  key={f.id}
                  type="button"
                  className={active ? styles.fontSizeCardActive : styles.fontSizeCard}
                  onClick={() => onUpdatePreferences({ fontSize: f.id })}
                >
                  <span className={styles.fontSizeSample} style={{ fontSize: f.sample }}>
                    Aa
                  </span>
                  <span className={styles.fontSizeLabel}>{f.label}</span>
                  <span className={styles.fontSizeMeta}>{f.body} de corpo</span>
                </button>
              );
            })}
          </div>
        </div>
      </section>

      <section className={styles.card}>
        <div className={styles.cardHeader}>
          <h2 className={styles.cardHeaderTitle}>Modo</h2>
        </div>
        <div className={styles.cardBody}>
          <div className={styles.modeRow}>
            {THEME_MODES.map((m) => (
              <button
                key={m.id}
                type="button"
                className={preferences.themeMode === m.id ? styles.modeButtonActive : styles.modeButton}
                onClick={() => onUpdatePreferences({ themeMode: m.id })}
              >
                {m.label}
              </button>
            ))}
          </div>
        </div>
      </section>
    </>
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
    <section className={styles.card}>
      <div className={styles.cardHeader}>
        <h2 className={styles.cardHeaderTitle}>Personalização</h2>
        <span className={styles.cardHeaderMeta}>a leitura numérica nunca depende só do gráfico</span>
      </div>
      <div className={styles.toggleList}>
        {PERSONALIZATION_TOGGLES.map((t) => (
          <div key={t.key} className={styles.toggleRow}>
            <span className={styles.toggleText}>
              <span className={styles.toggleTitle}>{t.title}</span>
              <span className={styles.toggleSub}>{t.text}</span>
            </span>
            <Switch
              on={preferences[t.key]}
              onToggle={() => onUpdatePreferences({ [t.key]: !preferences[t.key] })}
              label={t.title}
            />
          </div>
        ))}
      </div>
    </section>
  );
}

function PagamentoSection({ planName, priceLabel }: { planName: string; priceLabel: string }) {
  return (
    <section className={styles.card}>
      <div className={styles.cardHeader}>
        <h2 className={styles.cardHeaderTitle}>Pagamento</h2>
        <span className={styles.statusPillWarning}>em preparação</span>
      </div>
      <div className={styles.cardBody}>
        <p className={styles.cardIntro}>
          Cobrança automática ainda não está ativa neste app. Hoje o plano é atribuído manualmente
          (painel Admin) — quando a cobrança entrar em produção, esta tela passa a gerenciar cartão
          e fatura.
        </p>
        <div className={styles.infoGrid}>
          <div className={styles.infoGridRow}>
            <span className={styles.infoGridLabel}>plano atual</span>
            <span className={styles.infoGridValue}>
              {planName} · {priceLabel}
            </span>
          </div>
          <div className={styles.infoGridRow}>
            <span className={styles.infoGridLabel}>forma de pagamento</span>
            <span className={styles.infoGridValue}>—</span>
          </div>
          <div className={styles.infoGridRow}>
            <span className={styles.infoGridLabel}>próxima cobrança</span>
            <span className={styles.infoGridValue}>—</span>
          </div>
        </div>
        <button type="button" className={styles.primaryButton} disabled title="Ainda não disponível">
          Gerenciar assinatura
        </button>
      </div>
    </section>
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
      await changeEmail(emailPassword, newEmail);
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
      await deleteAccount(deletePassword);
    } catch (err) {
      setDeleteError(err instanceof Error ? err.message : String(err));
      setDeleting(false);
    }
  }

  return (
    <>
      <section className={styles.card}>
        <div className={styles.cardHeader}>
          <h2 className={styles.cardHeaderTitle}>Trocar senha</h2>
        </div>
        <form className={styles.cardBody} onSubmit={handleChangePassword}>
          <label className={styles.field}>
            <span className={styles.fieldLabel}>senha atual</span>
            <input
              className={styles.input}
              type="password"
              value={currentPassword}
              onChange={(e) => setCurrentPassword(e.target.value)}
              autoComplete="current-password"
              required
            />
          </label>
          <label className={styles.field}>
            <span className={styles.fieldLabel}>nova senha</span>
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
            <span className={styles.fieldLabel}>repetir nova senha</span>
            <input
              className={styles.input}
              type="password"
              value={confirmPassword}
              onChange={(e) => setConfirmPassword(e.target.value)}
              autoComplete="new-password"
              required
            />
          </label>
          <button className={styles.primaryButton} type="submit" disabled={savingPassword}>
            {savingPassword ? <Loader2 size={14} className="spin" /> : null}
            {savingPassword ? "Salvando…" : "Trocar senha"}
          </button>
          {passwordMsg && <p className={styles.successText}>{passwordMsg}</p>}
          {passwordError && <p className={styles.errorText}>{passwordError}</p>}
        </form>
      </section>

      <section className={styles.card}>
        <div className={styles.cardHeader}>
          <h2 className={styles.cardHeaderTitle}>Trocar email de acesso</h2>
        </div>
        <div className={styles.cardBody}>
          <div className={styles.infoGridRow}>
            <span className={styles.infoGridLabel}>email atual</span>
            <span className={styles.infoGridValue}>{user?.email ?? "—"}</span>
          </div>
          {!showEmailForm ? (
            <button type="button" className={styles.secondaryButton} onClick={() => setShowEmailForm(true)}>
              Alterar
            </button>
          ) : (
            <form className={styles.inlineForm} onSubmit={handleChangeEmail}>
              <label className={styles.field}>
                <span className={styles.fieldLabel}>novo email</span>
                <input
                  className={styles.input}
                  type="email"
                  value={newEmail}
                  onChange={(e) => setNewEmail(e.target.value)}
                  required
                />
              </label>
              <label className={styles.field}>
                <span className={styles.fieldLabel}>senha atual (confirmação)</span>
                <input
                  className={styles.input}
                  type="password"
                  value={emailPassword}
                  onChange={(e) => setEmailPassword(e.target.value)}
                  autoComplete="current-password"
                  required
                />
              </label>
              <div className={styles.inlineFormActions}>
                <button className={styles.primaryButton} type="submit" disabled={savingEmail}>
                  {savingEmail ? "Enviando…" : "Enviar confirmação"}
                </button>
                <button
                  type="button"
                  className={styles.linkButton}
                  onClick={() => setShowEmailForm(false)}
                  disabled={savingEmail}
                >
                  Cancelar
                </button>
              </div>
            </form>
          )}
          {emailMsg && <p className={styles.successText}>{emailMsg}</p>}
          {emailError && <p className={styles.errorText}>{emailError}</p>}
        </div>
      </section>

      <section className={styles.dangerCard}>
        <div className={styles.cardHeader}>
          <h2 className={styles.cardHeaderTitle}>Excluir conta</h2>
        </div>
        <div className={styles.cardBody}>
          <p className={styles.cardIntro}>
            <AlertTriangle size={13} style={{ verticalAlign: "-2px", marginRight: 4 }} />
            Apaga o login e o perfil salvo. Catálogos e histórico processados ficam órfãos no banco
            — não tem como desfazer pelo app.
          </p>
          {!showDeleteForm ? (
            <button type="button" className={styles.dangerButton} onClick={() => setShowDeleteForm(true)}>
              Excluir conta
            </button>
          ) : (
            <form className={styles.inlineForm} onSubmit={handleDeleteAccount}>
              <label className={styles.field}>
                <span className={styles.fieldLabel}>confirme sua senha</span>
                <input
                  className={styles.input}
                  type="password"
                  value={deletePassword}
                  onChange={(e) => setDeletePassword(e.target.value)}
                  autoComplete="current-password"
                  required
                />
              </label>
              <div className={styles.inlineFormActions}>
                <button className={styles.dangerButton} type="submit" disabled={deleting}>
                  {deleting ? "Excluindo…" : "Confirmar exclusão"}
                </button>
                <button
                  type="button"
                  className={styles.linkButton}
                  onClick={() => setShowDeleteForm(false)}
                  disabled={deleting}
                >
                  Cancelar
                </button>
              </div>
              {deleteError && <p className={styles.errorText}>{deleteError}</p>}
            </form>
          )}
        </div>
      </section>

      <section className={styles.card}>
        <div className={styles.cardBody}>
          <button className={styles.linkButton} type="button" onClick={() => void signOutUser()}>
            sair desta conta
          </button>
        </div>
      </section>
    </>
  );
}
