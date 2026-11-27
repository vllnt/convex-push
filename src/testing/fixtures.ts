/** Throwaway keys and helpers for tests. Every key is generated at run time; none is committed. */
import { base64UrlEncode, concat, toBytes, utf8 } from "../component/crypto/codec.js";
import { hkdf } from "../component/crypto/web_push_crypto.js";

function pem(der: ArrayBuffer): string {
  const b64 = btoa(String.fromCodePoint(...new Uint8Array(der)));
  return `-----BEGIN PRIVATE KEY-----\n${b64.replaceAll(/(.{64})/g, "$1\n")}\n-----END PRIVATE KEY-----\n`;
}

export interface EcKeys {
  pem: string;
  publicKey: CryptoKey;
}

/** A fresh P-256 signing key as an Apple-style .p8 PEM, plus its public key. */
export async function generateP8(): Promise<EcKeys> {
  const pair = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
  return { pem: pem(await crypto.subtle.exportKey("pkcs8", pair.privateKey)), publicKey: pair.publicKey };
}

/** A fresh RSA-2048 key as a service-account style PEM, plus its public key. */
export async function generateRsa(): Promise<EcKeys> {
  const pair = await crypto.subtle.generateKey(
    { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
    true,
    ["sign", "verify"],
  );
  return { pem: pem(await crypto.subtle.exportKey("pkcs8", pair.privateKey)), publicKey: pair.publicKey };
}

/** A fresh VAPID key pair in the raw base64url form web-push tooling prints. */
export async function generateVapid(): Promise<{ publicKey: string; privateKey: string; verifyKey: CryptoKey }> {
  const pair = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
  const jwk = await crypto.subtle.exportKey("jwk", pair.privateKey);
  return {
    publicKey: base64UrlEncode(new Uint8Array(await crypto.subtle.exportKey("raw", pair.publicKey))),
    privateKey: jwk.d ?? "",
    verifyKey: pair.publicKey,
  };
}

/** A fake browser subscription whose private key the test keeps, to decrypt what was sent. */
export async function generateSubscription(): Promise<{ p256dh: string; auth: string; privateKey: CryptoKey; publicRaw: Uint8Array<ArrayBuffer>; authRaw: Uint8Array<ArrayBuffer> }> {
  const pair = await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]);
  const publicRaw = toBytes(await crypto.subtle.exportKey("raw", pair.publicKey));
  const authRaw = crypto.getRandomValues(new Uint8Array(16));
  return { p256dh: base64UrlEncode(publicRaw), auth: base64UrlEncode(authRaw), privateKey: pair.privateKey, publicRaw, authRaw };
}

/** Decrypt an aes128gcm Web Push body as the browser would (RFC 8291). */
export async function decryptWebPush(
  body: Uint8Array,
  sub: { privateKey: CryptoKey; publicRaw: Uint8Array<ArrayBuffer>; authRaw: Uint8Array<ArrayBuffer> },
): Promise<string> {
  const salt = toBytes(body.slice(0, 16));
  const idLength = body[20] ?? 0;
  const senderPublic = toBytes(body.slice(21, 21 + idLength));
  const ciphertext = toBytes(body.slice(21 + idLength));
  const senderKey = await crypto.subtle.importKey("raw", senderPublic, { name: "ECDH", namedCurve: "P-256" }, false, []);
  const ecdh = toBytes(await crypto.subtle.deriveBits({ name: "ECDH", public: senderKey }, sub.privateKey, 256));
  const ikm = await hkdf(sub.authRaw, ecdh, concat(utf8("WebPush: info\0"), sub.publicRaw, senderPublic), 32);
  const cek = await hkdf(salt, ikm, utf8("Content-Encoding: aes128gcm\0"), 16);
  const nonce = await hkdf(salt, ikm, utf8("Content-Encoding: nonce\0"), 12);
  const key = await crypto.subtle.importKey("raw", cek, "AES-GCM", false, ["decrypt"]);
  const plain = new Uint8Array(await crypto.subtle.decrypt({ name: "AES-GCM", iv: nonce }, key, ciphertext));
  if (plain.at(-1) !== 2) throw new Error("missing padding delimiter");
  return new TextDecoder().decode(plain.slice(0, -1));
}

/** Verify a compact JWS against a public key and return its decoded header and claims. */
export async function verifyJwt(
  jwt: string,
  key: CryptoKey,
): Promise<{ valid: boolean; header: Record<string, unknown>; claims: Record<string, unknown> }> {
  const [h = "", c = "", s = ""] = jwt.split(".");
  const decode = (part: string): Record<string, unknown> =>
    JSON.parse(atob(part.replaceAll("-", "+").replaceAll("_", "/").padEnd(Math.ceil(part.length / 4) * 4, "=")));
  const sig = Uint8Array.from(atob(s.replaceAll("-", "+").replaceAll("_", "/").padEnd(Math.ceil(s.length / 4) * 4, "=")), (ch) => ch.codePointAt(0) ?? 0);
  const algorithm = key.algorithm.name === "ECDSA" ? { name: "ECDSA", hash: "SHA-256" } : { name: "RSASSA-PKCS1-v1_5" };
  const valid = await crypto.subtle.verify(algorithm, key, sig, utf8(`${h}.${c}`));
  return { valid, header: decode(h), claims: decode(c) };
}

/** A recorded HTTP response for the fetch stub. */
export function reply(status: number, body: unknown = "", headers: Record<string, string> = {}): Response {
  return new Response(typeof body === "string" ? body : JSON.stringify(body), { status, headers });
}
