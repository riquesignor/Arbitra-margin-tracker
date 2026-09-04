import { useEffect, useState } from "react";
import { motion } from "framer-motion";
import {
  ShieldAlert,
  ShieldCheck,
  UploadCloud,
  FileText,
  Trash2,
  Loader2,
  AlertCircle,
  Search,
  Check,
  ChevronDown,
  ChevronRight,
  KeyRound,
  Gauge,
  X,
  RefreshCw,
  Server,
} from "lucide-react";
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
import { getTodayUsage } from "../lib/usageQuota";
import { listCatalogUploads, type CatalogUploadRecord } from "../lib/catalogHistory";
import { fetchAdminDiagnostics, type AdminDiagnostics } from "../lib/adminDiagnostics";
import styles from "./Admin.module.css";

const DETAIL_CATALOG_LIMIT = 5;

interface Props {
  profile: UserProfile | null;
}

interface DraftCatalog {
  fileName: string;
  rows: CatalogRow[];
  skippedAmbiguous: number;
  plans: PlanId[];
}

/**
 * Base do sistema de planos (ver conversa sobre a ideia do parceiro):
 * admin sobe um PDF, o parser client-side existente (`parsePdfCatalog.ts`)
 * já extrai os produtos, e o admin escolhe quais planos enxergam aquele
 * catálogo — vira um item da biblioteca (`shared_catalogs`). Guardamos
 * só os produtos extraídos, não o PDF original (ver comentário em
 * `sharedCatalogs.ts` sobre por que isso evita depender de Firebase
 * Storage). Gestão de plano por usuário é manual aqui, sem billing.
 */
export default function Admin({ profile }: Props) {
  const [catalogs, setCatalogs] = useState<SharedCatalog[]>([]);
  const [catalogsLoading, setCatalogsLoading] = useState(false);
  const [users, setUsers] = useState<UserProfile[]>([]);
  const [usersLoading, setUsersLoading] = useState(false);

  const [draft, setDraft] = useState<DraftCatalog | null>(null);
  const [parsing, setParsing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Filtro da tabela "Contas e permissões" — só recorta o array `users`
  // já carregado, não dispara nenhuma chamada nova ao Firestore.
  const [filterText, setFilterText] = useState("");
  const [onlyAdmins, setOnlyAdmins] = useState(false);

  // Detalhe por usuário (ADR-0002, Action Item 1) — um único usuário
  // expandido por vez, carregado sob demanda (não pré-carrega uso/
  // histórico de todo mundo, só de quem o admin de fato abrir).
  const [expandedUid, setExpandedUid] = useState<string | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailUsage, setDetailUsage] = useState<number>(0);
  const [detailCatalogs, setDetailCatalogs] = useState<CatalogUploadRecord[]>([]);

  // Diagnóstico de config server-side (SCRAPERAPI_KEY, OAuth ML, Firebase
  // Admin) — ver adminDiagnostics.ts. `null` = ainda não carregou OU o
  // endpoint falhou; os dois casos mostram "verificando"/erro, nunca
  // "não configurado" por engano.
  const [diagnostics, setDiagnostics] = useState<AdminDiagnostics | null>(null);
  const [diagnosticsLoading, setDiagnosticsLoading] = useState(false);

  function refreshDiagnostics() {
    setDiagnosticsLoading(true);
    fetchAdminDiagnostics()
      .then(setDiagnostics)
      .finally(() => setDiagnosticsLoading(false));
  }

  useEffect(() => {
    if (!profile?.isAdmin) return;
    refreshCatalogs();
    refreshUsers();
    refreshDiagnostics();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [profile?.isAdmin]);

  function refreshCatalogs() {
    setCatalogsLoading(true);
    listAllSharedCatalogs()
      .then(setCatalogs)
      .finally(() => setCatalogsLoading(false));
  }

  function refreshUsers() {
    setUsersLoading(true);
    listAllUsers()
      .then(setUsers)
      .finally(() => setUsersLoading(false));
  }

  async function handleFileSelected(file: File) {
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

  function toggleDraftPlan(planId: PlanId) {
    setDraft((d) =>
      d
        ? {
            ...d,
            plans: d.plans.includes(planId)
              ? d.plans.filter((p) => p !== planId)
              : [...d.plans, planId],
          }
        : d
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
      setDraft(null);
      refreshCatalogs();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  }

  async function toggleCatalogPlan(catalog: SharedCatalog, planId: PlanId) {
    const next = catalog.plans.includes(planId)
      ? catalog.plans.filter((p) => p !== planId)
      : [...catalog.plans, planId];
    setCatalogs((prev) => prev.map((c) => (c.id === catalog.id ? { ...c, plans: next } : c)));
    try {
      await updateSharedCatalogPlans(catalog.id, next);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      refreshCatalogs();
    }
  }

  async function handleDeleteCatalog(id: string) {
    setCatalogs((prev) => prev.filter((c) => c.id !== id));
    try {
      await deleteSharedCatalog(id);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      refreshCatalogs();
    }
  }

  async function handleChangeUserPlan(uid: string, plan: PlanId) {
    setUsers((prev) => prev.map((u) => (u.uid === uid ? { ...u, plan } : u)));
    try {
      await updateUserPlan(uid, plan);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      refreshUsers();
    }
  }

  async function handleToggleUserAdmin(uid: string, isAdmin: boolean) {
    setUsers((prev) => prev.map((u) => (u.uid === uid ? { ...u, isAdmin } : u)));
    try {
      await updateUserAdmin(uid, isAdmin);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      refreshUsers();
    }
  }

  /**
   * Abre/fecha o detalhe de um usuário. Reaproveita `getTodayUsage` e
   * `listCatalogUploads` sem nenhuma mudança nelas — o que muda é só a
   * security rule (agora com `allow read` pra admin), então o mesmo
   * código que o próprio usuário usa em Dashboard.tsx funciona aqui pra
   * ler o uid de QUALQUER usuário quando quem está logado é admin.
   */
  async function toggleUserDetail(uid: string) {
    if (expandedUid === uid) {
      setExpandedUid(null);
      return;
    }
    setExpandedUid(uid);
    setDetailLoading(true);
    try {
      const [usage, catalogs] = await Promise.all([
        getTodayUsage(uid),
        listCatalogUploads(uid, DETAIL_CATALOG_LIMIT),
      ]);
      setDetailUsage(usage);
      setDetailCatalogs(catalogs);
    } finally {
      setDetailLoading(false);
    }
  }

  if (!profile?.isAdmin) {
    return (
      <div className={styles.container}>
        <h1 className={styles.title}>Admin</h1>
        <div className={styles.deniedCard}>
          <span className={styles.avatar}>
            <ShieldAlert size={20} />
          </span>
          <p className={styles.hint}>Acesso restrito a administradores.</p>
        </div>
      </div>
    );
  }

  const filteredUsers = users.filter((u) => {
    if (onlyAdmins && !u.isAdmin) return false;
    const needle = filterText.trim().toLowerCase();
    if (!needle) return true;
    return (u.email ?? "").toLowerCase().includes(needle) || u.uid.toLowerCase().includes(needle);
  });

  const adminCount = users.filter((u) => u.isAdmin).length;
  const catalogsWithoutPlan = catalogs.filter((c) => c.plans.length === 0);
  const totalProducts = catalogs.reduce((sum, c) => sum + c.rows.length, 0);

  const stats = [
    { label: "contas", value: String(users.length), foot: `${adminCount} com acesso admin` },
    {
      label: "catálogos na biblioteca",
      value: String(catalogs.length),
      foot:
        catalogsWithoutPlan.length > 0
          ? `${catalogsWithoutPlan.length} sem plano atribuído`
          : "todos com plano atribuído",
    },
    {
      label: "produtos indexados",
      value: totalProducts.toLocaleString("pt-BR"),
      foot: "somados em toda a biblioteca",
    },
    { label: "planos ativos", value: String(PLANS.length), foot: PLANS.map((p) => p.name).join(" · ") },
  ];

  const maxPlanUsers = Math.max(1, ...PLANS.map((p) => users.filter((u) => u.plan === p.id).length));

  // "Novas contas" — últimos 6 meses, contados a partir do createdAt real
  // de cada perfil (users/{uid}). Nada aqui é dado ilustrativo.
  const now = new Date();
  const signupMonths = Array.from({ length: 6 }, (_, i) => {
    const monthDate = new Date(now.getFullYear(), now.getMonth() - (5 - i), 1);
    const count = users.filter((u) => {
      if (!u.createdAt) return false;
      const created = new Date(u.createdAt);
      return (
        created.getFullYear() === monthDate.getFullYear() &&
        created.getMonth() === monthDate.getMonth()
      );
    }).length;
    const label = monthDate.toLocaleDateString("pt-BR", { month: "short" }).replace(".", "");
    return { label, count };
  });
  const maxSignups = Math.max(1, ...signupMonths.map((m) => m.count));

  return (
    <motion.div
      className={styles.container}
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.3, ease: [0.16, 1, 0.3, 1] }}
    >
      <div className={styles.header}>
        <div className={styles.headerMain}>
          <span className={styles.eyebrow}>Painel administrativo</span>
          <h1 className={styles.title}>Central de administração</h1>
          <p className={styles.subtitle}>
            Gerencie a biblioteca compartilhada, o acesso de cada plano e as permissões das
            contas.
          </p>
        </div>
        <div className={styles.headerCard}>
          <span className={styles.headerCardIcon}>
            <ShieldCheck size={15} />
          </span>
          <span className={styles.headerCardText}>
            <span className={styles.headerCardLabel}>administrador</span>
            <span className={styles.headerCardValue}>{profile.email ?? profile.uid}</span>
          </span>
        </div>
      </div>

      {error && (
        <p className={styles.error}>
          <AlertCircle size={14} style={{ verticalAlign: "-2px", marginRight: 4 }} /> {error}
        </p>
      )}

      <div className={styles.statsGrid}>
        {stats.map((s) => (
          <div key={s.label} className={styles.statCard}>
            <span className={styles.statCardLabel}>{s.label}</span>
            <span className={styles.statCardValue}>{s.value}</span>
            <span className={styles.statCardFoot}>{s.foot}</span>
          </div>
        ))}
      </div>

      <section className={styles.card} style={{ marginBottom: "var(--space-5)" }}>
        <div className={styles.cardHeader}>
          <span className={styles.cardHeaderNumber}>
            <KeyRound size={13} />
          </span>
          <h2 className={styles.cardHeaderTitle}>Diagnóstico de configuração</h2>
          <span className={styles.cardHeaderMeta}>
            <Server size={11} style={{ verticalAlign: "-2px", marginRight: 4 }} />
            {diagnostics?.environment ?? "verificando ambiente…"}
          </span>
          <button
            type="button"
            onClick={refreshDiagnostics}
            disabled={diagnosticsLoading}
            className={styles.diagRefreshButton}
            title="Reconsultar"
          >
            <RefreshCw size={13} className={diagnosticsLoading ? "spin" : undefined} />
          </button>
        </div>
        <div className={styles.cardBody}>
          {!diagnostics ? (
            <p className={styles.hint}>
              {diagnosticsLoading
                ? "Consultando variáveis de ambiente do servidor…"
                : "Não consegui consultar agora — clique em recarregar."}
            </p>
          ) : (
            <>
              {/*
                Linha "ScraperAPI (SCRAPERAPI_KEY)" REMOVIDA (set/2026, mesma
                sessão da conversão BYOK — ver comentário no topo de
                src/lib/userSecrets.ts e de api/admin-diagnostics.ts): não
                existe mais env var de servidor pra checar, a chave é por
                usuário. "ScraperAPI" entrou na lista BYOK logo abaixo.
              */}
              <div className={styles.diagRow}>
                <span
                  className={diagnostics.mercadoLivreOAuthConfigured ? styles.diagOk : styles.diagMissing}
                >
                  {diagnostics.mercadoLivreOAuthConfigured ? <Check size={14} /> : <X size={14} />}
                </span>
                <span className={styles.diagLabel}>
                  <strong>OAuth Mercado Livre (ML_CLIENT_ID / ML_CLIENT_SECRET)</strong>
                  <span>Hoje parked por pendência de verificação de titularidade no DevCenter deles.</span>
                </span>
              </div>
              <div className={styles.diagRow}>
                <span className={diagnostics.firebaseAdminConfigured ? styles.diagOk : styles.diagMissing}>
                  {diagnostics.firebaseAdminConfigured ? <Check size={14} /> : <X size={14} />}
                </span>
                <span className={styles.diagLabel}>
                  <strong>Firebase Admin (server-side)</strong>
                  <span>Se isto aparecer como ausente, nada nesta tela funcionaria — sinal de alerta grave.</span>
                </span>
              </div>
              <p className={styles.hint} style={{ marginTop: "var(--space-3)" }}>
                BYOK (chave própria do usuário, cadastrada em Conta — nunca configurável pela
                plataforma): {diagnostics.byokOnlyProviders.join(" · ")}.
              </p>
            </>
          )}
        </div>
      </section>

      <div className={styles.layout}>
        <div className={styles.main}>
          <section className={styles.card}>
            <div className={styles.cardHeader}>
              <span className={styles.cardHeaderNumber}>01</span>
              <h2 className={styles.cardHeaderTitle}>Publicar catálogo na biblioteca</h2>
              <span className={styles.cardHeaderMeta}>PDF · parse no navegador</span>
            </div>
            <div className={styles.cardBody}>
              {!draft ? (
                <label
                  className={
                    parsing ? `${styles.uploadRow} ${styles.uploadRowDisabled}` : styles.uploadRow
                  }
                >
                  <span className={styles.uploadIconBox}>
                    {parsing ? (
                      <Loader2 size={20} className="spin" />
                    ) : (
                      <UploadCloud size={20} strokeWidth={2} />
                    )}
                  </span>
                  <span className={styles.uploadText}>
                    <span className={styles.uploadTitle}>
                      {parsing ? "Lendo PDF…" : "Escolher PDF do fornecedor"}
                    </span>
                    <span className={styles.uploadHint}>
                      os produtos são extraídos aqui — o PDF original não é armazenado
                    </span>
                  </span>
                  <span className={styles.uploadButton}>selecionar</span>
                  <input
                    className={styles.fileInput}
                    type="file"
                    accept=".pdf"
                    disabled={parsing}
                    onChange={(e) => e.target.files?.[0] && void handleFileSelected(e.target.files[0])}
                  />
                </label>
              ) : (
                <div className={styles.draft}>
                  <div className={styles.draftInfo}>
                    <FileText size={14} /> {draft.fileName} · {draft.rows.length} produtos
                    reconhecidos
                    {draft.skippedAmbiguous > 0 && ` · ${draft.skippedAmbiguous} linha(s) ignorada(s)`}
                  </div>
                  <div className={styles.planChips}>
                    {PLANS.map((p) => {
                      const active = draft.plans.includes(p.id);
                      return (
                        <button
                          key={p.id}
                          type="button"
                          className={active ? styles.planChipActive : styles.planChip}
                          onClick={() => toggleDraftPlan(p.id)}
                        >
                          {active && <Check size={12} />} {p.name}
                        </button>
                      );
                    })}
                  </div>
                  <div className={styles.draftActions}>
                    <button
                      className={styles.button}
                      type="button"
                      disabled={saving || draft.plans.length === 0}
                      onClick={() => void handleSaveDraft()}
                    >
                      {saving ? "Salvando…" : "Salvar na biblioteca"}
                    </button>
                    <button className={styles.linkButton} type="button" onClick={() => setDraft(null)}>
                      Cancelar
                    </button>
                  </div>
                  {draft.plans.length === 0 && (
                    <p className={styles.hintSmall}>Selecione ao menos um plano antes de salvar.</p>
                  )}
                </div>
              )}
            </div>
          </section>

          <section className={styles.card}>
            <div className={styles.cardHeader}>
              <span className={styles.cardHeaderNumber}>02</span>
              <h2 className={styles.cardHeaderTitle}>Biblioteca compartilhada</h2>
              <span className={styles.cardHeaderMeta}>
                {catalogsLoading && <Loader2 size={12} className="spin" />}
                {catalogs.length} catálogo(s)
              </span>
            </div>
            {catalogs.length === 0 && !catalogsLoading ? (
              <div className={styles.tableEmpty}>Nenhum catálogo na biblioteca ainda.</div>
            ) : (
              <>
                <div className={styles.catalogHeadRow}>
                  <span>arquivo</span>
                  <span>produtos</span>
                  <span>planos com acesso</span>
                  <span />
                </div>
                {catalogs.map((catalog) => (
                  <div key={catalog.id} className={styles.catalogRow}>
                    <span className={styles.catalogCellFile}>
                      <FileText size={13} /> {catalog.fileName}
                    </span>
                    <span className={styles.catalogCellCount}>{catalog.rows.length}</span>
                    <div className={styles.catalogCellPlans}>
                      {PLANS.map((p) => {
                        const active = catalog.plans.includes(p.id);
                        return (
                          <button
                            key={p.id}
                            type="button"
                            className={active ? styles.planChipActive : styles.planChip}
                            onClick={() => void toggleCatalogPlan(catalog, p.id)}
                          >
                            {active && <Check size={12} />} {p.name}
                          </button>
                        );
                      })}
                    </div>
                    <button
                      className={styles.iconButton}
                      type="button"
                      title="Remover da biblioteca"
                      onClick={() => void handleDeleteCatalog(catalog.id)}
                    >
                      <Trash2 size={14} />
                    </button>
                  </div>
                ))}
              </>
            )}
          </section>

          <section className={styles.card}>
            <div className={styles.cardHeader}>
              <span className={styles.cardHeaderNumber}>03</span>
              <h2 className={styles.cardHeaderTitle}>Contas e permissões</h2>
              <span className={styles.cardHeaderMeta}>
                {usersLoading && <Loader2 size={12} className="spin" />}
                {filteredUsers.length} de {users.length} conta(s)
              </span>
            </div>
            <div className={styles.filterBar}>
              <span className={styles.filterInputWrap}>
                <Search size={13} />
                <input
                  className={styles.filterInput}
                  type="text"
                  placeholder="filtrar por email ou uid"
                  value={filterText}
                  onChange={(e) => setFilterText(e.target.value)}
                />
              </span>
              <button
                type="button"
                className={onlyAdmins ? styles.planChipActive : styles.planChip}
                onClick={() => setOnlyAdmins((v) => !v)}
              >
                {onlyAdmins && <Check size={12} />} só admins
              </button>
            </div>
            {filteredUsers.length === 0 && !usersLoading ? (
              <div className={styles.tableEmpty}>Nenhuma conta encontrada.</div>
            ) : (
              <>
                <div className={styles.userHeadRow}>
                  <span>conta</span>
                  <span>entrou em</span>
                  <span>plano</span>
                  <span>permissão</span>
                </div>
                {filteredUsers.map((u) => {
                  const expanded = expandedUid === u.uid;
                  return (
                    <div key={u.uid} className={styles.userBlock}>
                      <div className={styles.userRow}>
                        <span className={styles.userCellAccount}>
                          <button
                            type="button"
                            className={styles.expandButton}
                            onClick={() => void toggleUserDetail(u.uid)}
                            title="Ver detalhe"
                          >
                            {expanded ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
                          </button>
                          <span className={styles.userCellEmailWrap}>
                            <span className={styles.userCellEmail}>{u.email ?? "—"}</span>
                            <span className={styles.userCellUid}>{u.uid}</span>
                          </span>
                          {u.hasSerpApiKey && (
                            <span className={styles.keyBadge} title="Tem chave SerpApi cadastrada">
                              <KeyRound size={11} />
                            </span>
                          )}
                        </span>
                        <span className={styles.userCellSince}>
                          {u.createdAt ? new Date(u.createdAt).toLocaleDateString("pt-BR") : "—"}
                        </span>
                        <select
                          className={styles.select}
                          value={u.plan}
                          onChange={(e) => void handleChangeUserPlan(u.uid, e.target.value as PlanId)}
                        >
                          {PLANS.map((p) => (
                            <option key={p.id} value={p.id}>
                              {p.name}
                            </option>
                          ))}
                        </select>
                        <button
                          type="button"
                          className={u.isAdmin ? styles.planChipActive : styles.planChip}
                          onClick={() => void handleToggleUserAdmin(u.uid, !u.isAdmin)}
                        >
                          {u.isAdmin && <Check size={12} />} Admin
                        </button>
                      </div>

                      {expanded && (
                        <div className={styles.detailPanel}>
                          {detailLoading ? (
                            <p className={styles.hintSmall}>
                              <Loader2 size={12} className="spin" /> Carregando…
                            </p>
                          ) : (
                            <>
                              <div className={styles.detailMeta}>
                                <span className={styles.detailMetaItem}>
                                  <Gauge size={13} /> {detailUsage} busca(s) hoje
                                </span>
                                <span className={styles.detailMetaItem}>
                                  <KeyRound size={13} />
                                  {u.hasSerpApiKey ? " chave SerpApi cadastrada" : " sem chave SerpApi"}
                                </span>
                              </div>

                              <div className={styles.hintSmall}>
                                Últimos catálogos ({detailCatalogs.length})
                              </div>
                              {detailCatalogs.length === 0 && (
                                <p className={styles.hintSmall}>Nenhum catálogo processado ainda.</p>
                              )}
                              {detailCatalogs.map((c) => (
                                <div key={c.id} className={styles.detailCatalogRow}>
                                  <span className={styles.userCellEmail}>
                                    <FileText size={12} /> {c.fileName}
                                  </span>
                                  <span className={styles.userCellUid}>
                                    {c.results.length}/{c.rows.length} produtos ·{" "}
                                    {(c.marketplaces ?? []).join(" + ") || "—"}
                                  </span>
                                  <span className={styles.userCellUid}>
                                    {new Date(c.uploadedAt).toLocaleDateString("pt-BR")}
                                  </span>
                                </div>
                              ))}
                            </>
                          )}
                        </div>
                      )}
                    </div>
                  );
                })}
              </>
            )}
          </section>
        </div>

        <aside className={styles.aside}>
          <section className={styles.card}>
            <div className={styles.cardHeader}>
              <h2 className={styles.cardHeaderTitle}>Contas por plano</h2>
            </div>
            <div className={styles.planBars}>
              {PLANS.map((p) => {
                const count = users.filter((u) => u.plan === p.id).length;
                const catalogsForPlan = catalogs.filter((c) => c.plans.includes(p.id)).length;
                return (
                  <div key={p.id} className={styles.planBar}>
                    <div className={styles.planBarHeader}>
                      {p.name}
                      <span className={styles.planBarValue}>{count}</span>
                    </div>
                    <span className={styles.planBarTrack}>
                      <span
                        className={styles.planBarFill}
                        style={{ width: `${Math.round((count / maxPlanUsers) * 100)}%` }}
                      />
                    </span>
                    <span className={styles.planBarFoot}>
                      {catalogsForPlan} catálogo(s) liberado(s)
                    </span>
                  </div>
                );
              })}
            </div>
          </section>

          <section className={styles.card}>
            <div className={styles.cardHeader}>
              <h2 className={styles.cardHeaderTitle}>Novas contas</h2>
              <span className={styles.cardHeaderMeta}>6 meses</span>
            </div>
            <div className={styles.chartWrap}>
              <div className={styles.chart}>
                {signupMonths.map((m, i) => (
                  <div key={`${m.label}-${i}`} className={styles.chartBarCol}>
                    <span className={styles.chartBarValue}>{m.count}</span>
                    <span className={styles.chartBarTrack}>
                      <span
                        className={styles.chartBarFill}
                        style={{ height: `${Math.max(4, Math.round((m.count / maxSignups) * 100))}%` }}
                      />
                    </span>
                    <span className={styles.chartBarLabel}>{m.label}</span>
                  </div>
                ))}
              </div>
            </div>
          </section>

          {catalogsWithoutPlan.length > 0 && (
            <section className={styles.cardWarning}>
              <div className={styles.cardHeader}>
                <h2 className={styles.cardHeaderTitle}>Precisa de atenção</h2>
              </div>
              <div className={styles.attentionRow}>
                <span className={styles.attentionDot} />
                <span>
                  {catalogsWithoutPlan.length} catálogo(s) sem plano atribuído — ninguém enxerga na
                  biblioteca até você marcar um plano.
                </span>
              </div>
            </section>
          )}

          <section className={styles.card}>
            <div className={styles.cardHeader}>
              <h2 className={styles.cardHeaderTitle}>Planos</h2>
            </div>
            <div className={styles.planList}>
              {PLANS.map((p) => (
                <div key={p.id} className={styles.planItem}>
                  <div className={styles.planItemHeader}>
                    <span className={styles.planItemName}>{p.name}</span>
                    <span className={styles.planItemPrice}>{p.priceLabel}</span>
                  </div>
                  <span className={styles.planItemDesc}>{p.description}</span>
                </div>
              ))}
            </div>
          </section>
        </aside>
      </div>
    </motion.div>
  );
}
