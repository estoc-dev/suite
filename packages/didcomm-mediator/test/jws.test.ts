import { p256 } from "@noble/curves/nist.js";
import { base64urlnopad } from "@scure/base";
import { describe, expect, it, test } from "vitest";
import { type CurveName, type PublicKey, SecretKey, sign, verify } from "../src/envelope/index.ts";

const payload = new TextEncoder().encode('{"id":"1","type":"https://example.com/test","from":"did:example:alice"}');
const kid = "did:example:alice#1";

describe("a signature", () => {
  it.each([
    ["Ed25519", "EdDSA"],
    ["P-256", "ES256"],
    ["secp256k1", "ES256K"],
  ] as [CurveName, string][])("by a %s key is %s, and verifies", async (curve, alg) => {
    const secret = SecretKey.random(curve);
    const jws = sign(payload, { kid, secret });
    const [signature] = jws.signatures;
    expect(JSON.parse(new TextDecoder().decode(base64urlnopad.decode(signature?.protected ?? "")))).toEqual({
      typ: "application/didcomm-signed+json",
      alg,
    });
    expect(signature?.header).toEqual({ kid });
    expect(await verify({ ...jws }, async () => secret.publicKey)).toEqual({ payload, signer: kid });
  });

  test("is not made by a key that does not sign", () => {
    expect(() => sign(payload, { kid, secret: SecretKey.random("X25519") })).toThrow(/do not sign/);
    expect(() => sign(payload, { kid, secret: SecretKey.random("P-384") })).toThrow(/do not sign/);
  });
});

describe("verification", () => {
  const secret = SecretKey.random("Ed25519");
  const jws = sign(payload, { kid, secret });
  const [signature] = jws.signatures;
  if (signature === undefined) throw new Error("no signature");
  const key = async () => secret.publicKey;

  test("reads the flattened serialization, and a kid in the protected header", async () => {
    const flattened = { payload: jws.payload, ...signature };
    await expect(verify(flattened, key)).resolves.toEqual({ payload, signer: kid });
    const header = JSON.stringify({ typ: "application/didcomm-signed+json", alg: "EdDSA", kid });
    const protectedHeader = base64urlnopad.encode(new TextEncoder().encode(header));
    const signed = secret.sign(new TextEncoder().encode(`${protectedHeader}.${jws.payload}`));
    await expect(
      verify({ payload: jws.payload, protected: protectedHeader, signature: base64urlnopad.encode(signed) }, key),
    ).resolves.toEqual({ payload, signer: kid });
  });

  test("asks for the key that kid names, and refuses one its signer does not authenticate with", async () => {
    const asked: string[] = [];
    await expect(
      verify({ ...jws }, async (named) => {
        asked.push(named);
        return undefined;
      }),
    ).rejects.toThrow(/not an authentication key/);
    expect(asked).toEqual([kid]);
  });

  test("refuses another key, another payload, and an algorithm that is not the key's", async () => {
    const other = SecretKey.random("Ed25519").publicKey;
    await expect(verify({ ...jws }, async () => other)).rejects.toThrow(/does not verify/);
    const changed = base64urlnopad.encode(new TextEncoder().encode('{"id":"2"}'));
    await expect(verify({ ...jws, payload: changed }, key)).rejects.toThrow(/does not verify/);
    const p256Key: PublicKey = SecretKey.random("P-256").publicKey;
    await expect(verify({ ...jws }, async () => p256Key)).rejects.toThrow(/does not verify/);
  });

  test("refuses two signatures, and two kids", async () => {
    await expect(verify({ ...jws, signatures: [signature, signature] }, key)).rejects.toThrow(/not one signature/);
    const header = { kid: "did:example:alice#2" };
    const protectedHeader = base64urlnopad.encode(
      new TextEncoder().encode(JSON.stringify({ typ: "application/didcomm-signed+json", alg: "EdDSA", kid })),
    );
    await expect(
      verify({ payload: jws.payload, signatures: [{ ...signature, protected: protectedHeader, header }] }, key),
    ).rejects.toThrow(/name two keys/);
  });

  test("accepts an ES256 signature whose s is high, as Web Crypto writes half of them", async () => {
    const p256Secret = SecretKey.random("P-256");
    const signed = sign(payload, { kid, secret: p256Secret });
    const [only] = signed.signatures;
    if (only === undefined) throw new Error("no signature");
    const s = p256.Signature.fromBytes(base64urlnopad.decode(only.signature));
    const flipped = new p256.Signature(s.r, p256.Point.CURVE().n - s.s);
    const high = { ...only, signature: base64urlnopad.encode(flipped.toBytes()) };
    await expect(
      verify({ payload: signed.payload, signatures: [high] }, async () => p256Secret.publicKey),
    ).resolves.toEqual({ payload, signer: kid });
  });
});
