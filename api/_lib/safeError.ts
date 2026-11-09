/**
 * Mensagem de erro SEGURA pra devolver ao cliente (nov/2026, revisão de
 * segurança). Vários handlers devolviam `detail: err.message` cru — e a
 * mensagem de um erro interno pode conter o que não devia sair do servidor:
 * nome de variável de ambiente ("FIREBASE_PRIVATE_KEY ausente"), chave de API
 * que viajou na query string de uma URL, token Bearer, caminho de arquivo.
 *
 * O `detail` continua existindo (o cliente o mostra: é o que explica "sua
 * chave SerpApi é inválida", por exemplo) — só passa por aqui antes:
 * segredos conhecidos são trocados por "[oculto]", nomes de variável de
 * ambiente por "[config]", e o texto é cortado num tamanho razoável. O erro
 * completo continua no log do servidor.
 */

const MAX_DETAIL_CHARS = 300;

const SECRET_PATTERNS: [RegExp, string][] = [
  // ?api_key=… / &key=… / token=… numa URL ou num texto
  [/([?&;\s](?:api[_-]?key|apikey|key|token|access[_-]?token|secret|signature|sig|auth)=)[^&\s"'<>)]+/gi, "$1[oculto]"],
  // Authorization: Bearer abc…
  [/(Bearer\s+)[A-Za-z0-9._~+/=-]{8,}/gi, "$1[oculto]"],
  // formatos de chave conhecidos (Google AIza…, Mercado Pago APP_USR-/TEST-, sk-…)
  [/\bAIza[0-9A-Za-z_-]{20,}\b/g, "[oculto]"],
  [/\b(?:APP_USR|TEST)-[0-9A-Za-z-]{16,}\b/g, "[oculto]"],
  [/\bsk-[A-Za-z0-9_-]{16,}\b/g, "[oculto]"],
  // nomes de variável de ambiente (TUDO_MAIÚSCULO_COM_UNDERSCORE)
  [/\b[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+\b/g, "[config]"],
];

/** Troca segredos e nomes de variável de ambiente por marcadores. Texto sem nada disso passa intacto. */
export function redactSecrets(text: string): string {
  return SECRET_PATTERNS.reduce((acc, [pattern, replacement]) => acc.replace(pattern, replacement), text);
}

/** Texto de um erro, já sem segredos e com tamanho limitado — é o que pode ir no `detail` da resposta HTTP. */
export function publicErrorDetail(err: unknown, maxChars: number = MAX_DETAIL_CHARS): string {
  const raw = err instanceof Error ? err.message : String(err);
  const clean = redactSecrets(raw).replace(/\s+/g, " ").trim();
  return clean.length > maxChars ? `${clean.slice(0, maxChars - 1)}…` : clean;
}
