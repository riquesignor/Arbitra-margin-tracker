# Arbitra

Ferramenta de arbitragem de preço pra revendedores brasileiros: sobe um catálogo de fornecedor (PDF ou CSV), busca o preço de cada produto nos principais marketplaces e calcula a margem real — taxas, frete e imposto inclusos — já sugerindo o preço de revenda que bate sua meta de margem.

## O que faz

- **Leitura de catálogo**: upload de PDF (extração heurística por posição de texto, com fallback por IA de visão) ou CSV.
- **Busca de preço multi-fonte**: Amazon e Mercado Livre via raspagem interna + IA, ou através de provedores plugáveis (SerpApi, RapidAPI, SearchApi.io, ScraperAPI, Google Lens/Amazon PA-API/Mercado Livre OAuth quando configurados) — cada usuário cadastra a própria chave (BYOK), sem chave compartilhada de servidor.
- **Cálculo de margem**: taxas de marketplace, faixas de frete e impostos configuráveis por conta, com badge de recomendação (recomendado/revisar/evitar) por produto.
- **Preço sugerido de revenda**: calcula o preço de venda que bate exatamente a margem-alvo configurada, comparando com o preço de mercado encontrado.
- **Histórico de catálogos**, exportação CSV, biblioteca de catálogos administrável e painel de planos.

## Stack

- **Frontend**: React 18 + TypeScript + Vite
- **Backend**: Vercel Serverless Functions (`api/`)
- **Dados/Auth**: Firebase (Auth + Firestore, client SDK + Admin SDK)
- **Testes**: Vitest
- **Parsing de catálogo**: pdfjs-dist, tesseract.js (OCR), papaparse (CSV)

## Pré-requisitos

- Node.js ≥ 20.6 (versão de referência em `.nvmrc` — `nvm use` seleciona a certa)
- Uma conta Firebase (Auth + Firestore) — grátis no plano Spark
- [Vercel CLI](https://vercel.com/docs/cli) para rodar as funções serverless localmente

## Como rodar localmente

```bash
git clone <url-do-repositorio>
cd arbitra
npm install
```

### Configurar o `.env`

```bash
cp .env.example .env
```

Preencha pelo menos as variáveis do Firebase (client + Admin) — sem elas o login não funciona e a busca de preço fica bloqueada. As demais chaves de provedor de busca (SerpApi, RapidAPI, ScraperAPI, Gemini, Mistral...) **não vão no `.env`**: são BYOK, cadastradas por cada usuário direto na tela **Conta** do app depois do login. `.env.example` documenta cada variável e para que serve.

### Deploy das regras do Firestore

```bash
npm install -g firebase-tools
firebase login
firebase deploy --only firestore:rules,firestore:indexes
```

Sem isso o banco roda com as regras padrão do console (geralmente bloqueiam tudo) e o histórico/biblioteca de catálogos não funcionam.

### Rodar

```bash
npm install -g vercel
vercel dev
```

Abre em `http://localhost:3000`. Rodar só `npm run dev` (Vite puro, `http://localhost:5173`) também funciona pra navegar a UI, mas a busca de preço real depende das funções em `api/`, que só sobem com `vercel dev` (ou em produção).

## Scripts disponíveis

| Comando            | O que faz                                              |
|---------------------|---------------------------------------------------------|
| `npm run dev`        | Vite dev server (só frontend)                           |
| `vercel dev`          | Frontend + funções serverless (`api/`) juntos            |
| `npm run build`       | Typecheck completo + build de produção                  |
| `npm run typecheck`   | `tsc --noEmit` no frontend e no backend                  |
| `npm test`            | Roda a suíte de testes (Vitest)                          |
| `npm run lint`        | ESLint                                                  |

## Qualidade

A CI (`.github/workflows/ci.yml`) roda em todo push e PR, na ordem: typecheck (frontend e `api/`), lint, testes e build de produção. Push pra `main` também dispara o deploy na Vercel, então vale rodar `npm run typecheck && npm test` antes de subir.

- Os testes (Vitest) cobrem a lógica pura: cálculo de margem, parsing de catálogo, ranking/similaridade, cache, cota, retry e deduplicação da busca.
- O lint ainda roda sem bloquear (`continue-on-error`) até a base ficar limpa — ver comentário no `ci.yml`.

## Rodando em várias máquinas (Windows/Linux, pen drive exFAT)

Line endings são forçados como LF (`.gitattributes`). Em Linux, exFAT não aceita os symlinks do `node_modules`, então rode uma vez por máquina:

```bash
./scripts/setup-linux-devenv.sh          # monta node_modules fora do pen drive e instala
./scripts/install-linux-automount.sh     # opcional: monta sozinho ao plugar o pen drive
```

O script confere a versão do Node pelo `.nvmrc` antes de instalar.

## Estrutura

```
src/            # frontend (React + TS)
  components/   # telas e componentes de UI
  lib/          # lógica de negócio client-side (margem, parsing, etc.)
  types/        # contratos compartilhados
api/            # funções serverless (Vercel)
  _lib/         # lógica compartilhada entre as funções
docs/           # decisões de arquitetura e notas de projeto
```

## Licença

Distribuído sob a licença MIT — veja [LICENSE](LICENSE).