import { describe, expect, it } from "vitest";
import { identityFromJson, identityToJson, SoftwareSigner } from "../src/index.ts";

const secretKey = new Uint8Array(32).fill(1);
const ed25519Key = "8a88e3dd7409f195fd52db2d3cba5d72ca6709bf1d94121bf3748801b40f6f5c";

describe("an identity's JSON form", () => {
  it.each(["ed25519", "eip191", "solana-offchain"] as const)("reads back as the same %s identity", (scheme) => {
    const identity = SoftwareSigner.fromSecretKey(scheme, secretKey).identity;
    const json = identityToJson(identity);
    expect(json).toEqual({ publicKey: expect.stringMatching(/^[0-9a-f]+$/), scheme });
    expect(identityFromJson(JSON.parse(JSON.stringify(json)))).toEqual(identity);
  });

  it("is refused with a key of another scheme's length", () => {
    const eip191Key = identityToJson(SoftwareSigner.fromSecretKey("eip191", secretKey).identity).publicKey;
    expect(() => identityFromJson({ publicKey: eip191Key, scheme: "ed25519" })).toThrow();
    expect(() => identityFromJson({ publicKey: ed25519Key, scheme: "eip191" })).toThrow();
  });

  it("is refused with a field besides publicKey and scheme", () => {
    expect(() => identityFromJson({ publicKey: ed25519Key, scheme: "ed25519", role: "buyer" })).toThrow();
  });

  it("is refused without one of its fields", () => {
    expect(() => identityFromJson({ publicKey: ed25519Key })).toThrow();
    expect(() => identityFromJson({ scheme: "ed25519" })).toThrow();
  });

  it("is refused with a scheme this package does not know", () => {
    expect(() => identityFromJson({ publicKey: ed25519Key, scheme: "ed448" })).toThrow();
    expect(() => identityFromJson({ publicKey: ed25519Key, scheme: "toString" })).toThrow();
  });

  it("is refused with the key in uppercase hex", () => {
    expect(() => identityFromJson({ publicKey: ed25519Key.toUpperCase(), scheme: "ed25519" })).toThrow();
  });

  it("is refused when it is not a JSON object", () => {
    for (const value of [null, ed25519Key, [ed25519Key, "ed25519"]]) {
      expect(() => identityFromJson(value)).toThrow();
    }
  });
});
