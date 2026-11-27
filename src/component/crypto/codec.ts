/** Byte and text encodings shared by the signers and the encryption code. Web APIs only. */

/** Bytes backed by a plain ArrayBuffer, as Web Crypto expects. */
export type Bytes = Uint8Array<ArrayBuffer>;

const encoder = new TextEncoder();
const decoder = new TextDecoder();

/**
 * Encode text as UTF-8.
 * @param text - Any string.
 * @returns Its UTF-8 bytes.
 */
export function utf8(text: string): Bytes {
  return encoder.encode(text);
}

/**
 * Decode UTF-8 bytes.
 * @param bytes - UTF-8 bytes.
 * @returns The decoded string.
 */
export function fromUtf8(bytes: Uint8Array): string {
  return decoder.decode(bytes);
}

/**
 * Concatenate byte arrays.
 * @param parts - Arrays to join, in order.
 * @returns One array.
 */
export function concat(...parts: Uint8Array[]): Bytes {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

/**
 * Copy any byte view into a fresh ArrayBuffer-backed array.
 * @param input - An ArrayBuffer or byte view.
 * @returns A copy.
 */
export function toBytes(input: ArrayBuffer | Uint8Array): Bytes {
  return new Uint8Array(input instanceof Uint8Array ? input : new Uint8Array(input));
}

/**
 * Encode bytes as unpadded base64url (RFC 4648 section 5).
 * @param bytes - Bytes to encode.
 * @returns The base64url string.
 */
export function base64UrlEncode(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCodePoint(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

/**
 * Decode base64 or base64url, padded or not.
 * @param text - The encoded string. Whitespace is ignored.
 * @returns The bytes, or `null` when the input is not base64.
 */
export function base64Decode(text: string): Bytes | null {
  const normalized = text.replaceAll(/\s+/g, "").replaceAll("-", "+").replaceAll("_", "/");
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(normalized) || normalized.replace(/=+$/, "").length % 4 === 1) {
    return null;
  }
  const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "=");
  const binary = atob(padded);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

/**
 * Encode bytes as lowercase hex.
 * @param bytes - Bytes to encode.
 * @returns The hex string.
 */
export function toHex(bytes: Uint8Array): string {
  return [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * SHA-256 of a string, as hex.
 * @param text - Input text, hashed as UTF-8.
 * @returns 64 hex characters.
 */
export async function sha256Hex(text: string): Promise<string> {
  return toHex(new Uint8Array(await crypto.subtle.digest("SHA-256", utf8(text))));
}

/**
 * SHA-256 of a string, as base64url.
 * @param text - Input text, hashed as UTF-8.
 * @returns 43 base64url characters.
 */
export async function sha256Base64Url(text: string): Promise<string> {
  return base64UrlEncode(new Uint8Array(await crypto.subtle.digest("SHA-256", utf8(text))));
}

/**
 * Size of a string in UTF-8 bytes.
 * @param text - Any string.
 * @returns The byte length.
 */
export function byteLength(text: string): number {
  return utf8(text).length;
}
