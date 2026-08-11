import { describe, expect, it } from "vitest";
import { getTopCandidates, pickBestCandidate, popularityScore } from "./rankCandidates";

interface Fixture {
  title: string;
  popularity: number;
}

const CANDIDATES: Fixture[] = [
  { title: "Fone de Ouvido Bluetooth JBL Tune 510BT Preto", popularity: 10 },
  { title: "Fone de Ouvido Bluetooth JBL Tune 510BT Azul", popularity: 50 },
  { title: "Fone de Ouvido Bluetooth JBL Tune 510BT Branco", popularity: 5 },
  { title: "Headset Gamer RGB Com Fio USB", popularity: 999 }, // popular, mas produto errado
];

const getTitle = (c: Fixture) => c.title;
const getPopularity = (c: Fixture) => c.popularity;

describe("getTopCandidates", () => {
  it("devolve lista vazia sem quebrar quando não há candidatos", () => {
    expect(getTopCandidates("qualquer coisa", [], getTitle, getPopularity, 3)).toEqual([]);
  });

  it("não deixa um candidato de popularidade MUITO maior mas texto ruim entrar — o filtro de similaridade vem antes do ranking por popularidade", () => {
    const top = getTopCandidates("Fone de Ouvido Bluetooth JBL Tune 510BT", CANDIDATES, getTitle, getPopularity, 10);

    expect(top.every((t) => t.candidate.title.startsWith("Fone de Ouvido Bluetooth JBL Tune 510BT"))).toBe(true);
    expect(top.some((t) => t.candidate.title.startsWith("Headset Gamer"))).toBe(false);
  });

  it("ordena os sobreviventes do filtro por popularidade (maior primeiro)", () => {
    const top = getTopCandidates("Fone de Ouvido Bluetooth JBL Tune 510BT", CANDIDATES, getTitle, getPopularity, 10);

    const popularities = top.map((t) => t.candidate.popularity);
    expect(popularities).toEqual([...popularities].sort((a, b) => b - a));
    expect(top[0].candidate.popularity).toBe(50);
  });

  it("respeita o limite k, mesmo com mais candidatos elegíveis do que o pedido", () => {
    const top = getTopCandidates("Fone de Ouvido Bluetooth JBL Tune 510BT", CANDIDATES, getTitle, getPopularity, 2);

    expect(top).toHaveLength(2);
  });

  it("mesmo critério de filtro de pickBestCandidate — o primeiro de getTopCandidates bate com o resultado de pickBestCandidate quando k=1 é o único empatado no topo", () => {
    const best = pickBestCandidate("Fone de Ouvido Bluetooth JBL Tune 510BT", CANDIDATES, getTitle, getPopularity);
    const top = getTopCandidates("Fone de Ouvido Bluetooth JBL Tune 510BT", CANDIDATES, getTitle, getPopularity, 10);

    expect(top[0].candidate).toEqual(best?.candidate);
  });
});

describe("popularityScore", () => {
  it("cresce em escala log com a contagem, não linear", () => {
    const score10 = popularityScore(10, 0);
    const score100 = popularityScore(100, 0);
    const score10000 = popularityScore(10000, 0);
    const score10090 = popularityScore(10090, 0);

    // Salto de 10 pra 100 (10x) pesa muito mais que de 10.000 pra 10.090
    // (0,9%) — é a propriedade que justifica log10 em vez de linear.
    expect(score100 - score10).toBeGreaterThan(score10090 - score10000);
  });

  it("trata contagem ausente/negativa como zero, sem lançar exceção", () => {
    expect(popularityScore(null, null)).toBe(0);
    expect(popularityScore(undefined, undefined)).toBe(0);
    expect(popularityScore(-5, -1)).toBe(0);
  });
});
