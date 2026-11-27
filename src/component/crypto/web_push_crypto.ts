import { type Bytes, concat, toBytes, utf8 } from "./codec.js";

/** Record size written in the aes128gcm header. One record is always enough for a push. */
const RECORD_SIZE = 4096;
/** Length of an uncompressed P-256 public point. */
const POINT_LENGTH = 65;

/**
 * HKDF-SHA-256 (RFC 5869).
 * @param salt - Salt bytes.
 * @param ikm - Input keying material.
 * @param info - Context info.
 * @param length - Output length in bytes.
 * @returns The derived bytes.
 */
export async function hkdf(salt: Bytes, ikm: Bytes, info: Bytes, length: number): Promise<Bytes> {
  const key = await crypto.subtle.importKey("raw", ikm, "HKDF", false, ["deriveBits"]);
  return toBytes(await crypto.subtle.deriveBits({ name: "HKDF", hash: "SHA-256", salt, info }, key, length * 8));
}

/** The sender's ephemeral ECDH key pair. Tests inject the RFC 8291 key; production generates one per message. */
export interface SenderKeys {
  privateKey: CryptoKey;
  publicKey: Bytes;
}

/**
 * Make a fresh ephemeral ECDH key pair.
 * @returns The private key and its raw public point.
 */
export async function generateSenderKeys(): Promise<SenderKeys> {
  const pair = await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, false, ["deriveBits"]);
  return { privateKey: pair.privateKey, publicKey: toBytes(await crypto.subtle.exportKey("raw", pair.publicKey)) };
}

/** Inputs of one Web Push encryption. */
export interface EncryptInput {
  plaintext: Bytes;
  /** The subscription's `p256dh` key: the browser's public point. */
  uaPublic: Bytes;
  /** The subscription's `auth` secret: 16 bytes. */
  authSecret: Bytes;
  /** Defaults to 16 random bytes. */
  salt?: Bytes;
  /** Defaults to a fresh key pair. */
  senderKeys?: SenderKeys;
}

/**
 * Encrypt a push message with the aes128gcm content coding (RFC 8188) as Web
 * Push uses it (RFC 8291): ECDH with the browser key, HKDF with the auth secret,
 * then AES-128-GCM over one record ending in the 0x02 padding delimiter.
 * @param input - Plaintext and subscription keys.
 * @returns The request body: header (salt, record size, sender key) then ciphertext.
 * @throws When the browser key is not a valid P-256 point.
 */
export async function encryptWebPush(input: EncryptInput): Promise<Bytes> {
  const salt = input.salt ?? crypto.getRandomValues(new Uint8Array(16));
  const sender = input.senderKeys ?? (await generateSenderKeys());
  const uaKey = await crypto.subtle.importKey("raw", input.uaPublic, { name: "ECDH", namedCurve: "P-256" }, false, []);
  const ecdhSecret = toBytes(
    await crypto.subtle.deriveBits({ name: "ECDH", public: uaKey }, sender.privateKey, 256),
  );
  const keyInfo = concat(utf8("WebPush: info\0"), input.uaPublic, sender.publicKey);
  const ikm = await hkdf(input.authSecret, ecdhSecret, keyInfo, 32);
  const cek = await hkdf(salt, ikm, utf8("Content-Encoding: aes128gcm\0"), 16);
  const nonce = await hkdf(salt, ikm, utf8("Content-Encoding: nonce\0"), 12);
  const aesKey = await crypto.subtle.importKey("raw", cek, "AES-GCM", false, ["encrypt"]);
  const ciphertext = toBytes(
    await crypto.subtle.encrypt({ name: "AES-GCM", iv: nonce }, aesKey, concat(input.plaintext, new Uint8Array([2]))),
  );
  const recordSize = new Uint8Array(4);
  new DataView(recordSize.buffer).setUint32(0, RECORD_SIZE);
  return concat(salt, recordSize, new Uint8Array([POINT_LENGTH]), sender.publicKey, ciphertext);
}
