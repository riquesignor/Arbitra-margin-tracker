/** "R$ 1.234,56" — pt-BR em todas as telas (antes Resultados/Meus produtos mostravam "R$ 1234.56"). */
export function brl(value: number): string {
  return `R$ ${value.toLocaleString("pt-BR", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

/** Fração → porcentagem pt-BR: `pct(0.205)` → "20,5%". */
export function pct(fraction: number, digits = 1): string {
  return `${(fraction * 100).toLocaleString("pt-BR", { minimumFractionDigits: digits, maximumFractionDigits: digits })}%`;
}

/** Latência legível: 840 → "840 ms", 12048 → "12,0 s". */
export function formatMs(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)} ms`;
  return `${(ms / 1000).toLocaleString("pt-BR", { minimumFractionDigits: 1, maximumFractionDigits: 1 })} s`;
}

const LOWERCASE_WORDS = new Set(["de", "da", "do", "das", "dos", "e", "em", "com", "c/", "p/", "para", "na", "no", "a", "o"]);

/**
 * Só pra EXIBIÇÃO — o nome original continua sendo o usado na busca de
 * preço. Catálogo de fornecedor às vezes vem inteiro em CAIXA ALTA
 * ("POTE DE VIDRO HERMETICO 320ML"), mais lento de ler numa tabela.
 * Nome com caixa mista fica intocado; tokens com dígito (320ML, BM-A16)
 * ficam como estão.
 */
export function displayProductName(name: string): string {
  const letters = name.replace(/[^A-Za-zÀ-ÿ]/g, "");
  if (letters.length < 4 || letters !== letters.toUpperCase()) return name;
  return name
    .toLowerCase()
    .split(" ")
    .map((word, i) => {
      if (/\d/.test(word)) return word.toUpperCase();
      if (i > 0 && LOWERCASE_WORDS.has(word)) return word;
      return word.charAt(0).toUpperCase() + word.slice(1);
    })
    .join(" ");
}

/** Tom semântico de uma margem em relação à meta — mesma régua em todas as telas. */
export function marginTone(marginPct: number, targetMarginPct: number): "good" | "warn" | "bad" {
  if (marginPct >= targetMarginPct) return "good";
  if (marginPct >= 0) return "warn";
  return "bad";
}
