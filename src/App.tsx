import { useEffect, useRef, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import type {
  CatalogRow,
  MarginResult,
  MarketplaceId,
  MarketplacePriceResult,
  PricingRules,
  Screen,
} from "./types";
import { subscribeToAuth, type AuthUser } from "./lib/auth";
import { ensureUserProfile, type UserProfile } from "./lib/userProfile";
import { listCatalogUploads } from "./lib/catalogHistory";
import { loadPricingRules, savePricingRules } from "./lib/pricingRulesStore";
import { DEFAULT_PRICING_RULES, calculateMargins } from "./lib/marginCalculator";
import { applyTheme, getInitialTheme, type Theme } from "./lib/theme";
import Sidebar from "./components/Sidebar";
import Dashboard, { type DashboardResult } from "./components/Dashboard";
import PricingConfig from "./components/PricingConfig";
import ResultsTable from "./components/ResultsTable";
import Account from "./components/Account";
import Admin from "./components/Admin";

export default function App() {
  const [screen, setScreen] = useState<Screen>("dashboard");
  const [user, setUser] = useState<AuthUser | null>(null);
  const [profile, setProfile] = useState<UserProfile | null>(null);
  const [pricingRules, setPricingRules] = useState<PricingRules>(DEFAULT_PRICING_RULES);

  const [catalogRows, setCatalogRows] = useState<CatalogRow[]>([]);
  const [pricesByMarket, setPricesByMarket] = useState<
    Partial<Record<MarketplaceId, Record<string, MarketplacePriceResult>>>
  >({});
  const [results, setResults] = useState<MarginResult[]>([]);
  const [source, setSource] = useState<"server" | "local" | null>(null);

  const [theme, setTheme] = useState<Theme>(() => getInitialTheme());
  useEffect(() => applyTheme(theme), [theme]);

  useEffect(() => subscribeToAuth(setUser), []);

  useEffect(() => {
    loadPricingRules(user?.uid ?? null).then(setPricingRules);
  }, [user]);

  // Perfil (plano + isAdmin) — busca/cria junto com o login, não faz
  // parte do AuthUser do Firebase Auth (isso vem de `users/{uid}` no
  // Firestore, ver lib/userProfile.ts).
  useEffect(() => {
    if (!user) {
      setProfile(null);
      return;
    }
    ensureUserProfile(user.uid, user.email).then(setProfile);
  }, [user]);

  // Restaura a última busca salva ao logar — inclusive no F5, já que o
  // Firebase Auth restaura a sessão sozinho e dispara `subscribeToAuth`
  // de novo com o mesmo usuário. Sem isso, atualizar a página jogava
  // fora catalogRows/results (só existiam em memória). Reaproveita o
  // MESMO histórico que já é salvo a cada busca (catalog_uploads, ver
  // catalogHistory.ts) — não é um mecanismo novo de persistência.
  // `skipRestoreRef` evita sobrescrever uma busca recém-feita nesta
  // sessão com um resultado mais antigo, caso a promise resolva depois
  // do usuário já ter processado um catálogo novo.
  const skipRestoreRef = useRef(false);
  useEffect(() => {
    if (!user) return;
    listCatalogUploads(user.uid).then((history) => {
      if (skipRestoreRef.current) return;
      const latest = history[0];
      if (latest) {
        setCatalogRows(latest.rows);
        setPricesByMarket(latest.pricesByMarket);
        setResults(latest.results);
        setSource(latest.source);
      }
    });
  }, [user]);

  function handleDashboardComplete(data: DashboardResult) {
    skipRestoreRef.current = true;
    setCatalogRows(data.rows);
    setPricesByMarket(data.pricesByMarket);
    setResults(data.results);
    setSource(data.source);
    setScreen("results");
  }

  function handlePricingChange(newRules: PricingRules) {
    setPricingRules(newRules);
    void savePricingRules(user?.uid ?? null, newRules);

    if (catalogRows.length > 0) {
      // Recalcula margem pra cada marketplace comparado, sem re-buscar preço.
      const recalculated = Object.values(pricesByMarket).flatMap((priceMap) =>
        priceMap ? calculateMargins(catalogRows, priceMap, newRules) : []
      );
      setResults(recalculated);
    }
  }

  return (
    <div className="app-shell">
      <Sidebar
        active={screen}
        onChange={setScreen}
        resultsCount={results.length}
        theme={theme}
        onToggleTheme={() => setTheme((t) => (t === "dark" ? "light" : "dark"))}
        isAdmin={profile?.isAdmin ?? false}
      />
      <main className="app-shell__main">
        <AnimatePresence mode="wait">
          <motion.div
            key={screen}
<<<<<<< HEAD
            className="app-shell__content"
=======
<<<<<<< HEAD
            className="app-shell__content"
=======
>>>>>>> 7c481fb27bc9373aac5d889f1743cdf12b977510
>>>>>>> 876d06fbe516a280c102d8517ac760291de86799
            initial={{ opacity: 0, y: 6 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -6 }}
            transition={{ duration: 0.2, ease: [0.16, 1, 0.3, 1] }}
          >
            {screen === "dashboard" && (
              <Dashboard
                rules={pricingRules}
                userId={user?.uid ?? null}
                profile={profile}
                onComplete={handleDashboardComplete}
              />
            )}
            {screen === "pricing" && (
              <PricingConfig
                rules={pricingRules}
                onChange={handlePricingChange}
                catalogRows={catalogRows}
                pricesByMarket={pricesByMarket}
              />
            )}
            {screen === "results" && (
              <ResultsTable
                results={results}
                targetMarginPct={pricingRules.targetMarginPct}
                source={source}
              />
            )}
<<<<<<< HEAD
            {screen === "account" && <Account user={user} profile={profile} />}
=======
<<<<<<< HEAD
            {screen === "account" && <Account user={user} profile={profile} />}
=======
            {screen === "account" && <Account user={user} />}
>>>>>>> 7c481fb27bc9373aac5d889f1743cdf12b977510
>>>>>>> 876d06fbe516a280c102d8517ac760291de86799
            {screen === "admin" && <Admin profile={profile} />}
          </motion.div>
        </AnimatePresence>
      </main>
    </div>
  );
}
