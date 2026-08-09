import type { SearchProviderId } from "../types";

/**
 * Estatística de velocidade por mecanismo — substitui o antigo card
 * "Como o cálculo roda" (Dashboard) por um comparativo real: ms por
 * produto, medido no PRÓPRIO navegador do usuário a cada busca (ver
 * `recordSample`, chamado em Dashboard.tsx > finishWithRows). Deliberado
 * usar dado observado em vez de número de marketing — SerpApi/RapidAPI/
 * Mercado Livre direto têm latência que varia por rede, hora do dia e
 * tamanho do lote; não tem "número certo" pra fabricar aqui. Só
 * localStorage (não é dado sensível, não precisa de Firestore/sync entre
 * dispositivos — é só uma média local de referência).
 */

const STORAGE_KEY = "arbitra:provider_speed";
/** Média móvel simples das últimas N amostras — não deixa 1 pico isolado (ex: rede lenta um dia) dominar o gráfico. */
const MAX_SAMPLES_PER_PROVIDER = 20;

interface SpeedStats {
  [provider: string]: number[]; // ms por item, amostras mais recentes
}

function load(): SpeedStats {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? (JSON.parse(raw) as SpeedStats) : {};
  } catch {
    return {};
  }
}

function save(stats: SpeedStats): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(stats));
  } catch {
    // localStorage indisponível (modo privado, quota) — só perde o histórico, não quebra a busca.
  }
}

/** Registra 1 amostra de ms/item pro provider — chamado depois de cada lote resolvido (ver Dashboard.tsx). */
export function recordSample(provider: SearchProviderId, msPerItem: number): void {
  if (!Number.isFinite(msPerItem) || msPerItem <= 0) return;
  const stats = load();
  const samples = stats[provider] ?? [];
  samples.push(msPerItem);
  if (samples.length > MAX_SAMPLES_PER_PROVIDER) samples.shift();
  stats[provider] = samples;
  save(stats);
}

export interface ProviderSpeedSummary {
  provider: SearchProviderId;
  avgMsPerItem: number;
  sampleCount: number;
}

/** Média por provider, ordenada do mais rápido pro mais lento. Providers sem amostra ficam de fora (não dá pra comparar o que nunca rodou). */
export function getSpeedSummary(): ProviderSpeedSummary[] {
  const stats = load();
  return Object.entries(stats)
    .map(([provider, samples]) => ({
      provider: provider as SearchProviderId,
      avgMsPerItem: samples.reduce((a, b) => a + b, 0) / samples.length,
      sampleCount: samples.length,
    }))
    .sort((a, b) => a.avgMsPerItem - b.avgMsPerItem);
}
