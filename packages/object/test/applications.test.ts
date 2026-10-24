import { SoftwareSigner, type Scheme } from "@estoc/identity";
import { describe, expect, it } from "vitest";
import { defaultValidator } from "../src/default-validator.ts";
import {
  decodeObject,
  encodeObject,
  encodeSchema,
  linkOf,
  linkSchema,
  loadSignatures,
  type EncodedObject,
  type IdentityObject,
  type Json,
  type JsonLink,
  type Link,
  type Reader,
  type Schema,
  type Signature,
} from "../src/index.ts";

// Applications built on objects and signatures. What makes a login or a sale
// hold is each application's own rule, written here against the schemas it
// pins; the package only reads the blobs.

const signatures = await loadSignatures(defaultValidator);
const { identities } = signatures;

const DRAFT = "https://json-schema.org/draft/2020-12/schema";
const signer = (scheme: Scheme, fill: number) => SoftwareSigner.fromSecretKey(scheme, new Uint8Array(32).fill(fill));
const byLink = (blobs: readonly Uint8Array[]) => new Map(blobs.map((bytes) => [linkOf(bytes), bytes]));

/**
 * What an application holds: blobs by link, the objects of the identities
 * that signed among them, and the signatures it was given.
 */
interface Received {
  readonly blobs: Reader;
  readonly signatures: readonly Uint8Array[];
}

async function signersOf(link: Link<unknown>, received: Received): Promise<IdentityObject[]> {
  const read = received.signatures.map((bytes) => signatures.verify(decodeObject(bytes, signatures.schema), received.blobs));
  return (await Promise.all(read)).filter((signature) => signature.object === link).map((signature) => signature.identity);
}

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
// object itself and needs back only the signature, with the object of the
// identity that signed.
async function loggedIn(audience: string, nonce: string, signature: Uint8Array, identity: Uint8Array): Promise<IdentityObject | undefined> {
  const expected = encodeObject(login, { audience, nonce });
  const read = await signatures.verify(decodeObject(signature, signatures.schema), byLink([identity]));
  return read.object === expected.link ? read.identity : undefined;
}

describe("a login", () => {
  const user = signer("eip191", 1);
  const signed = signatures.sign(encodeObject(login, { audience: "https://app.estoc.dev", nonce: "6f1c0a9e" }), user);
  const logIn = async (audience: string, nonce: string) => {
    const { bytes, identity } = await signed;
    return loggedIn(audience, nonce, bytes, identity.bytes);
  };

  it("logs in whoever signed it, though the object names no one", async () => {
    expect(await logIn("https://app.estoc.dev", "6f1c0a9e")).toEqual(identities.encode(user.identity));
  });

  it("for another nonce or audience logs no one in", async () => {
    expect(await logIn("https://app.estoc.dev", "0b5e7d21")).toBeUndefined();
    expect(await logIn("https://other.example", "6f1c0a9e")).toBeUndefined();
  });
});

// A sale names its parties by the links of their identity objects, as a
// signature names its signer.
type Sale = {
  readonly buyer: JsonLink<IdentityObject>;
  readonly seller: JsonLink<IdentityObject>;
  readonly goods: string;
  readonly price: string;
};

const sale: Schema<Json, Sale> = await encodeSchema(
  {
    $schema: DRAFT,
    title: "Sale",
    type: "object",
    properties: {
      buyer: linkSchema,
      seller: linkSchema,
      goods: { type: "string" },
      price: { type: "string", pattern: "^[0-9]+\\.[0-9]{2} [A-Z]{3}$" },
    },
    required: ["buyer", "seller", "goods", "price"],
    additionalProperties: false,
  },
  defaultValidator,
);

const delivery: Schema<Json, { readonly sale: JsonLink<EncodedObject<Json, Sale>> }> = await encodeSchema(
  {
    $schema: DRAFT,
    title: "Delivery",
    type: "object",
    properties: { sale: linkSchema },
    required: ["sale"],
    additionalProperties: false,
  },
  defaultValidator,
);

// A sale is in force once its buyer and its seller have both signed it.
async function saleInForce(link: Link<EncodedObject<Json, Sale>>, received: Received): Promise<Sale | undefined> {
  const bytes = await received.blobs.get(link);
  if (bytes === undefined) return undefined;
  const terms = decodeObject(bytes, sale).data;
  const signers = await signersOf(link, received);
  const signed = (party: JsonLink<IdentityObject>) => signers.some((identity) => identity.link === party.$link);
  return signed(terms.buyer) && signed(terms.seller) ? terms : undefined;
}

// A delivery is confirmed once the buyer of a sale in force signs for it.
async function deliveryConfirmed(link: Link<unknown>, received: Received): Promise<boolean> {
  const bytes = await received.blobs.get(link);
  if (bytes === undefined) return false;
  const terms = await saleInForce(decodeObject(bytes, delivery).data.sale.$link, received);
  return terms !== undefined && (await signersOf(link, received)).some((identity) => identity.link === terms.buyer.$link);
}

const buyer = signer("eip191", 1);
const seller = signer("ed25519", 2);
const witness = signer("solana-offchain", 3);
const terms = encodeObject(sale, {
  buyer: { $link: identities.encode(buyer.identity).link },
  seller: { $link: identities.encode(seller.identity).link },
  goods: "one bicycle",
  price: "120.00 CAD",
});
const confirmation = encodeObject(delivery, { sale: { $link: terms.link } });
const receive = (signed: readonly Signature[]): Received => ({
  blobs: byLink([terms.bytes, confirmation.bytes, ...signed.map(({ identity }) => identity.bytes)]),
  signatures: signed.map(({ bytes }) => bytes),
});
const signedBy = (...pairs: [{ readonly link: Link<unknown> }, SoftwareSigner][]) => Promise.all(pairs.map(([object, by]) => signatures.sign(object, by)));

describe("a sale", () => {
  it("is in force only once its buyer and its seller have both signed it", async () => {
    expect(await saleInForce(terms.link, receive(await signedBy([terms, buyer])))).toBeUndefined();
    const both = await signedBy([terms, buyer], [terms, seller]);
    expect(await saleInForce(terms.link, receive(both))).toEqual(terms.data);
  });

  it("takes a signature from someone it does not name, without counting it as a party's", async () => {
    const witnessed = await signatures.sign(terms, witness);
    const received = receive([...(await signedBy([terms, buyer])), witnessed]);
    expect(await signersOf(terms.link, received)).toContainEqual(identities.encode(witness.identity));
    expect(await saleInForce(terms.link, received)).toBeUndefined();
  });
});

describe("a delivery", () => {
  it("is confirmed when the buyer of a sale in force signs for it", async () => {
    const received = receive(await signedBy([terms, buyer], [terms, seller], [confirmation, buyer]));
    expect(await deliveryConfirmed(confirmation.link, received)).toBe(true);
  });

  it("is not confirmed when only the seller signs for it", async () => {
    const received = receive(await signedBy([terms, buyer], [terms, seller], [confirmation, seller]));
    expect(await deliveryConfirmed(confirmation.link, received)).toBe(false);
  });

  it("is not confirmed while the sale is not in force", async () => {
    const received = receive(await signedBy([terms, buyer], [confirmation, buyer]));
    expect(await deliveryConfirmed(confirmation.link, received)).toBe(false);
  });
});
