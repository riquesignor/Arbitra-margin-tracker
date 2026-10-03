import { useEffect, useState } from "react";
import {
  Home as HomeIcon,
  LayoutDashboard,
  SlidersHorizontal,
  BarChart3,
  PackageSearch,
  Truck,
  UserRound,
  Boxes,
  Sun,
  Moon,
  ShieldCheck,
  ChevronDown,
  Settings as SettingsIcon,
  HelpCircle,
  Bell,
} from "lucide-react";
import type { Screen } from "../types";
import type { Theme } from "../lib/theme";
import { listUnreadAlerts, markAlertRead, type WatchAlert } from "../lib/watchlist";
import styles from "./TopNav.module.css";

const ALERT_KIND_LABEL: Record<WatchAlert["kind"], string> = {
  price_down: "preço caiu",
  price_up: "preço subiu",
  out_of_stock: "esgotou",
  back_in_stock: "voltou ao estoque",
};

interface Props {
  active: Screen;
  onChange: (screen: Screen) => void;
  resultsCount?: number;
  theme: Theme;
  onToggleTheme: () => void;
  isAdmin?: boolean;
  /** Email do usuário logado — vira o nome exibido no bloco de conta (ver `accountLabel` abaixo). Sem login: mostra "convidado". */
  userEmail?: string | null;
  /** Sino de alertas de monitoramento (ver src/lib/watchlist.ts) — `null`/ausente sem login. */
  userId?: string | null;
}

const NAV_ITEMS: { screen: Screen; icon: typeof LayoutDashboard; label: string }[] = [
  { screen: "home", icon: HomeIcon, label: "Início" },
  // Rótulo "Nova busca" — nome de tela interno segue "dashboard" (ver
  // types/index.ts), só a navegação passou a chamar o que antes era
  // "Dashboard" de outra forma: agora é só a etapa operacional de
  // configurar e rodar uma busca, com a Home cuidando do que antes era
  // a tela de chegada (histórico resumido, biblioteca, atalhos).
  { screen: "dashboard", icon: LayoutDashboard, label: "Nova busca" },
  { screen: "pricing", icon: SlidersHorizontal, label: "Precificação" },
  { screen: "results", icon: BarChart3, label: "Resultados" },
  { screen: "portfolio", icon: PackageSearch, label: "Meus produtos" },
  { screen: "suppliers", icon: Truck, label: "Fornecedores" },
];

/** Nome curto pra saudação/avatar a partir do email — não há displayName no AuthUser (ver lib/auth.ts). */
function accountLabel(email?: string | null): string {
  if (!email) return "convidado";
  const local = email.split("@")[0] ?? email;
  return local.charAt(0).toUpperCase() + local.slice(1);
}

/** Estado real da conexão (antes o indicador dizia "online" fixo, sempre). */
function useOnlineStatus(): boolean {
  const [online, setOnline] = useState(() => (typeof navigator === "undefined" ? true : navigator.onLine));
  useEffect(() => {
    const up = () => setOnline(true);
    const down = () => setOnline(false);
    window.addEventListener("online", up);
    window.addEventListener("offline", down);
    return () => {
      window.removeEventListener("online", up);
      window.removeEventListener("offline", down);
    };
  }, []);
  return online;
}

export default function TopNav({
  active,
  onChange,
  resultsCount,
  theme,
  onToggleTheme,
  isAdmin,
  userEmail,
  userId = null,
}: Props) {
  const name = accountLabel(userEmail);
  const online = useOnlineStatus();
  const [alerts, setAlerts] = useState<WatchAlert[]>([]);
  const [alertsOpen, setAlertsOpen] = useState(false);
  useEffect(() => {
    void listUnreadAlerts(userId).then(setAlerts);
    // Recarrega a cada troca de tela — jeito barato de refletir um alerta
    // novo (ex.: acabou de clicar "checar agora" em Meus produtos) sem
    // precisar de polling nem de um canal de evento entre telas.
  }, [userId, active]);

  async function handleOpenAlert(alert: WatchAlert) {
    if (!userId) return;
    setAlerts((prev) => prev.filter((a) => a.id !== alert.id));
    await markAlertRead(userId, alert.id);
  }

  return (
    <header className={styles.topnav}>
      <div className={styles.brandRow}>
        <span className={styles.brandMark}>
          <Boxes size={15} strokeWidth={2.5} />
        </span>
        <span className={styles.brand}>Arbitra</span>
      </div>

      <nav className={styles.nav}>
        {NAV_ITEMS.map((item) => {
          const Icon = item.icon;
          const isActive = active === item.screen;
          return (
            <button
              key={item.screen}
              type="button"
              className={isActive ? styles.navItemActive : styles.navItem}
              onClick={() => onChange(item.screen)}
            >
              <span className={styles.navIcon}>
                <Icon size={16} strokeWidth={2} />
              </span>
              {item.label}
              {item.screen === "results" && !!resultsCount && (
                <span className={styles.badge}>{resultsCount}</span>
              )}
            </button>
          );
        })}
      </nav>

      <div className={styles.rightCluster}>
        <button
          type="button"
          className={styles.iconButton}
          onClick={onToggleTheme}
          aria-label={theme === "dark" ? "Mudar pro modo claro" : "Mudar pro modo escuro"}
          title={theme === "dark" ? "Modo claro" : "Modo escuro"}
        >
          {theme === "dark" ? <Sun size={15} strokeWidth={2} /> : <Moon size={15} strokeWidth={2} />}
        </button>

        <button
          type="button"
          className={active === "settings" ? styles.iconButtonActive : styles.iconButton}
          onClick={() => onChange("settings")}
          aria-label="Configurações"
          title="Configurações"
        >
          <SettingsIcon size={15} strokeWidth={2} />
        </button>

        <button
          type="button"
          className={active === "faq" ? styles.iconButtonActive : styles.iconButton}
          onClick={() => onChange("faq")}
          aria-label="Perguntas frequentes"
          title="Perguntas frequentes"
        >
          <HelpCircle size={15} strokeWidth={2} />
        </button>

        {userId && (
          <span className={styles.alertWrap}>
            <button
              type="button"
              className={alerts.length > 0 ? styles.iconButtonActive : styles.iconButton}
              onClick={() => setAlertsOpen((v) => !v)}
              aria-label="Alertas de monitoramento"
              title={alerts.length > 0 ? `${alerts.length} alerta(s) não lido(s)` : "Nenhum alerta novo"}
            >
              <Bell size={15} strokeWidth={2} />
              {alerts.length > 0 && <span className={styles.alertDot}>{alerts.length}</span>}
            </button>
            {alertsOpen && (
              <>
                <div className={styles.alertBackdrop} onClick={() => setAlertsOpen(false)} />
                <div className={styles.alertPanel}>
                  {alerts.length === 0 ? (
                    <p className={styles.alertEmpty}>Nenhum alerta novo — produtos monitorados sem mudança.</p>
                  ) : (
                    alerts.map((alert) => (
                      <button
                        key={alert.id}
                        type="button"
                        className={styles.alertItem}
                        onClick={() => void handleOpenAlert(alert)}
                      >
                        <span className={styles.alertItemKind}>{ALERT_KIND_LABEL[alert.kind]}</span>
                        <span className={styles.alertItemName}>{alert.name}</span>
                        {alert.oldPrice != null && alert.newPrice != null && (
                          <span className={styles.alertItemPrice}>
                            R$ {alert.oldPrice.toFixed(2)} → R$ {alert.newPrice.toFixed(2)}
                          </span>
                        )}
                      </button>
                    ))
                  )}
                </div>
              </>
            )}
          </span>
        )}

        <span
          className={styles.statusRow}
          title={
            online
              ? "Conectado à internet — buscas e salvamento funcionando"
              : "Sem conexão — buscas e salvamento ficam indisponíveis até voltar"
          }
        >
          <span className={online ? styles.statusDot : styles.statusDotOffline} />
          {online ? "online" : "offline"}
        </span>

        <span className={styles.separator} />

        {isAdmin && (
          <button
            type="button"
            className={active === "admin" ? styles.navItemActive : styles.navItem}
            onClick={() => onChange("admin")}
          >
            <span className={styles.navIcon}>
              <ShieldCheck size={16} strokeWidth={2} />
            </span>
            Admin
          </button>
        )}

        <button
          type="button"
          className={styles.accountButton}
          onClick={() => onChange("account")}
        >
          <span className={styles.avatar}>
            <UserRound size={13} strokeWidth={2.5} />
          </span>
          <span className={styles.accountName}>{name}</span>
          <ChevronDown size={13} strokeWidth={2} />
        </button>
      </div>
    </header>
  );
}
