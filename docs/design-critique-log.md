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
- Sessions futuras (Conta, outras) a registrar aqui.
- Paginação de verdade em Resultados (hoje só mostra a contagem, ainda
  não corta em páginas) — considerar se catálogos crescerem muito além
  de ~200 SKUs.
- Otimização de cota da SerpApi: compartilhar a mesma busca entre
  Amazon e Mercado Livre quando os dois estão selecionados (ver TODO em
  `googleShoppingProvider.ts`).
