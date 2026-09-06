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
import { listCatalogUploads, type CatalogUploadRecord } from "./lib/catalogHistory";
import type { SharedCatalog } from "./lib/sharedCatalogs";
import { loadPricingRules, savePricingRules } from "./lib/pricingRulesStore";
import { DEFAULT_PRICING_RULES, calculateMargins } from "./lib/marginCalculator";
import { applyAccent, applyFontSize, applyTheme, getInitialTheme, resolveThemeMode, type Theme } from "./lib/theme";
import {
  DEFAULT_PREFERENCES,
  loadUserPreferences,
  saveUserPreferences,
  type UserPreferences,
} from "./lib/userPreferences";
import TopNav from "./components/TopNav";
import Home from "./components/Home";
import Dashboard, { type DashboardResult } from "./components/Dashboard";
import PricingConfig from "./components/PricingConfig";
import ResultsTable from "./components/ResultsTable";
import Portfolio from "./components/Portfolio";
import SupplierCompare from "./components/SupplierCompare";
import Account from "./components/Account";
import Settings from "./components/Settings";
import Admin from "./components/Admin";
import Faq from "./components/Faq";
import DoubtToast from "./components/DoubtToast";

export default function App() {
  // "home" — tela de entrada (ver docs/design-critique-log.md, Session
  // 4): resumo do que já foi processado + atalho pra Nova busca (a
  // Dashboard atual, agora só operacional). Landing screen padrão no
  // lugar do antigo "dashboard".
  const [screen, setScreen] = useState<Screen>("home");
  const [user, setUser] = useState<AuthUser | null>(null);
  const [profile, setProfile] = useState<UserProfile | null>(null);
  const [pricingRules, setPricingRules] = useState<PricingRules>(DEFAULT_PRICING_RULES);

  const [catalogRows, setCatalogRows] = useState<CatalogRow[]>([]);
  const [pricesByMarket, setPricesByMarket] = useState<
    Partial<Record<MarketplaceId, Record<string, MarketplacePriceResult>>>
  >({});
  const [results, setResults] = useState<MarginResult[]>([]);
  const [source, setSource] = useState<"server" | "local" | null>(null);

  // Histórico completo do usuário (não só o mais recente, ver efeito de
  // restauro abaixo) — alimenta o seletor "qual busca ver" em
  // Precificação e Resultados (feature pedida: escolher entre buscas já
  // feitas sem precisar voltar pro Dashboard). `activeHistoryId` é null
  // quando o que está em tela é o resultado mais recente desta sessão
  // (recém-processado ou restaurado no login) e ainda não foi trocado
  // manualmente pelo seletor.
  const [history, setHistory] = useState<CatalogUploadRecord[]>([]);
  const [activeHistoryId, setActiveHistoryId] = useState<string | null>(null);
  // Seleção MÚLTIPLA do histórico, só usada pela tela de Resultados (ver
  // handleSelectHistoryMultiple abaixo e o seletor em ResultsTable.tsx) —
  // "processei 5 catálogos, quero ver só 3 combinados". Fica em sincronia
  // com `activeHistoryId` (0 ou 1 item = mesma coisa que o single-select
  // de sempre), mas existe separado porque Precificação (PricingConfig)
  // continua só single-select — combinar pricesByMarket de catálogos
  // diferentes ali não faria sentido (a tela recalcula margem em cima de
  // UM mapa de preço só).
  const [selectedHistoryIds, setSelectedHistoryIds] = useState<string[]>([]);

  // Catálogo da biblioteca escolhido em "usar" na Home (ver Home.tsx) —
  // a biblioteca em si só mora na Home agora; isto é só o gatilho pra
  // Dashboard processar sem reabrir a lista lá (ver Dashboard.tsx).
  const [pendingSharedCatalog, setPendingSharedCatalog] = useState<SharedCatalog | null>(null);

  // Preferências de UI (Configurações → Aparência/Personalização + as
  // opcionais da tela Conta, ver lib/userPreferences.ts). `resolvedTheme`
  // é o valor JÁ resolvido de `preferences.themeMode` (light/dark, nunca
  // "system" — ver resolveThemeMode em lib/theme.ts), o que a barra
  // superior de fato usa pro ícone sol/lua.
  const [preferences, setPreferences] = useState<UserPreferences>(DEFAULT_PREFERENCES);
  const [resolvedTheme, setResolvedTheme] = useState<Theme>(() => getInitialTheme());

  useEffect(() => {
    loadUserPreferences(user?.uid ?? null).then(setPreferences);
  }, [user]);

  useEffect(() => {
    const resolved = resolveThemeMode(preferences.themeMode);
    setResolvedTheme(resolved);
    applyTheme(resolved);
    applyAccent(preferences.accent);
    applyFontSize(preferences.fontSize);
  }, [preferences]);

  // "Sistema" acompanha o SO em tempo real, sem precisar de reload —
  // só o listener importa quando o modo escolhido é "system" (light/dark
  // explícitos não mudam com o SO).
  useEffect(() => {
    if (preferences.themeMode !== "system" || typeof window === "undefined") return;
    const mq = window.matchMedia("(prefers-color-scheme: light)");
    const handler = () => {
      const resolved = resolveThemeMode("system");
      setResolvedTheme(resolved);
      applyTheme(resolved);
    };
    mq.addEventListener("change", handler);
    return () => mq.removeEventListener("change", handler);
  }, [preferences.themeMode]);

  /** Atualiza e persiste um subconjunto de preferências — usado pelo toggle rápido da TopNav e pela tela Configurações. */
  function updatePreferences(partial: Partial<UserPreferences>) {
    setPreferences((prev) => {
      const next = { ...prev, ...partial };
      void saveUserPreferences(user?.uid ?? null, next);
      return next;
    });
  }

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
    if (!user) {
      setHistory([]);
      return;
    }
    listCatalogUploads(user.uid).then((fetchedHistory) => {
      setHistory(fetchedHistory);
      if (skipRestoreRef.current) return;
      const latest = fetchedHistory[0];
      if (latest) {
        setCatalogRows(latest.rows);
        setPricesByMarket(latest.pricesByMarket);
        setResults(latest.results);
        setSource(latest.source);
        setActiveHistoryId(latest.id);
        setSelectedHistoryIds([latest.id]);
      }
    });
  }, [user]);

  function handleDashboardComplete(data: DashboardResult) {
    skipRestoreRef.current = true;
    setCatalogRows(data.rows);
    setPricesByMarket(data.pricesByMarket);
    setResults(data.results);
    setSource(data.source);
    setActiveHistoryId(null);
    setSelectedHistoryIds([]);
    setScreen("results");
  }

  /**
   * Ver comentário de `onProgress` em Dashboard.tsx — mesma atualização de
   * dados que `handleDashboardComplete`, MAS sem `setScreen("results")`.
   * De propósito: `screen === "dashboard" && <Dashboard/>` em App.tsx
   * desmonta o Dashboard assim que a tela troca — se `onProgress` também
   * navegasse, o primeiro lote já tiraria o usuário da tela de progresso
   * NO MEIO de uma busca de 5+ minutos, perdendo o spinner/barra sem
   * ganho real (o próprio Dashboard já mostra "N já com preço" ao vivo
   * enquanto fica na tela — ver `foundSoFar`). Quem navega pra Resultados
   * continua sendo só o `onComplete` de sempre, no final de verdade.
   */
  function handleDashboardProgress(data: DashboardResult) {
    skipRestoreRef.current = true;
    setCatalogRows(data.rows);
    setPricesByMarket(data.pricesByMarket);
    setResults(data.results);
    setSource(data.source);
  }

  /** Recarrega o histórico global após uma nova busca ser salva (Dashboard.tsx). */
  function handleHistoryChanged() {
    if (!user) return;
    listCatalogUploads(user.uid).then(setHistory);
  }

  /** Poda um registro excluído (Dashboard.tsx) da lista global — mesma exclusão usada no seletor de Precificação/Resultados. */
  function handleHistoryDeleted(id: string) {
    setHistory((prev) => prev.filter((h) => h.id !== id));
    if (activeHistoryId === id) setActiveHistoryId(null);
    setSelectedHistoryIds((prev) => prev.filter((existingId) => existingId !== id));
  }

  /** Troca qual busca salva está sendo exibida em Precificação/Resultados (ver seletor de histórico) — single-select de sempre. */
  function handleSelectHistory(id: string) {
    const record = history.find((h) => h.id === id);
    if (!record) return;
    setActiveHistoryId(id);
    setSelectedHistoryIds([id]);
    setCatalogRows(record.rows);
    setPricesByMarket(record.pricesByMarket);
    setResults(record.results);
    setSource(record.source);
  }

  /**
   * Multi-seleção do histórico, só pra tela de Resultados (ver
   * `selectedHistoryIds` acima) — "processei 5 catálogos, quero ver só 3
   * combinados". Com 0 ou 1 id vira o mesmo comportamento de
   * `handleSelectHistory`; com 2+, concatena os resultados de cada
   * catálogo marcado, carimbando `sourceUpload` em cada linha (ver
   * MarginResult em types/index.ts) pra tabela poder mostrar de qual
   * catálogo veio cada oferta — sem isso, dois catálogos com o mesmo SKU
   * ficariam indistinguíveis na visão combinada.
   */
  function handleSelectHistoryMultiple(ids: string[]) {
    setSelectedHistoryIds(ids);

    if (ids.length <= 1) {
      const id = ids[0];
      if (id) handleSelectHistory(id);
      else setActiveHistoryId(null);
      return;
    }

    setActiveHistoryId(null);
    const records = ids
      .map((id) => history.find((h) => h.id === id))
      .filter((r): r is CatalogUploadRecord => Boolean(r));

    const combinedResults = records.flatMap((r) =>
      r.results.map((res) => ({ ...res, sourceUpload: { id: r.id, fileName: r.fileName } }))
    );
    const combinedRows = records.flatMap((r) => r.rows);
    // Prioriza "server" se qualquer um dos catálogos combinados for real
    // (não faz sentido rebaixar a fonte só porque um dos vários também
    // rodou em modo mock local, ver Dashboard.tsx).
    const combinedSource: "server" | "local" | null = records.some((r) => r.source === "server")
      ? "server"
      : (records[0]?.source ?? null);

    setCatalogRows(combinedRows);
    setResults(combinedResults);
    setSource(combinedSource);
    // `pricesByMarket` fica como está — só Precificação (PricingConfig)
    // consome esse mapa, e aquela tela continua usando o single-select
    // de sempre (handleSelectHistory), nunca este handler.
  }

  /** Abre um registro do histórico direto na tela de Resultados (Home > "Suas buscas" / "Ver último resultado"). */
  function handleOpenHistoryRecord(id: string) {
    handleSelectHistory(id);
    setScreen("results");
  }

  /** "usar" num catálogo da biblioteca (Home) — manda pra Nova busca já processando. */
  function handleUseSharedCatalog(catalog: SharedCatalog) {
    setPendingSharedCatalog(catalog);
    setScreen("dashboard");
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
      <DoubtToast onOpenFaq={() => setScreen("faq")} />
      <TopNav
        active={screen}
        onChange={setScreen}
        resultsCount={results.length}
        theme={resolvedTheme}
        onToggleTheme={() =>
          updatePreferences({ themeMode: resolvedTheme === "dark" ? "light" : "dark" })
        }
        isAdmin={profile?.isAdmin ?? false}
        userEmail={user?.email}
      />
      <main className="app-shell__main">
        <AnimatePresence mode="wait">
          <motion.div
            key={screen}
            className="app-shell__content"
            initial={{ opacity: 0, y: 6 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -6 }}
            transition={{ duration: 0.2, ease: [0.16, 1, 0.3, 1] }}
          >
            {screen === "home" && (
              <Home
                userId={user?.uid ?? null}
                userEmail={user?.email}
                profile={profile}
                history={history}
                onNavigate={setScreen}
                onOpenRecord={handleOpenHistoryRecord}
                onUseSharedCatalog={handleUseSharedCatalog}
              />
            )}
            {screen === "dashboard" && (
              <Dashboard
                rules={pricingRules}
                userId={user?.uid ?? null}
                profile={profile}
                onComplete={handleDashboardComplete}
                onProgress={handleDashboardProgress}
                onHistoryChanged={handleHistoryChanged}
                onHistoryDeleted={handleHistoryDeleted}
                warnAt80PercentQuota={preferences.warnAt80PercentQuota}
                pendingSharedCatalog={pendingSharedCatalog}
                onPendingSharedCatalogConsumed={() => setPendingSharedCatalog(null)}
              />
            )}
            {screen === "pricing" && (
              <PricingConfig
                rules={pricingRules}
                onChange={handlePricingChange}
                catalogRows={catalogRows}
                pricesByMarket={pricesByMarket}
                history={history}
                activeHistoryId={activeHistoryId}
                onSelectHistory={handleSelectHistory}
                showCharts={preferences.chartsPricing}
              />
            )}
            {screen === "results" && (
              <ResultsTable
                results={results}
                targetMarginPct={pricingRules.targetMarginPct}
                source={source}
                history={history}
                selectedHistoryIds={selectedHistoryIds}
                onSelectHistoryMultiple={handleSelectHistoryMultiple}
                showCharts={preferences.chartsResults}
                compareSideBySide={preferences.compareEnginesSideBySide}
                groupBySku={preferences.groupOffersBySku}
              />
            )}
            {screen === "portfolio" && (
              <Portfolio history={history} onNavigateToDashboard={() => setScreen("dashboard")} />
            )}
            {screen === "suppliers" && (
              <SupplierCompare history={history} onNavigateToDashboard={() => setScreen("dashboard")} />
            )}
            {screen === "account" && (
              <Account
                user={user}
                profile={profile}
                preferences={preferences}
                onUpdatePreferences={updatePreferences}
              />
            )}
            {screen === "settings" && (
              <Settings
                preferences={preferences}
                onUpdatePreferences={updatePreferences}
                user={user}
                profile={profile}
              />
            )}
            {screen === "admin" && <Admin profile={profile} />}
            {screen === "faq" && <Faq />}
          </motion.div>
        </AnimatePresence>
      </main>
    </div>
  );
}
