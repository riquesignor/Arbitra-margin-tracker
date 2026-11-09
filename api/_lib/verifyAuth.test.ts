import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ApiRequest } from "./httpTypes.js";

/**
 * A mensagem do erro de autenticação vai pro cliente. Ela não pode carregar
 * o detalhe interno da falha do Firebase (que pode citar projeto, credencial
 * do Admin SDK ou o próprio token).
 */
const auth = vi.hoisted(() => ({ verifyIdToken: vi.fn() }));
vi.mock("firebase-admin/auth", () => ({ getAuth: () => ({ verifyIdToken: auth.verifyIdToken }) }));
vi.mock("./firestoreAdmin.js", () => ({ getAdminApp: () => ({}) }));

import { EmailNotVerifiedError, requireAuth, requireVerifiedAuth, UnauthorizedError } from "./verifyAuth.js";

const withToken = (token?: string): ApiRequest => ({
  method: "POST",
  body: {},
  headers: token ? { authorization: `Bearer ${token}` } : {},
});

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

describe("requireAuth / requireVerifiedAuth", () => {
  it("sem token: UnauthorizedError e nem chega no Firebase", async () => {
    await expect(requireAuth(withToken())).rejects.toBeInstanceOf(UnauthorizedError);
    expect(auth.verifyIdToken).not.toHaveBeenCalled();
  });

  it("token recusado: mensagem GENÉRICA, sem o detalhe interno do Firebase", async () => {
    auth.verifyIdToken.mockRejectedValue(
      new Error("Decoding Firebase ID token failed. Credential implementation: FIREBASE_PRIVATE_KEY projeto-secreto-123")
    );

    const error = await requireAuth(withToken("tok-invalido")).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(UnauthorizedError);
    expect((error as Error).message).toBe("Sessão inválida ou expirada. Entre de novo.");
    expect((error as Error).message).not.toMatch(/Firebase|FIREBASE|projeto-secreto|Credential/);
  });

  it("o detalhe da recusa fica no log do servidor, não na resposta", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    auth.verifyIdToken.mockRejectedValue(new Error("auth/id-token-expired"));

    await requireAuth(withToken("tok")).catch(() => {});

    expect(warn).toHaveBeenCalledWith("[auth] token recusado:", "auth/id-token-expired");
  });

  it("devolve o uid do token válido", async () => {
    auth.verifyIdToken.mockResolvedValue({ uid: "uid-9", email_verified: false });
    expect(await requireAuth(withToken("ok"))).toBe("uid-9");
  });

  it("requireVerifiedAuth exige e-mail confirmado", async () => {
    auth.verifyIdToken.mockResolvedValue({ uid: "uid-9", email_verified: false });
    await expect(requireVerifiedAuth(withToken("ok"))).rejects.toBeInstanceOf(EmailNotVerifiedError);

    auth.verifyIdToken.mockResolvedValue({ uid: "uid-9", email_verified: true });
    expect(await requireVerifiedAuth(withToken("ok"))).toBe("uid-9");
  });
});
