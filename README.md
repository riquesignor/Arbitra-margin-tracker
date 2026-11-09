# Arbitra

Ferramenta de **arbitragem de preço pra revendedores brasileiros**: você sobe o
catálogo de um fornecedor (PDF, planilha ou CSV), o Arbitra procura o preço de
cada produto nos marketplaces e calcula a **margem real** — com taxas, frete e
imposto — já sugerindo o preço de revenda que bate a sua meta.

> **Projeto gratuito e beneficente, feito como portfólio.** Qualquer pessoa pode
> usar: basta entrar e cadastrar as **próprias chaves de API** (modelo BYOK, veja
> abaixo). Não há planos pagos, e doar não libera nada. Não há garantia de
> disponibilidade, de precisão dos preços encontrados nem de suporte — leia o
> [aviso](#aviso-projeto-gratuito-sem-garantias) antes de decidir uma compra com
> base no que a ferramenta mostrar.

<!-- Prints: veja docs/img/README.md. Quando as imagens existirem, descomente:
![Resultados](docs/img/resultados.png)
![Painel do produto](docs/img/produto.png)
-->

## O que faz

- **Leitura de catálogo**: PDF (extração por posição do texto, com apoio de OCR
  e de IA de visão quando o PDF é só imagem), planilha `.xlsx`/`.xlsm` e CSV.
- **Busca de preço**: Amazon e Mercado Livre, por **texto** ou por **foto** do
  produto, usando o mecanismo que você escolher (SerpApi, RapidAPI, SearchApi.io,
  ScraperAPI, ou o "motor interno + IA" com Gemini, Mistral ou NVIDIA).
- **Cálculo de margem**: taxas de marketplace, faixas de frete e impostos
  configuráveis por conta; cada produto recebe uma recomendação
  (recomendado / revisar / evitar) e o **preço sugerido** que atinge a meta.
- **Simulador de precificação**: mexa nas taxas e veja o efeito no catálogo
  inteiro na hora, sem gastar uma busca nova.
- **Resultados**: filtros, ordenação, exportação CSV, relatório imprimível/PDF e
  um painel lateral que mostra a conta da margem de cada produto.
- **Meus produtos e monitoramento**: tendência de preço entre buscas, alerta
  quando um produto monitorado muda de preço ou esgota e checagem diária
  automática (opcional, ligada por você).
- **Assistente de produto**: manda a foto de um produto avulso e recebe o preço
  de mercado, um preço sugerido e uma conversa pra tirar dúvidas.
- **Fornecedores**: compara o preço de custo do mesmo produto em catálogos de
  fornecedores diferentes.
- Tema claro/escuro, paletas de cor, tamanho de texto e densidade das tabelas.

## Stack

- **Frontend**: React 18 + TypeScript + Vite
- **Backend**: Vercel Serverless Functions (`api/`)
- **Dados e login**: Firebase (Auth + Firestore; SDK de cliente e Admin SDK)
- **Testes**: Vitest · **CI**: GitHub Actions
- **Leitura de catálogo**: pdfjs-dist, tesseract.js (OCR), papaparse (CSV)

## Decisões técnicas

- **BYOK (traga a sua chave).** O Arbitra não tem chave compartilhada de
  provedor: cada pessoa cadastra as suas na tela **Conta**, e as buscas gastam a
  cota do **próprio** provedor. As chaves ficam em `users/{uid}/secrets/keys`; o
  navegador não as lê de volta — quem chama o provedor é o servidor, que lê a
  chave pelo `uid` do token. Nem um administrador consegue ver o valor.
- **Limite diário aplicado no servidor.** O contador de buscas é gravado só
  pelo servidor, dentro de uma *transaction*, com o dia no fuso de Brasília —
  o cliente não consegue zerá-lo (as regras do Firestore recusam escrita nele).
- **Cobrança desligada, mas preservada.** O código de assinatura (Mercado Pago)
  continua no repositório, dormente atrás de uma chave
  (`BILLING_ENABLED`/`VITE_BILLING_ENABLED`). Com ela desligada, todo usuário
  tem todos os recursos e o único limite é o de buscas por dia.
- **Segurança como parte do projeto.** A auditoria de setembro/2026
  ([docs/auditoria-2026-09.md](docs/auditoria-2026-09.md)) fechou, entre outros, a
  promoção de usuário a admin pelas regras do Firestore, o contador de cota
  editável pelo cliente, a leitura de chaves no navegador e o SSRF no download de
  fotos. A revisão de novembro/2026
  ([docs/seguranca-2026-11.md](docs/seguranca-2026-11.md)) reforçou o SSRF,
  filtrou vazamento de segredo em mensagens de erro e fechou um XSS armazenado na
  rota de fotos. As decisões de arquitetura estão em [docs/adr](docs/adr).

## Pré-requisitos

- Node.js ≥ 20.6 (versão de referência em `.nvmrc`; `nvm use` seleciona a certa)
- Um projeto Firebase (Auth + Firestore) — o plano gratuito basta
- [Vercel CLI](https://vercel.com/docs/cli), para rodar as funções de `api/` localmente

## Como rodar localmente

```bash
git clone <url-do-repositorio>
cd arbitra
npm install
cp .env.example .env
```

Preencha no `.env` as variáveis do **Firebase** (cliente e Admin) — sem elas o
login não funciona e a busca de preço fica bloqueada. As chaves dos provedores
de busca **não vão no `.env`**: cada usuário cadastra as suas no app. O
`.env.example` documenta cada variável, inclusive as do modo gratuito.

Publique as regras e os índices do Firestore (sem isso o histórico e a
biblioteca de catálogos não funcionam):

```bash
npm install -g firebase-tools
firebase login
firebase deploy --only firestore:rules,firestore:indexes
```

Suba o app com as funções de `api/`:

```bash
npm install -g vercel
vercel dev
```

Abre em `http://localhost:3000`. Só `npm run dev` (Vite puro,
`http://localhost:5173`) também serve pra navegar a interface, mas a busca de
preço depende de `api/`, que só sobe com `vercel dev` (ou em produção).

## Como cadastrar suas chaves

Entre no app, abra **Conta** e cadastre pelo menos uma chave. A tela agrupa por
uso e traz, em cada linha, o link de onde criar a chave:

- **SerpApi** — a principal: sozinha já faz a busca por texto e por foto na
  Amazon e no Mercado Livre. Tem plano gratuito mensal.
- **RapidAPI (Amazon)** e **SearchApi.io** — alternativas e reserva.
- **Gemini**, **Mistral** e **NVIDIA** — IAs que reconhecem a foto do produto
  (o **Assistente** usa a Gemini).
- **ScraperAPI** e **Unwrangle** — só valem se as lojas bloquearem a busca.

A chave fica guardada na sua conta e nunca é exibida de novo; só dá pra
substituí-la ou removê-la.

## Limite de buscas

Para o projeto se manter gratuito, cada conta tem **100 buscas por dia**. Uma
"busca" é **um produto em um marketplace** (20 produtos em Amazon e Mercado Livre
= 40). O contador zera à meia-noite, no horário de Brasília, e quem aplica o
limite é o servidor. Ao estourar, a busca é recusada com uma mensagem amigável.
Quem hospeda a própria instância pode mudar o número com a variável
`DAILY_SEARCH_LIMIT` (veja `.env.example`). Reabrir um catálogo já salvo não
gasta busca. Preços buscados há menos de 12 horas voltam do cache (poupa a
chamada ao provedor, mas a busca ainda conta no limite do dia).

## Scripts

| Comando | O que faz |
|---|---|
| `npm run dev` | Vite dev server (só frontend) |
| `vercel dev` | frontend + funções serverless (`api/`) juntos |
| `npm run build` | typecheck completo + build de produção |
| `npm run typecheck` | `tsc --noEmit` no frontend e em `api/` |
| `npm test` | suíte de testes (Vitest) |
| `npm run lint` | ESLint |

## Qualidade

A CI (`.github/workflows/ci.yml`) roda em todo push e PR: typecheck (frontend e
`api/`), lint, testes e build de produção. Os testes cobrem a lógica pura —
cálculo de margem, leitura de catálogo, ranking de resultados, cache, cota,
proteção contra SSRF e os portões de autenticação de cada rota de `api/`.

O lint ainda não bloqueia (`continue-on-error`) e não consegue ler `api/` com
informação de tipo; isso está registrado em
[docs/seguranca-2026-11.md](docs/seguranca-2026-11.md).

## Variáveis que valem a pena conhecer

| Variável | Onde | Pra quê |
|---|---|---|
| `VITE_FIREBASE_*` | cliente (build) | login e Firestore no navegador |
| `FIREBASE_*` | servidor | Admin SDK nas funções |
| `CRON_SECRET` | servidor | autoriza o cron de checagem diária (sem ela a rota recusa tudo) |
| `DAILY_SEARCH_LIMIT` | servidor | limite diário de buscas (padrão 100) |
| `BILLING_ENABLED` / `VITE_BILLING_ENABLED` | servidor / cliente | religar a cobrança (desligada por padrão) |
| `VITE_DONATE_PIX_COPIA_COLA` | cliente (build) | botão "Copiar chave PIX" |

> Toda variável `VITE_*` é lida **no build**: mudar o valor na Vercel só vale
> depois de um novo deploy.

## Apoie o projeto

O Arbitra é gratuito. Se ele te ajudou, dá pra fazer uma **contribuição
voluntária por PIX** em *Configurações → Apoie o projeto* (QR Code ou "copia e
cola"). Contribuir **não libera funções** nem aumenta o limite de buscas.

## Aviso: projeto gratuito, sem garantias

Este é um projeto pessoal, gratuito, oferecido **"como está"**, sem garantia de
funcionamento contínuo, de precisão dos preços encontrados ou de suporte. Os
preços vêm de fontes de terceiros (e a correspondência de produto pode errar —
a tela marca como "aproximado" quando tem dúvida), então **confira o anúncio
antes de comprar**. O uso das chaves de API e dos marketplaces é de responsabilidade
de quem usa. Veja a [política de privacidade](docs/legal/politica-privacidade.md)
e os [termos de uso](docs/legal/termos-de-uso.md).

## Rodando em várias máquinas (Windows/Linux, pen drive exFAT)

Os fins de linha são forçados como LF (`.gitattributes`). No Linux, o exFAT não
aceita os symlinks do `node_modules`; rode uma vez por máquina:

```bash
./scripts/setup-linux-devenv.sh          # monta node_modules fora do pen drive e instala
./scripts/install-linux-automount.sh     # opcional: monta sozinho ao plugar o pen drive
```

O script confere a versão do Node pelo `.nvmrc` antes de instalar.

## Estrutura

```
src/            # frontend (React + TS)
  components/   # telas e componentes de UI
  config/       # planos, cobrança, limite diário, doação
  lib/          # lógica client-side (margem, leitura de catálogo, etc.)
  types/        # contratos compartilhados
api/            # funções serverless (Vercel)
  _lib/         # lógica compartilhada entre as funções
docs/           # auditorias, decisões de arquitetura, notas legais
```

## Créditos

Ideia e validação do produto: [NOME DO AMIGO]

## Licença

Distribuído sob a licença MIT — veja [LICENSE](LICENSE).
