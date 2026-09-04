import { describe, expect, it } from "vitest";
import {
  dedupeCatalogRows,
  extractGridBlocks,
  extractProductBlocksWithoutPrice,
  extractProductBlocksWithoutPriceIndexed,
  extractRows,
  extractVitrineGridBlocks,
  sanitizeProductName,
} from "./parsePdfCatalog";
import type { CatalogRow } from "../types";

describe("sanitizeProductName", () => {
  it("não mexe em nome limpo (garantia de não-regressão pra catálogo que já funcionava)", () => {
    for (const name of [
      "Caneta Azul BIC",
      "Videogame Sony PS5",
      "Suporte para moto e bike",
      "Organizador de Gaveta 6 peças",
      "Bicicleta Aro 29",
    ]) {
      expect(sanitizeProductName(name)).toBe(name);
    }
  });

  it("extrai o nome real de um nome afogado em lixo de OCR (caso real reportado)", () => {
    const raw = 'Timm 15 sda E o SE E e "Econ. NS ss. YE, rs ZA Kit: Organizadores de';

    expect(sanitizeProductName(raw)).toBe("Kit: Organizadores de");
  });

  it("preserva números e medidas (é o que distingue um produto do outro na busca)", () => {
    expect(sanitizeProductName("XX Suporte 500ml 3 unidades")).toBe("Suporte 500ml 3 unidades");
  });

  it("devolve string vazia quando a linha inteira é ruído — o chamador trata como linha descartada", () => {
    expect(sanitizeProductName('NS ss YE rs ZA "')).toBe("");
    expect(sanitizeProductName("   ")).toBe("");
  });

  it("descarta conector solto no início (recorte no meio de uma frase)", () => {
    expect(sanitizeProductName("NS de Organizadores Multiuso")).toBe("Organizadores Multiuso");
  });
});

describe("extractRows", () => {
  it("extrai sku, nome e preço de uma linha simples", () => {
    const { rows, skippedAmbiguous } = extractRows(["SKU-001 Caneta Azul BIC R$ 12,50"]);

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ sku: "SKU-001", name: "Caneta Azul BIC", supplierPrice: 12.5 });
    expect(skippedAmbiguous).toBe(0);
  });

  it("le preco de 4+ digitos SEM separador de milhar, sem truncar (BR, sem R$) — regressão: 'Produto 3800,00' virava 800,00", () => {
    const { rows } = extractRows(["Videogame Sony PS5 3800,00"]);

    expect(rows).toHaveLength(1);
    expect(rows[0].supplierPrice).toBe(3800);
    expect(rows[0].name).toBe("Videogame Sony PS5");
  });

  it("le preco de 5 digitos sem separador de milhar, sem truncar", () => {
    const { rows } = extractRows(["Bicicleta Aro 29 12345,00"]);

    expect(rows[0].supplierPrice).toBe(12345);
  });

  it("continua lendo preco BR com separador de milhar normalmente (sem regressão)", () => {
    const { rows } = extractRows(["Notebook Dell 3.800,00"]);

    expect(rows[0].supplierPrice).toBe(3800);
  });

  it("gera sku sintético quando não acha um padrão de SKU na linha", () => {
    const { rows } = extractRows(["Caneta Azul BIC R$ 12,50"]);

    expect(rows[0].sku).toMatch(/^PDF-/);
    expect(rows[0].name).toBe("Caneta Azul BIC");
  });

  it("sku sintético é determinístico por CONTEÚDO, não por posição — regressão: cache global colidia entre catálogos diferentes", () => {
    // Mesmo produto, catálogos (chamadas) diferentes -> mesmo sku sintético
    // (cache de preço deve ser reaproveitado, é o mesmo texto de produto).
    const a = extractRows(["Caneta Azul BIC R$ 12,50"]);
    const b = extractRows(["Lapis Preto Faber R$ 3,00", "Caneta Azul BIC R$ 12,50"]);
    expect(a.rows[0].sku).toBe(b.rows[1].sku);

    // Produtos DIFERENTES no mesmo catálogo -> skus diferentes (antes,
    // ambos virariam "PDF-1"/"PDF-2" por posição e colidiriam entre
    // uploads distintos).
    expect(b.rows[0].sku).not.toBe(b.rows[1].sku);
  });

  it("ignora linha sem nenhum preço reconhecível (sem contar como ambígua)", () => {
    const { rows, skippedAmbiguous } = extractRows(["Só um texto qualquer sem preço nenhum"]);

    expect(rows).toHaveLength(0);
    expect(skippedAmbiguous).toBe(0);
  });

  it("descarta (não corrompe) linha com mais de um preço — regressão crítica da Session 3", () => {
    // Exemplo real que motivou o fix: célula de tabela multi-coluna colada
    // numa linha só pelo agrupamento por Y — dois preços, nenhum jeito
    // seguro de saber qual pertence a qual produto.
    const linhaCorrompida = "30PCS/CX Unid.CX: 24PCS/CX Unid.CX: 32,00 5 0PCS/CX Unid.CX:23,00";

    const { rows, skippedAmbiguous } = extractRows([linhaCorrompida]);

    expect(rows).toHaveLength(0);
    expect(skippedAmbiguous).toBe(1);
  });

  it("descarta linha cujo 'nome' restante é implausivelmente longo", () => {
    const nomeGigante = "X".repeat(150);

    const { rows, skippedAmbiguous } = extractRows([`${nomeGigante} R$ 10,00`]);

    expect(rows).toHaveLength(0);
    expect(skippedAmbiguous).toBe(1);
  });

  it("processa linhas independentemente, acumulando skippedAmbiguous só nas ruins", () => {
    const { rows, skippedAmbiguous } = extractRows([
      "SKU-001 Produto A R$ 10,00",
      "30PCS/CX Unid.CX: 24PCS/CX Unid.CX: 32,00 preco2 23,00", // ambígua — 2 preços
      "SKU-002 Produto B R$ 20,00",
    ]);

    expect(rows).toHaveLength(2);
    expect(skippedAmbiguous).toBe(1);
    expect(rows.map((r) => r.sku)).toEqual(["SKU-001", "SKU-002"]);
  });

  it(
    "RECUPERA (não descarta) linha com 2 preços quando cada preço tem o PRÓPRIO código de SKU antes dele — " +
      "regressão real 'página com 12 produtos, só 8 reconhecidos': grade de 2 colunas sem cabeçalho " +
      "'MODELO:' funde 2 produtos DIFERENTES na mesma linha Y pelo agrupamento; diferente do caso " +
      "'30PCS/CX...' acima (0 código de SKU, preço de faixa/quantidade do MESMO produto), aqui cada " +
      "metade da linha tem um SKU_PATTERN de verdade — sinal seguro de que são 2 produtos, não 1",
    () => {
      const { rows, skippedAmbiguous } = extractRows([
        "SKU-100 Fone Bluetooth Preto R$ 45,00 SKU-200 Caixa de Som Portátil R$ 89,90",
      ]);

      expect(skippedAmbiguous).toBe(0);
      expect(rows).toHaveLength(2);
      expect(rows[0]).toMatchObject({ sku: "SKU-100", name: "Fone Bluetooth Preto", supplierPrice: 45 });
      expect(rows[1]).toMatchObject({ sku: "SKU-200", name: "Caixa de Som Portátil", supplierPrice: 89.9 });
    }
  );

  it("recupera 3 produtos de uma linha de grade de 3 colunas fundida (generaliza pra N preços/N SKUs)", () => {
    const { rows, skippedAmbiguous } = extractRows([
      "REF001 Caneca Térmica R$ 30,00 REF002 Garrafa Inox R$ 55,00 REF003 Copo Duplo R$ 22,50",
    ]);

    expect(skippedAmbiguous).toBe(0);
    expect(rows.map((r) => r.sku)).toEqual(["REF001", "REF002", "REF003"]);
    expect(rows.map((r) => r.supplierPrice)).toEqual([30, 55, 22.5]);
  });

  it(
    "NÃO recupera quando faltam SKUs pra cobrir todos os preços — sinal fraco demais (pode ser " +
      "faixa de preço do mesmo produto), continua descartando a linha inteira como antes",
    () => {
      const { rows, skippedAmbiguous } = extractRows([
        "SKU-300 Produto Único Com Faixa De Preço R$ 45,00 R$ 89,90", // 1 SKU, 2 preços
      ]);

      expect(rows).toHaveLength(0);
      expect(skippedAmbiguous).toBe(1);
    }
  );

  it("aceita formato de preço US (ponto decimal) além do BR (vírgula)", () => {
    const { rows } = extractRows(["SKU-010 Produto C 199.99"]);

    expect(rows[0].supplierPrice).toBeCloseTo(199.99, 2);
  });

  it("aceita preço inteiro sem centavos quando prefixado por R$ (regressão: catálogo real sem decimais)", () => {
    const { rows } = extractRows(["VIDEOGAME SONY POR R$ 3800"]);

    expect(rows).toHaveLength(1);
    expect(rows[0].supplierPrice).toBe(3800);
    expect(rows[0].name).toBe("VIDEOGAME SONY POR");
  });

  it("aceita preço inteiro com milhar (ponto) e sem centavos, prefixado por R$", () => {
    const { rows } = extractRows(["Bicicleta aro 29 R$ 1.200"]);

    expect(rows[0].supplierPrice).toBe(1200);
  });

  it("NÃO trata número solto sem R$ e sem decimal como preço (evita falso positivo com SKU/quantidade)", () => {
    const { rows, skippedAmbiguous } = extractRows(["BICICLETA POR 1200"]);

    expect(rows).toHaveLength(0);
    expect(skippedAmbiguous).toBe(0);
  });
});

describe("extractGridBlocks", () => {
  // Dados REAIS extraídos via pdfjs (x/y/width) da página 1 de um
  // catálogo de fornecedor real (3 cartões por linha x 3 linhas = 9
  // produtos/página, cada cartão com "MODELO: <código>" no topo e
  // "NPCS/CX Unid.CX: preço" no rodapé — layout que `extractRows`
  // (1 linha = 1 produto) não suporta). Regressão: antes desse modo
  // existir, esse PDF lia só 2-3 produtos com nome/preço corrompidos
  // (ver conversa/commit) — fixture trava o comportamento correto.
  const PAGE_WIDTH = 595.5;
  const PAGE_1_ITEMS = [
    { text: "Fale Conosco", x: 329.52, y: 22.801, width: 60.949 },
    { text: "VOLTAR", x: 37.18, y: 49.183, width: 46.01 },
    { text: "Voltou ao estoque", x: 357.728, y: 808.419, width: 198.92 },
    { text: "MODELO:", x: 27.922, y: 740.766, width: 55.452 },
    { text: "BMG-50", x: 89.745, y: 740.766, width: 45.282 },
    { text: "60PCS/CX", x: 25.487, y: 553.145, width: 47.467 },
    { text: "Suporte para moto e bike", x: 31.043, y: 613.855, width: 106.796 },
    { text: "•", x: 32.869, y: 595.315, width: 2.457 },
    { text: "Resistente a Agua.", x: 37.304, y: 595.315, width: 58.153 },
    { text: "•", x: 32.869, y: 587.517, width: 2.457 },
    { text: "Regulágem 360°", x: 37.304, y: 587.517, width: 51.304 },
    { text: "Unid.CX:", x: 112.109, y: 554.476, width: 42.304 },
    // "13,50" quebrado em 2 runs de fonte pelo PDF, gap=0 entre eles —
    // é o caso que motivou o espaçamento adaptativo (ver joinLineText).
    { text: "1", x: 157.199, y: 554.476, width: 5.571 },
    { text: "3,50", x: 162.77, y: 554.476, width: 19.499 },
    { text: "MODELO:", x: 215.094, y: 739.769, width: 55.452 },
    { text: "BMG-55", x: 280.447, y: 739.769, width: 45.282 },
    { text: "100PCS/CX", x: 214.242, y: 550.637, width: 52.898 },
    { text: "MODELO:", x: 401.379, y: 741.769, width: 55.452 },
    { text: "BMG-52", x: 463.202, y: 741.769, width: 45.282 },
    { text: "Unid.CX: 7,50", x: 310.695, y: 551.959, width: 63.14 },
    { text: "Unid.CX:9,50", x: 496.947, y: 554.22, width: 62.67 },
    { text: "MODELO:", x: 29.562, y: 516.582, width: 55.344 },
    { text: "BM-F1123", x: 88.242, y: 516.582, width: 56.676 },
    { text: "100PCS/CX", x: 26.392, y: 320.789, width: 54.63 },
    { text: "Unid.CX: 8,00", x: 124.222, y: 320.585, width: 65.54 },
    { text: "MODELO:", x: 216.663, y: 518.919, width: 55.344 },
    { text: "BM-F1031", x: 275.343, y: 518.919, width: 56.676 },
    { text: "20 PCS/CX", x: 213.711, y: 321.418, width: 51.85 },
    { text: "Unid.CX: 31,00", x: 305.391, y: 323.316, width: 70.16 },
    { text: "MODELO:", x: 403.604, y: 519.687, width: 55.452 },
    { text: "BM-8402", x: 465.175, y: 519.688, width: 48.912 },
    { text: "300PCS/CX", x: 403.187, y: 324.97, width: 52.898 },
    { text: "Unid.CX: 2,40", x: 491.048, y: 323.747, width: 69.98 },
    { text: "MODELO:", x: 28.873, y: 284.348, width: 50.732 },
    { text: "BM-S216", x: 82.567, y: 284.348, width: 46.453 },
    { text: "50PCS/CX", x: 30.534, y: 88.237, width: 48.98 },
    { text: "Unid.CX:21,00", x: 118.041, y: 88.027, width: 68.32 },
    { text: "MODELO:", x: 403.205, y: 284.99, width: 50.732 },
    { text: "BM-F1352", x: 456.955, y: 284.99, width: 51.953 },
    { text: "16PCS/CX", x: 402.429, y: 85.773, width: 48.98 },
    { text: "Unid.CX: 75,00", x: 486.395, y: 86.739, width: 71.19 },
    { text: "MODELO:", x: 215.118, y: 284.803, width: 55.452 },
    { text: "BM-A06", x: 276.697, y: 284.803, width: 44.114 },
    { text: "100PCS/CX", x: 212.907, y: 89.128, width: 53.148 },
    { text: "Unid. CX: 9,00", x: 306.168, y: 88.178, width: 68.41 },
  ];

  it("detecta grade 3x3 e extrai os 9 produtos com preço correto, sem ambiguidade", () => {
    const result = extractGridBlocks(PAGE_1_ITEMS, PAGE_WIDTH);

    expect(result).not.toBeNull();
    expect(result!.skippedAmbiguous).toBe(0);
    expect(result!.blocks).toHaveLength(9);

    const bySku = Object.fromEntries(result!.blocks.map((b) => [b.sku, b]));
    expect(bySku["BMG-50"].supplierPrice).toBe(13.5);
    expect(bySku["BMG-55"].supplierPrice).toBe(7.5);
    expect(bySku["BMG-52"].supplierPrice).toBe(9.5);
    expect(bySku["BM-F1123"].supplierPrice).toBe(8);
    expect(bySku["BM-F1031"].supplierPrice).toBe(31);
    expect(bySku["BM-8402"].supplierPrice).toBe(2.4);
    expect(bySku["BM-S216"].supplierPrice).toBe(21);
    expect(bySku["BM-A06"].supplierPrice).toBe(9);
    expect(bySku["BM-F1352"].supplierPrice).toBe(75);
  });

  it("usa o nome real quando existe como texto no PDF, e cai pro SKU quando a descrição está só na foto (gráfico)", () => {
    const result = extractGridBlocks(PAGE_1_ITEMS, PAGE_WIDTH);
    const bySku = Object.fromEntries(result!.blocks.map((b) => [b.sku, b]));

    expect(bySku["BMG-50"].name).toBe("Suporte para moto e bike");
    // Sem linha de nome própria no recorte -> cai pro SKU (não fica vazio).
    expect(bySku["BMG-55"].name).toBe("BMG-55");
  });

  it("devolve null (não é grade) pra catálogo de linha única normal — sem regressão no modo existente", () => {
    const result = extractGridBlocks(
      [{ text: "SKU-001 Caneta Azul BIC R$ 12,50", x: 10, y: 100, width: 200 }],
      595
    );

    expect(result).toBeNull();
  });

  // Regressão real: catálogo com banner de preço colorido/diagonal
  // (ex.: bmax_broxa.pdf, reportado pelo usuário) sai SEM camada de
  // texto real -> cai pro fallback de OCR (Tesseract) -> "MODELO:"/nome
  // saem legíveis, mas o banner de preço não. Sem `priceless`, o cartão
  // era descartado sem deixar rastro nenhum do SKU pra tentar recuperar
  // via Gemini depois (ver parsePdfCatalogFile). Este teste trava o
  // contrato: cartão sem preço vira `priceless` (com SKU/nome/bounding
  // box), não some.
  it("cartão sem preço legível vira `priceless` (não é descartado sem rastro) — base pra correção via Gemini", () => {
    const items = [
      { text: "MODELO:", x: 30, y: 700, width: 55 },
      { text: "A1", x: 90, y: 700, width: 20 },
      { text: "Produto Com Preco", x: 30, y: 650, width: 100 },
      { text: "Unid.CX: 12,00", x: 30, y: 500, width: 70 },

      { text: "MODELO:", x: 250, y: 700, width: 55 },
      { text: "B2", x: 310, y: 700, width: 20 },
      { text: "Produto Sem Preco", x: 250, y: 650, width: 100 },
    ];

    const result = extractGridBlocks(items, 595);

    expect(result).not.toBeNull();
    expect(result!.blocks).toHaveLength(1);
    expect(result!.blocks[0]).toMatchObject({ sku: "A1", name: "Produto Com Preco", supplierPrice: 12 });

    expect(result!.priceless).toHaveLength(1);
    expect(result!.priceless[0]).toMatchObject({ sku: "B2", name: "Produto Sem Preco" });
    expect(result!.skippedAmbiguous).toBe(1);
  });

  // Dados REAIS extraídos via pdfjs-equivalente (PyMuPDF, mesmo espaço de
  // coordenadas PDF) das duas primeiras linhas da página 3 de um catálogo
  // real (Issam Distribuidora, 4.585 produtos, 393 páginas) — reportado
  // pelo usuário como "0 produtos reconhecidos". Layout em grade 4
  // colunas igual ao BMG-50 acima, mas com rótulo "CÓD. <código>" em vez
  // de "MODELO:", e SEM a palavra "Unid" antes do preço (só "R$ X,XX"
  // solto). Regressão: antes deste fix, MODEL_LABEL_PATTERN só reconhecia
  // "MODELO:", então esta página inteira caía pro modo linha-única (que
  // também falha, nome e preço em linhas separadas) e o catálogo saía com
  // zero produtos reconhecidos.
  const PAGE_WIDTH_ISSAM = 841.89;
  const ISSAM_PAGE_ITEMS = [
    { text: "CÓD.", x: 37.0, y: 412.9, width: 17.784 },
    { text: "002168", x: 56.498, y: 412.9, width: 24.019 },
    { text: "Maozinha", x: 37.0, y: 398.856, width: 31.646 },
    { text: "latex", x: 70.675, y: 398.856, width: 15.199 },
    { text: "azul", x: 87.903, y: 398.856, width: 13.388 },
    { text: "9x10cm", x: 103.321, y: 398.856, width: 25.557 },
    { text: "ref", x: 130.907, y: 398.856, width: 8.519 },
    { text: "790862", x: 141.456, y: 398.856, width: 24.353 },
    { text: "R$", x: 171.952, y: 381.757, width: 13.419 },
    { text: "8,38", x: 188.29, y: 381.757, width: 20.433 },

    { text: "CÓD.", x: 235.723, y: 412.9, width: 17.784 },
    { text: "002175", x: 255.22, y: 412.9, width: 24.019 },
    { text: "Maozinha", x: 235.723, y: 398.856, width: 31.646 },
    { text: "latex", x: 269.397, y: 398.856, width: 15.199 },
    { text: "rosa", x: 286.625, y: 398.856, width: 14.199 },
    { text: "9x10cm", x: 302.853, y: 398.856, width: 25.557 },
    { text: "ref", x: 330.44, y: 398.856, width: 8.519 },
    { text: "790861", x: 340.989, y: 398.856, width: 24.353 },
    { text: "maozin", x: 367.371, y: 398.856, width: 23.528 },
    { text: "R$", x: 370.674, y: 381.757, width: 13.419 },
    { text: "8,38", x: 387.012, y: 381.757, width: 20.433 },

    { text: "CÓD.", x: 434.445, y: 412.9, width: 17.784 },
    { text: "002176", x: 453.943, y: 412.9, width: 24.019 },
    { text: "Pezinho", x: 434.445, y: 398.856, width: 26.01 },
    { text: "latex", x: 462.484, y: 398.856, width: 15.199 },
    { text: "rosa", x: 479.712, y: 398.856, width: 14.199 },
    { text: "9x10cm", x: 495.94, y: 398.856, width: 25.557 },
    { text: "ref", x: 523.527, y: 398.856, width: 8.519 },
    { text: "790863", x: 534.076, y: 398.856, width: 24.353 },
    { text: "pezinho", x: 560.458, y: 398.856, width: 25.565 },
    { text: "R$", x: 569.396, y: 381.757, width: 13.419 },
    { text: "8,38", x: 585.734, y: 381.757, width: 20.433 },

    { text: "CÓD.", x: 633.167, y: 412.9, width: 17.784 },
    { text: "031727", x: 652.665, y: 412.9, width: 24.019 },
    { text: "Cesto", x: 633.167, y: 398.856, width: 19.068 },
    { text: "organizador", x: 654.265, y: 398.856, width: 38.544 },
    { text: "poliester", x: 694.838, y: 398.856, width: 27.587 },
    { text: "45x45cm", x: 724.454, y: 398.856, width: 29.616 },
    { text: "color", x: 756.099, y: 398.856, width: 15.819 },
    { text: "R$", x: 762.281, y: 381.757, width: 13.419 },
    { text: "15,58", x: 778.619, y: 381.757, width: 26.271 },

    { text: "CÓD.", x: 37.0, y: 244.14, width: 17.784 },
    { text: "036571", x: 56.498, y: 244.14, width: 24.019 },
    { text: "Cj", x: 37.0, y: 230.096, width: 6.891 },
    { text: "talher", x: 45.921, y: 230.096, width: 18.257 },
    { text: "infantil", x: 66.207, y: 230.096, width: 20.878 },
    { text: "flexivel", x: 89.115, y: 230.096, width: 21.907 },
    { text: "2", x: 113.051, y: 230.096, width: 4.059 },
    { text: "pecas", x: 119.14, y: 230.096, width: 19.476 },
    { text: "silicone", x: 140.645, y: 230.096, width: 24.338 },
    { text: "R$", x: 171.952, y: 212.997, width: 13.419 },
    { text: "3,58", x: 188.29, y: 212.997, width: 20.433 },

    { text: "CÓD.", x: 235.723, y: 244.14, width: 17.784 },
    { text: "098807", x: 255.22, y: 244.14, width: 24.019 },
    { text: "Mamadeira", x: 235.723, y: 230.096, width: 36.434 },
    { text: "de", x: 274.186, y: 230.096, width: 8.118 },
    { text: "plastico", x: 284.333, y: 230.096, width: 24.747 },
    { text: "240ml", x: 311.11, y: 230.096, width: 19.878 },
    { text: "premium", x: 333.017, y: 230.096, width: 28.39 },
    { text: "com", x: 363.436, y: 230.096, width: 13.79 },
    { text: "bico", x: 379.255, y: 230.096, width: 13.388 },
    { text: "silicone", x: 235.723, y: 220.657, width: 24.338 },
    { text: "e", x: 262.09, y: 220.657, width: 4.059 },
    { text: "alca", x: 268.178, y: 220.657, width: 13.388 },
    { text: "color", x: 283.596, y: 220.657, width: 15.819 },
    { text: "R$", x: 364.836, y: 212.997, width: 13.419 },
    { text: "13,18", x: 381.174, y: 212.997, width: 26.271 },

    { text: "CÓD.", x: 434.445, y: 244.14, width: 17.784 },
    { text: "098884", x: 453.943, y: 244.14, width: 24.019 },
    { text: "Mamadeira", x: 434.445, y: 230.096, width: 36.434 },
    { text: "de", x: 472.909, y: 230.096, width: 8.118 },
    { text: "plastico", x: 483.056, y: 230.096, width: 24.747 },
    { text: "240ml", x: 509.832, y: 230.096, width: 19.878 },
    { text: "12", x: 531.739, y: 230.096, width: 8.118 },
    { text: "pecas", x: 541.886, y: 230.096, width: 19.476 },
    { text: "lisa", x: 563.392, y: 230.096, width: 10.95 },
    { text: "color", x: 576.372, y: 230.096, width: 15.819 },
    { text: "R$", x: 563.558, y: 212.997, width: 13.419 },
    { text: "76,15", x: 579.896, y: 212.997, width: 26.271 },

    { text: "CÓD.", x: 633.167, y: 244.14, width: 17.784 },
    { text: "320004", x: 652.665, y: 244.14, width: 24.019 },
    { text: "Mordedor", x: 633.167, y: 230.096, width: 31.237 },
    { text: "maozinha", x: 666.433, y: 230.096, width: 31.645 },
    { text: "sortida", x: 700.108, y: 230.096, width: 22.199 },
    { text: "R$", x: 768.119, y: 212.997, width: 13.419 },
    { text: "9,46", x: 784.457, y: 212.997, width: 20.433 },
  ];

  it("reconhece grade com rótulo 'CÓD.' (catálogo real Issam) em vez de 'MODELO:', sem a palavra 'Unid' antes do preço", () => {
    const result = extractGridBlocks(ISSAM_PAGE_ITEMS, PAGE_WIDTH_ISSAM);

    expect(result).not.toBeNull();
    expect(result!.skippedAmbiguous).toBe(0);
    expect(result!.blocks).toHaveLength(8);

    const bySku = Object.fromEntries(result!.blocks.map((b) => [b.sku, b]));
    expect(bySku["002168"]).toMatchObject({ name: "Maozinha latex azul 9x10cm ref 790862", supplierPrice: 8.38 });
    // "Cj" (2 letras, sem vogal com peso e fora de REAL_SHORT_TOKENS) cai
    // como ruído em sanitizeProductName — comportamento pré-existente do
    // sanitizador, não algo que este fix mexe.
    expect(bySku["036571"]).toMatchObject({ name: "talher infantil flexivel 2 pecas silicone", supplierPrice: 3.58 });
    expect(bySku["098884"]).toMatchObject({ supplierPrice: 76.15 });
    expect(bySku["320004"]).toMatchObject({ supplierPrice: 9.46 });
  });
});

describe("extractProductBlocksWithoutPrice", () => {
  it("reconhece blocos empilhados (SKU sozinho na linha, nome + metadado depois) sem preço nenhum", () => {
    const lines = [
      "TOP2905",
      "Kit Organizadores De Cozinha",
      "CX MASTER: 20",
      "NCM:39241000",
      "CORES:",
      "182734",
      "TOP2906",
      "Outro Produto Qualquer",
      "CX MASTER: 10",
      "NCM:39241000",
      "CORES:",
      "182735",
    ];

    const rows = extractProductBlocksWithoutPrice(lines);

    expect(rows).toHaveLength(2);
    expect(rows[0]).toEqual({ sku: "TOP2905", name: "Kit Organizadores De Cozinha" });
    expect(rows[1]).toEqual({ sku: "TOP2906", name: "Outro Produto Qualquer" });
    // Sem "R$", sem decimal em lugar nenhum do bloco — nenhuma das duas
    // linhas ganha supplierPrice.
    expect(rows[0].supplierPrice).toBeUndefined();
    expect(rows[1].supplierPrice).toBeUndefined();
  });

  it("aproveita um preço reconhecível no bloco quando ele existe (raro, mas não descarta o dado)", () => {
    const rows = extractProductBlocksWithoutPrice(["TOP2905", "Produto Com Preco Solto", "R$ 15,00"]);

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ sku: "TOP2905", name: "Produto Com Preco Solto", supplierPrice: 15 });
  });

  it("não atribui preço quando o bloco tem mais de um preço (ambíguo demais)", () => {
    const rows = extractProductBlocksWithoutPrice([
      "TOP2905",
      "Produto Ambiguo",
      "R$ 15,00 ou R$ 20,00",
    ]);

    expect(rows).toHaveLength(1);
    expect(rows[0].supplierPrice).toBeUndefined();
  });

  it("cai pro próprio SKU como nome quando não sobra nenhuma linha de nome útil", () => {
    const rows = extractProductBlocksWithoutPrice(["TOP2905", "CX MASTER: 20", "NCM:39241000", "182734"]);

    expect(rows).toHaveLength(1);
    expect(rows[0]).toEqual({ sku: "TOP2905", name: "TOP2905" });
  });

  it("LIMITAÇÃO CONHECIDA: produtos lado a lado (2 SKUs mesclados na mesma linha) não são reconhecidos", () => {
    // Grade de 2 colunas sem cabeçalho "MODELO:" — o agrupamento por Y do
    // PDF cola os dois códigos numa linha só, e a linha inteira não bate
    // em STANDALONE_SKU_LINE_PATTERN (que exige a linha ser exatamente 1
    // código) — os dois produtos ficam de fora, documentado no comentário
    // da função.
    const rows = extractProductBlocksWithoutPrice([
      "TOP2977          TOP2978",
      "Nome Produto A",
      "Nome Produto B",
      "CX MASTER: 20",
    ]);

    expect(rows).toEqual([]);
  });

  it("é no-op (retorna []) quando não há nenhum marcador de SKU standalone — não interfere em catálogo que já funciona", () => {
    expect(extractProductBlocksWithoutPrice(["MODELO: BM-F1324", "Produto Normal", "Unid.CX: 12,00"])).toEqual([]);
    expect(extractProductBlocksWithoutPrice([])).toEqual([]);
  });
});

describe("extractProductBlocksWithoutPriceIndexed", () => {
  it(
    "carrega o lineIndex do MARCADOR (linha do SKU sozinho), não da primeira linha do corpo — " +
      "confirmado com PDF real (Catálogo TOPUTIL/DL Grupo) pro recorte de foto do bloco " +
      "(ver uso em parsePdfCatalogFile > cropRowBand)",
    () => {
      const lines = [
        "TOP2905", // lineIndex 0
        "Kit Organizadores De Cozinha", // 1
        "CX MASTER: 20", // 2
        "TOP2906", // lineIndex 3
        "Outro Produto Qualquer", // 4
        "CX MASTER: 10", // 5
      ];

      const rows = extractProductBlocksWithoutPriceIndexed(lines);

      expect(rows).toHaveLength(2);
      expect(rows[0]).toMatchObject({ sku: "TOP2905", lineIndex: 0 });
      expect(rows[1]).toMatchObject({ sku: "TOP2906", lineIndex: 3 });
    }
  );

  it("extractProductBlocksWithoutPrice (sem índice) devolve exatamente os mesmos campos de antes — wrapper não vaza lineIndex", () => {
    const lines = ["TOP2905", "Produto Normal", "CX MASTER: 20"];

    expect(extractProductBlocksWithoutPrice(lines)).toEqual(extractProductBlocksWithoutPriceIndexed(lines).map(({ lineIndex: _l, ...row }) => row));
    expect(Object.keys(extractProductBlocksWithoutPrice(lines)[0])).not.toContain("lineIndex");
  });
});

describe("extractVitrineGridBlocks", () => {
  const PAGE_WIDTH = 595.5;

  // Dados REAIS extraídos via PyMuPDF (mesmo espaço de coordenadas PDF
  // que pdfjs) da página 2 do catálogo real que motivou este fix
  // (Catálogo TOPUTIL/DL Grupo) — resolve exatamente o caso documentado
  // como "LIMITAÇÃO CONHECIDA" em extractProductBlocksWithoutPrice acima:
  // TOP2977 e TOP2978 lado a lado na mesma linha Y (diff de 0.69pt, bem
  // dentro de Y_TOLERANCE), mais um "hero" (TOP2905) sozinho numa 3ª
  // coluna própria — layout misto, não uma grade uniforme.
  const TOPUTIL_PAGE_2_ITEMS = [
    { text: "TOP2905", x: 348.401, y: 507.531, width: 94.664 },
    { text: "MESA", x: 348.401, y: 485.760, width: 38.488 },
    { text: "PARA", x: 390.425, y: 485.760, width: 37.873 },
    { text: "COMPUTADOR", x: 348.401, y: 470.500, width: 99.825 },
    { text: "-", x: 451.762, y: 470.500, width: 4.935 },
    { text: "COLOR", x: 460.233, y: 470.500, width: 47.946 },
    { text: "-", x: 348.401, y: 455.241, width: 4.935 },
    { text: "60x40x1.2CM", x: 356.873, y: 455.241, width: 85.702 },
    { text: "ALTURA", x: 446.110, y: 455.241, width: 54.072 },
    { text: "AJUSTAVEL", x: 348.401, y: 439.981, width: 77.448 },
    { text: "69-80CM", x: 429.385, y: 439.981, width: 59.545 },
    { text: "NCM:94036000", x: 352.388, y: 401.717, width: 99.641 },
    { text: "CORES:", x: 351.303, y: 378.089, width: 48.208 },
    { text: "CX", x: 350.650, y: 419.286, width: 16.672 },
    { text: "MASTER:", x: 370.563, y: 419.286, width: 53.775 },
    { text: "6", x: 427.578, y: 419.286, width: 7.362 },
    { text: "017208", x: 352.388, y: 305.691, width: 80.827 },
    { text: "TOP2977", x: 181.802, y: 231.070, width: 60.454 },
    { text: "MOLDURA", x: 181.802, y: 216.058, width: 51.771 },
    { text: "P/", x: 236.175, y: 216.058, width: 10.343 },
    { text: "FOTO", x: 249.120, y: 216.058, width: 27.560 },
    { text: "DUOLA", x: 181.802, y: 204.832, width: 35.876 },
    { text: "FACE", x: 220.279, y: 204.832, width: 26.240 },
    { text: "BASE", x: 249.120, y: 204.832, width: 26.485 },
    { text: "MADEIRA", x: 181.802, y: 193.606, width: 47.133 },
    { text: "C/", x: 231.536, y: 193.606, width: 10.353 },
    { text: "VIDRO", x: 244.490, y: 193.606, width: 32.500 },
    { text: "10.2x15.2CM", x: 181.802, y: 182.380, width: 55.873 },
    { text: "NCM:44149000", x: 182.533, y: 156.333, width: 62.943 },
    { text: "CORES:", x: 182.740, y: 143.495, width: 31.011 },
    { text: "CX", x: 182.533, y: 165.587, width: 10.725 },
    { text: "MASTER:", x: 195.343, y: 165.587, width: 34.592 },
    { text: "24", x: 232.020, y: 165.587, width: 9.524 },
    { text: "002918", x: 182.533, y: 87.931, width: 52.271 },
    { text: "TOP2978", x: 477.239, y: 231.759, width: 63.745 },
    { text: "MOLDURA", x: 477.239, y: 212.825, width: 47.640 },
    { text: "P/", x: 527.273, y: 212.825, width: 9.518 },
    { text: "FOTO", x: 539.185, y: 212.825, width: 25.361 },
    { text: "DUOLA", x: 477.239, y: 202.494, width: 33.013 },
    { text: "FACE", x: 512.645, y: 202.494, width: 24.146 },
    { text: "BASE", x: 539.185, y: 202.494, width: 24.371 },
    { text: "MADEIRA", x: 477.239, y: 192.164, width: 43.372 },
    { text: "C/", x: 523.004, y: 192.164, width: 9.527 },
    { text: "VIDRO", x: 534.925, y: 192.164, width: 29.907 },
    { text: "12.7x17.8CM", x: 477.239, y: 181.834, width: 51.666 },
    { text: "NCM:44149000", x: 477.111, y: 151.371, width: 53.904 },
    { text: "CORES:", x: 477.239, y: 137.505, width: 26.558 },
    { text: "CX", x: 477.239, y: 163.192, width: 9.185 },
    { text: "MASTER:", x: 488.209, y: 163.192, width: 29.624 },
    { text: "18", x: 519.619, y: 163.192, width: 6.682 },
    { text: "003430", x: 479.370, y: 90.908, width: 48.183 },
  ];

  it(
    "recupera os 3 produtos da página 2 do Toputil, INCLUINDO o par lado a lado (TOP2977/TOP2978) que " +
      "extractProductBlocksWithoutPrice descarta (ver teste 'LIMITAÇÃO CONHECIDA' acima) — layout misto: " +
      "1 hero sozinho numa coluna + 2 produtos lado a lado em duas outras colunas",
    () => {
      const result = extractVitrineGridBlocks(TOPUTIL_PAGE_2_ITEMS, PAGE_WIDTH);

      expect(result).not.toBeNull();
      expect(result!.map((b) => b.sku).sort()).toEqual(["TOP2905", "TOP2977", "TOP2978"]);

      const bySku = Object.fromEntries(result!.map((b) => [b.sku, b]));
      expect(bySku["TOP2905"].name).toBe("MESA PARA COMPUTADOR COLOR 60x40x1.2CM ALTURA AJUSTAVEL 69-80CM");
      expect(bySku["TOP2977"].name).toBe("MOLDURA P/ FOTO DUOLA FACE BASE MADEIRA C/ VIDRO 10.2x15.2CM");
      expect(bySku["TOP2978"].name).toBe("MOLDURA P/ FOTO DUOLA FACE BASE MADEIRA C/ VIDRO 12.7x17.8CM");
      // Sem "R$" em lugar nenhum do catálogo — nenhum dos 3 ganha preço.
      expect(bySku["TOP2905"].supplierPrice).toBeUndefined();
      expect(bySku["TOP2977"].supplierPrice).toBeUndefined();
      expect(bySku["TOP2978"].supplierPrice).toBeUndefined();
    }
  );

  it("cada bloco carrega bounding box (xMin/xMax/yTop/yBottom) coerente com a própria coluna — base do recorte de foto (cropGridBlock)", () => {
    const result = extractVitrineGridBlocks(TOPUTIL_PAGE_2_ITEMS, PAGE_WIDTH);
    const bySku = Object.fromEntries(result!.map((b) => [b.sku, b]));

    // TOP2977 (coluna esquerda) e TOP2978 (coluna direita) não podem
    // compartilhar faixa de X — é o que garante que o nome de um nunca
    // vaza pro outro mesmo com as linhas de corpo interlaçando em Y.
    expect(bySku["TOP2977"].xMax).toBeLessThanOrEqual(bySku["TOP2978"].xMin);
  });

  // Dados REAIS da página 5 do mesmo catálogo — grade de 2 colunas
  // repetida a página INTEIRA (sem hero), incluindo o código de
  // referência com asterisco de item promocional ("001109*"/"002583*")
  // que STANDALONE_DIGITS_LINE_PATTERN precisou aprender a reconhecer
  // (ver comentário daquele padrão) pra não vazar pro nome.
  const TOPUTIL_PAGE_5_ITEMS = [
    { text: "TOP2038", x: 455.717, y: 501.801, width: 50.617 },
    { text: "TOP2036", x: 182.477, y: 519.012, width: 55.606 },
    { text: "Conjunto", x: 457.127, y: 489.779, width: 40.140 },
    { text: "6", x: 457.127, y: 479.795, width: 5.258 },
    { text: "copos", x: 464.699, y: 479.795, width: 25.760 },
    { text: "de", x: 492.772, y: 479.795, width: 10.977 },
    { text: "vidro", x: 457.127, y: 469.811, width: 21.961 },
    { text: "310ml", x: 481.402, y: 469.811, width: 24.971 },
    { text: "CX.", x: 457.127, y: 454.124, width: 10.385 },
    { text: "MASTER:", x: 469.233, y: 454.124, width: 28.581 },
    { text: "8", x: 499.534, y: 454.124, width: 4.073 },
    { text: "NCM:", x: 457.127, y: 447.774, width: 18.274 },
    { text: "70133700", x: 477.243, y: 447.774, width: 31.927 },
    { text: "Conjunto", x: 184.034, y: 505.740, width: 44.312 },
    { text: "6", x: 184.034, y: 494.718, width: 5.805 },
    { text: "canecas", x: 192.392, y: 494.718, width: 38.860 },
    { text: "de", x: 233.806, y: 494.718, width: 12.118 },
    { text: "vidro", x: 184.034, y: 483.697, width: 24.244 },
    { text: "100ml", x: 210.831, y: 483.697, width: 28.409 },
    { text: "CX.", x: 184.034, y: 466.379, width: 11.464 },
    { text: "MASTER:", x: 197.398, y: 466.379, width: 31.551 },
    { text: "12", x: 230.848, y: 466.379, width: 6.638 },
    { text: "NCM:", x: 184.034, y: 459.370, width: 20.173 },
    { text: "70134900", x: 206.241, y: 459.370, width: 36.101 },
    { text: "CORES:", x: 459.263, y: 426.665, width: 25.668 },
    { text: "CORES:", x: 186.392, y: 436.067, width: 28.335 },
    { text: "001831*", x: 457.127, y: 383.911, width: 56.831 },
    { text: "001109*", x: 180.807, y: 387.384, width: 63.840 },
    { text: "TOP2039", x: 174.443, y: 310.203, width: 60.564 },
    { text: "Conjunto", x: 176.138, y: 295.748, width: 48.263 },
    { text: "6", x: 176.138, y: 283.743, width: 6.323 },
    { text: "copos", x: 185.242, y: 283.743, width: 30.973 },
    { text: "de", x: 218.996, y: 283.743, width: 13.198 },
    { text: "vidro", x: 176.138, y: 271.739, width: 26.406 },
    { text: "420ml", x: 205.325, y: 271.739, width: 33.029 },
    { text: "CX.", x: 176.138, y: 252.877, width: 12.487 },
    { text: "MASTER:", x: 190.694, y: 252.877, width: 34.365 },
    { text: "8", x: 227.127, y: 252.877, width: 4.897 },
    { text: "NCM:", x: 176.138, y: 245.243, width: 21.972 },
    { text: "70133700", x: 200.326, y: 245.243, width: 38.389 },
    { text: "CORES:", x: 176.431, y: 230.478, width: 30.862 },
    { text: "002583*", x: 176.138, y: 174.693, width: 75.678 },
    { text: "TOP2041", x: 451.903, y: 310.203, width: 58.652 },
    { text: "Conjunto", x: 453.599, y: 295.748, width: 48.263 },
    { text: "6", x: 453.599, y: 283.744, width: 6.323 },
    { text: "taças", x: 462.703, y: 283.744, width: 27.565 },
    { text: "de", x: 493.049, y: 283.744, width: 13.198 },
    { text: "vidro", x: 453.599, y: 271.739, width: 26.406 },
    { text: "340ml", x: 482.786, y: 271.739, width: 33.029 },
    { text: "CX.", x: 453.599, y: 252.878, width: 12.487 },
    { text: "MASTER:", x: 468.154, y: 252.878, width: 34.365 },
    { text: "8", x: 504.588, y: 252.878, width: 4.897 },
    { text: "NCM:", x: 453.599, y: 245.243, width: 21.972 },
    { text: "70132800", x: 477.786, y: 245.243, width: 38.742 },
    { text: "CORES:", x: 455.790, y: 230.478, width: 30.862 },
    { text: "002866*", x: 455.682, y: 170.380, width: 77.278 },
    // Banner "PROMOÇÃO!" rotacionado, 1 palavra por linha (decoração da
    // página, não faz parte de nome nenhum) — presente 4x, perto de cada
    // um dos 4 produtos, testando que não contamina o nome de nenhum.
    { text: "PRO", x: 234.818, y: 217.742, width: 22.304 },
    { text: "MO", x: 232.853, y: 210.153, width: 17.820 },
    { text: "ÇÃO!", x: 230.888, y: 199.836, width: 25.287 },
    { text: "PRO", x: 232.451, y: 437.876, width: 22.304 },
    { text: "MO", x: 230.486, y: 430.286, width: 17.820 },
    { text: "ÇÃO!", x: 228.521, y: 419.970, width: 25.287 },
    { text: "PRO", x: 517.491, y: 423.614, width: 22.304 },
    { text: "MO", x: 515.526, y: 416.024, width: 17.820 },
    { text: "ÇÃO!", x: 513.561, y: 405.708, width: 25.287 },
    { text: "PRO", x: 527.340, y: 218.588, width: 22.304 },
    { text: "MO", x: 525.375, y: 210.998, width: 17.820 },
    { text: "ÇÃO!", x: 523.410, y: 200.682, width: 25.287 },
  ];

  it("recupera os 4 produtos de uma grade de 2 colunas repetida a página inteira, sem contaminar nome entre colunas nem com o banner de promoção", () => {
    const result = extractVitrineGridBlocks(TOPUTIL_PAGE_5_ITEMS, PAGE_WIDTH);

    expect(result).not.toBeNull();
    expect(result!.map((b) => b.sku).sort()).toEqual(["TOP2036", "TOP2038", "TOP2039", "TOP2041"]);

    const bySku = Object.fromEntries(result!.map((b) => [b.sku, b]));
    expect(bySku["TOP2036"].name).toBe("Conjunto 6 canecas de vidro 100ml");
    expect(bySku["TOP2038"].name).toBe("Conjunto 6 copos de vidro 310ml");
    expect(bySku["TOP2039"].name).toBe("Conjunto 6 copos de vidro 420ml");
    expect(bySku["TOP2041"].name).toBe("Conjunto 6 taças de vidro 340ml");
  });

  it("é no-op (devolve null) quando a página não tem nenhuma linha com 2+ marcadores lado a lado — catálogo de coluna única cai pro modo empilhado de sempre, sem mudança de comportamento", () => {
    const items = [
      { text: "TOP2905", x: 30, y: 700, width: 60 },
      { text: "Produto Empilhado Normal", x: 30, y: 650, width: 150 },
      { text: "CX MASTER: 20", x: 30, y: 600, width: 80 },
    ];

    expect(extractVitrineGridBlocks(items, PAGE_WIDTH)).toBeNull();
    expect(extractVitrineGridBlocks([], PAGE_WIDTH)).toBeNull();
  });

  it("é no-op quando a linha com 2+ segmentos NÃO são todos SKU standalone (evita falso positivo) — mesmo espírito do teste equivalente em extractProductBlocksWithoutPrice", () => {
    // 2 segmentos na mesma linha Y, mas só 1 bate no padrão de SKU
    // standalone (o outro é texto qualquer) — não é o caso de grade
    // lado a lado, então não deve ativar o modo grade.
    const items = [
      { text: "TOP2905", x: 30, y: 700, width: 60 },
      { text: "Alguma frase qualquer", x: 300, y: 700, width: 150 },
    ];

    expect(extractVitrineGridBlocks(items, PAGE_WIDTH)).toBeNull();
  });
});

describe("dedupeCatalogRows", () => {
  it("remove a segunda ocorrência de um SKU repetido, mantendo a primeira", () => {
    const rows: CatalogRow[] = [
      { sku: "TOP2905", name: "Mesa Para Computador", supplierPrice: 120 },
      { sku: "TOP2977", name: "Moldura P/ Foto", supplierPrice: 30 },
      { sku: "TOP2905", name: "Mesa Para Computador", supplierPrice: 120 },
    ];

    const { rows: deduped, removed } = dedupeCatalogRows(rows);

    expect(removed).toBe(1);
    expect(deduped).toHaveLength(2);
    expect(deduped.map((r) => r.sku)).toEqual(["TOP2905", "TOP2977"]);
  });

  it("não mexe em catálogo sem SKU repetido nenhum (caso comum — zero custo)", () => {
    const rows: CatalogRow[] = [
      { sku: "A1", name: "Produto A", supplierPrice: 10 },
      { sku: "B2", name: "Produto B", supplierPrice: 20 },
      { sku: "C3", name: "Produto C", supplierPrice: 30 },
    ];

    const { rows: deduped, removed } = dedupeCatalogRows(rows);

    expect(removed).toBe(0);
    expect(deduped).toEqual(rows);
  });

  it(
    "quando o SKU repete e só UMA ocorrência tem supplierPrice (ex: página vitrine sem preço + grade " +
      "principal com preço mais adiante), mantém a que tem preço — nunca perde o custo de fornecedor",
    () => {
      const rows: CatalogRow[] = [
        { sku: "B2", name: "Produto Vitrine (sem preço)" }, // aparece primeiro, sem preço
        { sku: "A1", name: "Produto A", supplierPrice: 10 },
        { sku: "B2", name: "Produto Vitrine", supplierPrice: 45 }, // mesma peça, agora com preço
      ];

      const { rows: deduped, removed } = dedupeCatalogRows(rows);

      expect(removed).toBe(1);
      expect(deduped).toHaveLength(2);
      const b2 = deduped.find((r) => r.sku === "B2");
      expect(b2).toMatchObject({ name: "Produto Vitrine", supplierPrice: 45 });
    }
  );

  it("mantém a PRIMEIRA ocorrência quando as duas têm preço (ou as duas não têm) — não tenta adivinhar qual é 'mais certa'", () => {
    const rows: CatalogRow[] = [
      { sku: "A1", name: "Nome Primeira Leitura", supplierPrice: 10 },
      { sku: "A1", name: "Nome Segunda Leitura (ruído de OCR, por exemplo)", supplierPrice: 11 },
    ];

    const { rows: deduped, removed } = dedupeCatalogRows(rows);

    expect(removed).toBe(1);
    expect(deduped).toHaveLength(1);
    expect(deduped[0]).toMatchObject({ name: "Nome Primeira Leitura", supplierPrice: 10 });
  });

  it("normaliza SKU (maiúsculas/espaço) antes de comparar — mesmo produto lido de formas ligeiramente diferentes em páginas diferentes ainda é reconhecido como duplicata", () => {
    const rows: CatalogRow[] = [
      { sku: "top-2905", name: "Produto A", supplierPrice: 10 },
      { sku: " TOP-2905 ", name: "Produto A", supplierPrice: 10 },
    ];

    const { rows: deduped, removed } = dedupeCatalogRows(rows);

    expect(removed).toBe(1);
    expect(deduped).toHaveLength(1);
  });

  it("é no-op em array vazio", () => {
    expect(dedupeCatalogRows([])).toEqual({ rows: [], removed: 0 });
  });
});
