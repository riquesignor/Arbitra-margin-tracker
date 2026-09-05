# Termos de Uso — Arbitra

> ⚠️ **AVISO IMPORTANTE, NÃO REMOVER ANTES DE PUBLICAR:** este documento é um
> **rascunho técnico**, escrito por um assistente de IA a partir do que o
> código do Arbitra realmente faz (autenticação, upload de catálogo, chaves
> BYOK de terceiro, planos, integração de pagamento). **Não é aconselhamento
> jurídico e não substitui a revisão de um advogado** antes de publicar — em
> especial os pontos marcados com `[PREENCHER]`, a seção de isenção de
> responsabilidade sobre preços/margem, e a compatibilidade com a legislação
> de proteção de dados (LGPD) e de defesa do consumidor (CDC) aplicável ao
> seu caso concreto (pessoa física vs. empresa, B2B vs. B2C).

**Última atualização:** `[PREENCHER — data de publicação]`

## 1. Quem oferece o serviço

O Arbitra é um serviço de precificação e arbitragem de catálogo, oferecido
por `[PREENCHER — nome completo ou razão social, CNPJ se houver, endereço
ou cidade/UF]` ("nós", "Arbitra"). Contato: `[PREENCHER — e-mail de
suporte]`.

## 2. O que o serviço faz

O usuário envia um catálogo de fornecedor (`.csv`, `.xlsx` ou `.pdf`) e o
Arbitra busca o preço equivalente em marketplaces (Amazon, Mercado Livre e,
opcionalmente, outras lojas) usando um ou mais mecanismos de busca —
alguns operados pela própria Arbitra, outros via chave de API que o
**próprio usuário cadastra e é responsável por manter** (modelo "traga sua
própria chave"/BYOK: SerpApi, RapidAPI, SearchApi.io, Unwrangle, ScraperAPI,
Gemini, Mistral). O Arbitra calcula uma margem estimada a partir do custo
informado pelo usuário e do preço encontrado.

## 3. Conta e cadastro

O acesso exige login (e-mail/senha ou provedor externo, via Firebase
Authentication). O usuário é responsável por manter a confidencialidade das
próprias credenciais e por toda atividade realizada na conta. O usuário
pode excluir a própria conta e os dados associados a qualquer momento, pela
tela de Conta.

## 4. Planos e pagamento

O Arbitra tem um plano Free e planos pagos (ver `config/plans.ts`). A
cobrança do plano pago é recorrente (mensal), processada pelo Mercado
Pago — o Arbitra não recebe nem armazena dado de cartão; o pagamento
acontece inteiramente na página do Mercado Pago, pra onde o usuário é
redirecionado ao assinar. `[PREENCHER antes de cobrar o primeiro cliente
real — exigência do CDC pra cobrança recorrente, não apenas boa prática]`:
valor exato vigente e regra de reajuste; política de reembolso; o que
acontece com o acesso em caso de atraso de pagamento (a assinatura entra
em `paused`/`cancelled` no Mercado Pago e o Arbitra rebaixa
automaticamente pro plano Free); e como o usuário cancela a própria
assinatura.

## 5. Chaves de API de terceiro (BYOK)

Alguns mecanismos de busca exigem que o usuário cadastre a própria chave de
API de um serviço terceiro (ex.: Gemini, ScraperAPI). Essas chaves:

- são de responsabilidade exclusiva do usuário perante o respectivo
  fornecedor (custo, limites de uso, violação dos termos daquele serviço);
- são armazenadas de forma restrita (o Arbitra não expõe o valor da chave
  de volta pro navegador depois de cadastrada — só um indicador de "chave
  cadastrada");
- podem ser removidas pelo usuário a qualquer momento na tela de Conta.

O Arbitra não se responsabiliza por cobrança, suspensão ou mudança de
política desses serviços terceiros.

## 6. Isenção sobre preço e margem — **leia com atenção**

Os preços de mercado exibidos são obtidos de forma automatizada (raspagem
de página pública, API oficial do marketplace, ou API estruturada de
terceiro) e **podem estar desatualizados, incorretos, ou não representar o
mesmo produto** do catálogo do usuário — o Arbitra sinaliza isso sempre que
possível (marca "Aproximado", indica a origem da confiança), mas **a
decisão final de compra, precificação e venda é sempre do usuário**. O
Arbitra não garante a exatidão de nenhum preço exibido e não se
responsabiliza por prejuízo decorrente de decisão comercial baseada nesses
dados.

## 7. Uso aceitável

É vedado: (a) usar o serviço para automatizar acesso a marketplaces de
forma que viole os termos de uso deles; (b) tentar contornar limites de
cota/plano; (c) enviar catálogo com conteúdo ilegal, ou que infrinja
propriedade intelectual de terceiro; (d) tentar obter acesso não autorizado
a dados de outro usuário ou à área administrativa.

## 8. Disponibilidade

O serviço é oferecido "como está", sem garantia de disponibilidade
contínua. Mecanismos de terceiro (marketplaces, provedores de IA, APIs de
busca) podem ficar indisponíveis ou mudar sem aviso — o Arbitra não
controla esses serviços e não garante que a busca de preço sempre retorne
resultado.

## 9. Alterações destes Termos

`[PREENCHER — como o usuário será avisado de mudança: e-mail, aviso no
próprio app, data de vigência a partir da publicação, etc.]`

## 10. Lei aplicável e foro

`[PREENCHER — em geral, legislação brasileira e foro da comarca do
domicílio do responsável pelo serviço, mas confirme com um advogado.]`
