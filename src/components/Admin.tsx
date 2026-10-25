import { useEffect, useMemo, useRef, useState, type DragEvent } from "react";
import {
  AlertTriangle,
  ArrowDown,
  ArrowUp,
  Check,
  ChevronDown,
  Download,
  FileText,
  KeyRound,
  Loader2,
  MoreHorizontal,
  RefreshCw,
  Search,
  ShieldAlert,
  ShieldCheck,
  Trash2,
  UploadCloud,
  X,
} from "lucide-react";
import Papa from "papaparse";
import type { CatalogRow, PlanId } from "../types";
import { PLANS } from "../config/plans";
import type { UserProfile } from "../lib/userProfile";
import { listAllUsers, updateUserPlan, updateUserAdmin } from "../lib/userProfile";
import {
  createSharedCatalog,
  listAllSharedCatalogs,
  updateSharedCatalogPlans,
  deleteSharedCatalog,
  type SharedCatalog,
} from "../lib/sharedCatalogs";
import { parsePdfCatalogFile } from "../lib/parsePdfCatalog";
import { fetchAdminDiagnostics, type AdminDiagnostics } from "../lib/adminDiagnostics";
import { useConfirm } from "../lib/confirm";
import { useToast } from "../lib/toast";
import CopyButton from "./CopyButton";
import AdminUserSheet from "./AdminUserSheet";
import { ALL_KEY_PROVIDERS, initials } from "../lib/adminUsers";
import styles from "./Admin.module.css";

interface Props {
  profile: UserProfile | null;
}

interface DraftCatalog {
  fileName: string;
  rows: CatalogRow[];
  skippedAmbiguous: number;
  plans: PlanId[];
}

type Tab = "contas" | "biblioteca" | "visao";
type PlanFilter = "todos" | PlanId;
type SortKey = "createdAt" | "email";

const DAY_MS = 86_400_000;

function relativeDate(ts: number): string {
  if (!ts) return "—";
  const days = Math.floor((Date.now() - ts) / DAY_MS);
  if (days <= 0) return "hoje";
  if (days === 1) return "ontem";
  if (days < 30) return `há ${days} dias`;
  return new Date(ts).toLocaleDateString("pt-BR", { day: "2-digit", month: "short", year: "numeric" });
}

/**
 * Central de administração (redesenho out/2026, padrões do shadcn: abas,
 * data table com filtro/ordenação/menu por linha, painel lateral de
 * detalhe). Base do sistema de planos: admin sobe um PDF, o parser
 * client-side existente (`parsePdfCatalog.ts`) extrai os produtos, e o
 * admin escolhe quais planos enxergam aquele catálogo — vira um item da
 * biblioteca (`shared_catalogs`). Guardamos só os produtos extraídos, não
 * o PDF original. Gestão de plano por usuário é manual aqui.
 */
export default function Admin({ profile }: Props) {
  const confirm = useConfirm();
  const toast = useToast();
  const [tab, setTab] = useState<Tab>("contas");
  const [catalogs, setCatalogs] = useState<SharedCatalog[]>([]);
  const [catalogsLoading, setCatalogsLoading] = useState(false);
  const [users, setUsers] = useState<UserProfile[]>([]);
  const [usersLoading, setUsersLoading] = useState(false);

  const [draft, setDraft] = useState<DraftCatalog | null>(null);
  const [parsing, setParsing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Filtros da tabela de contas — só recortam o array `users` já
  // carregado, não disparam nenhuma chamada nova ao Firestore.
  const [filterText, setFilterText] = useState("");
  const [planFilter, setPlanFilter] = useState<PlanFilter>("todos");
  const [onlyAdmins, setOnlyAdmins] = useState(false);
  const [sortKey, setSortKey] = useState<SortKey>("createdAt");
  const [sortDir, setSortDir] = useState<"asc" | "desc">("desc");
  const [openUid, setOpenUid] = useState<string | null>(null);

  // Diagnóstico de config server-side — `null` = ainda não carregou OU o
  // endpoint falhou; os dois casos mostram "verificando"/erro, nunca
  // "não configurado" por engano.
  const [diagnostics, setDiagnostics] = useState<AdminDiagnostics | null>(null);
  const [diagnosticsLoading, setDiagnosticsLoading] = useState(false);
  const [showDiagDetail, setShowDiagDetail] = useState(false);

  function refreshDiagnostics() {
    setDiagnosticsLoading(true);
    void fetchAdminDiagnostics()
      .then(setDiagnostics)
      .finally(() => setDiagnosticsLoading(false));
  }

  function refreshCatalogs() {
    setCatalogsLoading(true);
    void listAllSharedCatalogs()
      .then(setCatalogs)
      .finally(() => setCatalogsLoading(false));
  }

  function refreshUsers() {
    setUsersLoading(true);
    void listAllUsers()
      .then(setUsers)
      .finally(() => setUsersLoading(false));
  }

  function refreshAll() {
    refreshCatalogs();
    refreshUsers();
    refreshDiagnostics();
  }

  useEffect(() => {
    if (!profile?.isAdmin) return;
    refreshAll();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [profile?.isAdmin]);

  const filteredUsers = useMemo(() => {
    const needle = filterText.trim().toLowerCase();
    const list = users.filter((u) => {
      if (onlyAdmins && !u.isAdmin) return false;
      if (planFilter !== "todos" && u.plan !== planFilter) return false;
      if (!needle) return true;
      return (u.email ?? "").toLowerCase().includes(needle) || u.uid.toLowerCase().includes(needle);
    });
    return list.sort((a, b) => {
      const diff = sortKey === "email" ? (a.email ?? "").localeCompare(b.email ?? "") : a.createdAt - b.createdAt;
      return sortDir === "asc" ? diff : -diff;
    });
  }, [users, filterText, planFilter, onlyAdmins, sortKey, sortDir]);

  if (!profile?.isAdmin) {
    return (
      <div className={styles.container}>
        <header className={styles.header}>
          <h1 className={styles.title}>Administração</h1>
        </header>
        <div className={styles.denied}>
          <ShieldAlert size={18} aria-hidden="true" />
          <p>Acesso restrito a administradores.</p>
        </div>
      </div>
    );
  }

  async function handleFileSelected(file: File | undefined) {
    if (!file) return;
    if (!file.name.toLowerCase().endsWith(".pdf")) {
      setError("A biblioteca aceita só PDF de fornecedor.");
      return;
    }
    setError(null);
    setParsing(true);
    try {
      const { rows, skippedAmbiguous } = await parsePdfCatalogFile(file);
      setDraft({ fileName: file.name, rows, skippedAmbiguous, plans: [] });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setParsing(false);
    }
  }

  function handleDrop(e: DragEvent<HTMLElement>) {
    e.preventDefault();
    setDragging(false);
    void handleFileSelected(e.dataTransfer.files?.[0]);
  }

  function toggleDraftPlan(planId: PlanId) {
    setDraft((d) =>
      d ? { ...d, plans: d.plans.includes(planId) ? d.plans.filter((p) => p !== planId) : [...d.plans, planId] } : d
    );
  }

  async function handleSaveDraft() {
    if (!draft || !profile) return;
    setSaving(true);
    setError(null);
    try {
      await createSharedCatalog({
        fileName: draft.fileName,
        rows: draft.rows,
        skippedAmbiguous: draft.skippedAmbiguous,
        plans: draft.plans,
        uploadedAt: Date.now(),
        uploadedBy: profile.uid,
      });
      toast.show({ message: `"${draft.fileName}" publicado na biblioteca.` });
      setDraft(null);
      refreshCatalogs();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  }

  async function toggleCatalogPlan(catalog: SharedCatalog, planId: PlanId) {
    const next = catalog.plans.includes(planId) ? catalog.plans.filter((p) => p !== planId) : [...catalog.plans, planId];
    setCatalogs((prev) => prev.map((c) => (c.id === catalog.id ? { ...c, plans: next } : c)));
    try {
      await updateSharedCatalogPlans(catalog.id, next);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      refreshCatalogs();
    }
  }

  /** Some da lista na hora; só apaga de vez quando o aviso de "Desfazer" expira. */
  function handleDeleteCatalog(catalog: SharedCatalog) {
    setCatalogs((prev) => prev.filter((c) => c.id !== catalog.id));
    const putBack = () => setCatalogs((prev) => [...prev, catalog].sort((a, b) => b.uploadedAt - a.uploadedAt));
    toast.show({
      message: `"${catalog.fileName}" removido da biblioteca.`,
      action: { label: "Desfazer", onClick: putBack },
      onExpire: () => {
        deleteSharedCatalog(catalog.id).catch((err: unknown) => {
          putBack();
          toast.show({ tone: "error", message: `Não consegui remover: ${err instanceof Error ? err.message : String(err)}` });
        });
      },
    });
  }

  async function handleChangeUserPlan(uid: string, plan: PlanId) {
    const target = users.find((u) => u.uid === uid);
    if (!target || target.plan === plan) return;
    const from = PLANS.find((p) => p.id === target.plan)?.name ?? target.plan;
    const to = PLANS.find((p) => p.id === plan)?.name ?? plan;
    // Muda acesso à biblioteca e o teto diário do usuário na hora — vale
    // uma confirmação explícita em vez de salvar no onChange do <select>.
    const ok = await confirm({
      title: `Trocar o plano de ${target.email ?? uid}?`,
      message: `De ${from} para ${to}. Muda na hora o acesso à biblioteca e o teto diário de busca dessa conta.`,
      confirmLabel: `Trocar para ${to}`,
    });
    if (!ok) return;
    setUsers((prev) => prev.map((u) => (u.uid === uid ? { ...u, plan } : u)));
    try {
      await updateUserPlan(uid, plan);
      toast.show({ message: `Plano de ${target.email ?? uid} agora é ${to}.` });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      refreshUsers();
    }
  }

  async function handleToggleUserAdmin(uid: string, isAdmin: boolean) {
    const email = users.find((u) => u.uid === uid)?.email ?? uid;
    // Admin lê o perfil de todo mundo, troca plano e mexe na biblioteca —
    // é a ação de maior risco desta tela, então nunca num clique só.
    const ok = await confirm(
      isAdmin
        ? {
            title: `Dar acesso de admin para ${email}?`,
            message: "Essa conta vai poder ver todos os usuários, trocar planos e editar a biblioteca compartilhada.",
            confirmLabel: "Dar acesso de admin",
            tone: "danger",
          }
        : uid === profile?.uid
          ? {
              title: "Remover o seu próprio acesso de admin?",
              message: "Você perde acesso a esta tela imediatamente e só outro admin consegue devolver.",
              confirmLabel: "Remover meu acesso",
              tone: "danger",
            }
          : {
              title: `Remover o acesso de admin de ${email}?`,
              confirmLabel: "Remover acesso",
              tone: "danger",
            }
    );
    if (!ok) return;
    setUsers((prev) => prev.map((u) => (u.uid === uid ? { ...u, isAdmin } : u)));
    try {
      await updateUserAdmin(uid, isAdmin);
      toast.show({ message: isAdmin ? `${email} agora é admin.` : `${email} não é mais admin.` });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      refreshUsers();
    }
  }

  function handleSort(key: SortKey) {
    if (key === sortKey) setSortDir((d) => (d === "asc" ? "desc" : "asc"));
    else {
      setSortKey(key);
      setSortDir(key === "email" ? "asc" : "desc");
    }
  }

  function exportUsersCsv() {
    const csv = Papa.unparse(
      filteredUsers.map((u) => ({
        Email: u.email ?? "",
        UID: u.uid,
        Plano: PLANS.find((p) => p.id === u.plan)?.name ?? u.plan,
        Admin: u.isAdmin ? "Sim" : "Não",
        "Conta criada": u.createdAt ? new Date(u.createdAt).toLocaleDateString("pt-BR") : "",
        Chaves: (u.apiKeyProviders ?? []).join(", "),
      })),
      { delimiter: ";" }
    );
    const blob = new Blob([`\uFEFF${csv}`], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `arbitra-contas-${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  }

  const adminCount = users.filter((u) => u.isAdmin).length;
  const newLast30 = users.filter((u) => u.createdAt && Date.now() - u.createdAt < 30 * DAY_MS).length;
  const withKeys = users.filter((u) => (u.apiKeyProviders ?? []).length > 0).length;
  const catalogsWithoutPlan = catalogs.filter((c) => c.plans.length === 0);
  const totalProducts = catalogs.reduce((sum, c) => sum + c.rows.length, 0);
  const planCount = (id: PlanId) => users.filter((u) => u.plan === id).length;
  const openUser = openUid ? users.find((u) => u.uid === openUid) : undefined;

  const now = new Date();
  const signupMonths = Array.from({ length: 6 }, (_, i) => {
    const monthDate = new Date(now.getFullYear(), now.getMonth() - (5 - i), 1);
    const count = users.filter((u) => {
      if (!u.createdAt) return false;
      const created = new Date(u.createdAt);
      return created.getFullYear() === monthDate.getFullYear() && created.getMonth() === monthDate.getMonth();
    }).length;
    return { label: monthDate.toLocaleDateString("pt-BR", { month: "short" }).replace(".", ""), count };
  });
  const maxSignups = Math.max(1, ...signupMonths.map((m) => m.count));
  const maxPlanUsers = Math.max(1, ...PLANS.map((p) => planCount(p.id)));

  const diagItems = diagnostics
    ? [
        {
          ok: diagnostics.firebaseAdminConfigured,
          label: "Firebase Admin",
          detail: "Servidor lendo e gravando no banco. Se aparecer ausente, nada nesta tela funcionaria — alerta grave.",
        },
        {
          ok: diagnostics.mercadoLivreOAuthConfigured,
          label: "OAuth Mercado Livre",
          detail: diagnostics.mercadoLivreOAuthConfigured
            ? "Configurado — a API oficial do Mercado Livre (gratuita) entra como fonte de candidatos no motor interno."
            : "Ausente (ML_CLIENT_ID / ML_CLIENT_SECRET). Usuário não é afetado: o preço do Mercado Livre continua vindo via Google Shopping; o motor interno só pula essa fonte gratuita.",
        },
      ]
    : [];
  const loadingAny = usersLoading || catalogsLoading || diagnosticsLoading;

  return (
    <div className={styles.container}>
      <header className={styles.header}>
        <div className={styles.headerMain}>
          <h1 className={styles.title}>Administração</h1>
          <p className={styles.lead}>Contas, planos e a biblioteca de catálogos compartilhada.</p>
        </div>
        <div className={styles.headerActions}>
          <span className={styles.whoami}>
            <ShieldCheck size={14} aria-hidden="true" />
            {profile.email ?? profile.uid}
          </span>
          <button type="button" className={styles.toolButton} onClick={refreshAll} disabled={loadingAny}>
            <RefreshCw size={14} className={loadingAny ? "spin" : undefined} aria-hidden="true" /> Atualizar
          </button>
        </div>
      </header>

      {/* ─── status do sistema ─── */}
      <div className={styles.status}>
        <span className={styles.statusLabel}>Sistema</span>
        {!diagnostics ? (
          <span className={styles.muted}>
            {diagnosticsLoading ? "verificando servidor…" : "não consegui consultar o servidor — clique em Atualizar"}
          </span>
        ) : (
          <>
            {diagItems.map((d) => (
              <span key={d.label} className={d.ok ? styles.statusOk : styles.statusMissing}>
                {d.ok ? <Check size={12} aria-hidden="true" /> : <X size={12} aria-hidden="true" />}
                {d.label}
              </span>
            ))}
            <span className={styles.statusEnv}>{diagnostics.environment}</span>
            <button
              type="button"
              className={styles.inlineLink}
              onClick={() => setShowDiagDetail((v) => !v)}
              aria-expanded={showDiagDetail}
            >
              {showDiagDetail ? "ocultar detalhes" : "detalhes"}
            </button>
          </>
        )}
      </div>
      {diagnostics && showDiagDetail && (
        <ul className={styles.diagDetail}>
          {diagItems.map((d) => (
            <li key={d.label}>
              <b>{d.label}</b> — {d.detail}
            </li>
          ))}
          <li>
            <b>Chaves BYOK</b> — cada usuário cadastra a própria em Conta, nunca configuráveis pela plataforma:{" "}
            {diagnostics.byokOnlyProviders.join(" · ")}.
          </li>
        </ul>
      )}

      {error && (
        <p className={styles.error} role="alert">
          <AlertTriangle size={14} aria-hidden="true" /> {error}
          <button type="button" onClick={() => setError(null)} aria-label="Fechar aviso">
            <X size={13} aria-hidden="true" />
          </button>
        </p>
      )}

      {/* ─── KPIs ─── */}
      <div className={styles.kpis}>
        <button type="button" className={styles.kpiButton} onClick={() => { setTab("contas"); setPlanFilter("todos"); setOnlyAdmins(false); }}>
          <span className={styles.kpiLabel}>Contas</span>
          <span className={styles.kpiValue}>{users.length}</span>
          <span className={styles.kpiHint}>+{newLast30} nos últimos 30 dias</span>
        </button>
        <button type="button" className={styles.kpiButton} onClick={() => { setTab("contas"); setOnlyAdmins(true); }}>
          <span className={styles.kpiLabel}>Admins</span>
          <span className={styles.kpiValue}>{adminCount}</span>
          <span className={styles.kpiHint}>{withKeys} conta(s) com chave própria</span>
        </button>
        <button type="button" className={styles.kpiButton} onClick={() => setTab("biblioteca")}>
          <span className={styles.kpiLabel}>Catálogos na biblioteca</span>
          <span className={styles.kpiValue}>{catalogs.length}</span>
          <span className={catalogsWithoutPlan.length > 0 ? styles.kpiHintWarn : styles.kpiHint}>
            {catalogsWithoutPlan.length > 0 ? `${catalogsWithoutPlan.length} sem plano — ninguém vê` : "todos com plano"}
          </span>
        </button>
        <div className={styles.kpi}>
          <span className={styles.kpiLabel}>Produtos indexados</span>
          <span className={styles.kpiValue}>{totalProducts.toLocaleString("pt-BR")}</span>
          <span className={styles.kpiHint}>somados em toda a biblioteca</span>
        </div>
      </div>

      {/* ─── abas ─── */}
      <div className={styles.tabs} role="tablist" aria-label="Áreas da administração">
        {(
          [
            { id: "contas", label: "Contas", count: users.length },
            { id: "biblioteca", label: "Biblioteca", count: catalogs.length },
            { id: "visao", label: "Visão geral" },
          ] as const
        ).map((t) => (
          <button
            key={t.id}
            type="button"
            role="tab"
            aria-selected={tab === t.id}
            className={tab === t.id ? styles.tabActive : styles.tab}
            onClick={() => setTab(t.id)}
          >
            {t.label}
            {"count" in t && <span className={styles.tabCount}>{t.count}</span>}
          </button>
        ))}
      </div>

      {tab === "contas" && (
        <section role="tabpanel" aria-label="Contas">
          <div className={styles.toolbar}>
            <label className={styles.search}>
              <Search size={14} aria-hidden="true" />
              <input
                placeholder="Buscar por email ou UID"
                aria-label="Buscar por email ou UID"
                value={filterText}
                onChange={(e) => setFilterText(e.target.value)}
              />
              {filterText && (
                <button type="button" onClick={() => setFilterText("")} aria-label="Limpar busca">
                  <X size={13} aria-hidden="true" />
                </button>
              )}
            </label>
            <div className={styles.segmented} role="group" aria-label="Filtrar por plano">
              {(["todos", ...PLANS.map((p) => p.id)] as PlanFilter[]).map((f) => (
                <button
                  key={f}
                  type="button"
                  aria-pressed={planFilter === f}
                  className={planFilter === f ? styles.segmentActive : styles.segment}
                  onClick={() => setPlanFilter(f)}
                >
                  {f === "todos" ? "Todos" : PLANS.find((p) => p.id === f)?.name}
                  <span className={styles.segmentCount}>{f === "todos" ? users.length : planCount(f)}</span>
                </button>
              ))}
            </div>
            <button
              type="button"
              aria-pressed={onlyAdmins}
              className={onlyAdmins ? styles.toggleActive : styles.toolButton}
              onClick={() => setOnlyAdmins((v) => !v)}
            >
              <ShieldCheck size={14} aria-hidden="true" /> Só admins
            </button>
            <button type="button" className={`${styles.toolButton} ${styles.toolbarEnd}`} onClick={exportUsersCsv} disabled={filteredUsers.length === 0}>
              <Download size={14} aria-hidden="true" /> CSV
            </button>
          </div>

          {usersLoading && users.length === 0 ? (
            <div className={styles.skeletonList} aria-label="Carregando contas">
              {Array.from({ length: 4 }, (_, i) => (
                <span key={i} />
              ))}
            </div>
          ) : filteredUsers.length === 0 ? (
            <div className={styles.empty}>
              <p className={styles.emptyTitle}>Nenhuma conta com esse filtro</p>
              <button
                type="button"
                className={styles.toolButton}
                onClick={() => {
                  setFilterText("");
                  setPlanFilter("todos");
                  setOnlyAdmins(false);
                }}
              >
                Limpar filtros
              </button>
            </div>
          ) : (
            <div className={styles.tableWrap}>
              <table className={styles.table}>
                <thead>
                  <tr>
                    <th scope="col">
                      <button type="button" className={styles.sortButton} onClick={() => handleSort("email")}>
                        Conta <SortIcon active={sortKey === "email"} dir={sortDir} />
                      </button>
                    </th>
                    <th scope="col">Plano</th>
                    <th scope="col">Papel</th>
                    <th scope="col">Chaves</th>
                    <th scope="col">
                      <button type="button" className={styles.sortButton} onClick={() => handleSort("createdAt")}>
                        Entrou <SortIcon active={sortKey === "createdAt"} dir={sortDir} />
                      </button>
                    </th>
                    <th scope="col">
                      <span className={styles.srOnly}>Ações</span>
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {filteredUsers.map((u) => {
                    const keys = u.apiKeyProviders ?? [];
                    return (
                      <tr
                        key={u.uid}
                        className={u.uid === openUid ? styles.rowActive : styles.row}
                        onClick={(e) => {
                          if ((e.target as Element).closest("a, button, select, input, label")) return;
                          setOpenUid(u.uid);
                        }}
                      >
                        <td>
                          <span className={styles.account}>
                            <span className={styles.avatar} aria-hidden="true">
                              {initials(u.email)}
                            </span>
                            <span className={styles.accountText}>
                              <button type="button" className={styles.accountEmail} onClick={() => setOpenUid(u.uid)}>
                                {u.email ?? "sem email"}
                              </button>
                              {u.uid === profile.uid && <span className={styles.youTag}>você</span>}
                              <span className={styles.uid}>
                                {u.uid.slice(0, 10)}…
                                <CopyButton text={u.uid} label="Copiar UID" />
                              </span>
                            </span>
                          </span>
                        </td>
                        <td>
                          <select
                            className={styles.select}
                            value={u.plan}
                            onChange={(e) => void handleChangeUserPlan(u.uid, e.target.value as PlanId)}
                            aria-label={`Plano de ${u.email ?? u.uid}`}
                          >
                            {PLANS.map((p) => (
                              <option key={p.id} value={p.id}>
                                {p.name}
                              </option>
                            ))}
                          </select>
                        </td>
                        <td>
                          <span className={u.isAdmin ? styles.roleAdmin : styles.roleUser}>
                            {u.isAdmin && <ShieldCheck size={12} aria-hidden="true" />}
                            {u.isAdmin ? "Admin" : "Usuário"}
                          </span>
                        </td>
                        <td>
                          {keys.length === 0 ? (
                            <span className={styles.muted}>nenhuma</span>
                          ) : (
                            <span className={styles.keys} title={keys.join(", ")}>
                              <KeyRound size={12} aria-hidden="true" />
                              {keys.slice(0, 2).join(", ")}
                              {keys.length > 2 && <span className={styles.more}>+{keys.length - 2}</span>}
                            </span>
                          )}
                        </td>
                        <td className={styles.mono} title={u.createdAt ? new Date(u.createdAt).toLocaleString("pt-BR") : undefined}>
                          {relativeDate(u.createdAt)}
                        </td>
                        <td className={styles.actionsCell}>
                          <RowMenu
                            label={`Ações de ${u.email ?? u.uid}`}
                            items={[
                              { label: "Ver detalhes", onSelect: () => setOpenUid(u.uid) },
                              {
                                label: u.isAdmin ? "Remover admin" : "Tornar admin",
                                danger: u.isAdmin,
                                onSelect: () => void handleToggleUserAdmin(u.uid, !u.isAdmin),
                              },
                            ]}
                          />
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
          <p className={styles.footnote}>
            {filteredUsers.length} de {users.length} conta(s) · clique numa linha pra ver uso de hoje, chaves e últimas buscas
          </p>
        </section>
      )}

      {tab === "biblioteca" && (
        <section role="tabpanel" aria-label="Biblioteca" className={styles.library}>
          {!draft ? (
            <label
              className={parsing ? styles.dropzoneBusy : dragging ? styles.dropzoneActive : styles.dropzone}
              onDragOver={(e) => {
                e.preventDefault();
                setDragging(true);
              }}
              onDragLeave={() => setDragging(false)}
              onDrop={handleDrop}
            >
              <span className={styles.dropIcon} aria-hidden="true">
                {parsing ? <Loader2 size={20} className="spin" /> : <UploadCloud size={20} />}
              </span>
              <span className={styles.dropText}>
                <span className={styles.dropTitle}>{parsing ? "Lendo PDF…" : "Arraste o PDF do fornecedor ou clique pra escolher"}</span>
                <span className={styles.muted}>Os produtos são extraídos aqui no navegador — o PDF original não é armazenado.</span>
              </span>
              <input
                className={styles.fileInput}
                type="file"
                accept=".pdf"
                disabled={parsing}
                onChange={(e) => {
                  void handleFileSelected(e.target.files?.[0]);
                  e.target.value = "";
                }}
              />
            </label>
          ) : (
            <div className={styles.draft}>
              <div className={styles.draftHead}>
                <FileText size={16} aria-hidden="true" />
                <span className={styles.draftName}>{draft.fileName}</span>
                <span className={styles.mono}>
                  {draft.rows.length} produtos
                  {draft.skippedAmbiguous > 0 && ` · ${draft.skippedAmbiguous} linha(s) ignorada(s)`}
                </span>
              </div>
              <div className={styles.draftPlans}>
                <span className={styles.draftLabel}>Quem vê este catálogo</span>
                <PlanToggles active={draft.plans} onToggle={toggleDraftPlan} />
              </div>
              {draft.rows.length > 0 && (
                <p className={styles.muted}>
                  Primeiros itens: {draft.rows.slice(0, 3).map((r) => r.name).join(" · ")}
                  {draft.rows.length > 3 ? " …" : ""}
                </p>
              )}
              <div className={styles.draftActions}>
                <button
                  className={styles.primaryButton}
                  type="button"
                  disabled={saving || draft.plans.length === 0}
                  onClick={() => void handleSaveDraft()}
                >
                  {saving && <Loader2 size={14} className="spin" aria-hidden="true" />}
                  {saving ? "Publicando…" : "Publicar na biblioteca"}
                </button>
                <button className={styles.toolButton} type="button" onClick={() => setDraft(null)} disabled={saving}>
                  Cancelar
                </button>
                {draft.plans.length === 0 && <span className={styles.warnText}>Marque ao menos um plano.</span>}
              </div>
            </div>
          )}

          {catalogsLoading && catalogs.length === 0 ? (
            <div className={styles.skeletonList} aria-label="Carregando biblioteca">
              {Array.from({ length: 3 }, (_, i) => (
                <span key={i} />
              ))}
            </div>
          ) : catalogs.length === 0 ? (
            <div className={styles.empty}>
              <p className={styles.emptyTitle}>Biblioteca vazia</p>
              <p className={styles.muted}>Publique o primeiro PDF acima — ele aparece na tela Início dos planos que você marcar.</p>
            </div>
          ) : (
            <div className={styles.tableWrap}>
              <table className={styles.table}>
                <thead>
                  <tr>
                    <th scope="col">Arquivo</th>
                    <th scope="col" className={styles.num}>
                      Produtos
                    </th>
                    <th scope="col">Publicado</th>
                    <th scope="col">Planos com acesso</th>
                    <th scope="col">
                      <span className={styles.srOnly}>Remover</span>
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {catalogs.map((c) => (
                    <tr key={c.id} className={styles.rowStatic}>
                      <td>
                        <span className={styles.fileName}>
                          <FileText size={14} aria-hidden="true" /> {c.fileName}
                        </span>
                        {c.plans.length === 0 && <span className={styles.kpiHintWarn}>sem plano — ninguém vê</span>}
                      </td>
                      <td className={styles.num}>{c.rows.length}</td>
                      <td className={styles.mono}>{relativeDate(c.uploadedAt)}</td>
                      <td>
                        <PlanToggles active={c.plans} onToggle={(p) => void toggleCatalogPlan(c, p)} />
                      </td>
                      <td className={styles.actionsCell}>
                        <button
                          className={styles.iconButton}
                          type="button"
                          title="Remover da biblioteca"
                          aria-label={`Remover ${c.fileName} da biblioteca`}
                          onClick={() => handleDeleteCatalog(c)}
                        >
                          <Trash2 size={14} aria-hidden="true" />
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>
      )}

      {tab === "visao" && (
        <section role="tabpanel" aria-label="Visão geral" className={styles.overview}>
          <div className={styles.block}>
            <div className={styles.blockHead}>
              <h2 className={styles.blockTitle}>Contas por plano</h2>
            </div>
            <ul className={styles.planBars}>
              {PLANS.map((p) => {
                const count = planCount(p.id);
                const catalogsForPlan = catalogs.filter((c) => c.plans.includes(p.id)).length;
                return (
                  <li key={p.id}>
                    <span className={styles.planBarTop}>
                      <span>{p.name}</span>
                      <span className={styles.mono}>{count}</span>
                    </span>
                    <span className={styles.barTrack}>
                      <span className={styles.barFill} style={{ width: `${Math.round((count / maxPlanUsers) * 100)}%` }} />
                    </span>
                    <span className={styles.muted}>{catalogsForPlan} catálogo(s) liberado(s)</span>
                  </li>
                );
              })}
            </ul>
          </div>

          <div className={styles.block}>
            <div className={styles.blockHead}>
              <h2 className={styles.blockTitle}>Novas contas</h2>
              <span className={styles.muted}>últimos 6 meses</span>
            </div>
            <div className={styles.chart}>
              {signupMonths.map((m, i) => (
                <div key={`${m.label}-${i}`} className={styles.chartCol}>
                  <span className={styles.chartValue}>{m.count}</span>
                  <span className={styles.chartTrack}>
                    <span
                      className={styles.chartFill}
                      style={{ height: m.count === 0 ? 0 : `${Math.max(6, Math.round((m.count / maxSignups) * 100))}%` }}
                    />
                  </span>
                  <span className={styles.chartLabel}>{m.label}</span>
                </div>
              ))}
            </div>
          </div>

          <div className={`${styles.block} ${styles.blockWide}`}>
            <div className={styles.blockHead}>
              <h2 className={styles.blockTitle}>Planos</h2>
              <span className={styles.muted}>definidos em config/plans.ts</span>
            </div>
            <div className={styles.tableWrap}>
              <table className={styles.table}>
                <thead>
                  <tr>
                    <th scope="col">Plano</th>
                    <th scope="col">Preço</th>
                    <th scope="col" className={styles.num}>
                      Buscas/dia
                    </th>
                    <th scope="col" className={styles.num}>
                      Monitorados
                    </th>
                    <th scope="col">Recursos</th>
                  </tr>
                </thead>
                <tbody>
                  {PLANS.map((p) => (
                    <tr key={p.id} className={styles.rowStatic}>
                      <td>
                        <b>{p.name}</b>
                        <span className={styles.planDesc}>{p.description}</span>
                      </td>
                      <td>{p.priceLabel}</td>
                      <td className={styles.num}>{p.dailySearchLimit}</td>
                      <td className={styles.num}>{p.maxWatches}</td>
                      <td className={styles.muted}>
                        {[
                          p.features.printableReport && "relatório PDF",
                          p.features.productAssistant && "assistente",
                          p.features.autoWatchCheck && "checagem diária",
                        ]
                          .filter(Boolean)
                          .join(" · ") || "—"}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>

          <div className={`${styles.block} ${styles.blockWide}`}>
            <div className={styles.blockHead}>
              <h2 className={styles.blockTitle}>Chaves cadastradas pelas contas</h2>
              <span className={styles.muted}>quantas contas têm cada provedor</span>
            </div>
            <ul className={styles.keyBars}>
              {ALL_KEY_PROVIDERS.map((k) => {
                const n = users.filter((u) => (u.apiKeyProviders ?? []).includes(k)).length;
                return (
                  <li key={k}>
                    <span>{k}</span>
                    <span className={styles.barTrack}>
                      <span className={styles.barFill} style={{ width: `${users.length ? Math.round((n / users.length) * 100) : 0}%` }} />
                    </span>
                    <span className={styles.mono}>{n}</span>
                  </li>
                );
              })}
            </ul>
          </div>
        </section>
      )}

      {openUser && (
        <AdminUserSheet
          user={openUser}
          isSelf={openUser.uid === profile.uid}
          onChangePlan={(uid, plan) => void handleChangeUserPlan(uid, plan)}
          onToggleAdmin={(uid, isAdmin) => void handleToggleUserAdmin(uid, isAdmin)}
          onClose={() => setOpenUid(null)}
        />
      )}
    </div>
  );
}

function SortIcon({ active, dir }: { active: boolean; dir: "asc" | "desc" }) {
  if (!active) return <ChevronDown size={12} className={styles.sortIdle} aria-hidden="true" />;
  return dir === "asc" ? <ArrowUp size={12} aria-hidden="true" /> : <ArrowDown size={12} aria-hidden="true" />;
}

function PlanToggles({ active, onToggle }: { active: PlanId[]; onToggle: (p: PlanId) => void }) {
  return (
    <span className={styles.planToggles}>
      {PLANS.map((p) => {
        const on = active.includes(p.id);
        return (
          <button
            key={p.id}
            type="button"
            aria-pressed={on}
            className={on ? styles.planToggleOn : styles.planToggle}
            onClick={() => onToggle(p.id)}
          >
            {on && <Check size={12} aria-hidden="true" />}
            {p.name}
          </button>
        );
      })}
    </span>
  );
}

/** Menu "⋯" por linha (padrão do data table do shadcn). Fecha no clique fora e no Esc. */
function RowMenu({
  label,
  items,
}: {
  label: string;
  items: { label: string; onSelect: () => void; danger?: boolean }[];
}) {
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!open) return;
    function onPointerDown(e: PointerEvent) {
      if (!wrapRef.current?.contains(e.target as Node)) setOpen(false);
    }
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") {
        setOpen(false);
        buttonRef.current?.focus();
      }
    }
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  return (
    <div className={styles.menuWrap} ref={wrapRef}>
      <button
        ref={buttonRef}
        type="button"
        className={styles.iconButton}
        aria-label={label}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        <MoreHorizontal size={16} aria-hidden="true" />
      </button>
      {open && (
        <div className={styles.menu} role="menu">
          {items.map((item) => (
            <button
              key={item.label}
              type="button"
              role="menuitem"
              className={item.danger ? styles.menuItemDanger : styles.menuItem}
              onClick={() => {
                setOpen(false);
                item.onSelect();
              }}
            >
              {item.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
