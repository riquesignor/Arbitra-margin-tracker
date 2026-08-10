import { describe, expect, it } from "vitest";
import { extractGridBlocks, extractRows, sanitizeProductName } from "./parsePdfCatalog";

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
});
