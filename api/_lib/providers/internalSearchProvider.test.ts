import { afterEach, describe, expect, it, vi } from "vitest";
import {
  buildAmazonSearchUrl,
  buildMercadoLivreSearchUrl,
  detectBlock,
  fetchStoreOffers,
  parseAmazonHtml,
  parseBrazilianPrice,
  parseJsonLdOffers,
  parseMercadoLivreHtml,
} from "./internalSearchProvider";
import type { MarketplaceMatcher } from "./googleShoppingProvider";

/**
 * Estes testes são a rede de segurança do motor interno. Diferente de um
 * provider de API (que tem contrato publicado), aqui a "interface" é o
 * HTML da loja, que pode mudar sem aviso. A hora de descobrir que o
 * parser quebrou é aqui — não em produção, com o usuário achando que o
 * catálogo dele é que está ruim.
 *
 * As fixtures reproduzem os marcadores estruturais reais de cada loja
 * (classes do design system Andes no Mercado Livre; `data-asin` e
 * `a-offscreen` na Amazon), enxutas pro que o parser de fato lê.
 *
 * ⚠️ Quando uma loja mudar o layout: atualize a fixture com um trecho do
 * HTML novo e ajuste o parser até o teste voltar a passar. Não relaxe a
 * asserção pra "passar" — um parser que aceita qualquer coisa devolve
 * preço errado em silêncio, que é o pior resultado possível aqui.
 */

// Preenchimento pra fixture passar do piso de 2000 chars do detectBlock
// (página real de busca tem dezenas de KB; resposta curta é sinal de
// bloqueio, ver detectBlock).
const FILLER = `<div class="pad">${"x".repeat(2500)}</div>`;

const ML_HTML = `
<html><body>
<ol class="ui-search-layout">
  <li class="ui-search-layout__item">
    <div class="poly-card poly-card--grid">
      <img class="poly-component__picture" data-src="https://http2.mlstatic.com/D_111-O.webp" src="data:image/gif;base64,R0lGOD"/>
      <h3 class="poly-component__title-wrapper">
        <a class="poly-component__title" href="https://produto.mercadolivre.com.br/MLB-111">Fone de Ouvido Bluetooth JBL Tune 510BT Preto</a>
      </h3>
      <div class="poly-price__current">
        <span class="andes-money-amount andes-money-amount--cents-superscript">
          <span class="andes-money-amount__currency-symbol">R$</span>
          <span class="andes-money-amount__fraction">249</span>
          <span class="andes-money-amount__cents andes-money-amount__cents--superscript">90</span>
        </span>
      </div>
      <span class="poly-component__sold">+5mil vendidos</span>
    </div>
  </li>
  <li class="ui-search-layout__item">
    <div class="poly-card poly-card--grid">
      <img class="poly-component__picture" data-src="https://http2.mlstatic.com/D_222-O.webp"/>
      <h3 class="poly-component__title-wrapper">
        <a class="poly-component__title" href="https://produto.mercadolivre.com.br/MLB-222">Fone Gamer Headset RGB Com Fio</a>
      </h3>
      <div class="poly-price__current">
        <span class="andes-money-amount">
          <span class="andes-money-amount__currency-symbol">R$</span>
          <span class="andes-money-amount__fraction">1.299</span>
          <span class="andes-money-amount__cents">50</span>
        </span>
      </div>
      <span class="poly-component__sold">120 vendidos</span>
    </div>
  </li>
</ol>
${FILLER}
</body></html>`;

const AMAZON_HTML = `
<html><body>
<div class="s-main-slot">
  <div data-asin="B0ABC12345" data-component-type="s-search-result" class="s-result-item">
    <img class="s-image" src="https://m.media-amazon.com/images/I/71abc.jpg"/>
    <h2 class="a-size-base-plus a-color-base"><span>Fone de Ouvido Bluetooth JBL Tune 510BT Preto</span></h2>
    <span class="a-price" data-a-size="xl"><span class="a-offscreen">R$ 249,90</span><span aria-hidden="true"><span class="a-price-symbol">R$</span><span class="a-price-whole">249</span></span></span>
    <span class="a-icon-alt">4,6 de 5 estrelas</span>
    <a class="a-link-normal" aria-label="1.234 avaliações"></a>
  </div>
  <div data-asin="B0XYZ98765" data-component-type="s-search-result" class="s-result-item">
    <img class="s-image" src="https://m.media-amazon.com/images/I/81xyz.jpg"/>
    <h2 class="a-size-base-plus a-color-base"><span>Headset Gamer RGB Com Fio USB</span></h2>
    <span class="a-price"><span class="a-offscreen">R$ 1.299,50</span></span>
    <span class="a-icon-alt">4,1 de 5 estrelas</span>
  </div>
</div>
${FILLER}
</body></html>`;

describe("parseBrazilianPrice", () => {
  it("le formato brasileiro com separador de milhar e centavos", () => {
    expect(parseBrazilianPrice("R$ 1.299,50")).toBe(1299.5);
    expect(parseBrazilianPrice("249,90")).toBe(249.9);
    expect(parseBrazilianPrice("R$ 99")).toBe(99);
  });

  it("rejeita entrada sem número ou com valor não positivo", () => {
    expect(parseBrazilianPrice("")).toBeNull();
    expect(parseBrazilianPrice(null)).toBeNull();
    expect(parseBrazilianPrice("Frete grátis")).toBeNull();
    expect(parseBrazilianPrice("0,00")).toBeNull();
  });
});

describe("parseMercadoLivreHtml", () => {
  it("extrai título, preço, link e foto de cada card", () => {
    const offers = parseMercadoLivreHtml(ML_HTML);

    expect(offers).toHaveLength(2);
    expect(offers[0]).toMatchObject({
      title: "Fone de Ouvido Bluetooth JBL Tune 510BT Preto",
      price: 249.9,
      link: "https://produto.mercadolivre.com.br/MLB-111",
      thumbnail: "https://http2.mlstatic.com/D_111-O.webp",
    });
  });

  it("junta parte inteira e centavos — regressão: preço do ML vem quebrado em dois elementos", () => {
    const offers = parseMercadoLivreHtml(ML_HTML);

    // Sem juntar `__fraction` + `__cents`, isto viraria 1299 ou 50.
    expect(offers[1].price).toBe(1299.5);
  });

  it("le o sinal de popularidade (vendidos), incluindo a forma abreviada com 'mil'", () => {
    const offers = parseMercadoLivreHtml(ML_HTML);

    expect(offers[0].reviewCount).toBe(5000);
    expect(offers[1].reviewCount).toBe(120);
  });

  it("prefere data-src ao src — o src inicial é placeholder de lazy-load, não a foto", () => {
    const offers = parseMercadoLivreHtml(ML_HTML);

    expect(offers[0].thumbnail).not.toContain("base64");
  });

  it("devolve lista vazia (sem quebrar) quando o HTML não tem card nenhum", () => {
    expect(parseMercadoLivreHtml("<html><body>nada aqui</body></html>")).toEqual([]);
  });
});

describe("parseAmazonHtml", () => {
  it("extrai título, preço, link por ASIN e foto", () => {
    const offers = parseAmazonHtml(AMAZON_HTML);

    expect(offers).toHaveLength(2);
    expect(offers[0]).toMatchObject({
      title: "Fone de Ouvido Bluetooth JBL Tune 510BT Preto",
      price: 249.9,
      link: "https://www.amazon.com.br/dp/B0ABC12345",
      thumbnail: "https://m.media-amazon.com/images/I/71abc.jpg",
    });
    expect(offers[1].price).toBe(1299.5);
  });

  it("le nota e nº de avaliações no formato pt-BR (vírgula decimal)", () => {
    const offers = parseAmazonHtml(AMAZON_HTML);

    expect(offers[0].rating).toBe(4.6);
    expect(offers[0].reviewCount).toBe(1234);
  });

  it("ignora card sem preço em vez de inventar um", () => {
    const semPreco = `<div data-asin="B0NOPRICE1" data-component-type="s-search-result">
      <h2><span>Produto Sem Preço Anunciado</span></h2>
    </div>`;

    expect(parseAmazonHtml(semPreco)).toEqual([]);
  });

  it("não duplica o mesmo ASIN (aparece de novo em carrossel de patrocinado)", () => {
    const duplicado = AMAZON_HTML + AMAZON_HTML;

    const asins = parseAmazonHtml(duplicado).map((o) => o.link);
    expect(new Set(asins).size).toBe(asins.length);
  });
});

describe("parseJsonLdOffers", () => {
  it("extrai produtos de um ItemList (camada preferida — padrão web, muda menos que CSS)", () => {
    const html = `<script type="application/ld+json">
    {"@context":"https://schema.org","@type":"ItemList","itemListElement":[
      {"@type":"ListItem","item":{"@type":"Product","name":"Cafeteira Expresso 220v",
       "url":"https://loja.com/p/1","image":"https://loja.com/1.jpg",
       "offers":{"@type":"Offer","price":"499.90","priceCurrency":"BRL"},
       "aggregateRating":{"ratingValue":"4.7","reviewCount":"88"}}}
    ]}</script>`;

    const offers = parseJsonLdOffers(html);

    expect(offers).toHaveLength(1);
    expect(offers[0]).toMatchObject({
      title: "Cafeteira Expresso 220v",
      price: 499.9,
      link: "https://loja.com/p/1",
      rating: 4.7,
      reviewCount: 88,
    });
  });

  it("ignora bloco de JSON-LD malformado sem derrubar o parse dos demais", () => {
    const html = `
      <script type="application/ld+json">{ isto não é json }</script>
      <script type="application/ld+json">
      {"@type":"Product","name":"Produto Válido","offers":{"price":"10.00"}}
      </script>`;

    expect(parseJsonLdOffers(html)).toHaveLength(1);
  });
});

describe("detectBlock", () => {
  it("classifica HTTP 403 como bloqueio de IP, com instrução acionável", () => {
    const reason = detectBlock(403, "", "Amazon");

    expect(reason).toContain("403");
    expect(reason).toMatch(/bloquead|IP/i);
  });

  it(
    "a alternativa sugerida no 403 tem que EXISTIR no seletor — regressão real (set/2026): a mensagem " +
      'mandava "use RapidAPI/Mercado Livre", que saíram do grid (ver AB_TEST_PROVIDER_IDS em ' +
      "Dashboard.tsx), então o usuário procurava uma opção inexistente e achava que o app tinha quebrado",
    () => {
      const reason = detectBlock(403, "", "Amazon")!;

      expect(reason).toMatch(/ScraperAPI|SearchApi\.io/);
      expect(reason).not.toMatch(/RapidAPI/i);
    }
  );

  it("detecta CAPTCHA servido com HTTP 200 (o status sozinho não denuncia)", () => {
    const captcha = `<html><body><form action="/errors/validateCaptcha">
      Digite os caracteres que aparecem na imagem</form>${FILLER}</body></html>`;

    expect(detectBlock(200, captcha, "Amazon")).toMatch(/CAPTCHA/i);
  });

  it("trata resposta curta demais como bloqueio silencioso, não como busca vazia", () => {
    expect(detectBlock(200, "<html></html>", "Mercado Livre")).toMatch(/vazia|curta/i);
  });

  it("não acusa bloqueio numa página de busca legítima", () => {
    expect(detectBlock(200, ML_HTML, "Mercado Livre")).toBeNull();
    expect(detectBlock(200, AMAZON_HTML, "Amazon")).toBeNull();
  });
});

describe("fetchStoreOffers", () => {
  const MATCHERS: MarketplaceMatcher[] = [{ marketplace: "mercadolivre", matchesSource: () => true }];

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it(
    "avisa (console.warn) quando a página vem íntegra mas o parser não reconhece nenhuma oferta — " +
      "sem isso, layout que mudou (ou bloqueio disfarçado de página normal) ficava 100% silencioso, " +
      "sem NENHUM rastro no log (causa real de um catálogo inteiro voltar zerado sem erro visível)",
    async () => {
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
      const paginaSemCardsReconheciveis = `<html><body><div class="layout-novo-desconhecido">${"x".repeat(2500)}</div></body></html>`;
      vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValue({
          status: 200,
          text: async () => paginaSemCardsReconheciveis,
        } as unknown as Response)
      );

      const result = await fetchStoreOffers("produto qualquer", MATCHERS);

      expect(result).toHaveLength(1);
      expect(result[0].offers).toEqual([]);
      expect(warnSpy).toHaveBeenCalledWith(expect.stringMatching(/0 ofertas/));
      warnSpy.mockRestore();
    }
  );

  it("não avisa quando a página tem ofertas reconhecíveis (só o caminho de 0 ofertas é digno de aviso)", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({ status: 200, text: async () => ML_HTML } as unknown as Response)
    );

    const result = await fetchStoreOffers("fone bluetooth", MATCHERS);

    expect(result[0].offers.length).toBeGreaterThan(0);
    expect(warnSpy).not.toHaveBeenCalled();
    warnSpy.mockRestore();
  });
});

describe("fetchStoreHtml — retry em 503", () => {
  const MATCHERS: MarketplaceMatcher[] = [{ marketplace: "mercadolivre", matchesSource: () => true }];

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it(
    "recupera numa tentativa seguinte quando o 503 é transitório — regressão do lote inteiro " +
      "descartado por 'Amazon devolveu HTTP 503' quando bastava tentar de novo (relato real, ago/2026)",
    async () => {
      let calls = 0;
      vi.stubGlobal(
        "fetch",
        vi.fn(async () => {
          calls++;
          return calls < 3
            ? ({ status: 503, text: async () => "" } as unknown as Response)
            : ({ status: 200, text: async () => ML_HTML } as unknown as Response);
        })
      );

      const result = await fetchStoreOffers("produto qualquer", MATCHERS);

      expect(calls).toBe(3); // 1ª tentativa + 2 retries até acertar
      expect(result[0].offers.length).toBeGreaterThan(0);
    },
    10000
  );

  it("desiste depois de esgotar as tentativas extras se o 503 persistir", async () => {
    let calls = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        calls++;
        return { status: 503, text: async () => "" } as unknown as Response;
      })
    );

    await expect(fetchStoreOffers("produto qualquer", MATCHERS)).rejects.toThrow(/503/);
    expect(calls).toBe(3); // 1ª tentativa + 2 retries, todas 503
  }, 10000);

  it("NÃO retenta em 403 (bloqueio explícito, persistente) — só 503 justifica a espera", async () => {
    let calls = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        calls++;
        return { status: 403, text: async () => "" } as unknown as Response;
      })
    );

    await expect(fetchStoreOffers("produto qualquer", MATCHERS)).rejects.toThrow();
    expect(calls).toBe(1); // sem retry — 403 não é transitório
  });
});

describe("fetchStoreHtmlOnce — proxy ScraperAPI (BYOK, set/2026)", () => {
  const MATCHERS: MarketplaceMatcher[] = [{ marketplace: "mercadolivre", matchesSource: () => true }];

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("sem scraperApiKey, continua indo direto na loja com os headers de navegador — comportamento antigo intacto", async () => {
    let calledUrl = "";
    let calledHeaders: RequestInit["headers"];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        calledUrl = url;
        calledHeaders = init?.headers;
        return { status: 200, text: async () => ML_HTML } as unknown as Response;
      })
    );

    await fetchStoreOffers("produto qualquer", MATCHERS);

    expect(calledUrl).toContain("mercadolivre.com.br");
    expect(calledUrl).not.toContain("scraperapi.com");
    expect(calledHeaders).toMatchObject({ "User-Agent": expect.stringContaining("Mozilla") });
  });

  it(
    "com scraperApiKey (BYOK do usuário, passada por parâmetro), chama o endpoint do ScraperAPI " +
      "(api_key + url da loja como parâmetro) em vez de ir direto na loja, sem sobrepor header próprio " +
      "— mesmos parsers, só o transporte HTTP muda",
    async () => {
      let calledUrl = "";
      let calledHeaders: RequestInit["headers"];
      vi.stubGlobal(
        "fetch",
        vi.fn(async (url: string, init?: RequestInit) => {
          calledUrl = url;
          calledHeaders = init?.headers;
          return { status: 200, text: async () => ML_HTML } as unknown as Response;
        })
      );

      await fetchStoreOffers("produto qualquer", MATCHERS, "chave-de-teste");

      expect(calledUrl).toContain("https://api.scraperapi.com/?api_key=chave-de-teste&url=");
      expect(calledUrl).toContain("mercadolivre.com.br"); // URL da loja vai como parâmetro, não como destino
      // premium=true (pool residencial/mobile) — ago/2026, relato real: com
      // proxy ativo e AINDA ASSIM Amazon+ML bloqueando, o pool datacenter
      // padrão da ScraperAPI também já estava visado (ver comentário em
      // fetchStoreHtmlOnce, internalSearchProvider.ts).
      expect(calledUrl).toContain("premium=true");
      expect(calledHeaders).toBeUndefined(); // ScraperAPI monta os próprios headers do lado dele
    }
  );
});

describe("construção de URL de busca", () => {
  it("monta slug do Mercado Livre sem acento nem caractere especial (a URL deles é por caminho, não query)", () => {
    expect(buildMercadoLivreSearchUrl("Cafeteira Expresso 220v")).toBe(
      "https://lista.mercadolivre.com.br/cafeteira-expresso-220v"
    );
    expect(buildMercadoLivreSearchUrl("Óculos de Proteção (EPI)")).toBe(
      "https://lista.mercadolivre.com.br/oculos-de-protecao-epi"
    );
  });

  it("monta busca da Amazon com o termo escapado em query string", () => {
    const url = buildAmazonSearchUrl("Óculos de Proteção");

    expect(url).toContain("https://www.amazon.com.br/s?");
    expect(url).toContain("k=%C3%93culos+de+Prote%C3%A7%C3%A3o");
  });
});
