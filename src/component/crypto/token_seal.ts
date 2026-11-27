import { type Bytes, fromUtf8, toBytes, utf8 } from "./codec.js";
import { hkdf } from "./web_push_crypto.js";

const CACHE_SALT = utf8("@vllnt/convex-push token cache v1");

/**
 * Derive the AES-256-GCM key that protects cached provider tokens. It comes
 * from the long-lived private key, inside the action, and is never stored, so a
 * database export holds no usable token.
 * @param secret - The long-lived private key text.
 * @param credentialRef - The credential fingerprint, bound into the key.
 * @returns A non-extractable AES-GCM key.
 */
export async function deriveCacheKey(secret: string, credentialRef: string): Promise<CryptoKey> {
  const raw = await hkdf(CACHE_SALT, utf8(secret), utf8(credentialRef), 32);
  return crypto.subtle.importKey("raw", raw, "AES-GCM", false, ["encrypt", "decrypt"]);
}

/** A sealed token as stored in `providerTokens`. */
export interface Sealed {
  cipher: ArrayBuffer;
  iv: ArrayBuffer;
}

/**
 * Encrypt a token with a fresh 12-byte IV.
 * @param key - From {@link deriveCacheKey}.
 * @param token - The provider token.
 * @param aad - Bound associated data (credential and audience), so a row cannot be swapped.
 * @returns Ciphertext and IV.
 */
export async function seal(key: CryptoKey, token: string, aad: string): Promise<Sealed> {
  const iv: Bytes = crypto.getRandomValues(new Uint8Array(12));
  const cipher = await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData: utf8(aad) }, key, utf8(token));
  return { cipher, iv: iv.buffer };
}

/**
 * Decrypt a sealed token.
 * @param key - From {@link deriveCacheKey}.
 * @param sealed - Stored ciphertext and IV.
 * @param aad - The associated data used at sealing.
 * @returns The token, or `null` when the key or data do not match.
 */
export async function open(key: CryptoKey, sealed: Sealed, aad: string): Promise<string | null> {
  try {
    const plain = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: toBytes(sealed.iv), additionalData: utf8(aad) },
      key,
      toBytes(sealed.cipher),
    );
    return fromUtf8(new Uint8Array(plain));
  } catch {
    return null;
  }
}
