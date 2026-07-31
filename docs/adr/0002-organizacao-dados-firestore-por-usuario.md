# ADR-0002: Organização de Dados por Usuário no Firestore

**Status:** Accepted (Opção B mantida; Action Item 1 implementado)
**Date:** 2026-07-23
**Deciders:** Nicolas (produto/arquitetura)

## Context

Pedido: evitar que os dados no Firestore fiquem "uma mistura" — a proposta
concreta foi usar o **nome do usuário como nome da coleção** (ex: usuário
Cleber → coleção `cleber`, e dentro dela os documentos de chave SerpApi,
uso diário e buscas dele).

Vale desenhar o estado atual antes de avaliar a proposta — isso não é uma
decisão greenfield, é uma segunda opinião sobre um schema já implementado
e em produção:

| Coleção | Doc ID | Relação com o usuário | Quem escreve | Quem lê |
|---|---|---|---|---|
| `users` | `{uid}` | 1:1 (perfil) | client (dono) | dono + admin |
| `user_secrets` | `{uid}` | 1:1 (chave SerpApi) | client (dono) | só o dono |
| `pricing_rules` | `{uid}` | 1:1 (regras de margem) | client (dono) | só o dono |
| `usage_daily` | `{uid}_{yyyymmdd}` | 1:N (um doc por dia) | client (dono) | só o dono |
| `catalog_uploads` | auto-ID + campo `userId` | 1:N (um doc por busca) | client (dono) | só o dono (`where userId ==`) |
| `shared_catalogs` | auto-ID + campo `plans[]` | N:N (não é por usuário, é por plano) | admin | quem tem o plano ou é admin |
| `market_prices` | `{marketplace}__{sku}` | não é por usuário (cache global) | só Admin SDK | qualquer autenticado |
| `ml_oauth` | fixo | não é por usuário (token da app) | só Admin SDK | ninguém via client |

Todo dado "do Cleber" já está isolado pelo **UID dele** (`request.auth.uid`),
seja como ID do documento (`users/{uid}`) ou como campo de filtro
(`catalog_uploads` com `where("userId", "==", uid)`). A sensação de
"mistura" vem de serem 8 nomes de coleção espalhados na raiz do console,
não de falta de isolamento — os dados de dois usuários nunca se misturam
entre si hoje.

## Decision

**Manter o modelo atual (Opção B) como está — não criar coleção por nome
de usuário (Opção A).** Nome de usuário não é a chave de isolamento em
nenhuma regra hoje, e não deveria virar uma agora: quem garante que um
documento pertence ao Cleber é o UID do Firebase Auth, não a string
"cleber". Se o objetivo é enxergar "tudo do Cleber" num lugar só, a forma
correta de resolver isso é uma tela no Admin que consulta as 5 coleções
por UID e mostra o resultado agregado — não reorganizar o banco em torno
de como ele aparece na lista raiz do console.

Deixo a Opção C (subcoleções sob `users/{uid}/...`) documentada como
caminho válido se o incômodo for especificamente a navegação dentro do
Console do Firebase — tem custo de migração real, então trato como
opcional, não como parte desta decisão.

## Options Considered

### Option A: Coleção nomeada por usuário (proposta original) — Rejeitada

| Dimensão | Avaliação |
|---|---|
| Complexidade | Baixa pra criar, alta pra manter |
| Isolamento real | Pior que hoje (ver abaixo) |
| Queries entre usuários (Admin) | Impossível de forma nativa |
| Segurança | Uma regra por usuário, ou uma regra genérica que não verifica identidade de verdade |
| Estabilidade do identificador | Baixa — nome não é único nem imutável |

**Por que quebra na prática, não só "não é o padrão":**

1. **Nome não é identidade.** Dois usuários podem se chamar Cleber; um
   usuário pode mudar o próprio nome. A única coisa que o Firebase Auth
   garante única e imutável é o **UID** — é o que toda regra em
   `firestore.rules` já usa (`request.auth.uid == userId`). Trocar isso
   por nome reabre exatamente o bug que UID existe pra evitar: dois
   registros colidindo no mesmo "espaço".
2. **Regra de segurança não generaliza.** Hoje uma regra cobre TODOS os
   usuários: `match /user_secrets/{userId} { allow read, write: if
   request.auth.uid == userId }`. Com coleção-por-nome, `{userId}` vira o
   próprio nome da coleção (`match /{userName}/{document=**}`) — mas aí a
   regra não tem como confirmar que quem está logado É o Cleber, porque
   "cleber" não é um claim do token de autenticação. Pra isso funcionar
   de verdade, você precisaria de uma coleção auxiliar mapeando
   nome→UID... que é exatamente a coleção `users` que já existe hoje,
   agora como uma dependência extra em vez da própria fonte da verdade.
3. **Não dá pra listar/paginar entre usuários.** O painel Admin faz
   `getDocs(collection(db, "users"))` pra listar todo mundo — uma
   chamada, uma regra, um índice se precisar. Com coleção por nome, essa
   operação não existe: `listCollections()` do Admin SDK devolve só
   nomes de coleção (sem filtro, sem paginação, sem security rules) e é
   pensado pra backup/tooling, não pra lógica de produto.
4. **IDs de coleção têm restrição de formato** (sem `/`, não pode ser `.`
   nem `..`, UTF-8 válido) — nome de exibição com espaço, acento ou emoji
   precisa de sanitização, o que já mata a promessa de "pasta legível".
5. **Não resolve o problema real.** A reclamação é sobre navegar o
   console, não sobre isolamento de dado (que já existe). É o mesmo erro
   de criar uma tabela SQL por cliente em vez de uma tabela `usuarios`
   com `customer_id` — praticamente todo mundo trata isso como
   anti-padrão em banco relacional, e o motivo é o mesmo: explosão de
   schema, permissão impossível de generalizar, zero query entre linhas.

**Pros:** parece mais "arrumado" olhando a lista de coleções na raiz do console.
**Cons:** todos os 5 pontos acima — nenhum é estético, todos são funcionais.

### Option B: Coleções de nível superior chaveadas por UID (atual) — Recomendada

| Dimensão | Avaliação |
|---|---|
| Complexidade | Já implementada, testada, em produção |
| Isolamento real | Total — UID é a chave em toda regra |
| Queries entre usuários (Admin) | Uma `getDocs`/`where` por coleção, já em uso (`listAllUsers`) |
| Segurança | Uma regra por coleção, genérica pra qualquer usuário |
| Estabilidade do identificador | Alta — UID nunca muda, nunca colide |

**Pros:** é o padrão documentado pelo próprio Firebase pra dado
multi-tenant; todas as libs (`userProfile.ts`, `userSecrets.ts`,
`usageQuota.ts`, `catalogHistory.ts`, `sharedCatalogs.ts`) e
`firestore.rules` já seguem isso; zero migração.
**Cons:** pra ver "tudo do Cleber" você precisa saber em quais coleções
olhar e cruzar pelo UID manualmente no Console — não existe uma "pasta"
visual única. É o único ponto real da reclamação original, e é resolvido
por UI (Admin), não por schema — ver Action Items.

### Option C: Subcoleções sob `users/{uid}/...` — alternativa válida, maior custo

Mover o que é 1:N por usuário (`catalog_uploads`, `usage_daily`) pra
dentro do próprio doc do usuário: `users/{uid}/catalog_uploads/{autoId}`,
`users/{uid}/usage_daily/{yyyymmdd}`. No Console, abrir `users/{uid}`
mostra essas subcoleções aninhadas ali dentro — o mais perto que o
Firestore chega da "pastinha do Cleber com tudo dentro" mantendo UID (não
nome) como chave.

| Dimensão | Avaliação |
|---|---|
| Complexidade | Média — path muda, lógica de isolamento não |
| Isolamento real | Total (igual Opção B) |
| Queries entre usuários (Admin) | `collectionGroup("catalog_uploads")` no lugar de `collection(...)` — continua possível |
| Custo de migração | Real: reescrever 2 libs, `firestore.rules`, `firestore.indexes.json`, e migrar documentos existentes (Firestore não tem "mover coleção" — é ler tudo do path antigo e regravar no novo) |
| Ganho | Só navegação no Console — nenhuma capacidade nova |

**Pros:** resolve a navegação visual sem sacrificar isolamento ou query.
**Cons:** custo de migração pago agora por um benefício que é só
visual/organizacional — e o mesmo benefício dá pra ter com uma tela de
Admin, sem tocar em dado já gravado (ver Decision).

## Trade-off Analysis

A pergunta certa não é "como deixar bonito no console", é "o que
identifica um usuário de forma confiável". A resposta é sempre UID, nunca
nome — isso já está certo no projeto hoje. Coleção-por-nome (Opção A)
troca uma garantia forte (UID único e imutável do Firebase Auth) por uma
fraca (string editável, sem garantia de unicidade), só pra ganhar uma
lista mais curta na raiz do console — perde muito mais do que ganha.

Entre B (manter) e C (subcoleções), a decisão é sobre **onde pagar o
custo de organização**: no schema (C: migração real, uma vez) ou na
camada de apresentação (B + tela de Admin: sem migração, sem risco em
dado existente, entregue em uma sessão). Como o Admin panel já existe e
já lê `users`, `catalog_uploads` etc. individualmente, estender ele com
um filtro "ver tudo de um usuário" é estritamente mais barato que migrar
schema — e resolve o mesmo incômodo.

## Consequences

- **Fica mais fácil:** a reclamação de "mistura" tem uma resposta
  concreta e barata (tela de Admin), sem precisar decidir sobre migração
  de schema agora.
- **Fica mais difícil:** nada muda no código hoje — esta ADR é
  diagnóstico, a Opção C fica registrada como caminho futuro caso a dor
  seja especificamente navegar o Console do Firebase (não a lógica do
  app, que já isola corretamente).
- **Precisa revisitar:** se um dia `catalog_uploads` crescer a ponto de
  a consulta por usuário (hoje `where userId == + orderBy uploadedAt`)
  não bastar, migrar pra subcoleção (Opção C) resolve tanto a
  navegabilidade quanto abre `collectionGroup` pra analytics entre
  usuários — mas isso é motivado por escala, não por organização visual.

## Action Items

1. [x] **Feito** — Admin agora tem detalhe expansível por usuário
   (`Admin.tsx`): clicar numa linha mostra plano, admin, se tem chave
   SerpApi cadastrada (via flag `hasSerpApiKey` denormalizada em
   `users/{uid}` — nunca lê `user_secrets` de outro uid), uso de hoje
   (`usage_daily`) e os últimos 5 catálogos (`catalog_uploads`). Exigiu
   2 mudanças pontuais em `firestore.rules`: `allow read` (só leitura)
   pra admin em `usage_daily` e `catalog_uploads`, que antes eram
   estritamente owner-only. **Precisa de novo `firebase deploy --only
   firestore:rules` pra funcionar em produção** (mesma pegadinha de
   sempre — regra nova só vale depois do deploy).
2. [x] Nenhuma mudança de schema — Opção B permanece como está.
3. [ ] Se decidir migrar pra Opção C no futuro: script de migração
   (ler `catalog_uploads`/`usage_daily` atuais, regravar sob
   `users/{uid}/...`, apagar os antigos), atualizar `catalogHistory.ts`,
   `usageQuota.ts`, `firestore.rules` e `firestore.indexes.json`, e
   trocar a query do Admin pra `collectionGroup`.
