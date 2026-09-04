import { describe, expect, it } from "vitest";
import { parseSharedStrings, parseSheet, readXlsxSheet, XlsxReadError } from "./xlsxReader";

describe("parseSharedStrings", () => {
  it("lê a tabela de textos compartilhados, decodificando entidade XML", () => {
    const xml =
      '<sst><si><t>SKU</t></si><si><t>Mesa &amp; Cadeira</t></si><si><t>3 &lt; 5</t></si></sst>';

    expect(parseSharedStrings(xml)).toEqual(["SKU", "Mesa & Cadeira", "3 < 5"]);
  });

  it("junta texto quebrado em vários <t> dentro do mesmo <si> (formatação parcial no Excel)", () => {
    const xml = "<sst><si><r><t>Cabo </t></r><r><t>USB-C</t></r></si></sst>";

    expect(parseSharedStrings(xml)).toEqual(["Cabo USB-C"]);
  });

  it("é no-op em planilha sem textos compartilhados", () => {
    expect(parseSharedStrings("<sst/>")).toEqual([]);
  });
});

describe("parseSheet", () => {
  const shared = ["SKU", "Produto", "Custo", "TOP-1", "Mesa"];

  it("resolve célula de texto pelo índice da tabela compartilhada e número direto", () => {
    const xml =
      '<sheetData>' +
      '<row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c><c r="C1" t="s"><v>2</v></c></row>' +
      '<row r="2"><c r="A2" t="s"><v>3</v></c><c r="B2" t="s"><v>4</v></c><c r="C2"><v>12.5</v></c></row>' +
      "</sheetData>";

    expect(parseSheet(xml, shared)).toEqual([
      ["SKU", "Produto", "Custo"],
      ["TOP-1", "Mesa", "12.5"],
    ]);
  });

  it("lê texto inline (inlineStr) — Google Sheets exporta assim com frequência", () => {
    const xml = '<sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>Caneta Azul</t></is></c></row></sheetData>';

    expect(parseSheet(xml, [])).toEqual([["Caneta Azul"]]);
  });

  it(
    "posiciona a célula pela REFERÊNCIA, não pela ordem — planilha real OMITE célula vazia, e ler em " +
      "sequência desalinharia todas as colunas seguintes da linha (o erro clássico desse tipo de leitor)",
    () => {
      // Linha sem a coluna B: A e C preenchidas.
      const xml = '<sheetData><row r="1"><c r="A1" t="s"><v>3</v></c><c r="C1"><v>9,90</v></c></row></sheetData>';

      const rows = parseSheet(xml, shared);
      expect(rows[0][0]).toBe("TOP-1");
      expect(rows[0][1]).toBe(""); // buraco preservado
      expect(rows[0][2]).toBe("9,90");
    }
  );

  it("aceita célula vazia auto-fechada (<c r=\"B2\"/>) sem quebrar", () => {
    const xml = '<sheetData><row r="1"><c r="A1" t="s"><v>3</v></c><c r="B1"/></row></sheetData>';

    expect(parseSheet(xml, shared)[0]).toEqual(["TOP-1", ""]);
  });

  it("colunas além de Z (AA, AB...) caem no índice certo", () => {
    const xml = '<sheetData><row r="1"><c r="AA1"><v>27</v></c></row></sheetData>';

    expect(parseSheet(xml, [])[0]).toHaveLength(27);
    expect(parseSheet(xml, [])[0][26]).toBe("27");
  });
});

describe("readXlsxSheet — arquivo .xlsx real", () => {
  /**
   * .xlsx mínimo gerado por `zipfile` (deflate), com o mesmo layout que
   * Excel/LibreOffice produzem: `[Content_Types].xml`, `xl/workbook.xml`,
   * `xl/sharedStrings.xml` e `xl/worksheets/sheet1.xml`. Conteúdo:
   *
   *   SKU    | Produto        | Custo
   *   TOP-1  | Mesa & Cadeira | 12.5
   *   TOP-2  | Caneta Azul    | 3.75   (nome como inlineStr)
   *
   * Fixture em base64 pra o teste não depender de biblioteca de zip nem
   * de arquivo externo — é o arquivo binário de verdade, passando pelo
   * mesmo caminho de descompactação do navegador.
   */
  const FIXTURE_B64 = [
    "UEsDBBQAAAAIAD2sI12ZTS2bkgAAALMAAAATAAAAW0NvbnRlbnRfVHlwZXNdLnhtbCWOSw7CMAxE95wi8r51YYEQStIFnxOUA1jB",
    "/Yg2iRqDyu1J6dLzZjyj62Ua1YfnNARvYF9WoNi78Bx8Z+DR3IsT1Hanm2/kpLLXJwO9SDwjJtfzRKkMkX0mbZgnknzOHUZyL+oY",
    "D1V1RBe8sJdC1h9g9ZVbeo+ibkuWt94cB3XZfGuVAYpxHBxJxrhStBr/I+wPUEsDBBQAAAAIAD2sI11Q94a/kgAAALwAAAAPAAAA",
    "eGwvd29ya2Jvb2sueG1sNU69DoIwEN59iuZ2OXAwhrRlM2Fz0Aeo9IQGeiVtoz6+DZHp+08+2X39It4UkwusoKlqEMRDsI5HBY/7",
    "9XiBTh/kJ8T5GcIsSp2TginntUVMw0TepCqsxCV5hehNLjKOmNZIxqaJKPsFT3V9Rm8cg5abl/4o2HhScFsMNyA2q7flCIjYukJi",
    "bxtALXFf4X5F/wBQSwMEFAAAAAgAPawjXfETJvy2AAAAGwEAABQAAAB4bC9zaGFyZWRTdHJpbmdzLnhtbF2PQQrCMBBF954iZOGu",
    "Te1CRNO4KLgRUVAPENqxDTRJzUzE49siRenyv3mfz8j923bsBQGNdwVfpRln4CpfG9cU/H47JBu+VwuJSGwwHRa8Jeq3QmDVgtWY",
    "+h7ccHn4YDUNMTQC+wC6xhaAbCfyLFsLq43jrPLRUcHXnEVnnhHKKY8LRklS1+NdClJSjPGLLsHXkfwclxH/4NS/nS/Jaq6eADVb",
    "atvvWKlrMEHPjbGW/6AY3lUfUEsDBBQAAAAIAD2sI13tTXo56wAAAN8BAAAYAAAAeGwvd29ya3NoZWV0cy9zaGVldDEueG1sdZFR",
    "TsMwDIbfOUWU99VtygChNNM2xAWAA0RdtkY0SZWYDnF6vBW1pYi32N9vf1EiN5+uZb2JyQZf8SLLOTO+DgfrTxV/e31ePfCNupHn",
    "EN9TYwwyyvtU8QaxewRIdWOcTlnojCdyDNFppDKeIHXR6MN1yLUg8vwOnLaeK3ntPWnUtDiGM4skpnZ9OWwLzrDiiepe5RJ6JaH+",
    "Ybs5K36z/ZyJkQHtnyxitIhZulxY5ux2YRGDW2TrfxTlqChna9YLxcCsb603LxgpY5OSqPbaG9Rs+/XRSkCauLQnezncN7v/Y4fp",
    "TSWMn6W+AVBLAQIUAxQAAAAIAD2sI12ZTS2bkgAAALMAAAATAAAAAAAAAAAAAACAAQAAAABbQ29udGVudF9UeXBlc10ueG1sUEsB",
    "AhQDFAAAAAgAPawjXVD3hr+SAAAAvAAAAA8AAAAAAAAAAAAAAIABwwAAAHhsL3dvcmtib29rLnhtbFBLAQIUAxQAAAAIAD2sI13x",
    "Eyb8tgAAABsBAAAUAAAAAAAAAAAAAACAAYIBAAB4bC9zaGFyZWRTdHJpbmdzLnhtbFBLAQIUAxQAAAAIAD2sI13tTXo56wAAAN8B",
    "AAAYAAAAAAAAAAAAAACAAWoCAAB4bC93b3Jrc2hlZXRzL3NoZWV0MS54bWxQSwUGAAAAAAQABAAGAQAAiwMAAAAA",
  ].join("");

  function fixtureBuffer(): ArrayBuffer {
    const binary = atob(FIXTURE_B64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return bytes.buffer;
  }

  it("lê o arquivo binário de ponta a ponta: descompacta o ZIP e devolve a matriz da planilha", async () => {
    const rows = await readXlsxSheet(fixtureBuffer());

    expect(rows).toEqual([
      ["SKU", "Produto", "Custo"],
      ["TOP-1", "Mesa & Cadeira", "12.5"],
      ["TOP-2", "Caneta Azul", "3.75"],
    ]);
  });

  it("propaga erro claro quando o arquivo não é um ZIP válido (ex: .xls antigo renomeado)", async () => {
    const notAZip = new TextEncoder().encode("isto não é um zip, é texto puro").buffer;

    await expect(readXlsxSheet(notAZip)).rejects.toThrow(XlsxReadError);
  });
});
