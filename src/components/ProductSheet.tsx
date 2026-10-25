import { useEffect, useRef, useState } from "react";
import { ExternalLink, ImageOff, X } from "lucide-react";
import type { MarginResult, MarketplaceId, PlanId, Recommendation, SearchProviderId } from "../types";
import { brl, displayProductName, marginTone, pct } from "../lib/format";
import { MARKETPLACE_NAME, shortDate, signedPct } from "../lib/catalogSummary";
import { watchId } from "../lib/watchlist";
import CopyButton from "./CopyButton";
import PriceSparkline from "./PriceSparkline";
import WatchToggle from "./WatchToggle";
import styles from "./ProductSheet.module.css";

/**
 * Painel lateral de produto (out/2026) — abre ao clicar numa linha de
 * Resultados ou Meus produtos. Junta o que na tabela fica espremido em
 * células e tooltips: a CONTA da margem (preço − custo − taxas − frete −
 * impostos), todas as ofertas encontradas pro SKU, o histórico de preço e
 * o botão de monitorar. `<dialog>` nativo com `showModal()`: foco preso
 * dentro, Esc fecha, resto da página inerte.
 */

interface WatchProps {
  userId: string | null;
  planId: PlanId | null | undefined;
  provider: SearchProviderId | null | undefined;
  watchedKeys: Set<string>;
  onChange: (sku: string, marketplace: MarketplaceId, watching: boolean) => void;
}

interface Props {
  /** Todas as ofertas desse SKU (uma por marketplace/catálogo). Pelo menos uma. */
  offers: MarginResult[];
  targetMarginPct: number;
  /** Série cronológica de preço das buscas salvas (ver buildPortfolio). */
  priceHistory?: { price: number; date: number }[];
  watch?: WatchProps;
  onClose: () => void;
}

const REC_LABEL: Record<Recommendation, string> = {
  recomendado: "Recomendado",
  revisar: "Revisar",
  evitar: "Evitar",
  sem_custo: "Sem custo",
};

const SANITY_TEXT: Record<NonNullable<MarginResult["priceSanityFlag"]>, string> = {
  abaixo_do_custo:
    "Preço bem abaixo do seu custo — costuma ser acessório, peça avulsa ou outro produto. Abra o anúncio antes de usar esse preço.",
  muito_acima_do_custo:
    "Preço muitas vezes acima do seu custo — pode ser lote que o título não declarou, ou outro produto. Abra o anúncio antes de usar esse preço.",
};

const TONE_CLASS = { good: styles.toneGood, warn: styles.toneWarn, bad: styles.toneBad } as const;

function bestOffer(offers: MarginResult[]): MarginResult {
  return [...offers].sort((a, b) => (b.marginPct ?? -Infinity) - (a.marginPct ?? -Infinity))[0];
}

export default function ProductSheet({ offers, targetMarginPct, priceHistory = [], watch, onClose }: Props) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const best = bestOffer(offers);
  const [imageFailed, setImageFailed] = useState(false);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (dialog && !dialog.open) dialog.showModal();
    return () => {
      if (dialog?.open) dialog.close();
    };
  }, []);

  const tone = best.marginPct != null ? TONE_CLASS[marginTone(best.marginPct, targetMarginPct)] : "";
  const hasBreakdown = best.supplierPrice != null && best.totalCost != null;
  const surplus = hasBreakdown ? best.marketplacePrice - best.totalCost! : null;
  const otherOffers = offers.filter((o) => o !== best);
  const historyDesc = [...priceHistory].reverse().slice(0, 8);

  return (
    <dialog
      ref={dialogRef}
      className={styles.sheet}
      aria-labelledby="product-sheet-title"
      onCancel={(e) => {
        e.preventDefault();
        onClose();
      }}
      onClick={(e) => {
        if (e.target === dialogRef.current) onClose();
      }}
    >
      <div className={styles.inner}>
        <header className={styles.header}>
          {best.imageUrl && !imageFailed ? (
            <img
              className={styles.photo}
              src={best.imageUrl}
              alt=""
              onError={() => setImageFailed(true)}
            />
          ) : (
            <span className={styles.photoEmpty} aria-hidden="true">
              <ImageOff size={18} />
            </span>
          )}
          <div className={styles.headerText}>
            <h2 id="product-sheet-title" className={styles.name}>
              {displayProductName(best.name)}
            </h2>
            <span className={styles.sku}>
              {best.sku}
              <CopyButton text={best.sku} label="Copiar SKU" />
            </span>
          </div>
          <button type="button" className={styles.close} onClick={onClose} aria-label="Fechar painel do produto">
            <X size={18} aria-hidden="true" />
          </button>
        </header>

        {/* ─── veredito ─── */}
        <section className={styles.verdict}>
          <span className={`${styles.badge} ${styles[`rec_${best.recommendation}`]}`}>{REC_LABEL[best.recommendation]}</span>
          {best.marginPct != null ? (
            <>
              <span className={`${styles.margin} ${tone}`}>{signedPct(best.marginPct)}</span>
              <span className={styles.marginNote}>
                margem sobre o custo · meta {pct(targetMarginPct, 0)}
                {offers.length > 1 ? ` · melhor de ${offers.length} ofertas` : ""}
              </span>
            </>
          ) : (
            <span className={styles.marginNote}>
              Catálogo sem preço de custo pra este produto — dá pra ver o preço de mercado, mas não a margem.
            </span>
          )}
        </section>

        {/* ─── a conta ─── */}
        {hasBreakdown && (
          <section className={styles.section}>
            <h3 className={styles.sectionTitle}>Como a margem fecha</h3>
            <dl className={styles.ledger}>
              <div className={styles.ledgerRow}>
                <dt>
                  Preço de mercado ({MARKETPLACE_NAME[best.marketplace]})
                  {best.packQuantity != null && best.listingPrice != null && (
                    <span className={styles.ledgerHint}>
                      lote de {best.packQuantity} por {brl(best.listingPrice)} — conta por unidade
                    </span>
                  )}
                </dt>
                <dd>{brl(best.marketplacePrice)}</dd>
              </div>
              <div className={styles.ledgerRow}>
                <dt>Custo do produto</dt>
                <dd>− {brl(best.supplierPrice!)}</dd>
              </div>
              <div className={styles.ledgerRow}>
                <dt>Taxas do marketplace</dt>
                <dd>− {brl(best.feesCost ?? 0)}</dd>
              </div>
              <div className={styles.ledgerRow}>
                <dt>Frete</dt>
                <dd>− {brl(best.shippingCost ?? 0)}</dd>
              </div>
              <div className={styles.ledgerRow}>
                <dt>Impostos</dt>
                <dd>− {brl(best.taxesCost ?? 0)}</dd>
              </div>
              <div className={styles.ledgerTotal}>
                <dt>Sobra por unidade</dt>
                <dd className={tone}>{brl(surplus!)}</dd>
              </div>
            </dl>
            <p className={styles.formula}>
              {brl(surplus!)} ÷ {brl(best.supplierPrice!)} de custo = <b className={tone}>{signedPct(best.marginPct!)}</b>
            </p>
            {best.suggestedPrice != null && (
              <p className={styles.suggested}>
                Pra bater a meta de {pct(targetMarginPct, 0)}, venda a <b>{brl(best.suggestedPrice)}</b>
                {best.suggestedPrice <= best.marketplacePrice
                  ? " — cabe no preço de mercado."
                  : ` — ${brl(best.suggestedPrice - best.marketplacePrice)} acima do mercado.`}
              </p>
            )}
          </section>
        )}

        {/* ─── ofertas ─── */}
        <section className={styles.section}>
          <h3 className={styles.sectionTitle}>
            {offers.length === 1 ? "Oferta encontrada" : `${offers.length} ofertas encontradas`}
          </h3>
          <ul className={styles.offers}>
            {[best, ...otherOffers].map((o, i) => (
              <li key={`${o.marketplace}-${o.sourceUpload?.id ?? i}`} className={styles.offer}>
                <div className={styles.offerTop}>
                  <span className={styles.offerMarket}>{MARKETPLACE_NAME[o.marketplace]}</span>
                  <span className={styles.offerPrice}>{brl(o.marketplacePrice)}</span>
                  {o.marginPct != null && (
                    <span className={`${styles.offerMargin} ${TONE_CLASS[marginTone(o.marginPct, targetMarginPct)]}`}>
                      {signedPct(o.marginPct)}
                    </span>
                  )}
                </div>
                {o.matchedTitle && <p className={styles.offerLine}>Encontrado como “{o.matchedTitle}”</p>}
                <p className={styles.offerMeta}>
                  {Math.round(o.confidence * 100)}% de confiança
                  {o.confidenceSource ? ` (pela ${o.confidenceSource === "visual" ? "foto" : "semelhança do nome"})` : ""}
                  {" · "}
                  {o.competitorCount} {o.competitorCount === 1 ? "vendedor" : "vendedores"}
                  {o.buyBoxEligible ? " · elegível ao ganha-compra" : ""}
                  {o.reviewCount != null && o.reviewCount > 0
                    ? ` · ${o.reviewCount.toLocaleString("pt-BR")} ${o.marketplace === "mercadolivre" ? "vendas" : "avaliações"}`
                    : ""}
                  {o.rating != null ? ` · nota ${o.rating.toFixed(1).replace(".", ",")}` : ""}
                  {o.sourceUpload ? ` · catálogo ${o.sourceUpload.fileName}` : ""}
                </p>
                {o.approximate && (
                  <p className={styles.offerWarning}>
                    {o.priceSanityFlag
                      ? SANITY_TEXT[o.priceSanityFlag]
                      : o.matchedSource
                        ? `Correspondência aproximada — preço encontrado em "${o.matchedSource}", não no marketplace pedido.`
                        : "Correspondência aproximada — pode não ser exatamente o produto do seu catálogo."}
                  </p>
                )}
                <div className={styles.offerActions}>
                  {o.link ? (
                    <a className={styles.offerLink} href={o.link} target="_blank" rel="noopener noreferrer">
                      <ExternalLink size={13} aria-hidden="true" /> Ver anúncio
                    </a>
                  ) : (
                    <span className={styles.noLink}>a fonte não devolveu link do anúncio</span>
                  )}
                  {watch?.userId && watch.provider && (
                    <span className={styles.watch}>
                      <WatchToggle
                        userId={watch.userId}
                        planId={watch.planId}
                        provider={watch.provider}
                        item={o}
                        watching={watch.watchedKeys.has(watchId(o.sku, o.marketplace))}
                        onChange={watch.onChange}
                      />
                      {watch.watchedKeys.has(watchId(o.sku, o.marketplace)) ? "monitorando" : "monitorar"}
                    </span>
                  )}
                </div>
              </li>
            ))}
          </ul>
        </section>

        {/* ─── histórico ─── */}
        <section className={styles.section}>
          <h3 className={styles.sectionTitle}>Histórico de preço</h3>
          {priceHistory.length >= 2 ? (
            <>
              <div className={styles.chart}>
                <PriceSparkline points={priceHistory} width={440} height={72} />
              </div>
              <ol className={styles.historyList}>
                {historyDesc.map((p, i) => (
                  <li key={`${p.date}-${i}`}>
                    <span>{shortDate(p.date)}</span>
                    <span>{brl(p.price)}</span>
                  </li>
                ))}
              </ol>
            </>
          ) : (
            <p className={styles.empty}>
              {priceHistory.length === 1
                ? `Só uma busca até agora (${shortDate(priceHistory[0].date)}). Rode o catálogo de novo pra ver a tendência.`
                : "Sem buscas salvas deste produto ainda."}
            </p>
          )}
        </section>
      </div>
    </dialog>
  );
}
