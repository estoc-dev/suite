import { base64urlnopad } from "@scure/base";
import { describe, expect, it, test } from "vitest";
import {
  anoncrypt,
  authcrypt,
  type ContentEncryption,
  type CurveName,
  decrypt,
  type Jwe,
  type NamedKey,
  type OwnKey,
  SecretKey,
  type Secrets,
} from "../src/envelope/index.ts";
import vectors from "./vectors.json" with { type: "json" };

const plaintext = new TextEncoder().encode('{"id":"1","type":"https://example.com/test"}');

function own(curve: CurveName, kid: string): OwnKey {
  return { kid, secret: SecretKey.random(curve) };
}

const named = ({ kid, secret }: OwnKey): NamedKey => ({ kid, key: secret.publicKey });
const holding =
  (...keys: OwnKey[]): Secrets =>
  (kid) =>
    keys.find((key) => key.kid === kid)?.secret;
const noSender = async () => undefined;

function headerOf(jwe: Jwe): Record<string, unknown> {
  return JSON.parse(new TextDecoder().decode(base64urlnopad.decode(jwe.protected)));
}

function withHeader(jwe: Jwe, change: (header: Record<string, unknown>) => Record<string, unknown>): Jwe {
  const header = change(headerOf(jwe));
  return { ...jwe, protected: base64urlnopad.encode(new TextEncoder().encode(JSON.stringify(header))) };
}

const curves: CurveName[] = ["X25519", "P-256", "P-384", "P-521"];
const encs: ContentEncryption[] = ["A256CBC-HS512", "A256GCM", "XC20P"];

describe("anoncrypt", () => {
  it.each(curves.flatMap((curve) => encs.map((enc) => [curve, enc] as const)))(
    "on %s with %s decrypts for each recipient",
    async (curve, enc) => {
      const bob1 = own(curve, "did:example:bob#1");
      const bob2 = own(curve, "did:example:bob#2");
      const jwe = anoncrypt(plaintext, [named(bob1), named(bob2)], enc);
      expect(headerOf(jwe)).toMatchObject({ typ: "application/didcomm-encrypted+json", alg: "ECDH-ES+A256KW", enc });
      expect(headerOf(jwe)).not.toHaveProperty("skid");
      for (const bob of [bob1, bob2]) {
        const opened = await decrypt({ ...jwe }, holding(bob), noSender);
        expect(opened).toEqual({ plaintext, alg: "ECDH-ES+A256KW", enc, recipient: bob.kid, sender: undefined });
      }
    },
  );

  test("refuses recipients on more than one curve", () => {
    expect(() => anoncrypt(plaintext, [named(own("X25519", "a")), named(own("P-256", "b"))])).toThrow(/one curve/);
  });

  test("does not encrypt to keys that only sign", () => {
    expect(() => anoncrypt(plaintext, [named(own("Ed25519", "a"))])).toThrow(/do not agree/);
  });
});

describe("authcrypt", () => {
  it.each(curves)("on %s proves the sender's key", async (curve) => {
    const alice = own(curve, "did:example:alice#1");
    const bob = own(curve, "did:example:bob#1");
    const jwe = authcrypt(plaintext, alice, [named(bob)]);
    expect(headerOf(jwe)).toMatchObject({
      alg: "ECDH-1PU+A256KW",
      enc: "A256CBC-HS512",
      skid: alice.kid,
      apu: base64urlnopad.encode(new TextEncoder().encode(alice.kid)),
    });
    const asked: string[] = [];
    const opened = await decrypt({ ...jwe }, holding(bob), async (skid) => {
      asked.push(skid);
      return alice.secret.publicKey;
    });
    expect(opened).toMatchObject({ plaintext, recipient: bob.kid, sender: alice.kid });
    expect(asked).toEqual([alice.kid]);
  });

  test("does not decrypt as from another key", async () => {
    const alice = own("X25519", "did:example:alice#1");
    const bob = own("X25519", "did:example:bob#1");
    const mallory = own("X25519", "did:example:mallory#1");
    const jwe = authcrypt(plaintext, alice, [named(bob)]);
    await expect(decrypt({ ...jwe }, holding(bob), async () => mallory.secret.publicKey)).rejects.toThrow(
      /does not decrypt/,
    );
  });

  test("names the sender by apu when there is no skid", async () => {
    const alice = own("X25519", "did:example:alice#1");
    const bob = own("X25519", "did:example:bob#1");
    const jwe = withHeader(authcrypt(plaintext, alice, [named(bob)]), ({ skid: _, ...header }) => header);
    // The protected header is the AAD, so the changed one does not decrypt,
    // but the sender is asked for by apu first.
    const asked: string[] = [];
    await expect(
      decrypt({ ...jwe }, holding(bob), async (skid) => {
        asked.push(skid);
        return alice.secret.publicKey;
      }),
    ).rejects.toThrow(/does not decrypt/);
    expect(asked).toEqual([alice.kid]);
  });

  test("refuses a skid that apu does not name, and a sender that does not resolve", async () => {
    const alice = own("X25519", "did:example:alice#1");
    const bob = own("X25519", "did:example:bob#1");
    const jwe = authcrypt(plaintext, alice, [named(bob)]);
    const resolved = async () => alice.secret.publicKey;
    await expect(
      decrypt(
        withHeader(jwe, (header) => ({ ...header, skid: "did:example:mallory#1" })),
        holding(bob),
        resolved,
      ),
    ).rejects.toThrow(/skid and apu differ/);
    await expect(decrypt({ ...jwe }, holding(bob), noSender)).rejects.toThrow(/not a key agreement key/);
  });

  test("allows A256CBC-HS512 alone, which commits to its key", async () => {
    const alice = own("X25519", "did:example:alice#1");
    const bob = own("X25519", "did:example:bob#1");
    const jwe = withHeader(authcrypt(plaintext, alice, [named(bob)]), (header) => ({ ...header, enc: "A256GCM" }));
    await expect(decrypt({ ...jwe }, holding(bob), async () => alice.secret.publicKey)).rejects.toThrow(
      /A256CBC-HS512 alone/,
    );
  });
});

describe("a JWE that was changed", () => {
  // The X25519 authcrypt of C.3, with bob's first key.
  const jwe = vectors.encrypted[3] as Jwe;
  const bob = SecretKey.fromJwk(vectors.recipientSecrets[0]);
  const aliceKey = SecretKey.fromJwk(vectors.senderSecrets[3]).publicKey;
  const secrets: Secrets = (kid) => (kid === "did:example:bob#key-x25519-1" ? bob : undefined);
  const open = (changed: Jwe) => decrypt({ ...changed }, secrets, async () => aliceKey);

  test("decrypts as it is", async () => {
    await expect(open(jwe)).resolves.toMatchObject({ sender: "did:example:alice#key-x25519-1" });
  });

  it.each(["ciphertext", "tag", "iv"] as const)("does not decrypt with its %s changed", async (field) => {
    await expect(open({ ...jwe, [field]: flip(jwe[field]) })).rejects.toThrow(/does not decrypt/);
  });

  test("does not decrypt with its encrypted key changed", async () => {
    const recipients = jwe.recipients.map((recipient, i) =>
      i === 0 ? { ...recipient, encrypted_key: flip(recipient.encrypted_key) } : recipient,
    );
    await expect(open({ ...jwe, recipients })).rejects.toThrow(/does not decrypt/);
  });

  test("does not decrypt with its protected header changed", async () => {
    await expect(open(withHeader(jwe, (header) => ({ ...header, typ: "application/json" })))).rejects.toThrow(
      /does not decrypt/,
    );
  });

  test("is refused when it is for keys not held here", async () => {
    await expect(
      decrypt(
        { ...jwe },
        () => undefined,
        async () => aliceKey,
      ),
    ).rejects.toThrow(/no key held here/);
  });

  it.each([
    ["crit", ["exp"], /critical extensions/],
    ["zip", "DEF", /compressed/],
  ])("is refused with %s in its header", async (name, value, error) => {
    await expect(open(withHeader(jwe, (header) => ({ ...header, [name]: value })))).rejects.toThrow(error);
  });
});

describe("an ephemeral key", () => {
  test("not on its curve is refused, as DIDComm asks for the NIST curves", async () => {
    const bob = own("P-256", "did:example:bob#1");
    const jwe = withHeader(anoncrypt(plaintext, [named(bob)]), (header) => {
      const epk = header.epk as { y: string };
      return { ...header, epk: { ...epk, y: flip(epk.y) } };
    });
    await expect(decrypt({ ...jwe }, holding(bob), noSender)).rejects.toThrow(/not a P-256 public key/);
  });

  test("of small order gives no secret", async () => {
    const bob = own("X25519", "did:example:bob#1");
    const jwe = withHeader(anoncrypt(plaintext, [named(bob)]), (header) => ({
      ...header,
      epk: { kty: "OKP", crv: "X25519", x: base64urlnopad.encode(new Uint8Array(32)) },
    }));
    await expect(decrypt({ ...jwe }, holding(bob), noSender)).rejects.toThrow(/does not decrypt/);
  });

  test("on another curve than the recipient's key is not used with it", async () => {
    const bob = own("X25519", "did:example:bob#1");
    const other = own("P-256", "did:example:bob#1");
    const jwe = anoncrypt(plaintext, [named(other)]);
    await expect(decrypt({ ...jwe }, holding(bob), noSender)).rejects.toThrow(/no key held here/);
  });
});

function flip(text: string): string {
  const bytes = base64urlnopad.decode(text);
  bytes[0] = (bytes[0] ?? 0) ^ 1;
  return base64urlnopad.encode(bytes);
}
