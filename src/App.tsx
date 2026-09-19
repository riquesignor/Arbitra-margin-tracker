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

/**
 * Recalcula margem pra um catálogo já buscado, cobrindo TODOS os
 * marketplaces comparados na mesma busca (ver `pricesByMarket`,
 * `Partial<Record<MarketplaceId, ...>>` — uma busca pode ter comparado
 * Amazon + Mercado Livre ao mesmo tempo). Função de módulo (não depende
 * de nenhum state do componente) — usada tanto no restauro de login
 * quanto em `handleSyncPricing`/`handleSelectHistory*`, sempre com a
 * MESMA regra (evita reimplementar o mesmo `flatMap` em cada callsite).
 */
function recalcMarginsForPriceMap(
  rows: CatalogRow[],
  pricesByMarket: Partial<Record<MarketplaceId, Record<string, MarketplacePriceResult>>>,
  rules: PricingRules
): MarginResult[] {
  return Object.values(pricesByMarket).flatMap((priceMap) =>
    priceMap ? calculateMargins(rows, priceMap, rules) : []
  );
}

export default function App() {
  // "home" — tela de entrada (ver docs/design-critique-log.md, Session
  // 4): resumo do que já foi processado + atalho pra Nova busca (a
  // Dashboard atual, agora só operacional). Landing screen padrão no
  // lugar do antigo "dashboard".
  const [screen, setScreen] = useState<Screen>("home");
  const [user, setUser] = useState<AuthUser | null>(null);
  const [profile, setProfile] = useState<UserProfile | null>(null);
  const [pricingRules, setPricingRules] = useState<PricingRules>(DEFAULT_PRICING_RULES);
  /**
   * Snapshot da regra que efetivamente gerou os `results` atualmente em
   * tela (set/2026, pedido explícito do usuário: "se eu mudar a taxa de
   * venda, o resultado não muda"). Antes, `handlePricingChange` já
   * recalculava sozinho — mas em SILÊNCIO, sem indicar ao usuário se o
   * que está na tela de Resultados já reflete a regra atual ou não, e
   * com um bug real na multi-seleção de histórico (ver
   * handleSelectHistoryMultiple): `pricesByMarket` global não era
   * atualizado ao combinar 2+ catálogos, então um recálculo automático
   * ali usaria o mapa de preço ERRADO. Agora o recálculo em si só
   * acontece explicitamente (botão "Sincronizar" em Resultados, ver
   * handleSyncPricing) — este snapshot é o que decide se esse botão fica
   * clicável (`pricingRules` atual difere deste valor) ou não.
   */
  const [appliedPricingRules, setAppliedPricingRules] = useState<PricingRules>(DEFAULT_PRICING_RULES);

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

  // Unificado com o efeito de restauro do histórico logo abaixo (set/2026)
  // — precisa da MESMA regra carregada aqui pra recalcular o resultado
  // restaurado corretamente (ver aquele efeito); dois `useEffect`
  // separados disparando em paralelo não garantem qual resolve primeiro,
  // e usar `pricingRules` do state ali arriscava pegar o DEFAULT (ainda
  // não carregado) em vez da regra real salva do usuário.

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
    // `Promise.all` (não dois efeitos separados) — ver comentário acima
    // de onde `loadPricingRules` costumava rodar sozinho: o restauro do
    // histórico precisa da regra JÁ carregada (não do default) pra
    // recalcular `results` com o número certo logo de cara.
    Promise.all([loadPricingRules(user.uid), listCatalogUploads(user.uid)]).then(
      ([rules, fetchedHistory]) => {
        setPricingRules(rules);
        setAppliedPricingRules(rules);
        setHistory(fetchedHistory);
        if (skipRestoreRef.current) return;
        const latest = fetchedHistory[0];
        if (latest) {
          setCatalogRows(latest.rows);
          setPricesByMarket(latest.pricesByMarket);
          // Recalcula com a regra ATUAL em vez de usar `latest.results`
          // cru — se o usuário mudou a taxa de venda numa sessão anterior
          // e nunca sincronizou antes de sair, o registro salvo carrega
          // números calculados com a regra ANTIGA. Recalcular aqui (custo
          // desprezível, é só aritmética local) garante que o que aparece
          // logo no login já bate com a Precificação salva mais recente.
          setResults(recalcMarginsForPriceMap(latest.rows, latest.pricesByMarket, rules));
          setSource(latest.source);
          setActiveHistoryId(latest.id);
          setSelectedHistoryIds([latest.id]);
        }
      }
    );
  }, [user]);

  function handleDashboardComplete(data: DashboardResult) {
    skipRestoreRef.current = true;
    setCatalogRows(data.rows);
    setPricesByMarket(data.pricesByMarket);
    setResults(data.results);
    setSource(data.source);
    setActiveHistoryId(null);
    setSelectedHistoryIds([]);
    // `data.results` acabou de sair do Dashboard já calculado com
    // `pricingRules` (prop passada pra ele, ver JSX abaixo) — bate com a
    // regra vigente agora, então o snapshot "aplicado" é exatamente esta.
    setAppliedPricingRules(pricingRules);
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
    // Ver mesmo comentário em handleDashboardComplete.
    setAppliedPricingRules(pricingRules);
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
    // Recalcula com a regra ATUAL em vez de `record.results` cru — mesmo
    // raciocínio do restauro de login (ver recalcMarginsForPriceMap):
    // troca de catálogo no seletor já é o momento natural de "sincronizar
    // de graça" com a Precificação vigente, sem exigir um clique extra em
    // "Sincronizar" logo depois de simplesmente trocar de catálogo.
    setResults(recalcMarginsForPriceMap(record.rows, record.pricesByMarket, pricingRules));
    setSource(record.source);
    setAppliedPricingRules(pricingRules);
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

    // Recalcula CADA registro com o `pricesByMarket` PRÓPRIO dele (não
    // `r.results` cru) — bug real corrigido aqui (set/2026): antes, ao
    // editar a Precificação com 2+ catálogos combinados na tela, o
    // recálculo automático usava o `pricesByMarket` GLOBAL do último
    // catálogo aberto via single-select, que não tem relação nenhuma com
    // os catálogos combinados aqui — resultado silenciosamente errado
    // pra qualquer catálogo do combo que não fosse esse último. Recalcular
    // por registro, com o mapa de preço de CADA UM, evita isso — e evita
    // de quebra colidir SKU entre catálogos diferentes (um merge ingênuo
    // de `pricesByMarket` entre registros correria esse risco).
    const combinedResults = records.flatMap((r) =>
      recalcMarginsForPriceMap(r.rows, r.pricesByMarket, pricingRules).map((res) => ({
        ...res,
        sourceUpload: { id: r.id, fileName: r.fileName },
      }))
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
    setAppliedPricingRules(pricingRules);
    // `pricesByMarket` fica como está — só Precificação (PricingConfig)
    // consome esse mapa, e aquela tela continua usando o single-select
    // de sempre (handleSelectHistory), nunca este handler. Recálculo de
    // margem pra este combo (Sincronizar/multi-seleção) sempre passa por
    // `recalcMarginsForPriceMap` por REGISTRO (ver acima e
    // handleSyncPricing), nunca por este estado global.
  }

  /** Abre um registro do histórico direto na tela de Resultados (Home > "Suas buscas" / "Ver último resultado"). */
  function handleOpenHistoryRecord(id: string) {
    handleSelectHistory(id);
    setScreen("results");
  }

  /**
   * Comparação profunda simples (JSON.stringify — `PricingRules` é dado
   * puro, sem função/Date/undefined dentro, então a comparação por texto
   * é segura e mais barata que escrever um deep-equal à mão) — decide se
   * o botão "Sincronizar" em Resultados fica clicável. `false` sempre que
   * as duas apontam pro mesmo objeto (comparação começa aqui, mais
   * rápida que montar a string toda pra confirmar igualdade óbvia).
   */
  const isPricingDirty =
    pricingRules !== appliedPricingRules && JSON.stringify(pricingRules) !== JSON.stringify(appliedPricingRules);

  /** "usar" num catálogo da biblioteca (Home) — manda pra Nova busca já processando. */
  function handleUseSharedCatalog(catalog: SharedCatalog) {
    setPendingSharedCatalog(catalog);
    setScreen("dashboard");
  }

  /**
   * ⚠️ NÃO recalcula `results` mais (set/2026 — antes recalculava direto
   * aqui). Pedido explícito do usuário: mudar a taxa/regra em
   * Precificação deve deixar claro, na tela de Resultados, que há uma
   * mudança PENDENTE — um botão "Sincronizar" (ver handleSyncPricing)
   * que só fica clicável quando `pricingRules` diverge de
   * `appliedPricingRules`. Aplicar na hora, em silêncio, escondia esse
   * sinal (e tinha um bug real de dado errado na multi-seleção, ver
   * handleSelectHistoryMultiple). A regra em si já é salva na hora — só
   * o RECÁLCULO de margem que passou a ser explícito.
   */
  function handlePricingChange(newRules: PricingRules) {
    setPricingRules(newRules);
    void savePricingRules(user?.uid ?? null, newRules);
  }

  /**
   * Aplica a regra ATUAL (`pricingRules`, já editada em Precificação) aos
   * resultados em tela — botão "Sincronizar" em ResultsTable. Mesma
   * ramificação de fonte que os handlers de seleção de histórico: 2+
   * catálogos combinados recalculam CADA UM com o próprio `pricesByMarket`
   * (ver handleSelectHistoryMultiple pro porquê); processamento novo ou
   * 0/1 catálogo do histórico usa `catalogRows`/`pricesByMarket` diretos
   * (já corretos nesses casos).
   */
  function handleSyncPricing() {
    if (selectedHistoryIds.length > 1) {
      const records = selectedHistoryIds
        .map((id) => history.find((h) => h.id === id))
        .filter((r): r is CatalogUploadRecord => Boolean(r));
      setResults(
        records.flatMap((r) =>
          recalcMarginsForPriceMap(r.rows, r.pricesByMarket, pricingRules).map((res) => ({
            ...res,
            sourceUpload: { id: r.id, fileName: r.fileName },
          }))
        )
      );
    } else {
      setResults(recalcMarginsForPriceMap(catalogRows, pricesByMarket, pricingRules));
    }
    setAppliedPricingRules(pricingRules);
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
                isPricingDirty={isPricingDirty}
                onSyncPricing={handleSyncPricing}
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
