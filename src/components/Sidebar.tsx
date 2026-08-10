import { motion } from "framer-motion";
import {
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
} from "lucide-react";
import type { Screen } from "../types";
import type { Theme } from "../lib/theme";
import styles from "./Sidebar.module.css";

interface Props {
  active: Screen;
  onChange: (screen: Screen) => void;
  resultsCount?: number;
  theme: Theme;
  onToggleTheme: () => void;
  isAdmin?: boolean;
}

const NAV_ITEMS: { screen: Screen; icon: typeof LayoutDashboard; label: string }[] = [
  { screen: "dashboard", icon: LayoutDashboard, label: "Dashboard" },
  { screen: "pricing", icon: SlidersHorizontal, label: "Precificação" },
  { screen: "results", icon: BarChart3, label: "Resultados" },
  { screen: "portfolio", icon: PackageSearch, label: "Meus produtos" },
  { screen: "suppliers", icon: Truck, label: "Fornecedores" },
];

export default function Sidebar({
  active,
  onChange,
  resultsCount,
  theme,
  onToggleTheme,
  isAdmin,
}: Props) {
  return (
    <aside className={styles.sidebar}>
      <div>
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
                {isActive && (
                  <motion.span
                    layoutId="sidebar-active-pill"
                    className={styles.activePill}
                    transition={{ type: "spring", stiffness: 500, damping: 40 }}
                  />
                )}
                <span className={styles.navIcon}>
                  <Icon size={17} strokeWidth={2} />
                </span>
                <span style={{ position: "relative" }}>{item.label}</span>
                {item.screen === "results" && !!resultsCount && (
                  <span className={styles.badge} style={{ position: "relative" }}>
                    {resultsCount}
                  </span>
                )}
              </button>
            );
          })}
        </nav>
      </div>

      <div className={styles.footer}>
        {isAdmin && (
          <button
            type="button"
            className={active === "admin" ? styles.navItemActive : styles.navItem}
            onClick={() => onChange("admin")}
          >
            {active === "admin" && (
              <motion.span
                layoutId="sidebar-active-pill"
                className={styles.activePill}
                transition={{ type: "spring", stiffness: 500, damping: 40 }}
              />
            )}
            <span className={styles.navIcon}>
              <ShieldCheck size={17} strokeWidth={2} />
            </span>
            <span style={{ position: "relative" }}>Admin</span>
          </button>
        )}

        <button
          type="button"
          className={active === "account" ? styles.navItemActive : styles.navItem}
          onClick={() => onChange("account")}
        >
          {active === "account" && (
            <motion.span
              layoutId="sidebar-active-pill"
              className={styles.activePill}
              transition={{ type: "spring", stiffness: 500, damping: 40 }}
            />
          )}
          <span className={styles.navIcon}>
            <UserRound size={17} strokeWidth={2} />
          </span>
          <span style={{ position: "relative" }}>Conta</span>
        </button>

        <button
          type="button"
          className={styles.themeToggle}
          onClick={onToggleTheme}
          aria-label={theme === "dark" ? "Mudar pro modo claro" : "Mudar pro modo escuro"}
        >
          <span className={styles.navIcon}>
            {theme === "dark" ? <Sun size={15} strokeWidth={2} /> : <Moon size={15} strokeWidth={2} />}
          </span>
          {theme === "dark" ? "Modo claro" : "Modo escuro"}
        </button>

        <div className={styles.statusRow}>
          <span className={styles.statusDot} />
          <span>online</span>
        </div>
      </div>
    </aside>
  );
}
