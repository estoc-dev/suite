import { base64urlnopad } from "@scure/base";
import { describe, expect, it, test } from "vitest";
import {
  apvOf,
  type DidDocument,
  type DidResolver,
  type Jwe,
  SecretKey,
  type Secrets,
  unpack,
} from "../src/envelope/index.ts";
import vectors from "./vectors.json" with { type: "json" };

const readEncoded = (text: string) => new TextDecoder().decode(base64urlnopad.decode(text));

// The keys, documents and messages of the appendices of DIDComm Messaging
// v2.1, read from the spec's text into vectors.json. The recipient secrets
// there are named by "kid " with a space, which vectors.json reads as kid.

const documents = new Map<string, DidDocument>([
  [vectors.alice.id, vectors.alice],
  [vectors.bob.id, vectors.bob],
]);
const resolver: DidResolver = { resolve: async (did) => documents.get(did) };
const secretsOf = (jwks: { kid: string }[]) => new Map(jwks.map((jwk) => [jwk.kid, SecretKey.fromJwk(jwk)]));
const recipientSecrets = secretsOf(vectors.recipientSecrets);
const only =
  (kid: string): Secrets =>
  (asked) =>
    asked === kid ? recipientSecrets.get(kid) : undefined;

// The signed payloads say http: where C.1 says https:, and add typ.
const expected = {
  ...vectors.plaintext,
  type: "http://example.com/protocols/lets_do_lunch/1.0/proposal",
};

describe("the signed messages of C.2", () => {
  it.each(vectors.signed.map((jws) => [JSON.parse(readEncoded(jws.signatures[0]?.protected ?? "")).alg, jws]))(
    "verify by %s as alice's",
    async (_alg, jws) => {
      const kid = jws.signatures[0]?.header.kid ?? "";
      const unpacked = await unpack(JSON.stringify(jws), { resolver, secrets: () => undefined });
      expect(unpacked.message).toMatchObject(expected);
      expect(unpacked.sender).toBe("did:example:alice");
      expect(unpacked.envelopes).toEqual([{ kind: "signed", signer: kid, jws: JSON.stringify(jws) }]);
    },
  );
});

const encrypted = vectors.encrypted as Jwe[];
const describeJwe = (jwe: Jwe) => {
  const header = JSON.parse(readEncoded(jwe.protected));
  return `${header.alg} on ${header.epk.crv} with ${header.enc}`;
};

describe("the encrypted messages of C.3", () => {
  const cases = encrypted.flatMap((jwe) =>
    jwe.recipients.map(({ header }) => [describeJwe(jwe), header.kid, jwe] as const),
  );

  it.each(cases)("%s decrypt with the secret of %s alone", async (_name, kid, jwe) => {
    const unpacked = await unpack(JSON.stringify(jwe), { resolver, secrets: only(kid) });
    expect(unpacked.message).toMatchObject(expected);
    expect(unpacked.envelopes[0]).toMatchObject({ recipient: kid });
  });

  test("anoncrypt says nothing of who sent it", async () => {
    const [x25519, p384, p521] = encrypted;
    for (const jwe of [x25519, p384, p521]) {
      const kid = jwe?.recipients[0]?.header.kid ?? "";
      const unpacked = await unpack(JSON.stringify(jwe), { resolver, secrets: only(kid) });
      expect(unpacked.sender).toBeUndefined();
      expect(unpacked.envelopes.map((envelope) => envelope.kind)).toEqual(["anoncrypt"]);
    }
  });

  test("authcrypt, and the signatures inside, prove alice sent them", async () => {
    const kinds = [];
    for (const jwe of encrypted.slice(3)) {
      const kid = jwe.recipients[0]?.header.kid ?? "";
      const unpacked = await unpack(JSON.stringify(jwe), { resolver, secrets: only(kid) });
      expect(unpacked.sender).toBe("did:example:alice");
      kinds.push(unpacked.envelopes.map((envelope) => envelope.kind));
    }
    expect(kinds).toEqual([["authcrypt"], ["authcrypt", "signed"], ["anoncrypt", "authcrypt", "signed"]]);
  });

  test("apv is the hash of the recipients' kids", () => {
    for (const jwe of encrypted) {
      const header = JSON.parse(readEncoded(jwe.protected));
      expect(apvOf(jwe.recipients.map(({ header }) => header.kid))).toBe(header.apv);
    }
  });
});
