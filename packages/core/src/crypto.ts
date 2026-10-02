import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { getEnv } from "./env.js";

const PREFIX = "enc1";

/** Parses DATA_ENCRYPTION_KEY (base64 or hex, 32 bytes). Returns null if not configured. */
export function getEncryptionKey(): Buffer | null {
  const raw = getEnv().DATA_ENCRYPTION_KEY?.trim();
  if (!raw) return null;
  let key: Buffer;
  if (/^[0-9a-fA-F]{64}$/.test(raw)) key = Buffer.from(raw, "hex");
  else key = Buffer.from(raw, "base64");
  if (key.length !== 32) {
    throw new Error("DATA_ENCRYPTION_KEY must be 32 bytes (base64 of `openssl rand -base64 32`, or 64 hex chars)");
  }
  return key;
}

export function encryptText(plain: string, key: Buffer): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ct = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [PREFIX, iv.toString("base64"), tag.toString("base64"), ct.toString("base64")].join(":");
}

export function decryptText(payload: string, key: Buffer): string {
  const [prefix, ivB64, tagB64, ctB64] = payload.split(":");
  // an empty text encrypts to an empty ciphertext part, which is still a valid payload
  if (prefix !== PREFIX || !ivB64 || !tagB64 || ctB64 === undefined) throw new Error("Not an encrypted payload");
  const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(ivB64, "base64"));
  decipher.setAuthTag(Buffer.from(tagB64, "base64"));
  return Buffer.concat([decipher.update(Buffer.from(ctB64, "base64")), decipher.final()]).toString("utf8");
}

/** Encrypts body text if a key is configured; returns the stored value and a flag. */
export function protectBody(plain: string | null): { bodyText: string | null; bodyEncrypted: boolean } {
  if (plain == null) return { bodyText: null, bodyEncrypted: false };
  const key = getEncryptionKey();
  if (!key) return { bodyText: plain, bodyEncrypted: false };
  return { bodyText: encryptText(plain, key), bodyEncrypted: true };
}

/** Reads a stored body back to plaintext. */
export function readBody(msg: { bodyText: string | null; bodyEncrypted: boolean }): string | null {
  if (msg.bodyText == null) return null;
  if (!msg.bodyEncrypted) return msg.bodyText;
  const key = getEncryptionKey();
  if (!key) throw new Error("Message body is encrypted but DATA_ENCRYPTION_KEY is not set");
  return decryptText(msg.bodyText, key);
}
