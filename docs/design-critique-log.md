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

## Session 6 — Precificação (parte 2: KPIs, Preview ao vivo, Impacto no catálogo)

Continuação do Session 2 (`PricingConfig.tsx`/`PricingConfig.module.css`)
— aquela sessão já foi implementada (preview ao vivo, rollup de custo,
card Meta em destaque, restaurar padrão, todos visíveis e funcionando
nesta captura). Esta olha a linha de KPIs e o card "Impacto no
catálogo", não cobertos antes. Pedido extra do usuário: pensar em
elementos que e-commerce/analytics faz bem.

**Problema central**: a tela tem DUAS formas de mostrar "cor condicional
pra margem boa/ruim" já prontas no mesmo arquivo, mas só usa uma delas.
`previewResult` (linha ~547) já pinta a margem de verde/vermelho
conforme bate a meta (`(preview.marginPct ?? 0) >= 0 ? previewMarginUp :
previewMarginDown`) — mas a KPI "margem mediana" duas seções acima
(linha ~213-219, renderizada em `statCardValue` sem nenhuma classe
condicional, linha 346) mostra "-20,5%" na mesma cor neutra que
qualquer outro número da tela. É o indicador mais importante da tela
(mediana do catálogo INTEIRO, não um exemplo) e é o que recebe MENOS
destaque visual proporcional à gravidade.

Achados:
1. **KPI "margem mediana" sem cor condicional** (`PricingConfig.tsx`
   linha 213-219 + 346) — copiar o mesmo padrão já usado no Preview ao
   vivo (`previewMarginUp`/`previewMarginDown`) resolve. Mesma classe de
   problema já visto no Session 1 (Home) e Session 3 (Resultados), mas
   aqui ao contrário: não é alarme em excesso, é alarme FALTANDO onde
   mais precisa.
2. **Duas "margens" de escopo diferente, mesmo peso visual** — "-20,5%"
   (mediana de 16 produtos) no topo vs. "48,3%" (1 produto de exemplo,
   card Preview) são números grandes, próximos, sem rótulo que deixe
   claro que um é agregado e outro é só 1 SKU. Quem bate o olho rápido
   pode ler os dois como "a margem do catálogo".
3. **"Impacto no catálogo" é só visualização, sem ação** (linha
   613-667) — 9 de 16 produtos em "Evitar" e não existe nenhum
   `onClick`/link pra ver quais são. Padrão forte em ferramenta de
   e-commerce/analytics (Shopify, Keepa, etc.): todo gráfico de "isso
   está ruim" devia linkar direto pro dado bruto por trás — aqui seria
   natural levar pra Resultados já filtrado em "Evitar".
4. **Toggle "Ads/patrocinado" desligado mantém o valor quase tão visível
   quanto os ativos** — taxa desligada devia esmaecer o número inteiro
   da linha (não só o switch), deixando mais óbvio que não entra na
   conta.

O que funciona bem (e já acerta o pedido de "e-commerce"):
- Cores semânticas de verdade no histograma "Impacto no catálogo"
  (`.stackRecomendado`/`.stackRevisar`/`.stackEvitar` em
  `PricingConfig.module.css` linha 606-619, usando `--color-success`/
  `--color-warning`/--color-danger` respectivamente) — é o padrão de
  farol (verde/âmbar/vermelho) que bom dashboard de e-commerce usa pra
  "o que vender, o que revisar, o que evitar". Conferido no código —
  não é o azul único da marca, apesar do app ser deliberadamente
  mono-acento no resto (ver nota de paleta em "Implementado" abaixo).
- `previewResult` com cor condicional (verde ≥0%, vermelho <0%) — padrão
  certo, só falta espalhar pros outros números de margem da tela.
- Badge "APLICADO NO PREVIEW" na faixa de frete ativa — conecta
  visualmente a regra que está valendo com o exemplo mostrado ao lado,
  ótima prática de transparência de cálculo (comum em calculadora de
  frete de e-commerce).
- "bate a meta a partir de R$ 58,71 de preço de venda" (mensagem de
  sensibilidade) — direto e acionável, fala a língua de quem precifica.
- Caixa alta só em rótulos curtos (REGRAS DE MARGEM, VER BUSCA, nomes de
  KPI) — ao contrário do achado do Session 5 no Dashboard, aqui o uso
  está dentro do limite saudável (1-3 palavras).

## Session 7 — Resultados (parte 2: dado real em produção)

Continuação do Session 3 (`ResultsTable.tsx`) — os fixes daquela sessão
já estão confirmados funcionando nesta captura (mediana no lugar de
média, "Mostrando 1-16 de 16", colunas ordenáveis). Esta sessão usa um
catálogo real do usuário (BMAX 2.pdf) e achou 2 problemas novos.

**Problema central**: tem um produto chamado literalmente **"VOLTAR"**
na linha 4 da tabela (SKU `BM-F1132`, R$16,00 custo → R$49,90 preço) —
nome de botão/navegação que vazou pro catálogo como se fosse produto de
verdade.

**Contexto do dono do produto (set/2026)**: o nome vem de extração por
IA (Gemini lendo a página) — às vezes acerta o nome real, às vezes
devolve lixo como esse. É ruído esperado da abordagem, não um bug de
parsing determinístico pra caçar e eliminar por completo (ver Session 3,
que já cobre a classe de erro "nome ilegível" na parte determinística/
heurística do parser — isso aqui é a parte de IA, tolerância diferente).
Rebaixado de crítico pra melhoria opcional de baixo custo.

Achados:
1. **🟢 Nome de produto ocasionalmente corrompido pela IA** ("VOLTAR")
   — esperado em algum nível com extração por IA, não um bug a corrigir
   com urgência. Melhoria opcional e barata: uma lista de termos de
   navegação óbvios ("voltar", "avançar", "próximo", "menu") pra
   flagar como suspeito (mesmo padrão do `priceSanityFlag`/"Preço
   suspeito" que já existe pra preço) — mais fácil de implementar do
   que tentar impedir a IA de errar, e dá o mesmo sinal visual que o
   usuário já confia pra preço.
2. **🔴 Separador decimal inconsistente** — a tabela inteira de
   Resultados usa PONTO (`.toFixed()` sem tratamento, ex.: "R$ 310.86",
   "2285.5%"), enquanto Home e Precificação usam VÍRGULA (`brl()` em
   `PricingConfig.tsx` linha 77-79: `.toFixed(2).replace(".", ",")`).
   Confirmado em 4 lugares de `ResultsTable.tsx`: `MarketPrice` (linha
   388), `CostCell` (linha 441), `SuggestedPriceCell` (linha ~484+) e
   `MarginCell` (linha 524) — nenhum deles troca `.` por `,`. É o tipo
   de inconsistência que faz a ferramenta parecer "feita por partes
   diferentes" pra quem olha com atenção — fácil de corrigir (mesmo
   `.replace(".", ",")` ou extrair um helper `brl()`/`pct()`
   compartilhado, já que ele hoje só existe dentro de `PricingConfig.tsx`
   e não é importado por `ResultsTable.tsx`).
3. **🟡 Badges de concorrência/popularidade difíceis de distinguir** —
   `CompetitionBadge` (ícone `Crown`/`Users`, 10px) e `PopularityBadge`
   (ícone `Flame`/`Star`, 10px) ficam empilhados logo depois do badge de
   Status, cada um com um número do lado. Em 10px, de relance, os dois
   ícones são fáceis de confundir entre si (eu mesmo, lendo a captura,
   achei que fossem corações e alto-falantes) — aumentar o ícone uns
   2-3px ou dar mais respiro entre os dois resolveria.

O que funciona bem:
- **Autodiagnóstico de preço suspeito já funciona** — a linha com
  margem de 2285.5% (SKU `BMG-62`) já vem marcada com "⚠ Preço
  suspeito" (`priceSanityFlag`, badge ao lado do nome) — o sistema já
  desconfia do próprio dado antes do usuário precisar perceber sozinho.
  Mesmo padrão que resolveria o achado #1 acima, se algum dia valer a
  pena implementar.
- "fonte servidor (cache)" no topo — mantém a transparência de
  proveniência de dado já elogiada no Session 1.
- Paginação, ordenação por coluna e mediana (em vez de média) — todos
  os fixes do Session 3 confirmados funcionando com dado real.

## Session 8 — Meus produtos (Portfolio.tsx)

Primeira sessão nesta tela. Tabela irmã de Resultados (mesmo tipo de
dado: SKU/produto/preço/margem/status), mas sem boa parte dos recursos
que Resultados já ganhou no Session 3.

**Problema central**: os 3 KPIs de topo ("0 preço subiu", "0 preço
caiu", "9 recomendados agora") prometem uma tabela acionável, mas a
tabela só tem busca por texto — sem filtro por status nem ordenação por
coluna. Pra ver os "9 recomendados agora", o usuário tem que rolar a
lista inteira (27 itens) procurando manualmente, porque a ordem da
tabela não é por relevância nem por recomendação — é só a ordem que
veio do upload original. Resultados já resolveu exatamente esse
problema (botões "Todos/Recomendado/Revisar/Evitar/Sem custo" +
colunas ordenáveis, ver Session 3/7); aqui, mesma necessidade,
nenhum dos dois recursos.

Achados:
1. **🔴 Sem filtro por status nem ordenação** — confirmado em
   `Portfolio.tsx`: o único filtro é `filtered` (linha 74-82), que só
   olha o texto da busca; não existe `.sort()` em nenhum lugar do
   arquivo. Resultado visível nesta captura: as 6 primeiras linhas (de
   27) são todas "Sem custo"/"1ª busca" — quem acabou de abrir a tela
   não vê nenhum dos "9 recomendados agora" sem rolar ou procurar.
   Reaproveitar o mesmo padrão de filtro+ordenação de `ResultsTable.tsx`
   resolveria com código já existente, só portado pra cá.
2. **🟡 Nomes de produto em CAIXA ALTA** ("JARRA MEDIDORA VIDRO 500ML",
   "POTE DE VIDRO HERMETICO QUADRADO 320ML C/ TRAVA NA T…") — confirmado
   que NÃO é `text-transform` do CSS (`.productName` em
   `Portfolio.module.css` linha 268-273 não tem essa regra; as 3 regras
   `text-transform: uppercase` do arquivo são só em `.eyebrow`,
   `.cardLabel` e `.table th` — rótulos curtos, uso correto). É o texto
   bruto como veio do catálogo deste fornecedor específico (outros
   catálogos, como o do Session 7, vêm em texto normal). Parede de
   texto em caixa alta é mais lenta de ler que texto normal — considerar
   normalizar a EXIBIÇÃO (`text-transform: capitalize` ou um helper de
   title-case) sem alterar o texto de verdade usado na busca de preço.
3. Nome truncado com reticência + `title` no hover (linha 192) já
   existe aqui — mesma solução do Session 3 pra Resultados, bom reuso.

O que funciona bem:
- **KPI "Preço subiu"/"Preço caiu" já vem com cor condicional de
  verdade** — `cardValueUp`/`cardValueDown` (linha 126, 130) sempre
  aplicadas, verde pra subida, vermelho pra queda. É exatamente o
  padrão que falta na "Margem mediana" de Precificação (Session 6) —
  prova que o app já sabe fazer isso direito, só não em todo lugar.
- Badge de recomendação + ícone de popularidade (mesmo padrão de
  `ResultsTable.tsx`, reaproveitado aqui) — consistência entre as duas
  telas de listagem de produto.
- Thumbnail de foto por linha — mesma linguagem visual de Resultados.

## Session 9 — Conta e chave de busca (Account.tsx, parte logada)

Primeira sessão nesta tela. Precisou de 2 capturas rolando a página só
pra ver os 8 cards de chave (SerpApi, RapidAPI, SearchApi.io, Gemini,
Mistral, NVIDIA, ScraperAPI, Unwrangle) + uso diário + preferências.

**Problema central**: os 8 cards de BYOK são praticamente idênticos e
sempre vêm totalmente expandidos — campo de troca de chave, botão
Salvar e o parágrafo inteiro explicando "como criar grátis" ficam
visíveis pra SEMPRE, mesmo numa chave que já está configurada há meses.
Pra quem já passou pelo setup, essa tela vira uma parede de repetição
só pra conferir 2-3 status. O próprio app já tem o padrão certo pra
isso em outro lugar — `Settings.tsx` esconde o formulário de trocar
email atrás de um botão "Alterar" (`showEmailForm`, ver Session de
auth) — só não foi aplicado aqui.

Achados:
1. **🟡 Card de chave sempre expandido, nunca colapsa** — confirmado em
   `Account.tsx`: o form (input + botão Salvar + parágrafo de instrução)
   renderiza incondicionalmente pra cada provider (ex. linha 931-963
   pra SerpApi), só o texto do placeholder muda com `hasXKey`. Em
   contraste, `Settings.tsx` já colapsa o formulário de troca de email
   atrás de um botão até o usuário pedir pra editar. Aplicar o mesmo
   aqui: chave configurada mostra só o status + um botão "Trocar
   chave", sem o parágrafo de onboarding nem o input abertos por
   padrão — view compacta tipo tabela (Stripe/Twilio costumam fazer
   assim pra lista de API keys) resolveria o scroll duplo desta
   captura.
2. **🟡 Gráfico "Uso diário de busca" é 93% inventado** — confirmado:
   `ILLUSTRATIVE_USAGE_SHAPE = [4, 12, 2, 8, 18, 14, 6, 2, 15, 20, 9, 7,
   11]` (linha 292) é um array FIXO usado pras 13 barras de dias
   anteriores; só a barra de hoje (`todayUsage`) é dado real (linha
   882). O aviso embaixo ("ainda não é gravado por dia no back-end") é
   honesto, mas pequeno — quem só bate o olho no gráfico sai com a
   impressão de um histórico real de uso. Melhor reduzir a ambição:
   mostrar só a barra de hoje, ou um estado vazio tipo "histórico diário
   chega em breve" em vez de 13 barras fabricadas.
3. **🟢 UID exposto em texto puro** em "Dados da conta" (hash tipo
   `1czDxoiCAVfcWBr0IDHMRhBR1d42`) sem nenhum uso prático pro usuário
   comum — não é segredo, mas é ruído técnico que não ajuda ninguém
   que não seja suporte/debug.

O que funciona bem:
- **Botão de excluir chave só aparece quando já existe uma** (`{hasSerpKey
  && (<button>...Trash2...</button>)}`, linha 948-958, mesmo padrão nos
  8 cards) — conferido no código antes de criticar; não é bug, já está
  certo.
- Descrição de cada provider já vem com link direto pra criar a chave
  grátis + custo/cota ("crie grátis em serpapi.com (só email, ~250
  buscas/mês)") — ótima prática de self-service, reduz fricção real de
  setup (mesma filosofia do aviso de BYOK elogiado no Session 5 do
  Dashboard).
- "Preferências opcionais" com toggle + 1 linha de efeito explicando —
  consistente com o padrão de toggle+explicação já elogiado antes.
- Sidebar com plano, cota e dados da conta bem separados do conteúdo
  principal (chaves) — hierarquia clara entre "configurar" e "consultar
  status".

## Session 10 — Admin (Admin.tsx)

Primeira sessão nesta tela. Diferente das anteriores: é tela interna
(só pra quem já é admin), então "profissional" aqui pesa mais pro lado
de segurança operacional do que polish visual.

**Problema central**: a ação mais perigosa da tela inteira — dar/tirar
admin de uma conta — é a que tem MENOS fricção. Confirmado no código:
`handleToggleUserAdmin` (linha 201-209) escreve direto no Firestore num
único clique, sem confirmação, sem reautenticação, com update otimista
de UI (já muda na tela antes do servidor confirmar). Compare com trocar
a PRÓPRIA senha (Settings.tsx), que exige digitar a senha atual de
novo — dar admin pra conta de outra pessoa, ação estritamente mais
perigosa, não exige nada.

Achados:
1. **🔴 Conceder/revogar admin sem confirmação** (linha 201-209) — um
   clique errado na linha errada da tabela e outra conta vira admin
   (acesso a dado de todos os usuários, troca de plano, biblioteca
   compartilhada — tudo que essa própria tela permite). Pelo menos um
   `confirm()`/modal "tem certeza que quer dar admin pra
   fulano@email.com?" antes de aplicar.
2. **🟡 Trocar o plano de um usuário é instantâneo no `onChange` do
   `<select>`** (linha 609-612, `handleChangeUserPlan` chamado direto)
   — sem confirmar, sem desfazer. Tem implicação de billing/acesso à
   biblioteca; mesma lógica do achado #1, severidade menor porque é
   reversível (plano dá pra trocar de volta, admin pode ser usado pra
   causar dano enquanto está ativo).
3. **🟡 Diagnóstico do OAuth Mercado Livre explica causa, não impacto**
   (linha 386-388: "Hoje parked por pendência de verificação de
   titularidade no DevCenter deles.") — ao contrário da linha Firebase
   Admin logo abaixo, que diz exatamente o que quebra se faltar ("nada
   nesta tela funcionaria — sinal de alerta grave", linha 396). Pra um
   painel de diagnóstico, impacto é mais acionável que causa — o admin
   quer saber "isso afeta busca no Mercado Livre pros usuários agora?"
   antes de "por que está desligado". Detalhe extra: o texto começa com
   "Hoje" mas é string fixa (não vem de data/estado) — não vai
   envelhecer bem se a pendência ainda estiver aberta daqui 3 meses.

O que funciona bem:
- **Card "Diagnóstico de configuração" é um padrão maduro e raro** —
  health-check de env vars críticas (OAuth, Firebase Admin) direto na
  UI, com ✓/❌ + explicação, em vez de só descobrir que algo está
  faltando quando um usuário reporta erro. Poucos produtos desse porte
  têm esse tipo de auto-diagnóstico visível; vale manter e expandir
  (ex.: aplicar a mesma clareza de impacto em toda linha, não só na do
  Firebase Admin).
- **Mesmo padrão de KPI-card reaparece pela 5ª vez** (Home, Resultados,
  Precificação, Meus produtos, agora Admin) — reuso consistente de
  componente em telas bem diferentes é sinal de design system
  funcionando de verdade, não só coincidência visual.
- Ícone + texto nos diagnósticos (✓/❌, não só cor) — mantém o padrão
  de acessibilidade já visto em badges de status noutras telas.

## Session 11 — Configurações (Settings.tsx, aba Aparência)

Primeira sessão nesta tela. O usuário pediu pra tratar "muito espaço em
branco sobrando" como o achado PRINCIPAL desta vez, e perguntou se vale
pra todas as telas — resposta curta: não por igual. Já tinha marcado
esse mesmo problema no Session 1 (Dashboard) e ele já foi corrigido
(KPI row + painel de catálogos recentes); Precificação, Resultados,
Meus produtos e Admin já usam uma 2ª coluna (sidebar) que ocupa a
largura toda. **Configurações é a única tela da revisão até agora que
nunca ganhou esse tratamento** — é o pior caso, não o caso geral.

**Problema central, confirmado no código**: `Settings.module.css`
trava o container inteiro em `max-width: 920px` (linha 1-4) e o
`.layout` é só `200px` (nav lateral) + `1fr` (conteúdo) — SEM nenhuma
segunda coluna tipo `aside`/sidebar (linha 36-41). Em viewport largo
(a captura é ~2000px), sobra mais da metade da largura vazia, fora o
espaço vertical depois do card "Modo". Toda outra tela de card-grid já
revisada (Precificação, Admin, até a Home depois do fix do Session 1)
resolve isso com uma coluna extra de conteúdo relevante à direita —
aqui, essa coluna nunca foi criada.

Achados:
1. **🟡 Sem segunda coluna, ao contrário do resto do app** — confirmado
   em `Settings.module.css` linha 1-41. Reaproveitar o MESMO padrão já
   validado em Precificação (`cardAccent` + `aside`) resolveria sem
   inventar layout novo.
2. **O que preencher, especificamente**: a troca de paleta/modo/tamanho
   de texto já é "ao vivo" — confirmei em `App.tsx` (linha 128-130,
   `applyAccent`/`applyTheme`/`applyFontSize` rodam a cada mudança de
   preferência) que a barra de navegação e os botões ATRÁS do painel já
   re-skinam na hora. Isso É um preview ao vivo, só que implícito (o
   usuário precisa olhar o resto da tela, não um exemplo dedicado). O
   que falta é mostrar como a paleta fica nos componentes que NÃO
   aparecem em Configurações — barra de margem, badge de status, linha
   de tabela (os elementos mais usados do app, de Resultados/Meus
   produtos) — um card "Preview" com uma linha de exemplo (produto
   fictício + badge Recomendado/Revisar/Evitar + barra de margem)
   preenche o espaço E responde a pergunta real de quem está trocando
   tema: "como fica nas telas que eu realmente uso".
3. **🟢 Cards "Tamanho do texto" e "Modo" já são 3 colunas** (bom uso de
   largura DENTRO de cada card) — só o card "Paleta" tem 4 opções numa
   grid que também abre bem; o desperdício é todo no NÍVEL do layout
   (`.container`/`.layout`), não dentro dos cards individuais.

O que funciona bem:
- Contraste já informado por opção de paleta ("6,4:1 · AA", "7,2:1 ·
  AA"...) — dado de acessibilidade real, não só decoração, direto onde
  a decisão é tomada.
- Preview ao vivo "implícito" (tema aplica na hora em toda a UI ao
  redor) já existe e funciona — só falta o complemento específico
  (achado #2).
- Nav lateral de seções (Aparência/Personalização/Pagamento/Dados da
  conta) com largura fixa 200px — consistente, não compete por espaço
  com o conteúdo.

## Session 12 — Dúvidas (Faq.tsx)

Primeira sessão nesta tela. Pedido do usuário: além de achados,
ideias novas de design/UX. O conteúdo em si já é ótimo — vale destacar
antes de qualquer crítica.

**Destaque**: a pergunta "Qual formato de catálogo dá o melhor
resultado?" não só explica, ela RESOLVE — modelo de planilha pra
baixar + prompt pronto pra colar num agente de IA (ChatGPT/Claude) que
reorganiza o catálogo bagunçado do fornecedor sozinho. É suporte
self-service de verdade, raro ver isso num FAQ comum.

Achados:
1. **🟡 FAQ sem busca/filtro** — confirmado 4 seções ("Cadastro e
   arquivo", "Motores e APIs de busca", "Erros comuns", "Planos e
   conta") somando 19 perguntas (`Faq.tsx`, campos `title`/`question`).
   Volume grande o bastante pra um campo "buscar na dúvida" no topo
   compensar — hoje é só rolar e abrir pergunta por pergunta.
2. **🟢 As duas imagens de exemplo (PDF vs. planilha) têm alturas
   diferentes** — confirmado em `Faq.module.css`: `.guideImage { width:
   100%; }` sem nenhum controle de altura/aspect-ratio (linha 154-159),
   então cada PNG renderiza na proporção natural dele. O grid (`.
   guideImages`, `display: grid`) estica as duas colunas pra mesma
   altura, mas sobra vazio embaixo da imagem mais curta (planilha) antes
   da legenda — os dois exemplos deviam parecer "do mesmo peso" visual,
   já que são alternativas equivalentes. `object-fit: contain` numa
   caixa de altura fixa resolveria sem precisar redesenhar os PNGs.

Ideias novas:
1. **Link direto pra uma pergunta específica** — hoje não dá (app é
   roteado por estado, sem react-router, confirmado nas sessões
   anteriores — nenhuma pergunta tem âncora/URL própria). Essa pergunta
   específica do prompt de catálogo é ótima pra mandar em suporte via
   WhatsApp ("manda esse link que ensina a organizar seu catálogo") —
   um `#faq=cadastro-formato` navegável faria essa pergunta virar
   material de suporte compartilhável fora do app, não só dentro dele.
2. **"Isso ajudou?" por resposta** — um sim/não discreto no fim de cada
   pergunta expandida, salvando um contador simples (mesmo padrão BYOK
   de escrita por usuário já usado no resto do app). Com 19 perguntas,
   sem esse sinal não dá pra saber quais merecem reescrever — decisão
   de produto, não só estética.

O que funciona bem:
- Botão "Copiar prompt" já dá feedback visual real (`copied` state,
  linha 50-56: ícone + texto trocam pra "Copiado!" por 2s) — conferido
  antes de supor que faltava, já está certo.
- Acordeão já é acessível de verdade — `<button>` real com
  `aria-expanded` (linha 304-308), não uma `<div>` clicável.
- `alt` descritivo nas duas imagens ilustrativas (linha 77, 85) — boa
  prática já aplicada, não é genérico tipo "imagem1.png".
- Aviso explícito "estas imagens são ilustrativas" antes dos exemplos —
  evita que o usuário ache que precisa reproduzir o layout exato.

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

## Implementado (rodada 2 — Sessions 4 a 12)

Base comum: `src/lib/format.ts` (+ `format.test.ts`) — `brl()`, `pct()`,
`formatMs()`, `displayProductName()` e `marginTone()`. Antes `brl()` só
existia dentro de `PricingConfig.tsx`; agora toda tela usa o mesmo.

**Session 4 (Início)**:
- Margem mediana com cor pela meta (verde/âmbar/vermelho, mesma régua
  de Precificação), tooltip explicando o número e rótulo honesto ("do
  mês" vs. "geral" + meta). Negativa ganha link "entender esse número".
- Margem de cada busca recente com a mesma cor.
- "Como funciona" só aparece pra conta sem nenhum catálogo processado.
- Card da chave SerpApi subiu pro topo da coluna lateral.
- "Catálogos disponíveis" vazio deixou de ser beco sem saída: "Subir meu
  catálogo" + "Ver planos" (abre Configurações direto em Pagamento).
- Não feito, de propósito: remover "Nova busca" do hero (o item do menu
  é navegação global, o botão do hero é a ação principal da tela).
- Correção do achado: os ícones da barra superior JÁ tinham `title` e
  `aria-label`. O que estava errado era o "online" fixo — agora reflete
  a conexão real (`navigator.onLine`), com tooltip.

**Session 5 (Nova busca)**:
- Velocidade por mecanismo: rótulo em linha própria (sem corte) e tempo
  legível (`formatMs`: "12,0 s").
- Motor de busca com indicador de rádio (`role="radio"`), marketplace
  com check quadrado — seleção única vs. múltipla agora é visível.
- "Onde comparar" virou rótulo curto + frase explicativa em caixa normal.
- Pré-requisitos recolhem pra "Tudo pronto pra buscar" quando os 3 estão
  ok (com "detalhes" pra expandir).
- Card "Seu histórico" (duplicava "Catálogos processados") removido.

**Session 6 (Precificação)**:
- KPI "margem mediana" com cor pela meta e rodapé "mediana de N
  produto(s)"; Preview diz "margem deste produto · só este item".
- Taxa/imposto desligado esmaece a linha inteira.
- Legenda do "Impacto no catálogo" clicável + "Ver os N produto(s) em
  Evitar" → abre Resultados já filtrado (`initialFilter`), sincronizando
  as regras antes se estiverem pendentes.

**Session 7 (Resultados)**: vírgula decimal em toda a tabela (custo,
preço, sugerido, margem, visão lado a lado); nomes em CAIXA ALTA
normalizados só na exibição; ícones de concorrência/popularidade
10px → 12px com mais respiro. "VOLTAR" (ruído de IA) não tratado.

**Session 8 (Meus produtos)**: filtro por status/tendência (botões +
KPIs clicáveis), colunas ordenáveis, ordem padrão "o que dá pra agir
primeiro" (recomendado → revisar → evitar → sem custo), vírgula
decimal e nome normalizado.

**Session 9 (Conta)**: chave configurada recolhe pra "Chave salva" +
"Trocar chave" (form só abre pra quem não tem chave ou pediu pra
trocar; fecha sozinho ao salvar). Gráfico com 13 dias inventados
substituído por medidor real (uso de hoje × teto do plano). UID virou
"id de suporte" truncado (completo no hover).

**Session 10 (Admin)**: confirmação antes de dar/tirar admin (aviso
extra ao remover o próprio acesso) e antes de trocar plano. Diagnóstico
do OAuth Mercado Livre agora diz o impacto real (conferido em
`mercadoLivreSearchProvider.ts`: sem OAuth, ML segue via Google
Shopping; só a fonte oficial gratuita sai do motor interno).

**Session 11 (Configurações)**: container 920px → 1240px com 3ª coluna
(Preview com linhas de produto, barra de margem, badges e botão, na
paleta/tamanho atuais + "Seu plano"). Abaixo de 1180px o preview desce.

**Session 12 (Dúvidas)**: busca (pergunta + resposta em texto), âncora
pra todas as 14 perguntas (eram 14, não 19 como anotado), botão
"Copiar link desta pergunta" e link `#faq/<âncora>` abre o app direto na
pergunta (no carregamento e com o app já aberto). Imagens de exemplo
com a mesma caixa (`aspect-ratio` + `object-fit: contain`).
- Correção do achado: já existia âncora (`anchor`) — só em 1 pergunta e
  só usada internamente pelo aviso de erro da Nova busca.
- Não feito: "Isso ajudou?" — precisa de coleção nova no Firestore +
  regra + deploy; decisão de produto pendente.

Verificado no navegador (deslogado): Início, Configurações (preview +
troca de paleta ao vivo + "Ver planos"), Dúvidas (busca, link direto,
imagens) e Precificação. NÃO verificado no navegador, só por
typecheck/build: estados que exigem login com dado real — filtros de
Meus produtos, cores com histórico, cards de chave recolhidos,
confirmações do Admin.

## Pendente
- "Isso ajudou?" no FAQ (Session 12) — precisa de backend.
- Flag de nome suspeito pra ruído de IA ("VOLTAR", Session 7) — opcional.
- Rolagem não volta pro topo ao trocar de tela (notado no teste da
  rodada 2, comportamento anterior a ela).
- Paginação de verdade em Resultados (hoje só mostra a contagem, ainda
  não corta em páginas) — considerar se catálogos crescerem muito além
  de ~200 SKUs.
- Otimização de cota da SerpApi: compartilhar a mesma busca entre
  Amazon e Mercado Livre quando os dois estão selecionados (ver TODO em
  `googleShoppingProvider.ts`).
