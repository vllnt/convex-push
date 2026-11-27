import { describe, expect, test } from "vitest";
import { decryptWebPush, generateP8, generateRsa, generateSubscription, generateVapid, verifyJwt } from "../../testing/fixtures.js";
import {
  base64Decode,
  base64UrlEncode,
  byteLength,
  concat,
  fromUtf8,
  sha256Base64Url,
  sha256Hex,
  toBytes,
  toHex,
  utf8,
} from "./codec.js";
import { importRawP256PrivateKey, importSigningKey, pemToDer, pointToCoordinates, signJwt } from "./jwt.js";
import { deriveCacheKey, open, seal } from "./token_seal.js";
import { encryptWebPush, generateSenderKeys, hkdf } from "./web_push_crypto.js";

const hex = (s: string): Uint8Array<ArrayBuffer> => Uint8Array.from(s.match(/../g) ?? [], (b) => Number.parseInt(b, 16));
const b64 = (s: string): Uint8Array<ArrayBuffer> => base64Decode(s) ?? new Uint8Array();

describe("codec", () => {
  test("base64url round trip, padding and invalid input", () => {
    const bytes = new Uint8Array([0, 251, 255, 1, 2]);
    expect(base64UrlEncode(bytes)).toBe("APv_AQI");
    expect(base64Decode("APv_AQI")).toEqual(bytes);
    expect(base64Decode("APv/AQI=")).toEqual(bytes);
    expect(base64Decode("not base64!")).toBeNull();
    expect(base64Decode("abcde")).toBeNull();
  });

  test("text, hex, concat and hashing helpers", async () => {
    expect(fromUtf8(utf8("héllo"))).toBe("héllo");
    expect(byteLength("é")).toBe(2);
    expect(toHex(concat(new Uint8Array([1]), new Uint8Array([2, 255])))).toBe("0102ff");
    expect(toBytes(new Uint8Array([7]).buffer)).toEqual(new Uint8Array([7]));
    expect(await sha256Hex("abc")).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
    expect(await sha256Base64Url("abc")).toHaveLength(43);
  });
});

describe("HKDF (RFC 5869 test case 1)", () => {
  test("matches the published output", async () => {
    const okm = await hkdf(hex("000102030405060708090a0b0c"), hex("0b".repeat(22)), hex("f0f1f2f3f4f5f6f7f8f9"), 42);
    expect(toHex(okm)).toBe(
      "3cb25f25faacd57a90434f64d0362f2a2d2d0a90cf1a5a4c5db02d56ecc4c5bf34007208d5b887185865",
    );
  });
});

describe("JWS signatures", () => {
  test("RS256: verifies the RFC 7515 A.2 signature with its public key", async () => {
    const n =
      "ofgWCuLjybRlzo0tZWJjNiuSfb4p4fAkd_wWJcyQoTbji9k0l8W26mPddxHmfHQp-Vaw-4qPCJrcS2mJPMEzP1Pt0Bm4d4QlL-yRT-SFd2lZS-pCgNMsD1W_YpRPEwOWvG6b32690r2jZ47soMZo9wGzjb_7OMg0LOL-bSf63kpaSHSXndS5z5rexMdbBYUsLA9e-KXBdQOS-UTo7WTBEMa2R2CapHg665xsmtdVMTBQY4uDZlxvb3qCo5ZwKh9kG4LT6_I5IhlJH7aGhyxXFvUK-DWNmoudF8NAco9_h9iaGNj8q2ethFkMLs91kzk2PAcDTW9gb54h4FRWyuXpoQ";
    const signature =
      "cC4hiUPoj9Eetdgtv3hF80EGrhuB__dzERat0XF9g2VtQgr9PJbu3XOiZj5RZmh7AAuHIm4Bh-0Qc_lF5YKt_O8W2Fp5jujGbds9uJdbF9CUAr7t1dnZcAcQjbKBYNX4BAynRFdiuB--f_nZLgrnbyTyWzO75vRK5h6xBArLIARNPvkSjtQBMHlb1L07Qe7K0GarZRmB_eSN9383LcOLn6_dO--xi12jzDwusC-eOkHWEsqtFZESc6BfI7noOPqvhJ1phCnvWh6IeYI2w9QOYEUipUTI8np6LbgGY9Fs98rqVt5AXLIhWkWywlVmtVrBp0igcN_IoypGlUPQGe77Rw";
    const input = "eyJhbGciOiJSUzI1NiJ9.eyJpc3MiOiJqb2UiLA0KICJleHAiOjEzMDA4MTkzODAsDQogImh0dHA6Ly9leGFtcGxlLmNvbS9pc19yb290Ijp0cnVlfQ";
    const key = await crypto.subtle.importKey("jwk", { kty: "RSA", n, e: "AQAB" }, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["verify"]);
    expect(await crypto.subtle.verify("RSASSA-PKCS1-v1_5", key, b64(signature), utf8(input))).toBe(true);
    expect(await crypto.subtle.verify("RSASSA-PKCS1-v1_5", key, b64(signature), utf8(`${input}x`))).toBe(false);
  });

  test("ES256: verifies the RFC 7515 A.3 signature (raw r||s) with its public key", async () => {
    const key = await crypto.subtle.importKey(
      "jwk",
      { kty: "EC", crv: "P-256", x: "f83OJ3D2xF1Bg8vub9tLe1gHMzV76e8Tus9uPHvRVEU", y: "x_FEzRu9m36HLN_tue659LNpXW6pCyStikYjKIWI5a0" },
      { name: "ECDSA", namedCurve: "P-256" },
      false,
      ["verify"],
    );
    const input = "eyJhbGciOiJFUzI1NiJ9.eyJpc3MiOiJqb2UiLA0KICJleHAiOjEzMDA4MTkzODAsDQogImh0dHA6Ly9leGFtcGxlLmNvbS9pc19yb290Ijp0cnVlfQ";
    const signature = b64("DtEhU3ljbEg8L38VWAfUAqOyKAM6-Xx-F4GawxaepmXFCgfTjDxw5djxLa8ISlSApmWQxfKTUJqPP3-Kg6NU1Q");
    expect(signature).toHaveLength(64);
    expect(await crypto.subtle.verify({ name: "ECDSA", hash: "SHA-256" }, key, signature, utf8(input))).toBe(true);
  });

  test("signs ES256 and RS256 JWTs that verify against the public key", async () => {
    const ec = await generateP8();
    const ecKey = await importSigningKey(ec.pem, "ES256");
    expect(ecKey).not.toBeNull();
    const es = await signJwt({ kid: "KEY1" }, { iss: "TEAM", iat: 1 }, ecKey ?? ec.publicKey, "ES256");
    expect(await verifyJwt(es, ec.publicKey)).toEqual({ valid: true, header: { alg: "ES256", typ: "JWT", kid: "KEY1" }, claims: { iss: "TEAM", iat: 1 } });

    const rsa = await generateRsa();
    const rsKey = await importSigningKey(rsa.pem.replaceAll("\n", String.raw`\n`), "RS256");
    expect(rsKey).not.toBeNull();
    const rs = await signJwt({}, { iss: "svc", exp: 2 }, rsKey ?? rsa.publicKey, "RS256");
    expect((await verifyJwt(rs, rsa.publicKey)).valid).toBe(true);
  });

  test("rejects unusable keys", async () => {
    expect(pemToDer("-----BEGIN PRIVATE KEY-----\n-----END PRIVATE KEY-----")).toBeNull();
    expect(await importSigningKey("", "ES256")).toBeNull();
    expect(await importSigningKey("bm90IGEga2V5", "ES256")).toBeNull();
    const rsa = await generateRsa();
    expect(await importSigningKey(rsa.pem, "ES256")).toBeNull();
    expect(pointToCoordinates(new Uint8Array(65))).toBeNull();
    const vapid = await generateVapid();
    expect(await importRawP256PrivateKey("AAAA", vapid.publicKey, "sign")).toBeNull();
    expect(await importRawP256PrivateKey(vapid.privateKey, "AAAA", "sign")).toBeNull();
    expect(await importRawP256PrivateKey(vapid.privateKey, "!!!", "sign")).toBeNull();
    const other = await generateVapid();
    expect(await importRawP256PrivateKey(vapid.privateKey, other.publicKey, "sign")).toBeNull();
    const key = await importRawP256PrivateKey(vapid.privateKey, vapid.publicKey, "sign");
    const jwt = await signJwt({}, { aud: "https://push.example" }, key ?? vapid.verifyKey, "ES256");
    expect((await verifyJwt(jwt, vapid.verifyKey)).valid).toBe(true);
  });

  test("the header cannot override alg", async () => {
    const vapid = await generateVapid();
    const key = await importRawP256PrivateKey(vapid.privateKey, vapid.publicKey, "sign");
    const jwt = await signJwt({ alg: "none", kid: "k1" }, { aud: "a" }, key ?? vapid.verifyKey, "ES256");
    const header: unknown = JSON.parse(new TextDecoder().decode(base64Decode(jwt.split(".")[0] ?? "") ?? new Uint8Array()));
    expect(header).toEqual({ typ: "JWT", kid: "k1", alg: "ES256" });
  });
});

describe("Web Push encryption (RFC 8291)", () => {
  test("reproduces the Appendix A ciphertext", async () => {
    /** Published RFC 8291 Appendix A inputs: public test data, not a credential. */
    const senderPublic = "BP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A8";
    const senderScalar = "yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw";
    const privateKey = await importRawP256PrivateKey(senderScalar, senderPublic, "deriveBits");
    expect(privateKey).not.toBeNull();
    const body = await encryptWebPush({
      plaintext: b64("V2hlbiBJIGdyb3cgdXAsIEkgd2FudCB0byBiZSBhIHdhdGVybWVsb24"),
      uaPublic: b64("BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4"),
      authSecret: b64("BTBZMqHH6r4Tts7J_aSIgg"),
      salt: b64("DGv6ra1nlYgDCS1FRnbzlw"),
      senderKeys: { privateKey: privateKey ?? (await generateSenderKeys()).privateKey, publicKey: b64(senderPublic) },
    });
    const header = b64("DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A8");
    const ciphertext = b64("8pfeW0KbunFT06SuDKoJH9Ql87S1QUrdirN6GcG7sFz1y1sqLgVi1VhjVkHsUoEsbI_0LpXMuGvnzQ");
    expect(header).toHaveLength(86);
    expect(toHex(body)).toBe(toHex(concat(header, ciphertext)));
  });

  test("a fresh encryption decrypts with the browser's key", async () => {
    const sub = await generateSubscription();
    const body = await encryptWebPush({ plaintext: utf8('{"title":"hi"}'), uaPublic: sub.publicRaw, authSecret: sub.authRaw });
    expect(body.length).toBe(86 + 14 + 1 + 16);
    expect(await decryptWebPush(body, sub)).toBe('{"title":"hi"}');
  });
});

describe("AES-GCM token cache sealing", () => {
  test("Web Crypto AES-256-GCM matches GCM spec test case 16", async () => {
    const key = await crypto.subtle.importKey("raw", hex("feffe9928665731c6d6a8f9467308308feffe9928665731c6d6a8f9467308308"), "AES-GCM", false, ["encrypt"]);
    const out = await crypto.subtle.encrypt(
      { name: "AES-GCM", iv: hex("cafebabefacedbaddecaf888"), additionalData: hex("feedfacedeadbeeffeedfacedeadbeefabaddad2") },
      key,
      hex("d9313225f88406e5a55909c5aff5269a86a7a9531534f7da2e4c303d8a318a721c3c0c95956809532fcf0e2449a6b525b16aedf5aa0de657ba637b39"),
    );
    expect(toHex(new Uint8Array(out))).toBe(
      "522dc1f099567d07f47f37a32a84427d643a8cdcbfe5c0c97598a2bd2555d1aa8cb08e48590dbb3da7b08b1056828838c5f61e6393ba7a0abcc9f662" +
        "76fc6ece0f4e1768cddf8853bb2d551b",
    );
  });

  test("seals and opens; a wrong key, credential or audience opens nothing", async () => {
    const key = await deriveCacheKey("long-lived-secret", "ref-1");
    const sealed = await seal(key, "provider-token", "ref-1|");
    expect(fromUtf8(new Uint8Array(sealed.cipher))).not.toContain("provider-token");
    expect(await open(key, sealed, "ref-1|")).toBe("provider-token");
    expect(await open(key, sealed, "ref-1|https://other")).toBeNull();
    expect(await open(await deriveCacheKey("other-secret", "ref-1"), sealed, "ref-1|")).toBeNull();
    expect(await open(await deriveCacheKey("long-lived-secret", "ref-2"), sealed, "ref-1|")).toBeNull();
  });
});
