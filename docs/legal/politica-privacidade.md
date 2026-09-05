# Política de Privacidade — Arbitra

> ⚠️ **AVISO IMPORTANTE, NÃO REMOVER ANTES DE PUBLICAR:** rascunho técnico
> escrito por um assistente de IA a partir da leitura real do código
> (`firestore.rules`, `api/_lib/userSecrets.ts`, `src/lib/catalogImages.ts`
> e afins) — não é aconselhamento jurídico. Antes de publicar, um advogado
> precisa confirmar especialmente: (a) a base legal de cada tratamento
> listado abaixo, (b) se a transferência internacional de dados (Firebase/
> Google Cloud, possivelmente fora do Brasil) exige cláusula específica no
> seu caso, e (c) os campos marcados `[PREENCHER]`.

**Última atualização:** `[PREENCHER — data de publicação]`

Esta política descreve como o Arbitra trata dados pessoais, em conformidade
com a Lei Geral de Proteção de Dados (Lei 13.709/2018, LGPD).

## 1. Quem é o controlador

`[PREENCHER — mesmo responsável identificado nos Termos de Uso: nome/razão
social, CNPJ se houver, contato do encarregado/DPO ou, na ausência de um,
o e-mail de contato pra assuntos de privacidade]`.

## 2. Quais dados coletamos e por quê

| Dado | Onde fica | Pra que serve | Base legal (LGPD) |
|---|---|---|---|
| E-mail, senha (via provedor de autenticação) | Firebase Authentication | Login e identificação da conta | Execução de contrato (art. 7º, V) |
| Plano da conta (Free/Starter/Pro), flag de admin | Firestore, `users/{uid}` | Controlar limite de uso e acesso à biblioteca de catálogos | Execução de contrato |
| Catálogo enviado (nome, SKU, preço de custo, foto do produto) | Processado no navegador; histórico salvo em `users/{uid}/catalog_uploads` | Calcular preço de mercado e margem, permitir retomar buscas anteriores | Execução de contrato |
| Foto do produto (upload temporário) | `users/{uid}/catalog_images`, URL pública temporária servida por `api/catalog-image.ts` | Permitir que o mecanismo de busca por imagem compare a foto do catálogo com anúncios do marketplace | Execução de contrato |
| Chave de API de terceiro cadastrada pelo usuário (BYOK) | `users/{uid}/secrets/keys` | Autenticar as buscas feitas em nome do próprio usuário nos serviços de terceiro que ele escolheu | Execução de contrato |
| Contador de buscas do dia | `users/{uid}/usage_daily` | Mostrar e (conforme o plano) aplicar o teto diário de uso | Execução de contrato / legítimo interesse (prevenção a abuso) |
| Preferência de tema/aparência | `users/{uid}/preferences` | Lembrar a preferência de exibição do usuário | Legítimo interesse |
| `[PREENCHER, se aplicável]` Dado de pagamento (não o número do cartão em si — isso fica com o processador de pagamento) | Processador de pagamento (ex.: Mercado Pago) | Cobrança recorrente do plano pago | Execução de contrato |

Não coletamos dado sensível (LGPD art. 5º, II) de propósito — se o catálogo
enviado pelo usuário contiver, incidentalmente, esse tipo de informação, o
tratamento é de responsabilidade de quem enviou o arquivo.

## 3. Com quem compartilhamos

Pra que a busca de preço funcione, o texto/foto de um produto do catálogo é
enviado ao(s) mecanismo(s) de busca que o **usuário escolheu** usar naquela
busca. Dependendo da escolha, isso pode incluir:

- **Provedores de IA de visão:** Google Gemini API, Mistral AI API (leem a
  foto do produto pra descrevê-la/compará-la);
- **Provedores de busca:** SerpApi, SearchApi.io, RapidAPI, Unwrangle,
  ScraperAPI (recebem o nome do produto ou a foto pra buscar candidatos);
- **APIs oficiais de marketplace:** Mercado Livre (OAuth), Amazon (PA-API);
- **Infraestrutura:** Firebase/Google Cloud (hospedagem de dados,
  autenticação) e Vercel (hospedagem da aplicação e das funções de
  servidor) — ambos podem processar dados fora do Brasil (transferência
  internacional, LGPD art. 33 — `[PREENCHER: confirmar salvaguarda
  aplicável, ex. cláusulas-padrão contratuais dos próprios provedores]`).

Quando o mecanismo escolhido é BYOK, é a **chave do próprio usuário** que
autentica essa chamada — o provedor terceiro trata esse tratamento como
sendo diretamente com o usuário, não com o Arbitra.

Não vendemos dado pessoal a terceiro, e não usamos os dados do catálogo do
usuário para treinar modelo de IA próprio.

## 4. Retenção e exclusão

- Foto de produto (upload temporário) expira automaticamente após um prazo
  curto (TTL configurado no Firestore);
- Histórico de buscas (`catalog_uploads`) permanece até o usuário excluir
  manualmente ou encerrar a conta;
- Ao excluir a conta (disponível na tela de Conta), os dados nas
  subcoleções do próprio usuário são removidos;
- Cache de preço (`market_prices`) expira em algumas horas.

## 5. Seus direitos (LGPD art. 18)

Você pode solicitar, a qualquer momento: confirmação do tratamento, acesso
aos dados, correção, anonimização/eliminação de dado desnecessário,
portabilidade, informação sobre compartilhamento, e revogação de
consentimento (quando o tratamento depender dele). Muitos desses direitos
já são autoatendidos na própria tela de Conta (editar preferências, remover
chave de API, excluir a conta); pra qualquer outro pedido, contato:
`[PREENCHER — e-mail de privacidade/DPO]`.

## 6. Segurança

Adotamos controles técnicos e organizacionais proporcionais ao risco:
autenticação obrigatória nas rotas de servidor, isolamento de dado por
usuário no banco (regras de acesso), e chave de API de terceiro nunca
exposta de volta ao navegador depois de cadastrada. Nenhum sistema é
inviolável — em caso de incidente de segurança que gere risco relevante ao
titular, notificaremos conforme exigido pela LGPD (art. 48).

## 7. Cookies e armazenamento local

O Arbitra usa armazenamento local do navegador (via Firebase Authentication)
pra manter a sessão de login — não usamos cookie de rastreamento
publicitário nem compartilhamos dado de navegação com rede de anúncios.

## 8. Alterações desta política

`[PREENCHER — mesmo mecanismo de aviso descrito nos Termos de Uso.]`
