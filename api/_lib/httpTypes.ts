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
<<<<<<< HEAD
  /** Query string parseada (ex: `?id=abc` → `{ id: "abc" }`) — usado por catalog-image.ts. */
  query?: Record<string, string | string[] | undefined>;
=======
>>>>>>> 876d06fbe516a280c102d8517ac760291de86799
}

export interface ApiResponse {
  status(code: number): ApiResponse;
  json(body: unknown): void;
<<<<<<< HEAD
  /** Usado por catalog-image.ts pra servir a imagem com o Content-Type certo (não é JSON). */
  setHeader(name: string, value: string): ApiResponse;
  send(body: string | Buffer): void;
=======
>>>>>>> 876d06fbe516a280c102d8517ac760291de86799
}
