import { describe, expect, it } from "vitest";
import { collectMissReasons } from "./searchMissReasons";
import type { CatalogItemQuery, MarketplacePriceResult } from "./types";

function priced(sku: string): MarketplacePriceResult {
  return {
    marketplace: "amazon",
    sku,
    price: 10,
    competitorCount: 0,
    buyBoxEligible: true,
    confidence: 0.9,
  };
}

const ITEMS: CatalogItemQuery[] = [
  { sku: "COM-FOTO", name: "Produto com foto", imageUrl: "https://app/api/catalog-image?id=1" },
  { sku: "SEM-FOTO", name: "Produto sem foto" },
];

describe("collectMissReasons", () => {
  it("não explica produto que ACHOU preço (ele está na tela, não precisa de explicação)", () => {
    const reasons = collectMissReasons({ amazon: { "COM-FOTO": priced("COM-FOTO") } }, ITEMS, "vision_internal");
    expect(reasons["COM-FOTO"]).toBeUndefined();
  });

  it("mecanismo por imagem + item sem foto = sem_foto (o item nem chega a ser buscado)", () => {
    const reasons = collectMissReasons({ amazon: {} }, ITEMS, "vision_internal");
    expect(reasons["SEM-FOTO"]).toBe("sem_foto");
  });

  it("mecanismo por TEXTO ignora a ausência de foto — ali sem foto não impede busca", () => {
    const reasons = collectMissReasons({ amazon: {} }, ITEMS, "serpapi");
    expect(reasons["SEM-FOTO"]).toBe("sem_candidato");
  });

  it("cota de IA esgotada explica os que sobraram, mas sem_foto continua tendo prioridade (é certeza, não estimativa)", () => {
    const reasons = collectMissReasons({ amazon: {} }, ITEMS, "vision_internal", { quotaExhausted: true });
    expect(reasons["SEM-FOTO"]).toBe("sem_foto");
    expect(reasons["COM-FOTO"]).toBe("cota_ia");
  });

  it("achou em UM marketplace basta — não repete explicação por loja", () => {
    const reasons = collectMissReasons(
      { amazon: {}, mercadolivre: { "COM-FOTO": priced("COM-FOTO") } },
      ITEMS,
      "serpapi"
    );
    expect(reasons["COM-FOTO"]).toBeUndefined();
    expect(reasons["SEM-FOTO"]).toBe("sem_candidato");
  });

  it("busca inteira vazia devolve razão pra todo item pedido", () => {
    const reasons = collectMissReasons({ amazon: {} }, ITEMS, "scraperapi");
    expect(Object.keys(reasons).sort()).toEqual(["COM-FOTO", "SEM-FOTO"]);
  });
});
