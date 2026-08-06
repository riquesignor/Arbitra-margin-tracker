import {
  Home as HomeIcon,
  LayoutDashboard,
  SlidersHorizontal,
  BarChart3,
  UserRound,
  Boxes,
  Sun,
  Moon,
  ShieldCheck,
  ChevronDown,
} from "lucide-react";
import type { Screen } from "../types";
import type { Theme } from "../lib/theme";
import styles from "./TopNav.module.css";

interface Props {
  active: Screen;
  onChange: (screen: Screen) => void;
  resultsCount?: number;
  theme: Theme;
  onToggleTheme: () => void;
  isAdmin?: boolean;
  /** Email do usuário logado — vira o nome exibido no bloco de conta (ver `accountLabel` abaixo). Sem login: mostra "convidado". */
  userEmail?: string | null;
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
];

/** Nome curto pra saudação/avatar a partir do email — não há displayName no AuthUser (ver lib/auth.ts). */
function accountLabel(email?: string | null): string {
  if (!email) return "convidado";
  const local = email.split("@")[0] ?? email;
  return local.charAt(0).toUpperCase() + local.slice(1);
}

export default function TopNav({
  active,
  onChange,
  resultsCount,
  theme,
  onToggleTheme,
  isAdmin,
  userEmail,
}: Props) {
  const name = accountLabel(userEmail);

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

        <span className={styles.statusRow}>
          <span className={styles.statusDot} />
          online
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
