# Revisão de segurança — nov/2026

Resumo curto da revisão feita na branch `feat/projeto-gratuito`, quando o
Arbitra virou um projeto gratuito (cada pessoa cadastra as **próprias chaves
de API**, o BYOK). Seguiu uma regra: **nada que mude o comportamento visível**.
Quando uma correção pedia mudar o fluxo de uso, ela virou recomendação aqui
em vez de ser implementada.

Complementa `docs/auditoria-2026-09.md` (que fechou os achados P0–P1 de
setembro). Todo item abaixo tem teste automatizado, salvo onde estiver dito o
contrário.

## O que foi revisado

### Rotas de `api/` — autenticação e entrada

| Rota | Como se protege | Resultado |
|---|---|---|
| `fetch-prices` | login + e-mail confirmado (`requireVerifiedAuth`), validação de corpo, cota diária | ok; campos de texto agora têm tamanho máximo |
| `check-watch` | login + e-mail confirmado, cota diária | ok; `sku` com tamanho máximo |
| `product-assistant` | login + e-mail confirmado, cota diária, limites de foto/conversa | ok |
| `admin-diagnostics` | `requireAdmin` (login + `isAdmin` no banco) | ok; devolve só booleanos e nomes, nunca valor de variável |
| `billing-create-subscription` | login (`requireAuth`) e a chave `BILLING_ENABLED` | ok; dormente por padrão |
| `billing-webhook` | assinatura HMAC do Mercado Pago (não há login) e `BILLING_ENABLED` | ok; dormente por padrão |
| `cron-check-watches` | `Authorization: Bearer $CRON_SECRET`, comparação em tempo constante; sem a variável recusa tudo | ok |
| `catalog-image` | **pública de propósito** (o crawler do Google Lens não manda token); o "segredo" é o `id` não adivinhável + validade de 30 dias | corrigida, ver abaixo |

`api/_tests/auth-gates.test.ts` cobre isso: sem token, cada rota responde 401 sem tocar
no banco nem em provedor; o cron recusa token de usuário; o admin exige
`isAdmin`. Rota nova entra nesse arquivo.

> O `check-watch` é acionado por um **usuário** (botão "checar agora"), então
> ele se protege por login, não pelo segredo do cron. Só o `cron-check-watches`
> usa `CRON_SECRET`.

### Chaves de API dos usuários

- Ficam em `users/{uid}/secrets/keys`. A regra do Firestore não dá leitura nem
  a administradores; só o dono (e o servidor, via Admin SDK) lê.
- O navegador **não** lê nem reenvia a chave: o servidor busca pelo `uid` do
  token. O admin só enxerga a *flag* "tem chave de X", nunca o valor.
- Nenhum `console.*` do servidor registra o valor de uma chave. Os provedores
  logam o objeto de erro (`err`); as mensagens de erro dos provedores não
  repetem a chave, e a URL com `api_key=` nunca é registrada.

### SSRF

A rota que o servidor transforma em `fetch()` é a de **foto** (`imageUrl`,
em `safeImageUrl.ts`). Corrigido:

- **Redirecionamento seguido na mão** (`redirect: "manual"`, até 3 saltos) e
  cada `Location` validado *antes* de ser requisitado. Antes só o destino final
  era conferido, depois de a requisição já ter saído.
- **A foto do catálogo precisa estar no host do próprio app.** Só checar o
  caminho `/api/catalog-image` deixava apontar essa rota em qualquer host
  público. Hosts aceitos: o `Host` da requisição, `x-forwarded-host`,
  `VERCEL_URL`, `VERCEL_BRANCH_URL`, `VERCEL_PROJECT_PRODUCTION_URL` e
  `APP_BASE_URL`.
- **Hosts internos** agora incluem CGNAT (`100.64/10`), TEST-NET, benchmarking,
  multicast/reservado, IPv6 embutido (`::ffff:`), NAT64, IPv6 link-local,
  site-local e multicast, `localhost.` (com ponto final), `*.localhost`, `.lan`,
  `.intranet` e `.home.arpa`. URL com usuário/senha é recusada.
- Já existiam e continuam: só HTTPS num deploy, teto de 8 MB por imagem, corte
  do stream, erro genérico (sem ecoar URL nem status) e o timeout de quem chama.

### Vazamento de informação em erros

- Novo `api/_lib/safeError.ts`: o `detail` dos erros 502 passa por um filtro que
  troca chave de API em query string, token Bearer, formatos de chave conhecidos
  e **nomes de variável de ambiente** por marcadores, e corta o tamanho. O
  `detail` continua existindo porque é ele que explica ao usuário, por exemplo,
  "sua chave SerpApi é inválida".
- Token de login recusado agora devolve sempre "Sessão inválida ou expirada.
  Entre de novo." (o detalhe do Firebase vai só pro log).
- Rotas de cobrança (quando ligadas) não devolvem `detail`.
- `catalog-image`: erro interno virou "Falha ao servir imagem", sem a mensagem.

### XSS armazenado em `catalog-image`

O documento da foto é escrito pelo próprio cliente (a regra deixa o dono criar
qualquer campo), então o `contentType` gravado não é confiável: quem gravasse
`text/html` com HTML em `base64` **hospedaria uma página nossa, na origem do
app**. Agora só são servidos `image/jpeg`, `png`, `webp` e `gif` (SVG fica de
fora de propósito), com `X-Content-Type-Options: nosniff` e
`Content-Security-Policy: default-src 'none'; sandbox`. `id` e `uid` fora do
formato `[A-Za-z0-9_-]{1,128}` recusam com 400 sem consultar o banco.

### Limites de tamanho e abuso

- Plataforma: a Vercel limita o corpo de uma Function a 4,5 MB.
- `fetch-prices`: até 50 produtos por requisição, `sku` até 300 caracteres,
  nome até 2.000, `imageUrl` até 2.048, `supplierPrice` numérico.
- `product-assistant`: foto até ~3 MB em base64, 30 mensagens de 2.000 caracteres.
- Cota diária por usuário aplicada **no servidor**, em transaction (100 buscas
  por dia no modo gratuito).
- `cron-check-watches`: no máximo 200 watches por usuário por execução. O limite
  de monitorados é do lado do app e as regras deixam o dono gravar documentos à
  vontade; sem esse teto, milhares de watches gravados direto no banco fariam o
  cron varrer tudo todo dia.

### CORS

Nenhuma rota define `Access-Control-Allow-Origin`, então o navegador só aceita
chamada da mesma origem. Não havia nada a restringir.

### Cabeçalhos (`vercel.json`)

Já estavam todos presentes: `X-Content-Type-Options: nosniff`,
`Referrer-Policy: strict-origin-when-cross-origin`, `X-Frame-Options: DENY`,
`Permissions-Policy` restritiva e `Strict-Transport-Security`.
`api/_tests/vercel-headers.test.ts` trava isso contra regressão.

> **Decisão registrada — CSP.** O pedido era deixar a CSP só como
> `Content-Security-Policy-Report-Only`. Mas o `vercel.json` já a publica em
> modo **que bloqueia** desde 23/09, e o app roda em produção com ela. Voltar
> pra *report-only* **enfraqueceria** a proteção contra XSS (que é o que
> protege as chaves no navegador), então foi mantida como está. Se algo quebrar
> por causa dela, o ajuste é trocar a chave do cabeçalho em `vercel.json` para
> `Content-Security-Policy-Report-Only`.

### `firestore.rules`

Auditadas regra por regra. **Nenhuma alteração necessária nesta branch.**
Conferido: cada usuário só lê/escreve dentro do próprio `users/{uid}`; perfil
com `isAdmin` e `plan` travados (só admin altera); `secrets` sem leitura de
terceiros; `usage_daily` e `market_prices` só o servidor escreve (o limite
diário não pode ser zerado pelo cliente); `watch_alerts` só o servidor cria e o
dono só muda o campo `read`; `ml_oauth` fechado; `catalog_image_index` sem
leitura; qualquer outro caminho cai em "negar tudo".

### Dependências (`npm audit`)

`npm audit fix` **sem `--force`** (só `package-lock.json`): **40 → 32** achados.
Os que sobraram exigem atualização com quebra, então ficaram de fora:

| Pacote | Gravidade | Por que sobrou |
|---|---|---|
| `tinypool` / `vitest` / `@vitest/mocker` / `vite` / `esbuild` | crítica / moderada | só dev e testes; corrigir pede vitest 4 e vite 8 |
| `undici` / `@firebase/*` / `firebase` | alta | corrigir pede downgrade do `firebase` (9.14), que é pior |
| `@grpc/grpc-js` | alta | transitivo do Firebase |
| `uuid` / `firebase-admin` | moderada | corrigir pede `firebase-admin` 13 |
| `minimatch` / `typescript-eslint` | moderada | só lint; o `npm audit fix` não consegue atualizar (versão presa dentro do `typescript-eslint`) |

Dos 32, 19 estão nas dependências de produção (todos via `firebase`,
`firebase-admin` e seus subpacotes `undici`, `@grpc/grpc-js` e `uuid`); os
outros são só de desenvolvimento. Ficam como tarefa de atualização planejada
(subir o `firebase`/`firebase-admin` de versão maior e rodar a suíte).

## O que ficou como recomendação

1. **Limite por conta, não por pessoa.** Quem cria várias contas ganha 100
   buscas por conta. O e-mail confirmado já é exigido nas rotas caras
   (`requireVerifiedAuth`). Reforçar pede **Firebase App Check** (reCAPTCHA) ou
   outro desafio no cadastro, o que muda o fluxo de entrada.
2. **Rate limit por minuto.** Só existe o limite diário. Um limite curto por
   `uid` (ex.: 30 requisições por minuto nas rotas caras) evitaria rajadas, mas
   exige um armazenamento compartilhado entre instâncias (Upstash/Redis ou um
   documento no Firestore). Não foi inventada infraestrutura nova.
3. **Travar o `contentType` também na regra do Firestore**, em
   `catalog_images` (`request.resource.data.contentType in [...]`). Já está
   coberto no servidor; na regra seria defesa em profundidade, mas exige que
   você publique as regras.
4. **Teto de monitorados no servidor.** `maxWatches` é validado só no app; o
   cron já limita a 200 por usuário, mas o ideal é contar no servidor ao criar.
5. **DNS rebinding** (host público que resolve para IP privado no momento da
   conexão) continua aceito conscientemente: fechar exigiria resolver o DNS na
   mão e conectar por IP. A trava de host da foto reduz muito a superfície.
6. **Lint de `api/`.** O ESLint não consegue ler `api/` com informação de tipo
   (cada arquivo reporta *Parsing error*, 66 já antes desta branch). Corrigir o
   `eslint.config.js` revelaria ~80 achados reais de estilo/tipo.
7. **CSP sem `'unsafe-eval'`.** Necessário hoje pelo `pdfjs`/OCR; vale revisitar
   quando as bibliotecas permitirem.
8. **Exclusão de conta** apaga o login e o perfil, mas deixa subcoleções
   (histórico, chaves) órfãs no banco, o que diverge do que a política de
   privacidade promete.
