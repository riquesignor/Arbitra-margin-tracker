# ADR-0003: Subcoleções sob `users/{uid}/...` (adoção da Opção C da ADR-0002)

**Status:** Accepted
**Date:** 2026-08-06
**Deciders:** Nicolas (produto/arquitetura)
**Supersedes:** parte da [ADR-0002](./0002-organizacao-dados-firestore-por-usuario.md) (mantém a rejeição da Opção A; reverte a escolha da Opção B em favor da Opção C, já documentada lá como alternativa válida)

## Context

Pedido repetido: "cada gaveta ter um compartimento pra pessoa distinta" —
mesma dor de navegação da ADR-0002 (dados de usuários diferentes
aparecendo misturados em coleções de nível superior, filtrados por um
campo `userId`). A ADR-0002 já tinha diagnosticado isso corretamente:
isolamento por UID já era total, a "mistura" era só visual (console do
Firebase, 8 nomes de coleção na raiz). A decisão de lá (Opção B, manter
como está + tela de Admin agregando por usuário) resolveu o caso de uso
de Admin, mas não resolveu a reclamação original — o pedido voltou.

O que mudou desde 2026-07-23, e que muda a conta de custo/benefício da
própria ADR-0002 (seção "Trade-off Analysis"):

- **Não há mais dado de produção a preservar.** A ADR-0002 apontava a
  migração como o custo real da Opção C ("ler tudo do path antigo e
  regravar no novo"). Confirmado com o usuário nesta sessão: pode
  começar do zero, sem migrar `catalog_uploads`/`catalog_images`
  existentes. Isso zera o item mais caro da comparação.
- O pedido se repetiu mesmo com a Opção B — sinal de que a tela de Admin
  (Action Item 1 da ADR-0002) resolve o caso de uso de suporte/gestão,
  mas não a expectativa de organização do próprio dono do produto ao
  olhar o Console diretamente.

Continua rejeitada a Opção A (coleção nomeada pelo `displayName`/email do
usuário) pelos mesmos motivos da ADR-0002: nome não é identidade estável,
regra de segurança não generaliza, sem paginação/listagem nativa. O que
muda aqui é a chave de organização visual — de "8 coleções soltas
filtradas por UID" para "tudo dentro de `users/{uid}/...`" — nunca o nome
de exibição.

## Decision

Migrar as coleções que são genuinamente 1:N por usuário para subcoleções
de `users/{uid}`:

| Antes (nível superior + campo/prefixo `userId`) | Depois (subcoleção) |
|---|---|
| `catalog_uploads` (`where userId ==`) | `users/{uid}/catalog_uploads/{autoId}` |
| `catalog_images` (`where userId ==`, hoje só por leitura direta do dono) | `users/{uid}/catalog_images/{autoId}` |
| `user_secrets/{uid}` (1:1) | `users/{uid}/secrets/keys` |
| `pricing_rules/{uid}` (1:1) | `users/{uid}/pricing_rules/config` |
| `usage_daily/{uid}_{yyyymmdd}` (ID composto) | `users/{uid}/usage_daily/{yyyymmdd}` |

Ganho colateral real (não só estético): a query de `listCatalogUploads`
não precisa mais do índice composto `userId ASC, uploadedAt DESC` — a
subcoleção já escopa por usuário via path, sobra só um `orderBy` simples
(índice automático). `firestore.indexes.json` fica vazio.

Continuam OFF deste esquema, por não serem dado de usuário:

- **`market_prices`** — cache de preço GLOBAL por `{marketplace}__{sku}`,
  deliberadamente compartilhado entre todos os usuários (ver comentário
  em `api/_lib/cache.ts`). Mover pra dentro de cada usuário duplicaria
  cache e faria cada pessoa pagar cota da própria SerpApi por um preço
  que já estava resolvido — regressão de custo e performance, não
  organização.
- **`shared_catalogs`** — biblioteca curada pelo admin, indexada por
  `plans[]`, não por usuário.
- **`ml_oauth`** — token de aplicação (Mercado Livre), não é dado de
  nenhum usuário.

Também removidas do `firestore.rules` as entradas `catalogs/{catalogId}`
e `margin_calculations/{calcId}` — confirmado que nenhum código no
projeto escreve ou lê essas duas coleções hoje (grep em `src/` e `api/`
sem resultado); eram resíduo de uma fase anterior (Fase 3) e só
adicionavam superfície de regra sem função.

## Consequences

- **Fica mais fácil:** abrir `users/{uid}` no Console do Firebase mostra
  o documento de perfil E todas as subcoleções daquele usuário
  aninhadas ali — a "pastinha por pessoa" pedida, com UID (não nome)
  como chave real de isolamento.
- **Fica mais difícil:** consulta cross-user no Admin (hoje só
  `getTodayUsage`/`listCatalogUploads` por UID individual, que continuam
  funcionando sem mudança de assinatura) precisaria de
  `collectionGroup(...)` no lugar de `collection(...)` se um dia vira
  necessário (ex.: analytics agregado entre todos os usuários) — não é
  o caso hoje, então não foi implementado.
- **Assinatura de função alterada:** `deleteCatalogUpload(id)` virou
  `deleteCatalogUpload(userId, id)` — Firestore exige o path completo
  (`users/{uid}/catalog_uploads/{id}`) pra apagar um doc de subcoleção,
  não dá pra endereçar só pelo ID como antes.
- **URL pública da imagem do modo Lens muda de forma:**
  `/api/catalog-image?id=X` vira `/api/catalog-image?uid=X&id=Y` — o
  Admin SDK, do lado servidor, também precisa do `uid` pra montar o path
  da subcoleção (antes bastava o `id` porque a coleção era plana). Não
  reduz segurança: o endpoint já não tinha autenticação de propósito
  (crawler do Google Lens não manda header nenhum); o "segredo" continua
  sendo o ID do documento (não sequencial) + TTL de 30 dias.
- **Sem migração de dado existente** — decisão explícita do usuário
  nesta sessão. Documentos antigos em `catalog_uploads`/`catalog_images`
  (coleções de nível superior) ficam órfãos: não são lidos pelo código
  novo, não são apagados automaticamente. Se algum dia for necessário
  limpar, é uma exclusão manual em lote (Console ou script Admin SDK),
  não um item desta ADR.
- **Precisa de deploy de regras/índices** — `firebase deploy --only
  firestore:rules,firestore:indexes` depois do merge, mesma pegadinha já
  registrada na ADR-0002 (regra nova só vale em produção depois do
  deploy).

## Migration Path (caso um dia precise recuperar o histórico antigo)

Não implementado agora (sem necessidade), mas documentado pra não perder
o caminho: ler cada doc de `catalog_uploads`/`catalog_images` (coleção
antiga), extrair o campo `userId`, `addDoc` no path novo
`users/{userId}/catalog_uploads|catalog_images`, então apagar o doc
antigo — precisa de Admin SDK (chave de serviço), roda uma vez, fora do
código de produção (ex.: `scripts/migrate-to-user-subcollections.mjs`,
no mesmo padrão de `scripts/ml-oauth-setup.mjs`).
