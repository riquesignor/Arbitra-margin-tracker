import { useState } from "react";
import { Bell, BellOff, BellRing, Loader2 } from "lucide-react";
import type { MarginResult, MarketplaceId, PlanId, SearchProviderId } from "../types";
import { startWatching, stopWatching } from "../lib/watchlist";
import styles from "./WatchToggle.module.css";

interface Props {
  userId: string | null;
  planId: PlanId | null | undefined;
  watching: boolean;
  /** Dado completo pra criar o watch (sku/marketplace vêm daqui) — ver startWatching em lib/watchlist.ts. */
  item: Pick<
    MarginResult,
    "sku" | "name" | "marketplace" | "supplierPrice" | "marketplacePrice" | "marginPct" | "recommendation" | "imageUrl" | "link"
  >;
  /** `null`/`undefined` quando ambíguo (catálogos combinados) ou registro salvo antes desse campo existir — ver comentário em App.tsx > searchProvider. */
  provider: SearchProviderId | null | undefined;
  onChange: (sku: string, marketplace: MarketplaceId, watching: boolean) => void;
}

/**
 * Sino de monitoramento contínuo (out/2026 — ver docs/design-critique-log.md
 * e src/lib/watchlist.ts) — um componente só, reaproveitado em
 * ResultsTable.tsx e Portfolio.tsx, pra não duplicar a lógica de toggle
 * duas vezes. O pai é quem sabe se ESTE sku+marketplace já está sendo
 * monitorado (`watching`, derivado de uma única `listWatches` por tela)
 * e quem atualiza esse estado via `onChange` — este componente só chama
 * startWatching/stopWatching e devolve o resultado.
 */
export default function WatchToggle({ userId, planId, watching, item, provider, onChange }: Props) {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!userId) return null;

  if (!provider) {
    return (
      <span
        className={styles.disabled}
        title="Monitoramento indisponível pra catálogos combinados, ou buscas salvas antes desse recurso existir — reprocesse o catálogo pra habilitar."
      >
        <BellOff size={13} />
      </span>
    );
  }

  async function handleClick() {
    setError(null);
    setLoading(true);
    try {
      if (watching) {
        await stopWatching(userId!, item.sku, item.marketplace);
        onChange(item.sku, item.marketplace, false);
      } else {
        await startWatching(userId!, planId, item as MarginResult, provider!);
        onChange(item.sku, item.marketplace, true);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }

  return (
    <button
      type="button"
      className={watching ? styles.active : styles.idle}
      onClick={() => void handleClick()}
      disabled={loading}
      title={
        error ??
        (watching
          ? "Parar de monitorar este produto"
          : "Monitorar este produto — avisa quando o preço mudar ou esgotar")
      }
    >
      {loading ? <Loader2 size={13} className="spin" /> : watching ? <BellRing size={13} /> : <Bell size={13} />}
    </button>
  );
}
