/**
 * Valida link de anúncio antes de virar `href`.
 *
 * O `link` de um resultado vem da resposta de API de terceiro (SerpApi,
 * ScraperAPI, Google Lens, raspagem de loja) — dado externo que o app
 * renderiza como link clicável na tabela de resultados e na carteira. Sem
 * checagem de esquema, um `javascript:...` (ou `data:text/html,...`)
 * devolvido por um upstream comprometido/hostil executaria no clique, com
 * a sessão do usuário logado.
 *
 * `rel="noopener noreferrer"` já estava em todos os links (isso é
 * anterior), mas `rel` não protege contra esquema perigoso — só contra
 * tabnabbing/vazamento de referrer. Ver docs/auditoria-2026-09.md > P1-7.
 *
 * Devolve `undefined` quando a URL não é http(s), pra quem chama cair no
 * estado "sem link" que a UI já tem — em vez de renderizar um link que
 * não deveria existir.
 */
export function safeExternalUrl(rawUrl: string | undefined | null): string | undefined {
  if (!rawUrl?.trim()) return undefined;

  try {
    const url = new URL(rawUrl);
    if (url.protocol !== "http:" && url.protocol !== "https:") return undefined;
    return url.toString();
  } catch {
    // Não é URL absoluta válida — link relativo de marketplace não existe
    // no nosso contexto (o anúncio está em outro domínio), então descartar
    // é o comportamento certo, não tentar completar.
    return undefined;
  }
}
