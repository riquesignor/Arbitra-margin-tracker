import { useMemo, useState } from "react";
import { motion } from "framer-motion";
import { Truck, Search, TrendingDown, Info } from "lucide-react";
import type { CatalogUploadRecord } from "../lib/catalogHistory";
import { buildSupplierComparison, type SupplierComparisonGroup } from "../lib/supplierCompare";
import { ProductThumb } from "./ResultsTable";
import styles from "./SupplierCompare.module.css";

interface Props {
  history: CatalogUploadRecord[];
  onNavigateToDashboard: () => void;
}

function brl(value: number): string {
  return `R$ ${value.toFixed(2).replace(".", ",")}`;
}

function OfferChip({ offer, isBest }: { offer: SupplierComparisonGroup["offers"][number]; isBest: boolean }) {
  return (
    <span className={isBest ? styles.offerChipBest : styles.offerChip} title={`SKU ${offer.sku}`}>
      {offer.fileName}
      <b>{brl(offer.supplierPrice)}</b>
    </span>
  );
}

export default function SupplierCompare({ history, onNavigateToDashboard }: Props) {
  const [search, setSearch] = useState("");

  const comparison = useMemo(() => buildSupplierComparison(history), [history]);

  const filtered = useMemo(() => {
    const term = search.trim().toLowerCase();
    if (!term) return comparison.groups;
    return comparison.groups.filter((g) => g.name.toLowerCase().includes(term));
  }, [comparison.groups, search]);

  const avgSavings = useMemo(() => {
    if (comparison.groups.length === 0) return 0;
    return (
      comparison.groups.reduce((sum, g) => sum + g.savingsPct, 0) / comparison.groups.length
    );
  }, [comparison.groups]);

  return (
    <div className={styles.container}>
      <div className={styles.header}>
        <div className={styles.headerMain}>
          <span className={styles.eyebrow}>Custo de aquisição</span>
          <h1 className={styles.title}>Comparar fornecedores</h1>
          <p className={styles.subtitle}>
            Mesmo produto, catálogos de fornecedores diferentes — qual custa menos pra comprar.
            Comparação por NOME do produto (não existe SKU comum entre fornecedores), então
            sempre confira antes de decidir compra.
          </p>
        </div>
      </div>

      {comparison.supplierCount < 2 ? (
        <div className={styles.empty}>
          <Truck size={22} className={styles.emptyIcon} />
          <p>
            Só encontrei {comparison.supplierCount === 0 ? "nenhum" : "1"} catálogo processado até
            agora. Processe pelo menos 2 arquivos de fornecedores diferentes em Nova busca pra ter
            algo pra comparar aqui — cada arquivo é tratado como um fornecedor distinto.
          </p>
          <button type="button" className={styles.emptyButton} onClick={onNavigateToDashboard}>
            Ir pra Nova busca
          </button>
        </div>
      ) : comparison.groups.length === 0 ? (
        <div className={styles.empty}>
          <Info size={22} className={styles.emptyIcon} />
          <p>
            Comparei {comparison.supplierCount} fornecedores, mas não achei produtos em comum com
            nome parecido o bastante entre eles. Se os catálogos têm os mesmos produtos com nomes
            muito diferentes de descrição, o match por texto pode não pegar — é uma limitação
            conhecida, não um erro.
          </p>
        </div>
      ) : (
        <>
          <div className={styles.summaryRow}>
            <div className={styles.card}>
              <span className={styles.cardValue}>{comparison.supplierCount}</span>
              <span className={styles.cardLabel}>Fornecedores comparados</span>
            </div>
            <div className={styles.card}>
              <span className={styles.cardValue}>{comparison.groups.length}</span>
              <span className={styles.cardLabel}>Produtos em comum</span>
            </div>
            <div className={styles.card}>
              <span className={`${styles.cardValue} ${styles.cardValueGood}`}>
                {(avgSavings * 100).toFixed(1)}%
              </span>
              <span className={styles.cardLabel}>Economia média (mais barato vs. mais caro)</span>
            </div>
          </div>

          <div className={styles.panel}>
            <div className={styles.controls}>
              <span className={styles.searchWrap}>
                <Search size={13} />
                <input
                  className={styles.searchInput}
                  placeholder="Buscar produto"
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                />
              </span>
            </div>

            {filtered.length === 0 ? (
              <p className={styles.emptyFilter}>Nenhum produto com esse termo de busca.</p>
            ) : (
              <div className={styles.list}>
                {filtered.map((group, i) => (
                  <motion.div
                    key={group.name + i}
                    className={styles.row}
                    initial={{ opacity: 0, y: 6 }}
                    animate={{ opacity: 1, y: 0 }}
                    transition={{ duration: 0.2, delay: Math.min(i, 12) * 0.02 }}
                  >
                    <ProductThumb src={group.imageUrl} />
                    <div className={styles.rowMain}>
                      <span className={styles.rowName} title={group.name}>
                        {group.name}
                      </span>
                      <div className={styles.offers}>
                        {group.offers.map((offer) => (
                          <OfferChip
                            key={offer.fileName}
                            offer={offer}
                            isBest={offer.supplierPrice === group.bestPrice}
                          />
                        ))}
                      </div>
                    </div>
                    <div className={styles.rowSavings}>
                      <TrendDown group={group} />
                    </div>
                  </motion.div>
                ))}
              </div>
            )}
          </div>
        </>
      )}
    </div>
  );
}

function TrendDown({ group }: { group: SupplierComparisonGroup }) {
  return (
    <span className={styles.savingsBadge} title={`Mais caro: ${brl(group.worstPrice)}`}>
      <TrendingDown size={12} />
      {(group.savingsPct * 100).toFixed(0)}%
    </span>
  );
}
