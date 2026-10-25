import { useEffect, useRef, useState } from "react";
import { Check, FileText, Loader2, Minus, ShieldCheck, X } from "lucide-react";
import type { PlanId } from "../types";
import { PLANS, getPlan } from "../config/plans";
import type { UserProfile } from "../lib/userProfile";
import { getTodayUsage } from "../lib/usageQuota";
import { listCatalogUploads, type CatalogUploadRecord } from "../lib/catalogHistory";
import { ALL_KEY_PROVIDERS, initials } from "../lib/adminUsers";
import { MARKETPLACE_NAME } from "../lib/catalogSummary";
import CopyButton from "./CopyButton";
import styles from "./Admin.module.css";

const DETAIL_CATALOG_LIMIT = 5;

interface Props {
  user: UserProfile;
  isSelf: boolean;
  onChangePlan: (uid: string, plan: PlanId) => void;
  onToggleAdmin: (uid: string, isAdmin: boolean) => void;
  onClose: () => void;
}

/**
 * Detalhe de uma conta (out/2026) — painel lateral no mesmo padrão do
 * ProductSheet (`<dialog>` nativo, Esc fecha, foco preso). Uso de hoje e
 * últimos catálogos são lidos sob demanda, só da conta aberta (security
 * rule dá `read` pra admin em `usage_daily`/`catalog_uploads`, ADR-0002).
 */
export default function AdminUserSheet({ user, isSelf, onChangePlan, onToggleAdmin, onClose }: Props) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const [loading, setLoading] = useState(true);
  const [usage, setUsage] = useState(0);
  const [catalogs, setCatalogs] = useState<CatalogUploadRecord[]>([]);
  const plan = getPlan(user.plan);
  const keys = new Set(user.apiKeyProviders ?? []);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (dialog && !dialog.open) dialog.showModal();
    return () => {
      if (dialog?.open) dialog.close();
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    void Promise.all([getTodayUsage(user.uid), listCatalogUploads(user.uid, DETAIL_CATALOG_LIMIT)])
      .then(([u, c]) => {
        if (cancelled) return;
        setUsage(u);
        setCatalogs(c);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [user.uid]);

  const usagePct = Math.min(100, Math.round((usage / plan.dailySearchLimit) * 100));

  return (
    <dialog
      ref={dialogRef}
      className={styles.sheet}
      aria-labelledby="admin-user-title"
      onCancel={(e) => {
        e.preventDefault();
        onClose();
      }}
      onClick={(e) => {
        if (e.target === dialogRef.current) onClose();
      }}
    >
      <div className={styles.sheetInner}>
        <header className={styles.sheetHeader}>
          <span className={styles.avatarLg} aria-hidden="true">
            {initials(user.email)}
          </span>
          <div className={styles.sheetHeaderText}>
            <h2 id="admin-user-title" className={styles.sheetTitle}>
              {user.email ?? "sem email"}
              {isSelf && <span className={styles.youTag}>você</span>}
            </h2>
            <span className={styles.uid}>
              {user.uid}
              <CopyButton text={user.uid} label="Copiar UID" />
            </span>
          </div>
          <button type="button" className={styles.sheetClose} onClick={onClose} aria-label="Fechar detalhe da conta">
            <X size={18} aria-hidden="true" />
          </button>
        </header>

        <dl className={styles.sheetLedger}>
          <div>
            <dt>Plano</dt>
            <dd>
              <select
                className={styles.select}
                value={user.plan}
                onChange={(e) => onChangePlan(user.uid, e.target.value as PlanId)}
                aria-label="Plano da conta"
              >
                {PLANS.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
              </select>
            </dd>
          </div>
          <div>
            <dt>Papel</dt>
            <dd>
              <span className={user.isAdmin ? styles.roleAdmin : styles.roleUser}>
                {user.isAdmin && <ShieldCheck size={12} aria-hidden="true" />}
                {user.isAdmin ? "Admin" : "Usuário"}
              </span>
            </dd>
          </div>
          <div>
            <dt>Conta criada</dt>
            <dd className={styles.mono}>
              {user.createdAt ? new Date(user.createdAt).toLocaleDateString("pt-BR") : "—"}
            </dd>
          </div>
          <div>
            <dt>Assinatura</dt>
            <dd>{user.mpSubscriptionStatus ?? "—"}</dd>
          </div>
        </dl>

        <section className={styles.sheetSection}>
          <h3 className={styles.sheetSectionTitle}>Uso de hoje</h3>
          {loading ? (
            <p className={styles.muted}>
              <Loader2 size={13} className="spin" aria-hidden="true" /> Carregando…
            </p>
          ) : (
            <>
              <div className={styles.usageLine}>
                <span className={styles.usageValue}>{usage.toLocaleString("pt-BR")}</span>
                <span className={styles.muted}>
                  de {plan.dailySearchLimit.toLocaleString("pt-BR")} buscas (referência do plano {plan.name})
                </span>
              </div>
              <span className={styles.usageTrack} aria-hidden="true">
                <span
                  className={usagePct >= 80 ? styles.usageFillWarn : styles.usageFill}
                  style={{ width: `${Math.max(usage > 0 ? 2 : 0, usagePct)}%` }}
                />
              </span>
            </>
          )}
        </section>

        <section className={styles.sheetSection}>
          <h3 className={styles.sheetSectionTitle}>
            Chaves cadastradas <span className={styles.muted}>{keys.size} de {ALL_KEY_PROVIDERS.length}</span>
          </h3>
          <ul className={styles.keyGrid}>
            {ALL_KEY_PROVIDERS.map((k) => (
              <li key={k} className={keys.has(k) ? styles.keyOn : styles.keyOff}>
                {keys.has(k) ? <Check size={13} aria-hidden="true" /> : <Minus size={13} aria-hidden="true" />}
                {k}
              </li>
            ))}
          </ul>
          <p className={styles.muted}>Só a informação de que existe — o valor da chave nunca chega ao admin.</p>
        </section>

        <section className={styles.sheetSection}>
          <h3 className={styles.sheetSectionTitle}>Últimas buscas</h3>
          {loading ? null : catalogs.length === 0 ? (
            <p className={styles.muted}>Nenhum catálogo processado ainda.</p>
          ) : (
            <ul className={styles.sheetList}>
              {catalogs.map((c) => (
                <li key={c.id}>
                  <span className={styles.sheetListName}>
                    <FileText size={13} aria-hidden="true" /> {c.fileName}
                  </span>
                  <span className={styles.mono}>
                    {c.rows.length} produtos · {c.results.length} ofertas · {(c.marketplaces ?? []).map((m) => MARKETPLACE_NAME[m] ?? m).join(" + ") || "—"} ·{" "}
                    {new Date(c.uploadedAt).toLocaleDateString("pt-BR")}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </section>

        <section className={styles.sheetSection}>
          <h3 className={styles.sheetSectionTitle}>Permissão</h3>
          <p className={styles.muted}>
            {user.isAdmin
              ? "Admin vê todas as contas, troca planos e edita a biblioteca."
              : "Dar admin libera esta tela inteira pra essa conta."}
          </p>
          <div>
            <button
              type="button"
              className={user.isAdmin ? styles.dangerButton : styles.secondaryButton}
              onClick={() => onToggleAdmin(user.uid, !user.isAdmin)}
            >
              <ShieldCheck size={14} aria-hidden="true" />
              {user.isAdmin ? (isSelf ? "Remover meu acesso de admin" : "Remover acesso de admin") : "Tornar admin"}
            </button>
          </div>
        </section>
      </div>
    </dialog>
  );
}
