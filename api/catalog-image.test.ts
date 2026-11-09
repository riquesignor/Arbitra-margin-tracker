import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ApiRequest, ApiResponse } from "./_lib/httpTypes.js";

/**
 * /api/catalog-image é PÚBLICA (o crawler do Google Lens não manda
 * Authorization) e serve conteúdo gravado pelo próprio cliente. Estes testes
 * garantem que ela só serve imagem de verdade, com cabeçalhos que impedem o
 * navegador de tratar o corpo como página, e que não aceita id fora do formato.
 */
const store = vi.hoisted(() => ({
  docs: new Map<string, Record<string, unknown>>(),
  reads: [] as string[],
  fail: false,
}));

function docRef(path: string) {
  return {
    get: async () => {
      store.reads.push(path);
      if (store.fail) throw new Error("FIREBASE_PRIVATE_KEY quebrou em https://x?key=SEGREDO");
      return { data: () => store.docs.get(path) };
    },
    collection: (name: string) => ({ doc: (id: string) => docRef(`${path}/${name}/${id}`) }),
  };
}

vi.mock("./_lib/firestoreAdmin.js", () => ({
  getAdminDb: () => ({ collection: (name: string) => ({ doc: (id: string) => docRef(`${name}/${id}`) }) }),
}));

import handler from "./catalog-image.js";

function makeRes() {
  const out = { status: 0, body: undefined as unknown, headers: {} as Record<string, string>, sent: undefined as unknown };
  const res: ApiResponse = {
    status(code) {
      out.status = code;
      return res;
    },
    json(body) {
      out.body = body;
    },
    setHeader(name, value) {
      out.headers[name.toLowerCase()] = value;
      return res;
    },
    send(body) {
      out.sent = body;
      if (!out.status) out.status = 200;
    },
  };
  return { res, out };
}

const get = (query: ApiRequest["query"]): ApiRequest => ({ method: "GET", body: undefined, query });
const FUTURE = Date.now() + 60_000;
const JPEG_B64 = Buffer.from([0xff, 0xd8, 0xff, 0xe0]).toString("base64");

beforeEach(() => {
  store.docs.clear();
  store.reads.length = 0;
  store.fail = false;
  vi.spyOn(console, "error").mockImplementation(() => {});
});

describe("GET /api/catalog-image", () => {
  it("serve a imagem com o tipo certo e cabeçalhos que impedem tratar o corpo como página", async () => {
    store.docs.set("catalog_image_index/img123", { uid: "user1", expiresAt: FUTURE });
    store.docs.set("users/user1/catalog_images/img123", { base64: JPEG_B64, contentType: "image/jpeg", expiresAt: FUTURE });

    const { res, out } = makeRes();
    await handler(get({ id: "img123" }), res);

    expect(out.status).toBe(200);
    expect(out.headers["content-type"]).toBe("image/jpeg");
    expect(out.headers["x-content-type-options"]).toBe("nosniff");
    expect(out.headers["content-security-policy"]).toContain("default-src 'none'");
    expect(out.headers["content-security-policy"]).toContain("sandbox");
    expect(Buffer.isBuffer(out.sent)).toBe(true);
  });

  it.each(["text/html", "text/html; charset=utf-8", "image/svg+xml", "application/javascript", "application/octet-stream"])(
    "NÃO serve %s mesmo que o doc diga isso — o conteúdo é escrito pelo cliente (XSS armazenado)",
    async (contentType) => {
      store.docs.set("catalog_image_index/img1", { uid: "user1", expiresAt: FUTURE });
      store.docs.set("users/user1/catalog_images/img1", {
        base64: Buffer.from("<script>alert(1)</script>").toString("base64"),
        contentType,
        expiresAt: FUTURE,
      });

      const { res, out } = makeRes();
      await handler(get({ id: "img1" }), res);

      expect(out.status).toBe(404);
      expect(out.sent).toBeUndefined();
    }
  );

  it("sem contentType gravado assume jpeg (como antes)", async () => {
    store.docs.set("catalog_image_index/img1", { uid: "user1", expiresAt: FUTURE });
    store.docs.set("users/user1/catalog_images/img1", { base64: JPEG_B64, expiresAt: FUTURE });

    const { res, out } = makeRes();
    await handler(get({ id: "img1" }), res);

    expect(out.status).toBe(200);
    expect(out.headers["content-type"]).toBe("image/jpeg");
  });

  it.each([
    ["id com barra", { id: "a/b" }],
    ["id com ponto-ponto", { id: ".." }],
    ["id com espaço", { id: "a b" }],
    ["id gigante", { id: "a".repeat(500) }],
    ["uid com barra", { id: "ok", uid: "x/y" }],
    ["uid com caractere estranho", { id: "ok", uid: "x%00y" }],
  ])("recusa com 400 antes de consultar o banco: %s", async (_label, query) => {
    const { res, out } = makeRes();
    await handler(get(query), res);

    expect(out.status).toBe(400);
    expect(store.reads).toHaveLength(0);
  });

  it("imagem expirada ou inexistente é 404", async () => {
    store.docs.set("catalog_image_index/old", { uid: "user1", expiresAt: Date.now() - 1 });

    const { res, out } = makeRes();
    await handler(get({ id: "old" }), res);
    expect(out.status).toBe(404);

    const { res: res2, out: out2 } = makeRes();
    await handler(get({ id: "nao-existe" }), res2);
    expect(out2.status).toBe(404);
  });

  it("URL antiga (?uid=) segue funcionando até expirar", async () => {
    store.docs.set("users/user1/catalog_images/img9", { base64: JPEG_B64, contentType: "image/jpeg", expiresAt: FUTURE });

    const { res, out } = makeRes();
    await handler(get({ id: "img9", uid: "user1" }), res);

    expect(out.status).toBe(200);
  });

  it("falha interna devolve erro genérico — sem a mensagem do erro (nome de variável, chave)", async () => {
    store.fail = true;

    const { res, out } = makeRes();
    await handler(get({ id: "img1" }), res);

    expect(out.status).toBe(502);
    expect(out.body).toEqual({ error: "Falha ao servir imagem" });
    expect(JSON.stringify(out.body)).not.toMatch(/FIREBASE|SEGREDO|key=/);
  });

  it("só aceita GET", async () => {
    const { res, out } = makeRes();
    await handler({ method: "POST", body: {}, query: { id: "x" } }, res);
    expect(out.status).toBe(405);
  });
});
