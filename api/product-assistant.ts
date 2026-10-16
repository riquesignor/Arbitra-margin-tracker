import type { ApiRequest, ApiResponse } from "./_lib/httpTypes.js";
import type { MarketplaceId, SearchProviderId } from "./_lib/types.js";
import { requireVerifiedAuth, UnauthorizedError, EmailNotVerifiedError } from "./_lib/verifyAuth.js";
import { consumeSearchQuota, QuotaExceededError } from "./_lib/searchQuota.js";
import { fetchPricesCore, FetchPricesValidationError } from "./_lib/fetchPricesCore.js";
import { getUserApiKeyForProvider } from "./_lib/userSecrets.js";
import { getUserPlanFeatures } from "./_lib/planFeatures.js";
import { chatAboutProduct, identifyProductFromPhoto, type ChatTurn } from "./_lib/geminiChat.js";
import { GeminiVisionError } from "./_lib/geminiVision.js";

/**
 * POST /api/product-assistant (out/2026) — "Assistente" do plano pago:
 * o usuário manda a foto de UM produto, o servidor identifica o produto
 * (Gemini, chave BYOK do próprio usuário), busca o preço atual no
 * mercado (mesmo `fetchPricesCore` da Nova busca, provider escolhido pelo
 * usuário) e responde em linguagem natural com preço sugerido. Perguntas
 * seguintes reaproveitam o `context` devolvido aqui (sem nova busca, sem
 * reenviar a foto) — só a 1ª mensagem gasta cota de busca.
 */

/** Providers de busca por TEXTO que o assistente aceita, e os marketplaces que cada um cobre. */
const PROVIDER_MARKETPLACES: Partial<Record<SearchProviderId, MarketplaceId[]>> = {
  serpapi: ["mercadolivre", "amazon"],
  scraperapi: ["mercadolivre", "amazon"],
  rapidapi_amazon: ["amazon"],
};

const ALLOWED_MIME = new Set(["image/jpeg", "image/png", "image/webp"]);
const MAX_IMAGE_BASE64_CHARS = 4_000_000;
const MAX_TURNS = 30;
const MAX_TURN_CHARS = 2000;

export interface AssistantOffer {
  marketplace: MarketplaceId;
  price: number;
  title?: string;
  link?: string;
  competitorCount: number;
  approximate: boolean;
}

export interface AssistantContext {
  query: string;
  offers: AssistantOffer[];
  supplierPrice?: number;
}

interface RequestBody {
  imageBase64?: unknown;
  imageMimeType?: unknown;
  provider?: unknown;
  supplierPrice?: unknown;
  context?: unknown;
  messages?: unknown;
}

const BRL = new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL" });

function buildSystemInstruction(ctx: AssistantContext): string {
  const offers = ctx.offers.length
    ? ctx.offers
        .map(
          (o) =>
            `- ${o.marketplace === "amazon" ? "Amazon" : "Mercado Livre"}: ${BRL.format(o.price)}` +
            `${o.title ? ` ("${o.title}")` : ""}, ${o.competitorCount} vendedor(es)` +
            `${o.approximate ? " — correspondência APROXIMADA, pode não ser o mesmo produto" : ""}`
        )
        .join("\n")
    : "- Nenhuma oferta encontrada nesta busca.";
  return [
    "Você é o Assistente de precificação do Arbitra, ajudando um revendedor brasileiro a decidir",
    "por quanto vender (ou se vale comprar) um produto.",
    `Produto identificado pela foto: ${ctx.query}.`,
    "Ofertas encontradas agora no mercado (dados reais da busca, use SÓ estes números):",
    offers,
    `Custo do produto informado pelo usuário: ${ctx.supplierPrice != null ? BRL.format(ctx.supplierPrice) : "não informado"}.`,
    "Regras: todo valor em R$ que você citar tem que ser um dos preços acima, o custo informado, ou",
    "uma conta explícita feita com eles (ex.: média das ofertas, custo + X%) — mostre a conta. Nunca",
    "cite faixa ou 'média de mercado' que não venha desses números. Se não houver oferta, diga",
    "claramente que não achou preço de referência. Oferta marcada como APROXIMADA pode ser outro",
    "produto: diga isso antes de usá-la como referência. Lembre, quando falar de lucro, que a",
    "margem real depende de taxa do marketplace, frete e imposto (configuráveis na tela Precificação",
    "do Arbitra). Responda em português do Brasil, direto e curto, sem markdown pesado.",
  ].join("\n");
}

function parseTurns(raw: unknown): ChatTurn[] | null {
  if (!Array.isArray(raw) || raw.length === 0 || raw.length > MAX_TURNS) return null;
  const turns: ChatTurn[] = [];
  for (const t of raw) {
    const role = (t as { role?: unknown })?.role;
    const text = (t as { text?: unknown })?.text;
    if ((role !== "user" && role !== "model") || typeof text !== "string" || !text.trim()) return null;
    turns.push({ role, text: text.slice(0, MAX_TURN_CHARS) });
  }
  if (turns[turns.length - 1].role !== "user") return null;
  return turns;
}

function parseContext(raw: unknown): AssistantContext | null {
  const c = raw as Partial<AssistantContext> | undefined;
  if (!c || typeof c.query !== "string" || !Array.isArray(c.offers)) return null;
  const offers: AssistantOffer[] = c.offers
    .filter((o) => typeof o?.price === "number" && Number.isFinite(o.price))
    .slice(0, 5)
    .map((o) => ({
      marketplace: o.marketplace === "amazon" ? "amazon" : "mercadolivre",
      price: o.price,
      title: typeof o.title === "string" ? o.title.slice(0, 200) : undefined,
      link: typeof o.link === "string" ? o.link : undefined,
      competitorCount: typeof o.competitorCount === "number" ? o.competitorCount : 0,
      approximate: o.approximate === true,
    }));
  return {
    query: c.query.slice(0, 200),
    offers,
    supplierPrice: typeof c.supplierPrice === "number" && c.supplierPrice > 0 ? c.supplierPrice : undefined,
  };
}

export default async function handler(req: ApiRequest, res: ApiResponse): Promise<void> {
  if (req.method !== "POST") {
    res.status(405).json({ error: "Método não permitido" });
    return;
  }

  let uid: string;
  try {
    uid = await requireVerifiedAuth(req);
  } catch (err) {
    if (err instanceof UnauthorizedError) {
      res.status(401).json({ error: err.message });
      return;
    }
    if (err instanceof EmailNotVerifiedError) {
      res.status(403).json({ error: err.message });
      return;
    }
    throw err;
  }

  const features = await getUserPlanFeatures(uid);
  if (!features.productAssistant) {
    res.status(403).json({ error: "O Assistente de produto faz parte do plano Pro." });
    return;
  }

  const body = (req.body ?? {}) as RequestBody;
  const turns = parseTurns(body.messages);
  if (!turns) {
    res.status(400).json({ error: "Conversa inválida." });
    return;
  }

  const geminiKey = await getUserApiKeyForProvider(uid, "vision_internal");
  if (!geminiKey) {
    res.status(400).json({ error: "Cadastre sua chave Gemini em Conta pra usar o Assistente." });
    return;
  }

  try {
    let context = parseContext(body.context);

    if (!context) {
      if (typeof body.imageBase64 !== "string" || typeof body.imageMimeType !== "string") {
        res.status(400).json({ error: "Envie a foto do produto na primeira mensagem." });
        return;
      }
      if (!ALLOWED_MIME.has(body.imageMimeType) || body.imageBase64.length > MAX_IMAGE_BASE64_CHARS) {
        res.status(400).json({ error: "Foto inválida ou grande demais (use JPG, PNG ou WebP)." });
        return;
      }
      const provider = body.provider as SearchProviderId;
      const marketplaces = PROVIDER_MARKETPLACES[provider];
      if (!marketplaces) {
        res.status(400).json({ error: "Escolha um mecanismo de busca válido." });
        return;
      }
      const supplierPrice =
        typeof body.supplierPrice === "number" && body.supplierPrice > 0 ? body.supplierPrice : undefined;

      const query = await identifyProductFromPhoto(geminiKey, body.imageBase64, body.imageMimeType);

      try {
        await consumeSearchQuota(uid, provider, marketplaces.length);
      } catch (err) {
        if (err instanceof QuotaExceededError) {
          res.status(429).json({ error: err.message });
          return;
        }
        console.error("[product-assistant] falha ao reservar cota (seguindo sem bloquear):", err);
      }

      const SKU = "assistente";
      // `cacheMaxAgeMs: 0`: o SKU é fixo ("assistente") pra qualquer
      // consulta, então ler o cache devolveria o preço da consulta ANTERIOR.
      const { byMarketplace } = await fetchPricesCore(
        uid,
        provider,
        marketplaces,
        [{ sku: SKU, name: query, supplierPrice }],
        "auto",
        { cacheMaxAgeMs: 0 }
      );
      const offers: AssistantOffer[] = marketplaces.flatMap((m) => {
        const r = byMarketplace[m]?.[SKU];
        if (!r) return [];
        return [
          {
            marketplace: m,
            price: r.price,
            title: r.matchedTitle,
            link: r.link,
            competitorCount: r.competitorCount,
            approximate: r.approximate === true,
          },
        ];
      });
      context = { query, offers, supplierPrice };
    }

    const reply = await chatAboutProduct(geminiKey, buildSystemInstruction(context), turns);
    res.status(200).json({ reply, context });
  } catch (err) {
    if (err instanceof FetchPricesValidationError) {
      res.status(400).json({ error: err.message });
      return;
    }
    if (err instanceof GeminiVisionError) {
      res.status(502).json({ error: err.message });
      return;
    }
    res.status(502).json({
      error: "Assistente indisponível agora.",
      detail: err instanceof Error ? err.message : String(err),
    });
  }
}
