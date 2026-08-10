import type { CatalogRow } from "../types";
import type { CatalogUploadRecord } from "./catalogHistory";
import { textSimilarity } from "./textSimilarity";

/**
 * Compara o CUSTO de aquisição (preço do fornecedor, não preço de
 * marketplace) do mesmo produto entre catálogos de fornecedores
 * diferentes. Só faz sentido com 2+ arquivos distintos já processados
 * (`fileName` como proxy de "fornecedor" — o produto não tem cadastro
 * estruturado de fornecedor ainda, ver ranking de features; usar o
 * nome do arquivo é a aproximação mais simples que não exige schema
 * novo nem tela de cadastro).
 *
 * MATCH É HEURÍSTICO: não existe SKU comum entre fornecedores
 * diferentes (cada um usa o próprio código interno), então o único
 * critério disponível é similaridade de texto do NOME do produto
 * (mesma função usada pra casar produto do catálogo com anúncio do
 * marketplace, ver textSimilarity.ts). Threshold conservador
 * (`MATCH_THRESHOLD`) deliberadamente alto pra reduzir falso-positivo
 * (dois produtos diferentes agrupados como se fossem o mesmo) às custas
 * de perder alguns matches válidos com nomes muito diferentes entre
 * fornecedores — sempre conferir visualmente antes de decidir compra
 * baseado nisso, mesmo aviso que o parser de PDF já dá.
 */
const MATCH_THRESHOLD = 0.5;

export interface SupplierOffer {
  fileName: string;
  sku: string;
  name: string;
  supplierPrice: number;
  imageUrl?: string;
}

export interface SupplierComparisonGroup {
  /** Nome do produto no fornecedor mais barato — representa o grupo pra exibição. */
  name: string;
  imageUrl?: string;
  offers: SupplierOffer[]; // ordenadas por preço, mais barato primeiro
  bestPrice: number;
  worstPrice: number;
  /** Quanto se economiza escolhendo o mais barato em vez do mais caro entre os fornecedores encontrados. */
  savingsPct: number;
}

export interface SupplierComparisonResult {
  supplierCount: number;
  groups: SupplierComparisonGroup[];
}

/** Um upload por fileName — o mais recente, pra não comparar uma versão velha de um fornecedor que já foi reprocessado. */
function latestUploadPerFile(history: CatalogUploadRecord[]): CatalogUploadRecord[] {
  const byFile = new Map<string, CatalogUploadRecord>();
  for (const upload of history) {
    const current = byFile.get(upload.fileName);
    if (!current || upload.uploadedAt > current.uploadedAt) byFile.set(upload.fileName, upload);
  }
  return Array.from(byFile.values());
}

interface Cluster {
  offersByFile: Map<string, SupplierOffer>;
}

export function buildSupplierComparison(history: CatalogUploadRecord[]): SupplierComparisonResult {
  const latestUploads = latestUploadPerFile(history);
  if (latestUploads.length < 2) {
    return { supplierCount: latestUploads.length, groups: [] };
  }

  // Processa fornecedor por fornecedor — dentro de um mesmo fornecedor
  // as linhas nunca se agrupam entre si (são produtos diferentes do
  // MESMO catálogo, já vêm com SKU próprio garantido único).
  const clusters: Cluster[] = [];

  for (const upload of latestUploads) {
    const rows: CatalogRow[] = upload.rows;
    for (const row of rows) {
      const offer: SupplierOffer = {
        fileName: upload.fileName,
        sku: row.sku,
        name: row.name,
        supplierPrice: row.supplierPrice,
        imageUrl: row.imageUrl,
      };

      // Só considera clusters que AINDA não têm oferta deste fornecedor
      // — evita juntar duas linhas do mesmo catálogo no mesmo grupo.
      //
      // ⚠️ Bug corrigido (ago/2026): a versão anterior comparava contra
      // um `representativeName` CONGELADO (nome do 1º fornecedor
      // adicionado ao cluster, nunca atualizado depois). Conforme mais
      // fornecedores entravam, a comparação ficava presa numa referência
      // cada vez mais arbitrária — gerando tanto falso-negativo (o MESMO
      // produto, com nome ligeiramente diferente do 3º/4º fornecedor, não
      // batia mais contra a referência antiga) quanto falso-positivo (uma
      // referência genérica de menor discriminação atraía produto
      // errado). Agora compara contra o MELHOR match entre TODOS os
      // membros já no cluster — mais caro (O(clusters × ofertas por
      // cluster), mas o número de fornecedores por comparação é sempre
      // pequeno) e bem mais robusto.
      let bestCluster: Cluster | null = null;
      let bestSimilarity = MATCH_THRESHOLD;
      for (const cluster of clusters) {
        if (cluster.offersByFile.has(upload.fileName)) continue;
        let clusterBestSimilarity = 0;
        for (const existing of cluster.offersByFile.values()) {
          const similarity = textSimilarity(row.name, existing.name);
          if (similarity > clusterBestSimilarity) clusterBestSimilarity = similarity;
        }
        if (clusterBestSimilarity >= bestSimilarity) {
          bestSimilarity = clusterBestSimilarity;
          bestCluster = cluster;
        }
      }

      if (bestCluster) {
        bestCluster.offersByFile.set(upload.fileName, offer);
      } else {
        clusters.push({
          offersByFile: new Map([[upload.fileName, offer]]),
        });
      }
    }
  }

  const groups: SupplierComparisonGroup[] = clusters
    .filter((c) => c.offersByFile.size >= 2)
    .map((c) => {
      const offers = Array.from(c.offersByFile.values()).sort(
        (a, b) => a.supplierPrice - b.supplierPrice
      );
      const bestPrice = offers[0].supplierPrice;
      const worstPrice = offers[offers.length - 1].supplierPrice;
      return {
        name: offers[0].name,
        imageUrl: offers[0].imageUrl,
        offers,
        bestPrice,
        worstPrice,
        savingsPct: worstPrice > 0 ? (worstPrice - bestPrice) / worstPrice : 0,
      };
    })
    .sort((a, b) => b.savingsPct - a.savingsPct);

  return { supplierCount: latestUploads.length, groups };
}
