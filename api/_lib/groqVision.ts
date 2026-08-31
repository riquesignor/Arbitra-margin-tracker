/**
 * DEPRECADO (ago/2026) — Groq foi removido como backend de IA de visão do
 * motor interno + IA (relato real "testei Groq, não trouxe nenhum
 * resultado sequer": o free tier de 8.000 tokens/minuto zerava a cota
 * mesmo depois de implementar comparação em lote — ver mistralVision.ts
 * pro substituto escolhido e o raciocínio completo).
 *
 * Este arquivo não é mais importado por nada no código (ver
 * visionInternalSearchProvider.ts > MISTRAL_BACKEND) e continua existindo
 * só porque a ferramenta usada pra esta mudança não tem como apagar
 * arquivo do repositório — APAGUE groqVision.ts e groqVision.test.ts
 * manualmente (`git rm`) na próxima limpeza.
 */
export {};
