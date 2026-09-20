import { useEffect, useState, type ReactNode } from "react";
import { motion } from "framer-motion";
import { ChevronDown, Copy, Check as CheckIcon, HelpCircle } from "lucide-react";
import styles from "./Faq.module.css";

interface FaqItem {
  question: string;
  /** Aceita JSX (ver CatalogGuideAnswer) pra itens que precisam de imagem/botão, não só texto corrido. */
  answer: string | ReactNode;
  /**
   * Âncora estável pra abrir esta pergunta direto de outra tela (ver aviso
   * de erro de parsing em Dashboard.tsx, `/faq#<anchor>`) — diferente da
   * key `grupo-índice` usada internamente pro accordion, que muda se a
   * ordem dos itens mudar.
   */
  anchor?: string;
}

interface FaqGroup {
  title: string;
  items: FaqItem[];
}

/**
 * Prompt de base (set/2026, pedido explícito do usuário) pra quem tem um
 * catálogo bagunçado colar num agente de IA de sua preferência (ChatGPT,
 * Claude, etc.) e pedir pra reformatar no padrão que o Arbitra reconhece
 * de forma confiável. Pede saída em CSV, não em PDF novo — um agente de
 * texto não controla bem layout visual de PDF, mas acerta uma tabela CSV
 * de primeira, e o parser do site lê CSV sem depender de heurística de
 * layout nenhuma (ver parseCatalog.ts). A instrução "não invente dado" é
 * a parte mais importante: sem ela, IA generativa tende a completar
 * lacuna com estimativa plausível, contaminando o catálogo em silêncio.
 */
const CATALOG_PROMPT = `Tenho um catálogo de produtos de fornecedor (anexo) com formato bagunçado. Preciso que você reorganize essas informações em uma tabela CSV limpa, com exatamente estas colunas, nesta ordem:

SKU;Nome;Custo;EAN

Regras:
- Use ; (ponto e vírgula) como separador de coluna.
- SKU: código/referência do produto no catálogo original. Se não existir, deixe em branco — não invente um código.
- Nome: nome/descrição do produto, sem código de referência interno, sem medida de embalagem (ex: "9x10cm") misturados no texto.
- Custo: preço de custo do fornecedor, em formato 1234,56 (vírgula decimal) ou 1234.56. Se o produto não tiver preço, deixe em branco.
- EAN: código de barras (EAN/GTIN), só se existir no catálogo original. Se não tiver essa informação, deixe a coluna vazia — não invente.
- Uma linha por produto. Não crie linhas de categoria, título de seção ou subtotal.
- Não invente, estime ou complete nenhum dado que não esteja claramente presente no arquivo original — se uma informação estiver ilegível ou ausente, deixe o campo vazio.
- Devolva só a tabela final em CSV (não em markdown, não em texto explicativo) pronta pra eu baixar como arquivo .csv.`;

function CatalogGuideAnswer() {
  const [copied, setCopied] = useState(false);

  async function handleCopy() {
    try {
      await navigator.clipboard.writeText(CATALOG_PROMPT);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // Clipboard pode falhar por permissão do navegador (raro, mas
      // acontece em iframe/contexto restrito) — sem isso o clique parecia
      // não fazer nada, sem nenhuma pista do porquê.
      window.prompt("Não consegui copiar automaticamente — copie o texto abaixo:", CATALOG_PROMPT);
    }
  }

  return (
    <div className={styles.guideAnswer}>
      <p>
        Estas imagens são <b>ilustrativas</b> — o layout do seu catálogo pode ser em grade (3×3, 4×4,
        qualquer tamanho), lista de linha única, ou outro arranjo. O que realmente importa é que cada
        produto tenha <b>foto, nome, código e preço</b> identificáveis, não o desenho exato da imagem
        abaixo.
      </p>
      <div className={styles.guideImages}>
        <figure className={styles.guideFigure}>
          <img
            src="/exemplo-catalogo-pdf.png"
            alt="Exemplo ilustrativo de catálogo em PDF com foto, nome, código e preço de cada produto"
            className={styles.guideImage}
          />
          <figcaption>Exemplo ilustrativo — catálogo em PDF</figcaption>
        </figure>
        <figure className={styles.guideFigure}>
          <img
            src="/exemplo-planilha.png"
            alt="Exemplo ilustrativo de planilha com colunas SKU, Nome, Custo e EAN"
            className={styles.guideImage}
          />
          <figcaption>Exemplo ilustrativo — planilha (CSV/XLSX)</figcaption>
        </figure>
      </div>
      <p>
        Já tem um catálogo bagunçado? Baixe nosso <b>modelo de planilha</b> pra ver o formato exato
        esperado, ou cole o prompt abaixo num agente de IA (ChatGPT, Claude, etc.) junto com o seu
        arquivo — ele reorganiza tudo no padrão certo pra você.
      </p>
      <a href="/modelo-catalogo.xlsx" download className={styles.guideDownloadLink}>
        Baixar planilha modelo (.xlsx)
      </a>
      <div className={styles.promptBox}>
        <pre className={styles.promptText}>{CATALOG_PROMPT}</pre>
        <button type="button" className={styles.copyButton} onClick={() => void handleCopy()}>
          {copied ? <CheckIcon size={13} /> : <Copy size={13} />}
          {copied ? "Copiado!" : "Copiar prompt"}
        </button>
      </div>
    </div>
  );
}

// Conteúdo baseado no que o app realmente faz hoje (mensagens de erro,
// nomes de mecanismo, formatos aceitos) — ver Dashboard.tsx, parseCatalog.ts
// e visionInternalSearchProvider.ts. Atualizar aqui sempre que uma dessas
// peças mudar de nome/comportamento, senão a dúvida "documentada" fica
// desatualizada em relação ao que a tela realmente mostra.
const FAQ_GROUPS: FaqGroup[] = [
  {
    title: "Cadastro e arquivo",
    items: [
      {
        question: "Qual formato de catálogo dá o melhor resultado? (com exemplo e prompt pronto)",
        answer: <CatalogGuideAnswer />,
        anchor: "catalogo-ideal",
      },
      {
        question: "Quais formatos de catálogo o Arbitra aceita?",
        answer:
          "Planilha (.xlsx ou .xlsm), CSV (.csv) e PDF (.pdf). A planilha e o CSV precisam ter, no mínimo, " +
          "uma coluna de SKU/código e uma de custo/preço — o nome do produto é opcional, mas melhora bastante " +
          "a precisão da busca. .xls antigo não é lido: reexporte como .xlsx ou .csv direto no Excel.",
      },
      {
        question: "Deu erro \"Não encontrei colunas de SKU e/ou custo\" — o que fazer?",
        answer:
          "O app tenta reconhecer a coluna de código (sku, código, cod) e a de custo (custo, preço, valor, price, cost) " +
          "pelo nome do cabeçalho, aceitando variações comuns em português e inglês — inclusive quando o nome vem " +
          "decorado, tipo \"Custo (R$)\" ou \"Nome do Produto\". Se a primeira linha da planilha for um título/instrução " +
          "(não o cabeçalho de verdade), o app já procura automaticamente nas próximas linhas. Se a mensagem ainda " +
          "assim aparecer, é porque nenhuma das primeiras linhas tem uma coluna reconhecível de código OU de custo — " +
          "renomeie o cabeçalho pra um dos nomes aceitos acima.",
      },
      {
        question: "Posso subir um PDF de catálogo com fotos, sem tabela?",
        answer:
          "Sim — o Arbitra faz OCR automaticamente quando o PDF não tem texto selecionável, e nesse caso também " +
          "consegue extrair a foto de cada produto pra usar nos mecanismos de \"busca por foto\". Catálogos grandes " +
          "podem pedir um intervalo de páginas antes de processar, pra não estourar tempo/limite de uma vez só.",
      },
    ],
  },
  {
    title: "Motores e APIs de busca",
    items: [
      {
        question: "Qual a diferença entre \"busca por texto\" e \"busca por foto\"?",
        answer:
          "Busca por texto usa o NOME do produto (da planilha/CSV) pra procurar o preço equivalente no marketplace — " +
          "mais rápida e não depende de imagem. Busca por foto usa a FOTO do produto (extraída de um PDF ou de um " +
          "anúncio) pra comparar visualmente e confirmar que é o mesmo item — mais precisa quando o nome do catálogo " +
          "é vago, mas mais lenta.",
      },
      {
        question: "O que é o \"Motor interno + IA\" (Gemini/Mistral)?",
        answer:
          "É um mecanismo de busca por foto que usa uma IA de visão (Google Gemini ou Mistral, você escolhe) pra " +
          "descrever o produto da sua foto e depois confirmar visualmente qual anúncio do marketplace é o mesmo item. " +
          "Cada backend de IA tem sua própria chave (grátis, cadastrada em Conta) e você pode escolher qual serviço " +
          "de terceiro (ScraperAPI, SerpApi ou SearchApi.io) ele usa por trás pra buscar os candidatos.",
      },
      {
        question: "Preciso cadastrar chave de API pra usar o Arbitra?",
        answer:
          "Cada mecanismo (menos o \"Mercado Livre — API pública\") pede a SUA PRÓPRIA chave do serviço escolhido — " +
          "modelo \"traga sua própria chave\" (BYOK). É assim porque cada usuário usa a própria cota gratuita do " +
          "provedor, sem depender de uma cota compartilhada que se esgota rápido com muita gente usando ao mesmo " +
          "tempo. Todas as chaves são cadastradas na tela Conta e nunca reaparecem em texto puro depois de salvas.",
      },
      {
        question: "Qual mecanismo eu devo escolher pro meu catálogo?",
        answer:
          "Se o seu catálogo (CSV/planilha) já tem o nome real do produto, prefira um mecanismo de busca por TEXTO — " +
          "mais rápido e sem custo pago obrigatório. Se o catálogo só tem foto (ou o nome é vago demais pra achar o " +
          "produto certo), use um mecanismo de busca por FOTO. Dentro de cada grupo, o app já indica ao lado de cada " +
          "opção se ela prioriza precisão ou velocidade.",
      },
      {
        question: "O que significa a \"Confiança (%)\" de cada resultado?",
        answer:
          "É o quão seguro o app está de que o anúncio encontrado é o MESMO produto do seu catálogo. Ela pode vir de " +
          "duas formas — \"foto\" (uma IA comparou as imagens) ou \"nome\" (comparação de texto/similaridade) — " +
          "indicado logo ao lado do percentual. Resultados marcados como \"Aproximado\" tiveram confiança baixa ou " +
          "vieram de uma loja diferente da esperada; vale conferir o anúncio antes de decidir preço em cima dele.",
      },
    ],
  },
  {
    title: "Erros comuns",
    items: [
      {
        question: "Apareceu um erro de \"cota esgotada\" — o que é isso?",
        answer:
          "Os provedores de IA (Gemini/Mistral) e de busca (SerpApi, RapidAPI, SearchApi.io) têm um limite de uso " +
          "gratuito por minuto ou por mês. Se a mensagem aparecer, espere o tempo indicado (o app já pausa sozinho " +
          "quando detecta isso) ou cadastre uma chave de outro provedor como alternativa enquanto a cota não renova.",
      },
      {
        question: "A busca no Mercado Livre/Amazon falhou com erro 403 — por quê?",
        answer:
          "É bloqueio anti-robô do próprio marketplace contra acesso automatizado — instabilidade conhecida da busca " +
          "pública. Cadastre uma chave ScraperAPI (Conta → ScraperAPI) pra contornar: o motor interno já tenta usá-la " +
          "automaticamente como reforço quando detecta esse tipo de bloqueio.",
      },
      {
        question: "Por que um produto do catálogo não apareceu nos resultados?",
        answer:
          "As causas mais comuns: nome do produto genérico demais pra encontrar um candidato específico, produto " +
          "descontinuado/sem anúncio ativo no marketplace escolhido, ou o mecanismo de busca bateu na própria cota " +
          "durante aquele lote. A tela de Resultados mostra o motivo por trás de cada \"não encontrado\" quando o " +
          "mecanismo consegue identificar a causa.",
      },
    ],
  },
  {
    title: "Planos e conta",
    items: [
      {
        question: "O que muda entre os planos Free, Starter e Pro?",
        answer:
          "O teto diário de buscas exibido na barra de cota (mais alto em planos pagos) e quais catálogos da " +
          "Biblioteca administrável ficam liberados pra usar direto, sem precisar subir arquivo. A cota real de " +
          "busca em si é sempre a da SUA própria chave (BYOK) em cada provedor — o plano não muda isso.",
      },
      {
        question: "Consigo ver o histórico de catálogos que já processei?",
        answer:
          "Sim, na tela Nova busca (seção \"Catálogos processados\") e também na tela de Resultados, no seletor " +
          "\"ver busca\" — dá pra marcar mais de um catálogo do histórico ao mesmo tempo pra ver os resultados " +
          "combinados numa tabela só.",
      },
    ],
  },
];

const cardMotion = {
  initial: { opacity: 0, y: 8 },
  animate: { opacity: 1, y: 0 },
  transition: { duration: 0.3, ease: [0.16, 1, 0.3, 1] as const },
};

export default function Faq() {
  // Chave única "grupo-índice" — permite que a mesma pergunta (índice)
  // em grupos diferentes abra independentemente.
  const [openKeys, setOpenKeys] = useState<Set<string>>(new Set());

  function toggle(key: string) {
    setOpenKeys((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }

  // Abre e rola até a pergunta certa quando a tela chega via link com
  // âncora (ex: aviso de erro de parsing em Dashboard.tsx apontando pra
  // "/faq#catalogo-ideal") — sem isso, o usuário caía na Central de
  // dúvidas mas precisava procurar manualmente qual pergunta abrir.
  useEffect(() => {
    const anchor = window.location.hash.replace("#", "");
    if (!anchor) return;

    for (const group of FAQ_GROUPS) {
      const i = group.items.findIndex((item) => item.anchor === anchor);
      if (i === -1) continue;
      const key = `${group.title}-${i}`;
      setOpenKeys((prev) => new Set(prev).add(key));
      // Espera o accordion renderizar aberto antes de rolar até ele.
      requestAnimationFrame(() => {
        document.getElementById(`faq-${anchor}`)?.scrollIntoView({ behavior: "smooth", block: "start" });
      });
      break;
    }
  }, []);

  return (
    <motion.div className={styles.container} {...cardMotion}>
      <div className={styles.header}>
        <span className={styles.eyebrow}>Central de dúvidas</span>
        <h1 className={styles.title}>Perguntas frequentes</h1>
        <p className={styles.subtitle}>
          Clique numa pergunta pra abrir a resposta. Cobre os mecanismos de busca, formatos de arquivo
          e os erros mais comuns.
        </p>
      </div>

      {FAQ_GROUPS.map((group) => (
        <section key={group.title} className={styles.group}>
          <h2 className={styles.groupTitle}>{group.title}</h2>
          <div className={styles.itemList}>
            {group.items.map((item, i) => {
              const key = `${group.title}-${i}`;
              const open = openKeys.has(key);
              return (
                <div key={key} id={item.anchor ? `faq-${item.anchor}` : undefined} className={styles.item}>
                  <button
                    type="button"
                    className={styles.itemQuestion}
                    onClick={() => toggle(key)}
                    aria-expanded={open}
                  >
                    <span className={styles.itemQuestionIcon}>
                      <HelpCircle size={14} />
                    </span>
                    <span className={styles.itemQuestionText}>{item.question}</span>
                    <ChevronDown
                      size={14}
                      className={open ? styles.itemChevronOpen : styles.itemChevron}
                    />
                  </button>
                  {open && <div className={styles.itemAnswer}>{item.answer}</div>}
                </div>
              );
            })}
          </div>
        </section>
      ))}
    </motion.div>
  );
}
