/**
 * ══════════════════════════════════════════════════════════════════════
 * LEITOR MÍNIMO DE .XLSX — sem dependência nova
 * ══════════════════════════════════════════════════════════════════════
 *
 * Lacuna real (set/2026, ver docs/auditoria-2026-09.md > item 15):
 * fornecedor manda planilha o tempo todo, e o app só aceitava .csv e
 * .pdf — o usuário tinha que abrir o Excel e reexportar antes de usar o
 * produto.
 *
 * Por que NÃO usar SheetJS: a versão publicada no npm tem duas CVEs sem
 * correção (prototype pollution + ReDoS) — risco herdado já anotado em
 * parseCatalog.ts — e a alternativa oficial é instalar por tarball de
 * CDN, o que complica o `npm ci` de qualquer ambiente novo. Para o que
 * este app precisa (SKU, nome e custo de uma planilha simples de
 * fornecedor), um leitor próprio de ~150 linhas cobre o caso com zero
 * dependência e zero superfície de ataque nova.
 *
 * O que este leitor cobre:
 *   - .xlsx/.xlsm gerados por Excel, LibreOffice e Google Sheets;
 *   - texto em `sharedStrings`, texto inline (`inlineStr`) e número;
 *   - a PRIMEIRA planilha do arquivo (sheet1.xml), que é onde catálogo de
 *     fornecedor coloca a lista.
 *
 * O que NÃO cobre (deliberado, com falha explícita em vez de dado errado):
 *   - .xls antigo (formato binário BIFF, outra especificação por
 *     completo);
 *   - arquivo protegido por senha (o ZIP vem criptografado);
 *   - fórmula não calculada (lê o último valor salvo — que é o que o
 *     Excel grava em `<v>`; planilha nunca aberta pode não ter valor).
 *
 * Descompactação usa `DecompressionStream("deflate-raw")`, API nativa do
 * navegador (e do Node 18+, o que permite testar sem jsdom) — é o que
 * torna possível ler o ZIP do .xlsx sem biblioteca.
 */

export class XlsxReadError extends Error {}

// ── ZIP ────────────────────────────────────────────────────────────────

const EOCD_SIGNATURE = 0x06054b50;
const CENTRAL_FILE_SIGNATURE = 0x02014b50;

/** Registro "End of Central Directory": fica no FIM do arquivo e diz onde começa o índice. Pode ter até 64KB de comentário depois dele, daí a varredura de trás pra frente. */
function findEndOfCentralDirectory(view: DataView): number {
  const maxCommentLength = 0xffff;
  const start = Math.max(0, view.byteLength - maxCommentLength - 22);

  for (let offset = view.byteLength - 22; offset >= start; offset--) {
    if (view.getUint32(offset, true) === EOCD_SIGNATURE) return offset;
  }

  throw new XlsxReadError("Arquivo .xlsx inválido (não parece um ZIP — fim do índice não encontrado).");
}

async function inflateRaw(data: Uint8Array): Promise<Uint8Array> {
  const DecompressionStreamCtor = (
    globalThis as unknown as { DecompressionStream?: new (format: string) => TransformStream }
  ).DecompressionStream;

  if (!DecompressionStreamCtor) {
    throw new XlsxReadError(
      "Este navegador não suporta descompactar .xlsx (DecompressionStream indisponível). " +
        "Exporte a planilha como .csv e envie de novo."
    );
  }

  const stream = new Blob([data as BlobPart]).stream().pipeThrough(new DecompressionStreamCtor("deflate-raw"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/**
 * Lê as entradas do ZIP pelo ÍNDICE CENTRAL (não varrendo cabeçalhos
 * locais): é o único lugar onde tamanho e método de compressão são
 * confiáveis — cabeçalho local pode trazer zeros quando o arquivo foi
 * gravado em streaming (comum no Google Sheets).
 */
async function unzip(buffer: ArrayBuffer): Promise<Map<string, Uint8Array>> {
  const view = new DataView(buffer);
  const bytes = new Uint8Array(buffer);
  const eocd = findEndOfCentralDirectory(view);
  const entryCount = view.getUint16(eocd + 10, true);
  let offset = view.getUint32(eocd + 16, true);

  const entries = new Map<string, Uint8Array>();

  for (let i = 0; i < entryCount; i++) {
    if (view.getUint32(offset, true) !== CENTRAL_FILE_SIGNATURE) {
      throw new XlsxReadError("Arquivo .xlsx inválido (índice do ZIP corrompido).");
    }

    const method = view.getUint16(offset + 10, true);
    const compressedSize = view.getUint32(offset + 20, true);
    const nameLength = view.getUint16(offset + 28, true);
    const extraLength = view.getUint16(offset + 30, true);
    const commentLength = view.getUint16(offset + 32, true);
    const localOffset = view.getUint32(offset + 42, true);
    const name = new TextDecoder().decode(bytes.subarray(offset + 46, offset + 46 + nameLength));

    // Cabeçalho local: o início dos dados depende do tamanho do nome e do
    // campo "extra" DELE, que podem diferir dos do índice central.
    const localNameLength = view.getUint16(localOffset + 26, true);
    const localExtraLength = view.getUint16(localOffset + 28, true);
    const dataStart = localOffset + 30 + localNameLength + localExtraLength;
    const raw = bytes.subarray(dataStart, dataStart + compressedSize);

    if (method === 0) {
      entries.set(name, raw);
    } else if (method === 8) {
      entries.set(name, await inflateRaw(raw));
    } else {
      // Método exótico (bzip2, lzma...) — Excel não gera, então é sinal de
      // arquivo estranho; ignora a entrada em vez de derrubar a leitura.
      console.warn(`Entrada "${name}" do .xlsx usa compressão não suportada (${method}) — ignorada.`);
    }

    offset += 46 + nameLength + extraLength + commentLength;
  }

  return entries;
}

// ── XML da planilha ────────────────────────────────────────────────────

const XML_ENTITIES: Record<string, string> = {
  "&amp;": "&",
  "&lt;": "<",
  "&gt;": ">",
  "&quot;": '"',
  "&apos;": "'",
};

function decodeXmlText(raw: string): string {
  return raw
    .replace(/&#(\d+);/g, (_, code: string) => String.fromCharCode(Number(code)))
    .replace(/&#x([0-9a-f]+);/gi, (_, code: string) => String.fromCharCode(parseInt(code, 16)))
    .replace(/&(amp|lt|gt|quot|apos);/g, (entity) => XML_ENTITIES[entity] ?? entity);
}

/**
 * `sharedStrings.xml` — o Excel não repete texto na planilha: cada célula
 * de texto guarda um ÍNDICE pra esta tabela. Cada `<si>` pode ter o texto
 * quebrado em vários `<t>` (quando parte dele tem formatação diferente),
 * então concatenamos todos.
 *
 * Exportada pra teste unitário direto.
 */
export function parseSharedStrings(xml: string): string[] {
  const strings: string[] = [];

  for (const [, siContent] of xml.matchAll(/<si\b[^>]*>([\s\S]*?)<\/si>/g)) {
    const parts = [...siContent.matchAll(/<t\b[^>]*>([\s\S]*?)<\/t>/g)].map((m) => decodeXmlText(m[1]));
    strings.push(parts.join(""));
  }

  return strings;
}

/** "BC12" → 54 (índice 0-based da coluna). Letras são base-26 sem zero. */
function columnIndexFromRef(ref: string): number {
  const letters = ref.match(/^[A-Z]+/)?.[0] ?? "A";
  let index = 0;
  for (const letter of letters) {
    index = index * 26 + (letter.charCodeAt(0) - 64);
  }
  return index - 1;
}

/**
 * Converte a planilha numa matriz de strings, posicionando cada célula
 * pela REFERÊNCIA (`r="B7"`) em vez da ordem de aparição — planilha real
 * omite célula vazia, e ler em sequência desalinharia as colunas do resto
 * da linha (o erro clássico de leitor de xlsx improvisado).
 *
 * Exportada pra teste unitário direto.
 */
export function parseSheet(xml: string, sharedStrings: string[]): string[][] {
  const rows: string[][] = [];

  for (const [, rowAttrs, rowContent] of xml.matchAll(/<row\b([^>]*)>([\s\S]*?)<\/row>/g)) {
    const rowNumber = Number(rowAttrs.match(/\br="(\d+)"/)?.[1] ?? rows.length + 1);
    const row: string[] = [];

    for (const [, cellAttrs, cellContent] of rowContent.matchAll(/<c\b([^>]*)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
      const ref = cellAttrs.match(/\br="([A-Z]+\d+)"/)?.[1];
      const type = cellAttrs.match(/\bt="([^"]+)"/)?.[1];
      const column = ref ? columnIndexFromRef(ref) : row.length;

      let value = "";
      if (type === "inlineStr") {
        value = [...(cellContent ?? "").matchAll(/<t\b[^>]*>([\s\S]*?)<\/t>/g)]
          .map((m) => decodeXmlText(m[1]))
          .join("");
      } else {
        const raw = (cellContent ?? "").match(/<v\b[^>]*>([\s\S]*?)<\/v>/)?.[1];
        if (raw != null) {
          const decoded = decodeXmlText(raw);
          value = type === "s" ? (sharedStrings[Number(decoded)] ?? "") : decoded;
        }
      }

      row[column] = value;
    }

    // Linha 1 da planilha = índice 0 da matriz; buracos viram linha vazia
    // em vez de sumirem (mantém o alinhamento com o número da linha).
    rows[rowNumber - 1] = Array.from(row, (cell) => cell ?? "");
  }

  return Array.from(rows, (row) => row ?? []);
}

// ── API pública ────────────────────────────────────────────────────────

/** Caminho da primeira planilha dentro do pacote — o mesmo em Excel, LibreOffice e Google Sheets. */
const FIRST_SHEET_PATH = "xl/worksheets/sheet1.xml";
const SHARED_STRINGS_PATH = "xl/sharedStrings.xml";

/**
 * Lê a primeira planilha de um .xlsx e devolve a matriz de células como
 * texto (linha 0 = cabeçalho). Quem chama decide o que fazer com as
 * colunas — ver parseCatalog.ts, que reaproveita a MESMA detecção fuzzy
 * de cabeçalho usada no CSV.
 */
export async function readXlsxSheet(file: ArrayBuffer): Promise<string[][]> {
  const entries = await unzip(file);

  const sheetBytes = entries.get(FIRST_SHEET_PATH);
  if (!sheetBytes) {
    throw new XlsxReadError(
      "Não encontrei a primeira planilha dentro do arquivo. Se ele foi salvo como .xls antigo " +
        "(ou está protegido por senha), reexporte como .xlsx ou .csv."
    );
  }

  const decoder = new TextDecoder();
  const sharedBytes = entries.get(SHARED_STRINGS_PATH);
  const sharedStrings = sharedBytes ? parseSharedStrings(decoder.decode(sharedBytes)) : [];

  return parseSheet(decoder.decode(sheetBytes), sharedStrings);
}
