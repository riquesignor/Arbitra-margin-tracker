import { useState } from "react";
import { motion } from "framer-motion";
import { ChevronDown, HelpCircle } from "lucide-react";
import styles from "./Faq.module.css";

interface FaqItem {
  question: string;
  answer: string;
}

interface FaqGroup {
  title: string;
  items: FaqItem[];
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
          "pelo nome do cabeçalho, aceitando variações comuns em português e inglês. Se a mensagem aparecer, renomeie " +
          "a primeira linha da planilha pra um desses nomes, ou confirme que a primeira linha realmente é o cabeçalho " +
          "(não uma linha de título/logo antes dela).",
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
                <div key={key} className={styles.item}>
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
                  {open && <p className={styles.itemAnswer}>{item.answer}</p>}
                </div>
              );
            })}
          </div>
        </section>
      ))}
    </motion.div>
  );
}
