# Arbitra — Revisão de Arquitetura e Roadmap de Melhorias

**Status:** Proposto (análise — nada aqui foi implementado ainda)
**Data:** 2026-07-23
**Deciders:** Nicolas (produto/arquitetura)

## Contexto

Pedido: analisar o projeto inteiro, comparar com produtos do mesmo
estilo no mercado, e levantar melhorias — design (por tela) e,
principalmente, backend. Este documento é um levantamento pra revisão,
não uma implementação — cada item da seção "Roadmap priorizado" vira
trabalho concreto só quando você decidir tocar nele.

Estado atual do projeto: SPA React (Vite) + Firebase (Auth/Firestore) +
funções serverless na Vercel (`api/`), com busca de preço via Google
Shopping (SerpApi), parsing heurístico de catálogo (CSV/PDF), motor de
cálculo de margem configurável, sistema de planos com biblioteca de
catálogos curada por admin, e busca com chave SerpApi própria por
usuário (BYOK, implementado nesta sessão). Testes unitários (vitest) e
CI básico já cobrem os módulos puros — ver "Roadmap priorizado"
abaixo para o que já foi feito desde a versão original deste
documento. Ainda: um único ambiente (sem staging).

## Comparação com produtos do mercado

Pesquisei três ferramentas de arbitragem estabelecidas pra servir de
referência (não é uma lista exaustiva, mas cobre os três perfis mais
comuns: sourcing automatizado, análise pontual via extensão, e
histórico de preço):

| Dimensão | Tactical Arbitrage | SellerAmp | Keepa | **Arbitra (hoje)** |
|---|---|---|---|---|
| Ponto de partida | Escaneia 1000+ varejistas atrás de oportunidade | Extensão — analisa 1 produto/ASIN por vez | Extensão — histórico de 1 produto/ASIN | **Catálogo do PRÓPRIO fornecedor** (upload CSV/PDF) |
| Fonte de preço de mercado | Scraper próprio multi-varejista | Amazon + Walmart/Target/Home Depot | Só Amazon (histórico) | Google Shopping via SerpApi (multi-loja numa chamada) |
| Cálculo de margem/taxas | Sim, embutido | Sim | Não calcula margem, só mostra preço | Sim — motor de regras configurável (taxas, frete, impostos) |
| Histórico de preço ao longo do tempo | Sim | Parcial | Sim (ponto forte) | **Não tem** — só o último preço buscado |
| Modelo de custo | Assinatura ~US$59+/mês | US$16–20/mês | Assinatura | BYOK — cada usuário paga a própria cota SerpApi |
| Multi-usuário / times | Seats pagos | Individual | Individual | Planos + biblioteca compartilhada (recém-implementado) |

**Leitura disso:** nenhum concorrente pesquisado parte de "aqui está o
catálogo que meu fornecedor me mandou" — todos partem de "que produto
no Amazon parece bom pra revender". Isso é o diferencial real do
Arbitra (bate com o nome e com a feature mais robusta do projeto, o
parser de PDF/CSV) — vale tratar como posicionamento central, não como
gap. Em compensação, **ausência de histórico de preço** é uma lacuna de
verdade: hoje o Arbitra só sabe "quanto custa agora", nunca "isso
costuma vender por mais no fim do mês" ou "esse preço caiu 30% ontem" —
informação que o Keepa cobra caro por ter. Ver item de roadmap
correspondente abaixo.

*Fontes: [Top 10 Best Online Arbitrage Software of 2026 (ZipDo)](https://zipdo.co/best/online-arbitrage-software/), [SellerAmp 2026 Review](https://cleartheshelf.com/selleramp-review-a-great-all-round-sourcing-tool/), [Best Online Arbitrage Tools 2026 (ProfitPath)](https://profitpath.com/en/blog/best-online-arbitrage-tools).*

## Melhorias de design (por tela)

### Dashboard
- ~~**Progresso por item durante a busca**: hoje é um spinner genérico
  ("Buscando preço…") sem noção de quantos dos N produtos já foram
  resolvidos~~ **Feito** — busca em lotes de 20 no client com barra
  "X/Y produtos" (ver itens 8+9 do roadmap).
- **Distinção visual mais clara** entre "meu upload" e "biblioteca do
  plano" — hoje são dois painéis parecidos (`historyPanel` reutilizado
  pros dois) empilhados um embaixo do outro; um usuário novo pode não
  entender a diferença de cara.
- **Estado vazio da primeira visita** ainda é só o dropzone — um
  exemplo visual (screenshot ou catálogo de amostra pré-carregado) do
  resultado final ajudaria a comunicar valor antes do primeiro upload.

### Precificação
- **Comparação de cenários lado a lado** (ex: "com ICMS de SP" vs "sem
  ICMS", ou meta de margem 15% vs 25%) — hoje só existe o preview de UM
  cenário ativo por vez.
- **Histórico de mudança de regra**: se você mexer na margem-alvo hoje
  e de novo semana que vem, não há registro de qual regra gerou qual
  resultado passado — dificulta auditoria de "por que esse produto foi
  recomendado em tal data".

### Resultados
- **Paginação de verdade** (já anotado como pendente no
  `design-critique-log.md` — reforçando aqui): catálogos grandes
  renderizam todas as linhas de uma vez.
- **Exportar** (CSV/XLSX) — hoje o resultado só existe dentro do app;
  não dá pra levar pra uma planilha ou mandar pro fornecedor/sócio.
- **Filtro por recomendação** (só "recomendado", só "revisar") além da
  ordenação por coluna que já existe.
- **Ação em lote**: marcar produtos como "ignorar" pra não aparecerem
  de novo nas próximas buscas do mesmo catálogo.

### Conta
- **Caminho de upgrade de plano** inexistente — hoje troca de plano só
  acontece via Admin; a tela Conta nem mostra qual plano você está,
  nem convida a pedir upgrade.
- **Zona de risco**: não existe "excluir minha conta e meus dados" —
  relevante se algum dia isso lidar com dado de terceiro real (LGPD).

### Admin
- **Busca/filtro na lista de usuários** — hoje é uma lista simples sem
  paginação; cresce sem controle conforme a base de usuários cresce.
- **Log de auditoria** de ações administrativas (quem mudou o plano de
  quem, quando) — hoje a troca é silenciosa, sem rastro.
- **Versionamento de catálogo da biblioteca**: reenviar um PDF
  atualizado hoje cria um documento novo em vez de substituir/versionar
  o antigo — a biblioteca pode acumular versões velhas do mesmo
  catálogo sem um jeito fácil de "substituir este".

### Transversal (todas as telas)
- Estados de carregamento são spinners de texto (`Loader2` + string) em
  vez de skeletons — funcional, mas menos polido numa tela com muito
  dado (Resultados, Admin com listas grandes).
- Sem error boundary React — um erro de render em qualquer componente
  quebra a tela inteira em branco, sem fallback amigável.
- Não testado em mobile/tablet além do breakpoint da Sidebar
  (`@media max-width: 720px`) — os `.section`/`.row` das telas novas
  (Admin, Precificação) não foram auditados pra layout estreito.

## Melhorias de backend (foco principal)

### Segurança — a mais importante, recomendo tratar primeiro
- **`/api/fetch-prices` não verifica quem está chamando.** O endpoint
  recebe `{ marketplace, items, apiKey }` no corpo e confia
  cegamente — não há verificação do Firebase ID Token do usuário
  (`getAuth().verifyIdToken()` via Admin SDK). Hoje isso significa: (a)
  qualquer um pode chamar o endpoint diretamente (sem passar pelo
  client) só sabendo a URL; (b) não há como saber, no servidor, QUEM
  de fato fez a chamada — todo log/telemetria futura fica cega quanto
  a usuário. Corrigir exigindo um `Authorization: Bearer <idToken>` e
  validando com o Admin SDK antes de processar.
- **Chave SerpApi do usuário fica em texto puro no Firestore**
  (`user_secrets/{uid}.serpApiKey`). Firestore criptografa em repouso a
  nível de infraestrutura, mas qualquer pessoa com acesso ao Console do
  Firebase do projeto lê a chave de qualquer usuário em texto puro. Pra
  um MVP entre poucas pessoas de confiança isso é aceitável; se o
  produto crescer, vale considerar criptografar client-side antes de
  salvar (com uma chave derivada de algo que o servidor não guarda) ou
  mover pra um secret manager de verdade.
- **Sem rate limiting** em nenhum endpoint — nem por IP, nem por
  usuário. Um bug de loop no client (ou uso malicioso) pode martelar a
  SerpApi (gastando a cota do usuário) ou o Firestore sem nenhum freio.

### Performance / confiabilidade
- ~~Timeout de função serverless não configurado~~ **Feito**:
  `vercel.json` criado com `maxDuration: 300` explícito pra `api/*.ts`.
  Correção sobre o que eu tinha suposto aqui antes: com Fluid Compute
  (padrão hoje), o Hobby já tem default E máximo de 300s (5 min) — não
  é mais o limite baixo de versões antigas da Vercel. Ainda assim, pra
  catálogos muito grandes (concorrência fixa de 5 chamadas simultâneas
  à SerpApi), vale considerar quebrar em lotes menores no client com
  progresso incremental (item 9 do roadmap), já que 300s é também o
  teto do Hobby — não dá pra esticar mais sem virar Pro.
- **`listCatalogUploads` busca TODO o histórico do usuário sem
  paginação/limite** (`catalogHistory.ts`). Cada documento carrega
  linhas + preços + resultados completos — conforme o usuário acumula
  catálogos processados, essa leitura cresce sem teto. Adicionar
  `limit()` + paginação (ou pelo menos um teto de "últimos 50").
- **Sem retry/backoff** nas chamadas à SerpApi
  (`googleShoppingProvider.ts`) — uma falha transitória de rede
  simplesmente descarta aquele produto (`console.warn` e segue),
  silenciosamente reduzindo a taxa de match sem sinalizar isso como
  "falha recuperável" pro usuário.
- **Cache de preço (`market_prices`) usa TTL fixo de 2h pra qualquer
  marketplace/produto** — não diferencia categorias voláteis (ex:
  eletrônicos com preço mudando várias vezes ao dia) de categorias
  estáveis. TTL configurável por marketplace seria mais preciso.

### Qualidade / manutenção
- ~~**Zero testes automatizados.** Pra uma ferramenta que faz cálculo
  financeiro (`marginCalculator.ts`) e parsing heurístico frágil por
  natureza (`parsePdfCatalog.ts`, `textSimilarity.ts`), isso é o maior
  risco de regressão silenciosa~~ **Feito** — 31 testes vitest cobrindo
  `marginCalculator.ts`, `textSimilarity.ts` e `parsePdfCatalog.ts`
  (item 5 do roadmap). Cobertura ainda não inclui os componentes React
  nem os endpoints `api/*.ts` fim-a-fim — só a lógica pura.
- ~~**Sem CI** — não há GitHub Actions rodando typecheck/build a cada
  push~~ **Feito** — `.github/workflows/ci.yml` roda typecheck ×2 +
  `npm test` + `vite build` em todo push/PR contra `main` (item 6).
- **Tipos duplicados entre `src/types` e `api/_lib/types`** — decisão
  consciente e documentada na ADR-0001 (times pequenos, sem monorepo
  ainda), mas vale reconfirmar que ainda vale a pena conforme o projeto
  cresce; é o tipo de débito técnico que financia velocidade agora e
  cobra juros depois.
- **Observabilidade mínima**: só `console.warn`/`console.error`, que em
  função serverless na Vercel é efêmero a menos que encaminhado pra um
  serviço de log. Sem rastreamento de erro (tipo Sentry), sem métrica
  de quanto cada usuário gasta de cota SerpApi ao longo do tempo (além
  do contador diário informativo que já existe).

### Roadmap dos providers (já documentado, reforçando aqui)
- Amazon SP-API real e Mercado Livre OAuth continuam parados (fricção
  de aprovação/KYC, ver README) — SerpApi/Google Shopping é hoje o
  único caminho real. Válido pro estágio atual, mas é uma dependência
  de terceiro única pra toda a funcionalidade core do produto.
- ~~TODO já conhecido: uma busca no Google Shopping retorna várias lojas
  de uma vez, mas hoje Amazon + Mercado Livre juntos disparam 2
  chamadas (uma por marketplace) em vez de aproveitar a mesma resposta
  — dobra o consumo de cota de quem seleciona os dois.~~ **Feito** — ver
  item 15 do roadmap.

## Roadmap priorizado

**Agora (alta prioridade, baixo/médio esforço):**
1. ~~Verificar Firebase ID Token em `/api/fetch-prices`~~ **Feito** (Admin SDK, `api/_lib/verifyAuth.ts`).
2. ~~`vercel.json` com `maxDuration` explícito~~ **Feito** (300s, `api/*.ts`).
3. ~~`limit()`/paginação em `listCatalogUploads`~~ **Feito** (últimos 50, ordenado por `uploadedAt`).
4. ~~Exportar Resultados pra CSV~~ **Feito** (`papaparse`, BOM UTF-8 pra Excel).

**Próximo (esforço médio):**
5. ~~Testes unitários — `marginCalculator.ts`, `textSimilarity.ts`,
   `parsePdfCatalog.ts`~~ **Feito** (vitest, 31 testes — inclui a
   regressão crítica de linha ambígua da Session 3).
6. ~~CI básico (GitHub Actions: typecheck + build a cada push)~~ **Feito**
   (`.github/workflows/ci.yml` — typecheck ×2 + testes + build).
7. ~~Paginação real em Resultados~~ **Feito** (50 linhas/página, reseta ao filtrar).
8. ~~Barra de progresso por item durante a busca~~ **Feito** (junto com o item 9).
9. ~~Chunking de catálogos grandes no client (evitar timeout de função)~~
   **Feito** — lotes de 20 produtos, sequenciais, com progresso real
   (`X/Y produtos`) na tela de Dashboard.

**Depois (maior esforço ou depende de decisão de produto):**
10. Histórico de preço ao longo do tempo (gap real vs. Keepa).
11. Criptografia client-side da chave SerpApi antes de salvar.
12. Observability (Sentry ou equivalente + métricas de uso por usuário).
13. Retomar Amazon SP-API real / Mercado Livre OAuth.
14. Billing real pros planos (hoje é 100% manual).
15. ~~Compartilhar a mesma busca do Google Shopping entre Amazon +
    Mercado Livre (economia de cota)~~ **Feito** — uma chamada por
    produto cobrindo os marketplaces pedidos, ver
    `googleShoppingProvider.ts` e `fetch-prices.ts`.

## Consequências

- **Fica mais fácil**: priorizar conversa com o parceiro sobre o que
  atacar primeiro — a lista acima já vem ordenada por impacto/esforço.
- **Fica mais difícil**: nada aqui foi implementado — é diagnóstico, não
  entrega. Cada item vira trabalho real só quando puxado explicitamente.
- **Precisa revisitar**: os itens de segurança (token verification,
  chave em texto puro) merecem decisão consciente mesmo que a resposta
  seja "aceitável por enquanto, poucos usuários de confiança" — o
  importante é que seja uma escolha, não um ponto cego.
