import { base64Decode, base64UrlEncode, type Bytes, utf8 } from "./codec.js";

/** Signature algorithms used by the providers: ES256 for APNs and VAPID, RS256 for Google. */
export type JwtAlgorithm = "ES256" | "RS256";

const ECDSA_P256 = { name: "ECDSA", namedCurve: "P-256" } as const;
const RSA_SHA256 = { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" } as const;

/**
 * Read the DER bytes of a PEM private key. Accepts the PEM armour or bare
 * base64, and literal `\n` escapes as environment variables often carry them.
 * @param pem - The key text.
 * @returns The DER bytes, or `null` when the text is not a key.
 */
export function pemToDer(pem: string): Bytes | null {
  const body = pem
    .replaceAll(String.raw`\n`, "\n")
    .replaceAll(/-----(BEGIN|END) [A-Z ]+-----/g, "")
    .trim();
  if (body.length === 0) return null;
  return base64Decode(body);
}

/**
 * Import a PKCS#8 private key for signing.
 * @param pem - PEM text of the key (an Apple .p8 file or a Google service-account key).
 * @param algorithm - Which signature it makes.
 * @returns The signing key, or `null` when the key cannot be imported.
 */
export async function importSigningKey(pem: string, algorithm: JwtAlgorithm): Promise<CryptoKey | null> {
  const der = pemToDer(pem);
  if (!der) return null;
  try {
    return await crypto.subtle.importKey(
      "pkcs8",
      der,
      algorithm === "ES256" ? ECDSA_P256 : RSA_SHA256,
      false,
      ["sign"],
    );
  } catch {
    return null;
  }
}

/**
 * Split an uncompressed P-256 public point (65 bytes, leading 0x04) into JWK coordinates.
 * @param point - The raw public key.
 * @returns `x` and `y` as base64url, or `null` when the point is malformed.
 */
export function pointToCoordinates(point: Uint8Array): { x: string; y: string } | null {
  if (point.length !== 65 || point[0] !== 4) return null;
  return { x: base64UrlEncode(point.slice(1, 33)), y: base64UrlEncode(point.slice(33)) };
}

/**
 * Import a raw P-256 private scalar plus its public point, the format VAPID
 * keys and RFC 8291 test vectors use.
 * @param privateKey - base64url of the 32-byte scalar.
 * @param publicKey - base64url of the 65-byte uncompressed point.
 * @param usage - `sign` for ECDSA, `deriveBits` for ECDH.
 * @returns The key, or `null` when the input does not form a valid key pair.
 */
export async function importRawP256PrivateKey(
  privateKey: string,
  publicKey: string,
  usage: "sign" | "deriveBits",
): Promise<CryptoKey | null> {
  const d = base64Decode(privateKey);
  const point = base64Decode(publicKey);
  const coordinates = point ? pointToCoordinates(point) : null;
  if (d?.length !== 32 || !coordinates) return null;
  const jwk: JsonWebKey = { kty: "EC", crv: "P-256", d: base64UrlEncode(d), ...coordinates, ext: false };
  try {
    return await crypto.subtle.importKey(
      "jwk",
      jwk,
      usage === "sign" ? ECDSA_P256 : { name: "ECDH", namedCurve: "P-256" },
      false,
      [usage],
    );
  } catch {
    return null;
  }
}

/**
 * Make a compact JWS. ES256 signatures come out of Web Crypto as raw r||s,
 * which is the JWS encoding (RFC 7518 section 3.4).
 * @param header - JOSE header; `alg` always comes from `algorithm`, never from it.
 * @param claims - JWT claims.
 * @param key - A signing key from {@link importSigningKey} or {@link importRawP256PrivateKey}.
 * @param algorithm - ES256 or RS256.
 * @returns `header.claims.signature`, each part base64url.
 */
export async function signJwt(
  header: Record<string, string>,
  claims: Record<string, number | string>,
  key: CryptoKey,
  algorithm: JwtAlgorithm,
): Promise<string> {
  const input = `${base64UrlEncode(utf8(JSON.stringify({ typ: "JWT", ...header, alg: algorithm })))}.${base64UrlEncode(utf8(JSON.stringify(claims)))}`;
  const signature = await crypto.subtle.sign(
    algorithm === "ES256" ? { name: "ECDSA", hash: "SHA-256" } : RSA_SHA256,
    key,
    utf8(input),
  );
  return `${input}.${base64UrlEncode(new Uint8Array(signature))}`;
}
