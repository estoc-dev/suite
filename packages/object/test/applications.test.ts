import { identityToJson, SoftwareSigner, type Identity, type IdentityJson, type Scheme } from "@estoc/identity";
import { describe, expect, it } from "vitest";
import { defaultValidator } from "../src/default-validator.ts";
import {
  decodeObject,
  encodeObject,
  encodeSchema,
  sign,
  signatures,
  type EncodedObject,
  type Link,
} from "../src/index.ts";

// Applications built on objects and signatures. What makes a login or a sale
// hold is each application's own rule, written here against the schemas it
// pins; the package only reads the blobs.

const DRAFT = "https://json-schema.org/draft/2020-12/schema";
const signer = (scheme: Scheme, fill: number) => SoftwareSigner.fromSecretKey(scheme, new Uint8Array(32).fill(fill));
const same = (identity: Identity, json: IdentityJson) => {
  const { publicKey, scheme } = identityToJson(identity);
  return publicKey === json.publicKey && scheme === json.scheme;
};

/** What an application holds: blobs by link, and the signatures it was given. */
interface Received {
  readonly objects: ReadonlyMap<string, Uint8Array>;
  readonly signatures: readonly Uint8Array[];
}

const signersOf = (link: Link<EncodedObject>, received: Received) =>
  received.signatures
    .map((bytes) => signatures.decode(bytes))
    .filter((signature) => signature.object === link)
    .map((signature) => signature.identity);

const login = await encodeSchema(
  {
    $schema: DRAFT,
    title: "Login",
    type: "object",
    properties: { audience: { type: "string", format: "uri" }, nonce: { type: "string" } },
    required: ["audience", "nonce"],
    additionalProperties: false,
  },
  defaultValidator,
);

// The server knows its audience and the nonce it handed out, so it builds the
// object itself and needs only the signature back.
function loggedIn(audience: string, nonce: string, signature: Uint8Array): Identity | undefined {
  const expected = encodeObject(login, { audience, nonce });
  const read = signatures.decode(signature);
  return read.object === expected.link ? read.identity : undefined;
}

describe("a login", () => {
  const user = signer("eip191", 1);
  const signed = sign(encodeObject(login, { audience: "https://app.estoc.dev", nonce: "6f1c0a9e" }), user);

  it("logs in whoever signed it, though the object names no one", async () => {
    expect(loggedIn("https://app.estoc.dev", "6f1c0a9e", (await signed).bytes)).toEqual(user.identity);
  });

  it("for another nonce or audience logs no one in", async () => {
    const { bytes } = await signed;
    expect(loggedIn("https://app.estoc.dev", "0b5e7d21", bytes)).toBeUndefined();
    expect(loggedIn("https://other.example", "6f1c0a9e", bytes)).toBeUndefined();
  });
});

type Sale = {
  readonly buyer: IdentityJson;
  readonly seller: IdentityJson;
  readonly goods: string;
  readonly price: string;
};

const sale = await encodeSchema(
  {
    $schema: DRAFT,
    title: "Sale",
    type: "object",
    properties: {
      buyer: { $ref: "https://estoc.dev/schema/identity" },
      seller: { $ref: "https://estoc.dev/schema/identity" },
      goods: { type: "string" },
      price: { type: "string", pattern: "^[0-9]+\\.[0-9]{2} [A-Z]{3}$" },
    },
    required: ["buyer", "seller", "goods", "price"],
    additionalProperties: false,
  },
  defaultValidator,
);

const delivery = await encodeSchema(
  {
    $schema: DRAFT,
    title: "Delivery",
    type: "object",
    properties: { sale: { $ref: "https://estoc.dev/schema/link" } },
    required: ["sale"],
    additionalProperties: false,
  },
  defaultValidator,
);

// A sale is in force once its buyer and its seller have both signed it.
function saleInForce(link: Link<EncodedObject>, received: Received): Sale | undefined {
  const bytes = received.objects.get(link);
  if (bytes === undefined) return undefined;
  const terms = decodeObject(bytes, sale).data as Sale;
  const signers = signersOf(link, received);
  const signed = (party: IdentityJson) => signers.some((identity) => same(identity, party));
  return signed(terms.buyer) && signed(terms.seller) ? terms : undefined;
}

// A delivery is confirmed once the buyer of a sale in force signs for it.
function deliveryConfirmed(link: Link<EncodedObject>, received: Received): boolean {
  const bytes = received.objects.get(link);
  if (bytes === undefined) return false;
  const { sale: saleLink } = decodeObject(bytes, delivery).data as { sale: Link<EncodedObject> };
  const terms = saleInForce(saleLink, received);
  return terms !== undefined && signersOf(link, received).some((identity) => same(identity, terms.buyer));
}

const buyer = signer("eip191", 1);
const seller = signer("ed25519", 2);
const witness = signer("solana-offchain", 3);
const terms = encodeObject(sale, {
  buyer: identityToJson(buyer.identity),
  seller: identityToJson(seller.identity),
  goods: "one bicycle",
  price: "120.00 CAD",
});
const confirmation = encodeObject(delivery, { sale: terms.link });
const objects = new Map([terms, confirmation].map((object) => [object.link, object.bytes] as const));
const signedBy = async (...pairs: [EncodedObject, SoftwareSigner][]) =>
  (await Promise.all(pairs.map(([object, by]) => sign(object, by)))).map((signature) => signature.bytes);

describe("a sale", () => {
  it("is in force only once its buyer and its seller have both signed it", async () => {
    expect(saleInForce(terms.link, { objects, signatures: await signedBy([terms, buyer]) })).toBeUndefined();
    const both = await signedBy([terms, buyer], [terms, seller]);
    expect(saleInForce(terms.link, { objects, signatures: both })).toEqual(terms.data);
  });

  it("takes a signature from someone it does not name, without counting it as a party's", async () => {
    const witnessed = await sign(terms, witness);
    expect(signatures.decode(witnessed.bytes).identity).toEqual(witness.identity);
    const received = { objects, signatures: [...(await signedBy([terms, buyer])), witnessed.bytes] };
    expect(saleInForce(terms.link, received)).toBeUndefined();
  });
});

describe("a delivery", () => {
  it("is confirmed when the buyer of a sale in force signs for it", async () => {
    const received = { objects, signatures: await signedBy([terms, buyer], [terms, seller], [confirmation, buyer]) };
    expect(deliveryConfirmed(confirmation.link, received)).toBe(true);
  });

  it("is not confirmed when only the seller signs for it", async () => {
    const received = { objects, signatures: await signedBy([terms, buyer], [terms, seller], [confirmation, seller]) };
    expect(deliveryConfirmed(confirmation.link, received)).toBe(false);
  });

  it("is not confirmed while the sale is not in force", async () => {
    const received = { objects, signatures: await signedBy([terms, buyer], [confirmation, buyer]) };
    expect(deliveryConfirmed(confirmation.link, received)).toBe(false);
  });
});
