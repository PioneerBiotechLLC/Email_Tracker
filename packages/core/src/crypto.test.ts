import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { decryptText, encryptText } from "./crypto.js";

describe("encryptText / decryptText", () => {
  const key = randomBytes(32);

  it("round-trips text", () => {
    expect(decryptText(encryptText("Please quote 500 units. مرحبا", key), key)).toBe("Please quote 500 units. مرحبا");
  });

  it("round-trips an empty body", () => {
    expect(decryptText(encryptText("", key), key)).toBe("");
  });

  it("rejects text that is not an encrypted payload", () => {
    expect(() => decryptText("plain text", key)).toThrow("Not an encrypted payload");
    expect(() => decryptText("", key)).toThrow("Not an encrypted payload");
  });

  it("rejects a payload encrypted with another key", () => {
    expect(() => decryptText(encryptText("secret", key), randomBytes(32))).toThrow();
  });
});
