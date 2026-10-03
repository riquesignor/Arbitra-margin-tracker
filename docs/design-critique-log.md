# Arbitra — Log de critique de design

Registro incremental das sessões de revisão visual, pra consolidar antes
de implementar as mudanças. Cada sessão corresponde a uma tela revisada.

## Session 1 — Dashboard

**Problema central**: tela comunica "formulário administrativo", não
"ferramenta de arbitragem de preço". Zero prova de valor/dado real
visível na primeira tela; mais de 50% da área fica vazia.

Ausências prioritárias:
1. Nenhum KPI/stat visível (economia, oportunidades, margem média).
2. Histórico de uploads (`catalog_uploads`, já existe no Firestore) não
   aparece na UI — usuário não vê o que já processou sem reprocessar.
3. Chips de marketplace sem ícone/cor de marca — só texto.
4. Cards de passo (01/02/03) sem ícone, só número.
5. Sem selo de "dado ao vivo" / fonte da busca.

Outras notas:
- Toggle de marketplace (check + borda + glow) é o ponto forte — mantém.
- Contraste do subtítulo e do texto de ajuda do dropzone: verificar,
  parecem no limite sobre o fundo quase preto.

## Session 2 — Precificação

**Problema central**: mesma estrutura de card reutilizada de forma
consistente (bom), mas é uma tela que define regras financeiras sem
nenhum feedback visual do efeito delas — a promessa do subtítulo
("recalcula na hora") não tem nenhum "na hora" visível na própria tela.

Ausências prioritárias:
1. **Sem preview ao vivo do impacto** — maior gap. Um mini-exemplo
   (SKU de amostra) mostrando margem antes/depois ao mexer nos campos
   resolveria a lacuna entre "recalcula na hora" (texto) e o usuário
   ver isso de fato sem sair da tela.
2. **Sem rollup visual do custo total** — a tela define 4 componentes
   de custo (taxa referência, taxa fechamento, frete, ICMS) que somam
   em `totalCost` no `marginCalculator.ts`, mas não existe nenhum
   resumo/gráfico (barra empilhada, por exemplo) mostrando como eles
   se somam.
3. **Card "Meta" sem destaque visual** — é o número mais importante da
   tela (o que o sistema otimiza), mas tem o mesmo peso visual que
   qualquer outro card, e fica por último.
4. Mesmo problema de espaço vazio do Session 1 — coluna de conteúdo
   ~35% da largura, resto solto.
5. Sem callout ligando "mudar regra aqui" a "isso afeta os cálculos já
   feitos no Dashboard/Resultados".

Ambiguidades de usabilidade a esclarecer:
- Toggle "desligado" numa taxa: não fica claro se isso remove ela do
  cálculo (sem tooltip/help text) — em config financeira, vale deixar
  explícito.
- Faixas de frete (`Até R$50`, `Até R$150`): não está claro se o limite
  da faixa é editável ou só o valor do frete — o texto secundário
  ("até R$ 50.00") duplica o label sem indicar se é editável.
- Nenhum "restaurar padrão" caso o usuário bagunce a configuração.

Outras notas:
- Padrão de card (ícone + label caps) consistente com Session 1 — bom.
- Inputs numéricos (borda fina, fundo escuro, unidade fora da caixa)
  consistentes entre si dentro da tela.
- Verificar contraste do texto secundário das faixas de frete (cinza
  claro sobre fundo escuro) — mesmo risco já sinalizado no Session 1.

## Session 3 — Resultados

**Problema central**: primeira tela que realmente parece "ferramenta de
arbitragem" (cards de KPI, tabela densa, badges de status) — grande
salto em relação às sessões 1-2. Mas o conteúdo da tabela está
comprometido: nomes de produto vêm concatenados/corrompidos
(ex: "30PCS/CX Unid.CX: 24PCS/CX Unid.CX: 32,00 5 0PCS/CX Unid.CX:23,00"),
o que destrói a confiança na tela inteira antes mesmo de avaliar o
visual. Isso é sintoma do heurístico de extração de PDF (`parsePdfCatalog.ts`)
juntando células/linhas de tabela erradas — não é bug de layout, é
qualidade de dado que aparece na tela.

Achados críticos (dado, não só visual):
1. **Nomes de produto corrompidos** — coluna PRODUTO ilegível em várias
   linhas visíveis. Prioridade máxima, acima de qualquer ajuste visual.
2. **Confiança fixa em 50% em todas as linhas visíveis** — se for
   sempre o mesmo valor, a coluna não carrega informação real e passa
   a impressão de número fabricado.
3. **Margem média 2870.2%** — implausível pra arbitragem real; sem
   proteção contra outlier (uma linha com dado ruim contamina o KPI
   principal da tela).

Ausências/gaps visuais:
1. Sem ordenação por coluna (Margem/Spread) — tabela existe pra
   priorizar o que agir primeiro, e não dá pra ordenar.
2. Sem indicação de paginação/quantas linhas faltam (183 total, scroll
   contínuo sem "mostrando X de 183").
3. Truncamento ausente na coluna PRODUTO — nome longo (ainda mais
   corrompido) estica a altura da linha sem elipse/tooltip.
4. Mesmo espaço morto à direita da tabela (~1050px de conteúdo num
   viewport de ~1900px) — aqui dava pra aproveitar pra coluna PRODUTO
   mais larga em vez de ficar vazio.

O que funciona bem:
- Cards de KPI (SKUs/Recomendados/Margem média/Fonte) reaproveitam o
  padrão do Dashboard — primeira tela que de fato entrega a "prova de
  valor" que faltava no Session 1.
- Badges de status com texto (não só cor) — acessível.
- "Ver anúncio" por linha — resolve o gap de "sinal de dado ao vivo"
  apontado no Session 1.
- Badge de contagem (183) no item "Resultados" da sidebar — detalhe
  fino, reflete estado real.

## Session 4 — Início (Home)

**Problema central**: o olho vai direto pro "-288.9%" em vermelho no
canto superior direito (`heroStats` em `Home.tsx`, linha 171) — não pro
CTA "+ Nova busca", que deveria ser o foco. Primeira reação é de alarme
("algo quebrou?"), não de orientação. Hierarquia visual invertida: o
número mais alarmante da tela compete com a ação principal sem nenhum
contexto que explique por que está tão negativo.

Achados críticos:
1. **`medianMargin` (linha 173) exibida sem nenhum tooltip/link/contexto**
   — um valor como -288.9% sem explicação faz o usuário achar que o
   produto está quebrado logo na primeira tela. Mesma classe de problema
   já sinalizado no Session 3 pra margem média de Resultados (lá era
   outlier contaminando a média; aqui pode ser o mesmo tipo de dado ruim
   se propagando pro resumo da Home) — vale checar se straightforward é
   dado real ou herda o mesmo bug de origem.
2. **Card "Catálogos disponíveis" é beco sem saída pra plano pago**
   (linha 256-259): `"Nenhum catálogo liberado pro seu plano ainda — o
   admin adiciona pela tela Admin."` — sem botão/link de ação nenhum.
   Usuário Pro pagando e vendo isso sem next-step próprio é fricção séria.
3. **"Nova busca" duplicado** — existe no menu superior E como botão
   primário no hero (linha ~150-157) — redundância que não ajuda em nada.

Ausências/gaps visuais:
1. Bloco "Como funciona" (linha 180-194) aparece pra qualquer usuário,
   inclusive quem já tem histórico real — compete por espaço com
   "Suas buscas", que importa mais pra quem é recorrente. Mesmo raciocínio
   do Session 1: esconder/colapsar depois do primeiro catálogo processado.
2. Ícones da barra superior (tema, engrenagem, "?", indicador "online")
   sem rótulo visível — tooltip no hover resolve.
3. Card verde de sucesso (chave SerpApi ativa, linha ~282+) fica
   embaixo do card de beco-sem-saída do plano Pro — a informação boa
   devia ter mais destaque, não menos.

O que funciona bem:
- `recentRow` (linha 220) é um `<button>` cobrindo a linha inteira —
  boa prática de affordance, já correto, só confirmando.
- "Resultado guardado não gasta busca nova — reabrir um catálogo é de
  graça." (linha 241) — ótimo UX writing, antecipa a dúvida de cota.
- Saudação personalizada com data cria calor humano sem exagerar.
- CTA primário "+ Nova busca" tem bom contraste e está na posição certa.
- Cards de passo (01/02/03) com ícone — resolve o gap "sem ícone" que
  o Session 1 apontou pro Dashboard.

## Session 5 — Nova busca (Dashboard, parte 2: seletor de API + sidebar)

Continuação do Session 1 (mesmo componente, `Dashboard.tsx`/
`Dashboard.module.css`) — aquela sessão cobriu KPI/histórico/ícones de
chip (já implementados, visíveis e funcionando nesta captura); esta olha
o bloco "01 Qual API usar" e a sidebar (Pré-requisitos/Cota/Velocidade/
Histórico), não cobertos antes.

**Problema central**: o card "01 Qual API usar" empilha duas decisões
distintas (qual motor de busca, e em quais marketplaces comparar) com o
MESMO componente visual pros dois — mesmo grid, mesmo destaque azul,
mesmo check (`styles.marketplaceCard`/`marketplaceCardActive`, linhas
~2058 e ~2155). O problema é que são interações diferentes: motor é
seleção única (`selectProvider`, troca a anterior) e marketplace é
múltipla (`toggleMarketplace`, soma). Visualmente idênticos, sem nenhuma
pista (radio vs. checkbox, ou cor/formato diferente) de que um substitui
e o outro acumula.

Achados:
1. **Rótulo cortado em "Velocidade por mecanismo"** (`Dashboard.module.css`
   linha 958: `grid-template-columns: 84px minmax(0, 1fr) 44px`) — 84px
   fixos pra rótulos como "Motor interno + IA (Gemini)" (`Dashboard.tsx`
   linha 201). O `text-overflow: ellipsis` está correto (linha 967), o
   problema é só a largura da coluna: a reticência aparece cedo demais
   e quase nenhuma informação sobrevive ("Motor intern…"). Widen a
   coluna ou quebra em 2 linhas (label em cima, barra embaixo).
2. **Seleção única e múltipla com o mesmo visual** (acima) — dar um
   tratamento distinto (ex: radio real pros motores, ou pelo menos ícone
   de "escolha uma opção" vs "marque quantas quiser" na legenda).
3. **"ms" cru sem formatação** (`Dashboard.tsx` linha 2686:
   `{Math.round(s.avgMsPerItem)}ms`) — "12048ms" é mais difícil de ler
   que "12,0s" ou "12.048 ms". Resto do app formata número grande com
   separador (ex: `totalProdutos.toLocaleString("pt-BR")` na Home).
4. **Dado duplicado entre "03 Catálogos processados" (corpo) e "Seu
   histórico" (sidebar)** — os dois usam `uploadHistory.length`
   (linha ~2483 e 2705) pra mostrar basicamente a mesma contagem em
   dois cards separados, em posições opostas da tela.
5. **"Pré-requisitos" (linha 2550) só aparece com os 3 itens já ✓** —
   nesta captura ocupa espaço permanente sem exigir nenhuma ação; faz
   mais sentido como checklist que algo recolhe/resume ("tudo certo ✓")
   depois de satisfeito, do que uma seção sempre expandida.
6. **Legenda "onde comparar (...)" em caixa alta** (`.subGroupLabel`,
   `Dashboard.module.css` linha 425-433: `text-transform: uppercase`) —
   a classe tem cara de rótulo curto (tipo "SENHA" nos forms), mas aqui
   carrega uma frase inteira com parêntese. Caixa alta prejudica leitura
   de frases longas; reservar esse estilo pra rótulos de 1-3 palavras.

O que funciona bem:
- Seção "01/02/03" numerada é consistente com "Como funciona" da Home —
  o mesmo padrão de numeração se repete entre telas, reforça o fluxo.
- `MULTI_MARKETPLACE_PROVIDERS.has(searchProvider)` (linha 2143) esconde
  o seletor de marketplace certinho quando o motor só cobre um — não é
  bug, já tratado (hipótese inicial descartada ao ler o código).
- Aviso de BYOK ("Este mecanismo roda com a sua chave...", linha
  2128-2142) aparece no momento certo (ao escolher o motor, não só
  depois de falhar) — já é o fix documentado no comentário do próprio
  código (onboarding corrigido em set/2026).
- "Cota diária" com fração clara (0/500) e nome do plano — mesmo padrão
  bom já visto noutros cards de uso/cota.
- Dropzone com formato aceito explícito no texto de apoio — evita
  upload que vai falhar silenciosamente.

## Implementado (rodada 1 — todas as sessões acima)

Nova paleta em `src/styles/tokens.css`: preto + um único acento
(azul-aço), sem gradiente teal→ciano; modo claro (branco/preto)
adicionado com toggle na Sidebar (`src/lib/theme.ts`, persistido em
localStorage).

**Session 1 (Dashboard)**:
- KPI row (catálogos processados / última busca / marketplaces usados)
  quando logado e com histórico.
- Painel "Catálogos recentes" (lê `listCatalogUploads`), clicável pra
  carregar direto em Resultados.
- Ícones nos chips de marketplace (Store/ShoppingBag) e nos cards de
  passo (Upload/Search/Calculator).
- Nota "Preço buscado via Google Shopping..." como selo de dado ao vivo.

**Session 2 (Precificação)**:
- Painel "Preview ao vivo": recalcula margem de um produto real (1º do
  último catálogo) ou exemplo ilustrativo, a cada mudança de regra.
- Barra de rollup de custo (Produto/Taxas/Frete/Impostos) proporcional
  ao preço de venda.
- Card "Meta" movido pro topo com destaque visual (borda/fundo de acento).
- Tooltip nos toggles explicando o efeito de desativar.
- Texto da faixa de frete trocado por "faixa fixa — só o valor do frete
  é editável" (resolve a ambiguidade).
- Botão "Restaurar padrão".

**Session 3 (Resultados)**:
- **Fix crítico de dado**: `parsePdfCatalog.ts` agora descarta (não
  corrompe) linhas com mais de um preço detectado — provável mescla de
  colunas — e reporta a contagem de linhas ignoradas no Dashboard.
- Confiança deixou de ser fixa: `api/_lib/textSimilarity.ts` calcula
  similaridade real entre nome do catálogo e título do anúncio; o
  provider escolhe o candidato mais parecido, não o primeiro da lista.
- KPI de destaque trocado de média pra **mediana** (`median()` em
  `marginCalculator.ts`) — não é mais distorcido por outlier.
- Colunas Custo/Preço/Margem/Confiança ficaram ordenáveis (clique no
  cabeçalho).
- "Mostrando X de Y" acima da tabela.
- Nome do produto trunca com ellipsis + tooltip com o texto completo.
- Container mais largo (960px → 1180px), aproveitando o espaço que
  antes ficava vazio.

## Pendente
- Sessions 4 (Início) e 5 (Nova busca, parte 2) acima ainda não entraram
  em "Implementado" — ficam pendentes até rodar a próxima leva.
- Sessions futuras (Conta, outras — mais telas a caminho) a registrar
  aqui conforme forem chegando.
- Paginação de verdade em Resultados (hoje só mostra a contagem, ainda
  não corta em páginas) — considerar se catálogos crescerem muito além
  de ~200 SKUs.
- Otimização de cota da SerpApi: compartilhar a mesma busca entre
  Amazon e Mercado Livre quando os dois estão selecionados (ver TODO em
  `googleShoppingProvider.ts`).
