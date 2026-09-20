import { randomBytes, createHash } from "node:crypto";

/** Crockford-style base32 without I, L, O, U — short ids that survive being read aloud. */
const ALPHABET = "0123456789abcdefghjkmnpqrstvwxyz";

function encode(bytes: Uint8Array, length: number): string {
  let out = "";
  for (let i = 0; i < length; i++) {
    out += ALPHABET[bytes[i % bytes.length]! % ALPHABET.length];
  }
  return out;
}

export function newId(prefix: string, length = 10): string {
  return `${prefix}_${encode(randomBytes(length), length)}`;
}

export function decisionId(): string {
  return newId("d");
}

export function proposalId(): string {
  return newId("p");
}

export function runId(): string {
  return newId("r");
}

/** Stable identifier derived from arbitrary text (used for workspace ids). */
export function stableId(prefix: string, input: string, length = 10): string {
  const digest = createHash("sha256").update(input).digest();
  return `${prefix}_${encode(digest, length)}`;
}
