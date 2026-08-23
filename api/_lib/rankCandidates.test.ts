import { describe, expect, it } from "vitest";
import { getTopCandidates, pickBestCandidate, popularityScore, MIN_ACCEPTABLE_SIMILARITY } from "./rankCandidates";

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

describe("pickBestCandidate — piso mínimo de similaridade", () => {
  it("devolve null quando nenhum candidato passa do piso — melhor admitir 'não achei' do que chutar", () => {
    const candidatosSemRelacao: Fixture[] = [
      { title: "Parafuso Sextavado Inox M8", popularity: 500 },
      { title: "Caixa de Ferramentas Plástica 40L", popularity: 200 },
    ];

    const best = pickBestCandidate("Maozinha Latex Azul", candidatosSemRelacao, getTitle, getPopularity);

    expect(best).toBeNull();
  });

  it("ainda devolve candidato com similaridade baixa mas acima do piso (fica marcado aproximado pelo chamador)", () => {
    // "balão" e "látex" batem — o resto diverge. Similaridade baixa, mas
    // não zero: não deve ser rejeitado, só entra como aproximado lá no
    // provider (ver `approximate` em types.ts).
    const parcial: Fixture[] = [{ title: "Balão Bexiga Látex Colorido Festa Kit 50un", popularity: 10 }];

    const best = pickBestCandidate("Balão látex azul liso", parcial, getTitle, getPopularity);

    expect(best).not.toBeNull();
    expect(best!.similarity).toBeGreaterThanOrEqual(MIN_ACCEPTABLE_SIMILARITY);
  });

  it("lista vazia continua devolvendo null (não confundir com rejeição por similaridade)", () => {
    expect(pickBestCandidate("qualquer coisa", [], getTitle, getPopularity)).toBeNull();
  });

  it("não escolhe produto errado só porque compartilha termo genérico de catálogo (ago/2026, regressão do 'quase todo produto vem errado')", () => {
    // Nenhum destes é "Facas" de verdade — só compartilham "Kit
    // Profissional de" com a query. Antes do filtro de termo genérico
    // (textSimilarity.ts) + piso mais alto, um destes passava do piso
    // de 0.12 com confiança de sobra e era apresentado como o produto.
    const candidatosSoRuido: Fixture[] = [
      { title: "Kit Profissional de Panelas Antiaderente 5 Peças", popularity: 300 },
      { title: "Kit Profissional de Maquiagem 10 Peças", popularity: 900 },
    ];

    const best = pickBestCandidate("Kit Profissional de Facas Inox", candidatosSoRuido, getTitle, getPopularity);

    expect(best).toBeNull();
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
