# Billing — Mercado Pago (assinatura recorrente)

Status: **MVP implementado, NÃO testado contra a API real do Mercado Pago
nesta sessão** (sem acesso a ambiente de build/execução aqui — ver rodapé).
Antes de expor a qualquer cliente pagador, siga o checklist deste documento
no ambiente de teste (sandbox) do Mercado Pago.

## O que existe

- `api/_lib/mercadoPago.ts` — cliente REST mínimo: `createPreapproval`,
  `getPreapproval`, `verifyWebhookSignature`, `isActiveSubscriptionStatus`.
- `api/billing-create-subscription.ts` — endpoint autenticado (Firebase ID
  Token) que cria a assinatura e devolve `initPoint` (URL de checkout
  hospedada pelo Mercado Pago).
- `api/billing-webhook.ts` — endpoint público (sem `requireAuth` — quem
  chama é o Mercado Pago), valida a assinatura HMAC do header
  `x-signature`, confirma o status consultando a API deles (nunca confia
  no corpo da notificação) e grava `plan`/`mpSubscriptionStatus` via Admin
  SDK.
- `src/lib/billingApi.ts` + `Settings.tsx` (aba Pagamento) — botão
  "Assinar agora" que chama o endpoint e redireciona
  (`window.location.href = initPoint`).

## Por que redirect e não SDK de cartão

O checkout roda inteiro no domínio do Mercado Pago — o Arbitra nunca
recebe número de cartão, CVV ou nada equivalente. Isso: (a) mantém o
Arbitra fora do escopo PCI-DSS; (b) evita precisar liberar `script-src`/
`connect-src` da CSP pra um SDK de terceiro; (c) é bem mais simples de
implementar e auditar. O custo é uma UX levemente menos integrada
(navegação para outro domínio, e volta por `back_url`).

## Setup — sandbox (fazer isso ANTES de qualquer coisa em produção)

1. Crie/acesse uma conta de teste separada no [painel de
   desenvolvedores do Mercado Pago](https://www.mercadopago.com.br/developers).
2. Em **Suas integrações**, gere as **credenciais de TESTE** (não as de
   produção) — `MERCADOPAGO_ACCESS_TOKEN` de teste.
3. Configure uma notificação **Webhook** apontando pra
   `https://<seu-preview-ou-domínio>/api/billing-webhook`, evento
   "Assinaturas" (preapproval). O painel gera a **chave secreta** — isso é
   `MERCADOPAGO_WEBHOOK_SECRET`.
4. Preencha `APP_BASE_URL` com a URL pública do ambiente de teste.
5. Use um [usuário de teste comprador](https://www.mercadopago.com.br/developers/pt/docs/checkout-pro/additional-content/test-cards)
   com um cartão de teste pra simular a aprovação da assinatura.
6. Rode o fluxo ponta a ponta: Conta → Pagamento → "Assinar agora" → pagar
   com cartão de teste → confirmar que `users/{uid}.plan` virou `pro` (ou
   o valor de `MERCADOPAGO_PAID_PLAN_ID`) depois da notificação webhook
   chegar.
7. Teste também o caminho de cancelamento (cancelar a assinatura de teste
   no painel MP) e confirme que o webhook rebaixa o usuário de volta pro
   plano `free`.

Só depois de validar os 3 caminhos (aprovação, cancelamento, e uma
notificação com assinatura HMAC deliberadamente errada sendo recusada com
401) troque as variáveis de ambiente pelas credenciais de **produção**.

## Pendências conhecidas / decisões de MVP que talvez precisem revisitar

- **Um preapproval novo a cada clique em "Assinar agora"**: se o usuário
  clicar de novo sem concluir o checkout anterior, o preapproval antigo
  fica órfão (`pending`) no Mercado Pago — não gera cobrança sozinho, mas
  polui o painel deles. Se virar ruído, cancelar o anterior
  (`PUT /preapproval/{id}` com `status: "cancelled"`) antes de criar o
  novo.
- **Um único plano pago fixo** (`MERCADOPAGO_PAID_PLAN_ID`, default
  `"pro"`): não há hoje diferenciação Starter vs. Pro no billing — os dois
  continuam com `priceLabel: "Sob consulta"` em `config/plans.ts` até
  decidir se cada um vira um valor de assinatura diferente (exigiria um
  `auto_recurring.transaction_amount` por plano, e provavelmente um
  segundo botão/fluxo de upgrade).
- **CDC — cobrança recorrente**: a seção 4 dos Termos de Uso
  (`docs/legal/termos-de-uso.md`) ainda tem `[PREENCHER]` no valor exato,
  política de reembolso e o que acontece com o acesso em atraso — isso é
  exigência legal pra cobrança recorrente no Brasil, não só boa prática.
  Preencher antes de cobrar o primeiro cliente real.
- **Sem tela de "cancelar assinatura" pelo próprio usuário** ainda —
  hoje cancelamento só acontece pelo painel do Mercado Pago diretamente
  (ou por um admin editando o plano manualmente). Se o volume justificar,
  vale um botão "Cancelar assinatura" em Settings.tsx que chama
  `PUT /preapproval/{id}` com `status: "cancelled"`.

## Limitação desta implementação (disclosure)

O ambiente onde este código foi escrito não teve acesso a `npm install`
nem a um sandbox de execução ligado a este repositório — toda a
implementação foi feita por leitura cuidadosa do código existente e da
documentação pública do Mercado Pago, sem rodar `tsc`/testes/chamada real
contra a API deles. Rode `npm run typecheck && npm test` localmente e
execute o checklist de sandbox acima antes de considerar isto pronto pra
produção.
