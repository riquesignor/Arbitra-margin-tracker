/**
 * ONDE PEGAR A CHAVE DE CADA MECANISMO (set/2026, auditoria item 24)
 * ══════════════════════════════════════════════════════════════════════
 *
 * O app é BYOK: quase todo mecanismo roda com a chave do próprio usuário.
 * O problema não era a falta de aviso — a tela já dizia "cadastre sua
 * chave X em Conta" em três lugares — era que o aviso chegava DEPOIS
 * (quando a busca falhava), sem dizer onde conseguir a chave, e com o
 * texto duplicado num ternário de cinco braços em cada um dos três
 * pontos. Aqui a informação vira dado, num lugar só.
 *
 * As URLs são as mesmas já usadas nos cards de Conta (Account.tsx) —
 * fonte única evita o clássico "atualizei o link num lugar e esqueci do
 * outro".
 */

/** Campo de chave exigido por um mecanismo — espelha `needsKey` em Dashboard.tsx. */
export type ProviderKeyId =
  | "serpApiKey"
  | "rapidApiKey"
  | "searchApiKey"
  | "geminiApiKey"
  | "mistralApiKey";

export interface ProviderKeyGuide {
  /** Nome do serviço como o usuário o conhece. */
  name: string;
  /** Título do card correspondente na tela de Conta — é pra onde a pessoa precisa ir depois de criar a chave. */
  card: string;
  /** Página oficial de criação da chave. */
  url: string;
  /** Custo real, em uma linha. Importa: metade das desistências é achar que vai pagar. */
  cost: string;
}

export const PROVIDER_KEY_GUIDE: Record<ProviderKeyId, ProviderKeyGuide> = {
  serpApiKey: {
    name: "SerpApi",
    card: "SerpApi",
    url: "https://serpapi.com/manage-api-key",
    cost: "grátis, só email",
  },
  rapidApiKey: {
    name: "RapidAPI",
    card: "RapidAPI (Amazon)",
    url: "https://rapidapi.com/letscrape-6bRBa3QguO5/api/real-time-amazon-data/pricing",
    cost: "grátis até 100 buscas/mês",
  },
  searchApiKey: {
    name: "SearchApi.io",
    card: "SearchApi.io",
    url: "https://www.searchapi.io/users/sign_up",
    cost: "grátis até 100 buscas/mês",
  },
  geminiApiKey: {
    name: "Gemini",
    card: "Gemini (motor interno + IA)",
    url: "https://aistudio.google.com/apikey",
    cost: "grátis, sem cartão",
  },
  mistralApiKey: {
    name: "Mistral",
    card: "Mistral (motor interno + IA)",
    url: "https://console.mistral.ai",
    cost: "grátis, sem cartão",
  },
};

/** Frase pronta pro aviso de "falta chave" — mesma redação nos três pontos que precisam dela. */
export function missingKeyMessage(keyId: ProviderKeyId): string {
  const guide = PROVIDER_KEY_GUIDE[keyId];
  return `Este mecanismo usa sua própria chave ${guide.name} (${guide.cost}). Crie em ${guide.url} e cadastre em Conta, no card "${guide.card}".`;
}
