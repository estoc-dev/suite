import { base58 } from "@scure/base";
import { describe, expect, it, test } from "vitest";
import {
  canonicalDid,
  type DidDocument,
  didOf,
  keysOf,
  multibaseOf,
  OfflineResolver,
  peerDid2,
  peerDid4,
  publicKeyFromMultibase,
  resolveDidKey,
  resolvePeerDid2,
  sameDid,
} from "../src/envelope/index.ts";
import examples from "./peer-did.json" with { type: "json" };

// The examples of the Peer DID Method Specification, read from its text
// into peer-did.json, with the trailing commas the spec's JSON has taken
// out.

describe("did:peer:2", () => {
  const { did, document } = examples.peer2;

  it("resolves as the spec's example does, but for the optional alsoKnownAs", () => {
    const { alsoKnownAs: _, ...expected } = document;
    expect(resolvePeerDid2(did)).toEqual(expected);
  });

  it("is written from keys and services as the spec's example is", () => {
    const service = (uri: string, key: string) => ({
      type: "DIDCommMessaging",
      serviceEndpoint: { uri, accept: ["didcomm/v2"], routingKeys: [`did:example:123456789abcdefghi#${key}`] },
    });
    expect(
      peerDid2({
        keys: [
          {
            purpose: "authentication",
            key: publicKeyFromMultibase("z6Mkj3PUd1WjvaDhNZhhhXQdz5UnZXmS7ehtx8bsPpD47kKc"),
          },
          { purpose: "keyAgreement", key: publicKeyFromMultibase("z6LSg8zQom395jKLrGiBNruB9MM6V8PWuf2FpEy4uRFiqQBR") },
        ],
        services: [service("http://example.com/didcomm", "key-1"), service("http://example.com/another", "key-2")],
      }),
    ).toBe(did);
  });

  it("gives its keys by absolute DID URLs", () => {
    const resolved = resolvePeerDid2(did);
    expect(keysOf(resolved, "authentication").map(({ kid, key }) => [kid, key.curve])).toEqual([
      [`${did}#key-1`, "Ed25519"],
    ]);
    expect(keysOf(resolved, "keyAgreement").map(({ kid, key }) => [kid, key.curve])).toEqual([
      [`${did}#key-2`, "X25519"],
    ]);
  });

  it("expands a service whose endpoint is a bare url, as DIDComm v2.0 wrote it", () => {
    expect(resolvePeerDid2(examples.peer2.legacy).service).toEqual([
      {
        id: "#service",
        type: "DIDCommMessaging",
        serviceEndpoint: "https://example.com/endpoint",
        routingKeys: ["did:example:somemediator#somekey"],
        accept: ["didcomm/v2", "didcomm/aip2;env=rfc587"],
      },
    ]);
  });

  it("refuses an element of no purpose, and a key that does not read", () => {
    expect(() => resolvePeerDid2(`${did}.Xz6Mkj3PUd1WjvaDhNZhhhXQdz5UnZXmS7ehtx8bsPpD47kKc`)).toThrow(/purpose X/);
    expect(() => resolvePeerDid2("did:peer:2.Ez6LSg8zQom395jKLrGiBNruB9MM6V8")).toThrow(/multibase key/);
    expect(() => resolvePeerDid2("did:peer:2")).toThrow(/not a did:peer:2/);
  });
});

describe("did:peer:4", () => {
  const { long, short, longDocument, shortDocument } = examples.peer4;

  it("resolves its long form as the spec's example does", async () => {
    expect(await new OfflineResolver().resolve(long)).toEqual(longDocument);
  });

  it("resolves its short form once the long form has resolved", async () => {
    const resolver = new OfflineResolver();
    expect(await resolver.resolve(short)).toBeUndefined();
    await resolver.resolve(long);
    expect(await resolver.resolve(short)).toEqual(shortDocument);
  });

  it("forgets the oldest long form beyond those it remembers", async () => {
    const resolver = new OfflineResolver({ remembered: 1 });
    await resolver.resolve(long);
    await resolver.resolve(peerDid4({ service: [] }));
    expect(await resolver.resolve(short)).toBeUndefined();
  });

  it("is written back to the same DID from the document it encodes", async () => {
    const encoded = long.slice(long.lastIndexOf(":") + 1);
    const input = JSON.parse(new TextDecoder().decode(base58.decode(encoded.slice(1)).subarray(2)));
    expect(peerDid4(input)).toBe(long);
  });

  it("refuses a long form whose hash is not of its document", async () => {
    const other = peerDid4({ service: [] });
    const forged = `${short}${other.slice(other.lastIndexOf(":"))}`;
    await expect(new OfflineResolver().resolve(forged)).rejects.toThrow(/not of its document/);
  });

  test("its two forms are one DID, named by the short", () => {
    expect(canonicalDid(long)).toBe(short);
    expect(sameDid(long, short)).toBe(true);
    expect(sameDid(short, peerDid4({ service: [] }))).toBe(false);
  });
});

describe("did:key", () => {
  // The examples of the did:key Method specification.
  const ed25519 = "did:key:z6MkhaXgBZDvotDkL5257faiztiGiC2QtKLGpbnnEGta2doK";
  const x25519 = "z6LSj72tK8brWgZja8NLRwPigth2T9QRiG1uH9oKZuKjdh9p";

  it("derives the X25519 key of an Ed25519 key for key agreement, as the spec's example does", () => {
    const document = resolveDidKey(ed25519);
    expect(document.keyAgreement).toEqual([`${ed25519}#${x25519}`]);
    expect(keysOf(document, "keyAgreement")[0]?.key).toEqual(publicKeyFromMultibase(x25519));
    expect(keysOf(document, "authentication").map(({ kid }) => kid)).toEqual([`${ed25519}#${ed25519.slice(8)}`]);
  });

  it("gives an X25519 key for key agreement alone", () => {
    const document = resolveDidKey(`did:key:${x25519}`);
    expect(keysOf(document, "keyAgreement")).toHaveLength(1);
    expect(keysOf(document, "authentication")).toEqual([]);
  });

  it.each([
    ["P-256", "zDnaerx9CtbPJ1q36T5Ln5wYt3MQYeGRG5ehnPAmxcf5mDZpv", 1],
    ["P-384", "z82LkvCwHNreneWpsgPEbV3gu1C6NFJEBg4srfJ5gdxEsMGRJUz2sG9FE42shbn2xkZJh54", 1],
    ["secp256k1", "zQ3shokFTS3brHcDQrn82RUDfCZESWL1ZdCEJwekUDPQiYBme", 0],
  ])("reads a compressed %s key, which agrees on secrets %i times", (curve, value, agreements) => {
    const document: DidDocument = resolveDidKey(`did:key:${value}`);
    const [key] = keysOf(document, "authentication");
    expect(key?.key.curve).toBe(curve);
    expect(key && multibaseOf(key.key)).toBe(value);
    expect(keysOf(document, "keyAgreement")).toHaveLength(agreements);
  });
});

test("the DID of a DID URL is what comes before its path, query or fragment", () => {
  expect(didOf("did:example:alice#key-1")).toBe("did:example:alice");
  expect(didOf("did:web:example.com:user/path?query")).toBe("did:web:example.com:user");
  expect(didOf("did:example:alice")).toBe("did:example:alice");
});

test("an offline resolver leaves other methods to its fallback", async () => {
  const document = { id: "did:example:alice" };
  const resolver = new OfflineResolver({
    fallback: { resolve: async (did) => (did === document.id ? document : undefined) },
  });
  expect(await resolver.resolve("did:example:alice")).toBe(document);
  expect(await new OfflineResolver().resolve("did:example:alice")).toBeUndefined();
});
