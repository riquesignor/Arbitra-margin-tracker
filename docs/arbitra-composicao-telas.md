# Arbitra — Composição das telas (referência pra design)

Documento gerado a partir do código-fonte real (React + TypeScript + CSS Modules, sem Tailwind) — reflete o que está implementado hoje, não um mockup. Serve de briefing pra qualquer ferramenta de design gerar telas/protótipos consistentes com a estrutura e o vocabulário visual já existentes.

## O produto, em uma frase

Arbitra é uma ferramenta de arbitragem de preço pra revendedor: o usuário sobe um catálogo (CSV ou PDF) com SKU/nome/custo, escolhe onde comparar (Amazon, Mercado Livre, busca por foto), e a ferramenta devolve o preço de mercado encontrado e a margem calculada por produto, com recomendação (recomendado/revisar/evitar).

## Estrutura de navegação

Barra superior fixa (`TopNav`, sempre escura, independente do tema claro/escuro do resto do app) com: marca (ícone + "Arbitra") à esquerda; 6 itens de navegação principal ao centro (ícone + label, item ativo com fundo destacado); à direita — toggle de tema (sol/lua), botão de Configurações, indicador "online" (ponto verde + texto), item Admin (só se `isAdmin`), botão de conta (avatar + nome extraído do email + chevron).

Itens de navegação, nesta ordem: **Início** (home) · **Nova busca** (dashboard) · **Precificação** (pricing) · **Resultados** (results, com badge numérico de contagem quando há resultados) · **Meus produtos** (portfolio) · **Fornecedores** (suppliers).

Conta e Configurações ficam fora da nav principal, no cluster da direita. Abaixo da TopNav, uma área de conteúdo central com largura máxima (`--content-max`: 1180px, sobe pra 1440px/1680px em telas grandes) e troca de tela com fade + leve deslocamento vertical (framer-motion, 0.2s).

Obs.: existe um componente `Sidebar.tsx` (+ `.module.css`) no código, mas não é mais importado em lugar nenhum — é layout legado de uma versão anterior (a barra lateral foi substituída pela TopNav horizontal). Ignorar para novo design.

## Tokens de design (já implementados em `src/styles/tokens.css`)

**Tipografia**: Archivo (display + corpo, pesos 400/500/600 — nunca 700/bold em UI) e JetBrains Mono pra todo dado numérico (preço, margem, SKU, cota, data, contagem). Escala: display 32px · title 26px · card 13.5px · body 13px · sm 12px · xs 11.5px · label 11px — multiplicada por um fator de escala (0.93 compacto / 1 padrão / 1.14 grande, escolhido em Configurações).

**Raios**: 2px uniforme em tudo (decisão deliberada — "8px uniforme lia como template"). Pill (999px) só em contador de nav e trilho de toggle.

**Sombra**: nenhuma superfície estática usa sombra — hierarquia é feita com borda/fundo, não elevação.

**Espaçamento**: escala em `--space-1` (4px) até `--space-8` (64px), também escalada pelo fator de tamanho de texto.

**Cor — modo claro** (papel quente, não cinza-frio): fundo `#efeee9`, fundo elevado `#ffffff`, texto `#16191d`, texto secundário `#5c6167`, borda `#e2e0da`. Acento padrão ("Aço") `#35577a` / hover `#24405c`. Success `#2c6a46`, warning `#8a5d14`, danger `#9b3b34` — cada um com variante "dim" (fundo tênue) e "border" pra badges.

**Cor — modo escuro**: fundo `#15130f`, fundo elevado `#1c1a16`, texto `#ece9e2`. Acento `#7fa3c9`. Mesma estrutura de success/warning/danger, tons ajustados.

**Chrome (TopNav)**: sempre escuro em qualquer tema — `#15181c` de fundo, texto branco — eixo independente do restante do app.

**Paletas de acento alternativas** (Configurações → Aparência, trocam só o acento, nunca os neutros/status): Aço (padrão, `#35577a`) · Petróleo (`#1f5f5b`) · Índigo (`#474c88`) · Terracota (`#8a4a2f`). Todas com contraste AA medido sobre o papel claro.

**Recomendação de cor semântica** (badges/status usados em várias telas): `recomendado` = success (verde) · `revisar` = warning (âmbar) · `evitar` = danger (vermelho) · `sem_custo` = neutro.

## Tela: Início (Home)

**Rota interna**: `home` — landing screen padrão ao logar.

Layout: hero full-width no topo → grid de "Como funciona" (3 passos) → duas colunas (conteúdo principal + aside).

- **Hero card**: saudação dinâmica por hora do dia ("Bom dia/Boa tarde/Boa noite" + primeiro nome extraído do email) + data por extenso à esquerda; à direita, 3 estatísticas empilhadas (catálogos processados / produtos precificados / margem mediana do mês). Dois CTAs: botão primário "Nova busca" (ícone +) e botão secundário "Ver último resultado" (só aparece se há histórico).
- **Card "Como funciona"**: 3 colunas com ícone + número (01/02/03) + título + texto curto — Suba o catálogo / Escolha onde comparar / Leia a margem.
- **Coluna principal — "Suas buscas"**: lista das 5 buscas mais recentes (cada linha: ícone de arquivo + nome do arquivo, marketplaces usados, "N/total com preço", margem mediana daquela busca) — cada linha é clicável e abre direto em Resultados. Link "ver todas (N)" quando há mais de 5. Estado vazio: texto convidando a usar Nova busca.
- **Aside — "Catálogos disponíveis"**: biblioteca compartilhada pelo admin, filtrada pelo plano do usuário (badge "plano X" no cabeçalho). Cada item: nome do arquivo, contagem de produtos, botão "usar" que manda direto pra Nova busca já processando.
- **Aside — card de chave**: aviso compacto (ok/warning) sobre status da chave SerpApi, com link "Gerenciar chave" pra Conta.

## Tela: Nova busca (Dashboard)

**Rota interna**: `dashboard` — é a etapa operacional (upload + configuração + execução da busca), não mais a tela de chegada.

Layout: cabeçalho com card de status à direita → duas colunas (conteúdo principal numerado 01/02/03 + aside de apoio).

- **Cabeçalho**: título "Bancada de precificação" + subtítulo; card de status mostrando fonte ativa (label do provider) e, quando aplicável, plano + contagem de buscas hoje.
- **Card 01 — "Qual API usar"**: grid de cards selecionáveis (ícone + label), um por provider de busca disponível: Motor interno (Arbitra) · SerpApi (Google Shopping) · Amazon direto (RapidAPI) · Mercado Livre (API pública) · Busca por imagem (Google Lens) · Busca por imagem (SearchApi.io) · Motor interno + IA (Gemini). Card ativo com ícone destacado e checkmark. Abaixo, dependendo do provider escolhido: (a) se é modo imagem, uma sub-linha de chips pra trocar entre as 3 variantes de busca por foto + texto explicativo; (b) se é motor interno puro, nota explicando cobertura/limitação; (c) se o provider cobre mais de um marketplace, um segundo grid de seleção (checkbox visual) pra escolher Amazon e/ou Mercado Livre.
- **Card 02 — "Catálogo"**: dropzone de upload (arrastar ou clicar), aceita .csv/.pdf, com texto de instrução. Se for PDF, abre um painel de seleção de intervalo de páginas (inputs "página inicial"/"página final" + contagem total de páginas do arquivo) antes de processar — com aviso extra se o modo imagem estiver ativo (vai renderizar cada página como foto). Rodapé condicional do card mostra, conforme o estado: spinner "Lendo catálogo…", barra de progresso "Buscando preço (X/Y produtos)", mensagem de erro, oferta de fallback (tentar de novo com chave alternativa), aviso de catálogo já processado antes (com botão "Reprocessar mesmo assim"), aviso de linhas ignoradas por ambiguidade, ou aviso de pré-requisito faltando (login/chave).
- **Card 03 — "Catálogos processados"** (só logado): tabela compacta do histórico (arquivo, N/total com preço, marketplaces, data, botão excluir) — linha clicável carrega aquele resultado.
- **Aside — "Pré-requisitos"**: checklist de 3 itens (conta conectada / chave própria cadastrada / marketplace escolhido), cada um com ícone check verde ou alerta laranja.
- **Aside — "Cota diária"** (só quando aplicável ao provider ativo): barra de progresso da cota SerpApi do dia, muda de cor perto do limite.
- **Aside — "Velocidade por mecanismo"**: barras horizontais comparando ms médio por produto entre os providers já usados nesta sessão/navegador.
- **Aside — "Seu histórico"**: 3 linhas de estatística (catálogos processados / última busca / marketplaces usados).

## Tela: Precificação (PricingConfig — "Simulador de precificação")

**Rota interna**: `pricing`.

Layout: cabeçalho com card de status + seletor de histórico → grid de 4 cards de estatística → duas colunas (formulário de regras + aside com preview/gráficos).

- **Cabeçalho**: título + subtítulo ("ajuste e veja o efeito na hora"); card de status (quantos produtos sendo simulados, meta atual); dropdown "ver busca" pra trocar qual resultado salvo alimenta a simulação.
- **Stats row** (4 cards): margem mediana / recomendados (N de total) / lucro médio por venda / carga sobre a venda (%).
- **Coluna principal, cards em sequência**:
  - **Meta** (card com destaque visual/borda de acento): margem alvo (%) e preço mínimo/floor (R$) — os dois números que o sistema otimiza.
  - **Taxas de marketplace**: lista de linhas, cada uma com toggle liga/desliga + nome + valor calculado (R$) + input de taxa (%).
  - **Frete por faixa de custo**: lista de faixas fixas (não editáveis no limite, só no valor), tag "aplicado no preview" na faixa que está sendo usada no exemplo ao lado.
  - **Impostos**: mesmo padrão de linha com toggle da seção de taxas, com estado/UF no label.
  - Rodapé: nota "salvo automaticamente" + botão "Restaurar padrão".
- **Aside**:
  - **Preview ao vivo**: nome do produto de exemplo (real do último catálogo, ou ilustrativo com tag "exemplo"), barra de custo empilhada e colorida (Produto/Taxas/Frete/Impostos/Lucro) com legenda, resultado final em destaque (margem % grande, verde se positiva).
  - **"Se o preço mudar"** (gráfico de linha SVG): curva de margem simulada de −30% a +40% do preço atual, linha pontilhada na meta e no zero, legenda com o ponto de break-even.
  - **"Impacto no catálogo"**: barra empilhada (recomendado/revisar/evitar) + histograma de 6 faixas de margem (<0%, 0–10%, 10–20%, 20–30%, 30–50%, 50%+).

## Tela: Resultados (ResultsTable)

**Rota interna**: `results` — é a tela mais "densa" do produto, tabela como elemento central.

Layout: cabeçalho → 4 cards de KPI → card de distribuição (opcional) → painel com controles + tabela + paginação.

- **Cabeçalho**: título "Resultados" + subtítulo; card de status (fonte dos dados: "servidor (cache)" ou "direto no navegador"; meta de margem); seletor de histórico.
- **KPI row** (4 cards, ícone + valor + label): Total de SKUs / Recomendados / Margem mediana / A evitar.
- **Distribuição de margem** (card opcional, toggle em Configurações): 6 colunas de histograma com contagem e barra vertical.
- **Painel de tabela**:
  - Controles: campo de busca (SKU/produto), 5 botões de filtro por status (Todos/Recomendado/Revisar/Evitar/Sem custo), botão "Exportar CSV".
  - Texto "Mostrando X–Y de Z (filtrado de N)".
  - **3 modos de visualização** (conforme preferências): **flat** (1 linha por oferta, colunas ordenáveis: Custo/Preço/Margem/Confiança); **lado a lado** (1 linha por SKU, 1 coluna de preço por marketplace + coluna de diferença, quando 2+ marketplaces buscados); **agrupado** (1 linha por SKU com a melhor oferta, chevron pra expandir as demais ofertas do mesmo produto).
  - Cada linha: thumbnail do produto (ou placeholder), SKU, nome do produto (com tag "Aproximado" quando o match não é exato) + link "Ver anúncio", marketplace, custo, preço, barra de margem (`MarginBar` — trilho horizontal com eixo zero sólido, eixo meta tracejado, preenchimento colorido por status) + valor percentual, confiança (%), badge de status colorido + badge de concorrência (coroa se elegível ao "ganha-compra"/Buy Box, senão ícone de pessoas + contagem).
  - Paginação (50 itens/página): botões Anterior/Próxima + "Página X de Y".
  - Estado vazio: mensagens diferentes pra "nunca processou nada", "buscou mas não achou preço nenhum" (com explicação técnica extensa sobre causas prováveis) e "filtro atual não bate com nada".

## Tela: Meus produtos (Portfolio)

**Rota interna**: `portfolio` — agregação de todo SKU já buscado, entre buscas diferentes (portfólio, não busca isolada).

Layout: cabeçalho → 4 cards de resumo → painel com busca + tabela + paginação.

- **Cabeçalho**: título "Meus produtos" + subtítulo explicando o conceito de agregação/tendência.
- **Summary row**: Produtos acompanhados / Preço subiu (verde) / Preço caiu (vermelho) / Recomendados agora.
- **Tabela**: thumbnail, SKU, produto + link, marketplace, preço atual, **tag de tendência** (seta pra cima/baixo + delta em R$, ou "estável", ou "1ª busca" quando não há comparação anterior), margem, status (mesmo badge de Resultados), "última busca" (relativo: hoje/ontem/há Nd/há Nm).
- Estado vazio: ícone de caixas + texto convidando a processar um catálogo.

## Tela: Fornecedores (SupplierCompare)

**Rota interna**: `suppliers` — compara custo de aquisição entre diferentes catálogos de fornecedor (cada arquivo processado = um fornecedor).

Layout: cabeçalho → 3 cards de resumo → painel com busca + lista de linhas (não é tabela tradicional).

- **Cabeçalho**: título "Comparar fornecedores" + aviso de que o match é por NOME (não há SKU comum entre fornecedores).
- **Summary row**: Fornecedores comparados / Produtos em comum / Economia média (%, mais barato vs. mais caro).
- **Lista**: cada linha = thumbnail + nome do produto + chips de oferta (um por fornecedor, com nome do arquivo + preço, o mais barato destacado visualmente) + badge de economia (seta pra baixo + %, tooltip com o preço mais caro).
- Dois estados vazios distintos: menos de 2 catálogos processados (não dá pra comparar) vs. 2+ catálogos mas sem produtos em comum reconhecidos (explica a limitação do match por texto).

## Tela: Conta (Account)

**Rota interna**: `account` — tem dois estados de layout completamente diferentes.

**Deslogado**: duas colunas — pitch à esquerda (título + subtítulo + 3 benefícios com ícone) e card de autenticação à direita (tabs Entrar/Criar conta, campos email/senha, botão primário, hint, erro inline).

**Logado**: cabeçalho (card mostrando "conectado como" + botão sair) → duas colunas.

- **Coluna principal — 5 cards de chave BYOK**, todos no mesmo padrão (ícone chave + título + badge "configurada"/"não configurada" + texto intro com link de cadastro externo + form compacto: input password + botão Salvar + botão remover quando já configurada): **SerpApi** · **RapidAPI (Amazon)** · **SearchApi.io** · **Gemini (motor interno + IA)** · **Unwrangle (Mercado Livre alt.)**.
- **Card "Uso diário de busca"**: número grande do dia + gráfico de barras dos últimos 14 dias (só a barra de hoje é dado real, resto é ilustrativo, com aviso explícito disso).
- **Card "Preferências opcionais"**: 5 toggles (usar somente minha chave / avisar aos 80% de cota / reaproveitar resultado recente / notificar ao concluir busca / guardar histórico por 90 dias), cada um com título + descrição curta.
- **Aside**: card "Seu plano" (nome, preço, descrição, infos de cota/troca de plano) + card "Dados da conta" (email, uid em mono, permissão, link sair).

## Tela: Configurações (Settings)

**Rota interna**: `settings` — layout de navegação lateral interna (4 seções) + corpo.

- **Nav lateral**: Aparência · Personalização · Pagamento · Dados da conta (ícone + label, item ativo destacado).
- **Aparência**: card "Paleta" (grid de 4 opções, cada uma com 3 swatches de cor + label + contraste medido + check quando ativa); card "Tamanho do texto" (3 opções: Compacto/Padrão/Grande, cada uma mostrando "Aa" no tamanho real); card "Modo" (3 botões: Claro/Escuro/Sistema).
- **Personalização**: 4 toggles (gráficos em Precificação / gráficos em Resultados / comparar mecanismos lado a lado / agrupar ofertas por SKU).
- **Pagamento**: card com badge "em preparação", texto explicando que cobrança ainda é manual (via Admin), grid de infos (plano atual, forma de pagamento —, próxima cobrança —), botão desabilitado "Gerenciar assinatura".
- **Dados da conta**: card "Trocar senha" (3 campos + botão), card "Trocar email" (mostra email atual, expande formulário sob demanda, exige confirmação de senha), card "Excluir conta" (visual de perigo/vermelho, aviso de irreversibilidade, exige senha pra confirmar), link "sair desta conta".

## Tela: Admin

**Rota interna**: `admin` — só visível/acessível com `profile.isAdmin`; mostra tela de acesso negado caso contrário.

Layout: cabeçalho → 4 stats → card de diagnóstico full-width → duas colunas (conteúdo numerado 01/02/03 + aside).

- **Cabeçalho**: título "Central de administração" + card "administrador" com email.
- **Stats row**: contas (+ quantas são admin) / catálogos na biblioteca (+ quantos sem plano atribuído) / produtos indexados / planos ativos.
- **Card "Diagnóstico de configuração"** (full-width, com botão de recarregar): 3 linhas de check/x — ScraperAPI configurada, OAuth Mercado Livre configurado, Firebase Admin configurado — cada uma com explicação de uma linha; nota final listando quais providers são BYOK-only.
- **Card 01 — "Publicar catálogo na biblioteca"**: upload de PDF (parse no navegador), depois de processado mostra rascunho (nome + contagem de produtos + linhas ignoradas) com chips de seleção de plano (multi-select) e botão salvar.
- **Card 02 — "Biblioteca compartilhada"**: tabela (arquivo, produtos, chips de plano toggleáveis por linha, botão excluir).
- **Card 03 — "Contas e permissões"**: barra de filtro (busca por email/uid + toggle "só admins") + tabela expansível (conta+uid, data de entrada, dropdown de plano, toggle admin) — linha expande pra mostrar detalhe sob demanda (busca hoje, chave SerpApi cadastrada ou não, últimos catálogos processados por aquele usuário).
- **Aside**: "Contas por plano" (barra horizontal por plano, com contagem de catálogos liberados); "Novas contas" (gráfico de barras verticais, 6 meses, dado real de `createdAt`); card de alerta condicional "Precisa de atenção" (quando há catálogo sem plano atribuído); "Planos" (lista simples nome + preço + descrição).

## Componentes compartilhados entre telas

- **`ProductThumb`**: thumbnail 1:1 do produto ou ícone de placeholder (imagem quebrada/ausente) — usado em Resultados, Portfolio, Fornecedores.
- **`CompetitionBadge`**: badge pequeno com ícone (coroa = elegível ao "ganha-compra", pessoas = não elegível) + contagem de concorrentes.
- **`ApproximateBadge`**: tag de aviso (triângulo + "Aproximado") quando o match de produto não é exato ou veio de loja diferente da pedida.
- **`MarginBar`**: barra horizontal de spread com eixo zero (linha sólida) e eixo meta (linha tracejada), preenchimento colorido conforme recomendação.
- **Badge de recomendação**: 4 estados de cor — recomendado (verde) / revisar (âmbar) / evitar (vermelho) / sem_custo (neutro) — reaproveitado em Resultados, Portfolio e indiretamente em Precificação (contagens).
- **Card de estatística**: padrão repetido em quase toda tela (ícone opcional + valor grande + label pequeno + rodapé opcional) — Home, Dashboard, Precificação, Resultados, Portfolio, Fornecedores, Admin todos usam essa mesma unidade visual.
- **Seletor de histórico**: dropdown "ver busca" presente em Precificação e Resultados, mesma formatação de label (nome do arquivo + data/hora).
