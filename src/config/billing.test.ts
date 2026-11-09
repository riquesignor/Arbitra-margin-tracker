import { describe, expect, it } from "vitest";
import { parseBillingFlag } from "./billing";

describe("parseBillingFlag (VITE_BILLING_ENABLED)", () => {
  it("fica desligada por padrão", () => {
    expect(parseBillingFlag(undefined)).toBe(false);
    expect(parseBillingFlag("")).toBe(false);
  });

  it("só 'true' ou '1' ligam", () => {
    expect(parseBillingFlag("true")).toBe(true);
    expect(parseBillingFlag(" TRUE ")).toBe(true);
    expect(parseBillingFlag("1")).toBe(true);
    expect(parseBillingFlag("false")).toBe(false);
    expect(parseBillingFlag("0")).toBe(false);
    expect(parseBillingFlag("yes")).toBe(false);
  });
});
