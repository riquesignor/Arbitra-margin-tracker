/**
 * Tipos estruturais mínimos pro handler HTTP — evita puxar @vercel/node
 * inteiro só pra ter `req`/`res` tipados. Compatível com Vercel Edge/Node
 * Functions e fácil de portar pra outro runtime se necessário.
 */
export interface ApiRequest {
  method?: string;
  /** Node/Vercel normaliza chaves pra minúsculo (`authorization`, não `Authorization`). */
  headers?: Record<string, string | string[] | undefined>;
  body: unknown;
}

export interface ApiResponse {
  status(code: number): ApiResponse;
  json(body: unknown): void;
}
